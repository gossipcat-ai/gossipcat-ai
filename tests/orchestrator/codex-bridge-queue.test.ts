import {mkdtempSync,rmSync,statSync,writeFileSync,existsSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {CodexBridgeQueue,BridgeRunner} from '../../packages/orchestrator/src/codex-bridge-queue';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'codex-queue-'));});afterEach(()=>rmSync(dir,{recursive:true,force:true}));
const input=(id:string)=>({id,agentId:'codex-sol',task:'inspect '+id,instructions:'read only'});
const tick=()=>new Promise(r=>setTimeout(r,10));
test('persists result and deduplicates identical task ID across restart',async()=>{
 let calls=0;const runner:BridgeRunner=(_job,_thread,emit)=>({promise:(async()=>{calls++;emit({type:'log' as any,payload:JSON.stringify({threadId:'thread-1'}),timestamp:0});emit({type:'final_result' as any,payload:{result:'verified'},timestamp:0});})(),cancel:()=>{}});
 const q=new CodexBridgeQueue(dir,runner);q.submit(input('one'));await tick();expect(q.get('one')?.status).toBe('completed');
 const restored=new CodexBridgeQueue(dir,runner);restored.submit(input('one'));restored.start();await tick();expect(calls).toBe(1);expect(restored.get('one')?.terminal?.payload.result).toBe('verified');expect(statSync(join(dir,'job-one.json')).mode&0o777).toBe(0o600);
});
test('runs tasks serially and resumes the previous agent thread',async()=>{
 const received:any[]=[];let release!:()=>void;
 const runner:BridgeRunner=(job,thread,emit)=>({promise:(async()=>{received.push([job.id,thread]);if(job.id==='one')await new Promise<void>(r=>release=r);emit({type:'log' as any,payload:JSON.stringify({threadId:'thread-1'}),timestamp:0});emit({type:'final_result' as any,payload:{result:'ok'},timestamp:0});})(),cancel:()=>{}});
 const q=new CodexBridgeQueue(dir,runner);q.submit(input('one'));q.submit(input('two'));expect(received).toEqual([['one',undefined]]);release();await tick();expect(received).toEqual([['one',undefined],['two','thread-1']]);
});
test('marks interrupted execution failed and never replays it after a crash',async()=>{
 let calls=0;const runner:BridgeRunner=()=>({promise:new Promise(()=>{calls++;}),cancel:()=>{}});
 const q=new CodexBridgeQueue(dir,runner);q.submit(input('one'));q.submit(input('two'));
 const restored=new CodexBridgeQueue(dir,runner);expect(restored.get('one')?.status).toBe('failed');expect(restored.get('one')?.terminal?.payload.error).toContain('not retried');expect(restored.get('two')?.status).toBe('queued');expect(calls).toBe(1);
});
test('cancels queued jobs and does not let late completion overwrite cancellation',async()=>{
 let emit:any,release!:()=>void;const cancel=jest.fn(()=>release());
 const runner:BridgeRunner=(_job,_thread,callback)=>{emit=callback;return {promise:new Promise<void>(r=>release=r),cancel};};
 const q=new CodexBridgeQueue(dir,runner);q.submit(input('one'));q.submit(input('two'));q.cancel('two');q.cancel('one');emit({type:'final_result',payload:{result:'late'},timestamp:0});await tick();expect(cancel).toHaveBeenCalled();expect(q.get('one')?.status).toBe('failed');expect(q.get('two')?.status).toBe('failed');
});
test('rejects conflicting payloads, path traversal and malformed context',()=>{
 const q=new CodexBridgeQueue(dir,()=>({promise:new Promise(()=>{}),cancel:()=>{}}));q.submit(input('one'));expect(()=>q.submit({...input('one'),task:'different'})).toThrow('different payload');expect(()=>q.submit(input('../escape'))).toThrow('Invalid');expect(()=>q.submit({...input('two'),context:{} as any})).toThrow('Invalid');
});
test('retains queued work on clean shutdown',()=>{
 const q=new CodexBridgeQueue(dir,()=>({promise:new Promise(()=>{}),cancel:()=>{}}));q.submit(input('one'));q.submit(input('two'));q.shutdown();const next=new CodexBridgeQueue(dir,()=>({promise:new Promise(()=>{}),cancel:()=>{}}));expect(next.get('one')?.status).toBe('failed');expect(next.get('two')?.status).toBe('queued');
});

const writeJob=(id:string,createdAt:string,status='queued',extra:Record<string,unknown>={})=>writeFileSync(join(dir,'job-'+id+'.json'),JSON.stringify({...input(id),digest:'d',status,createdAt,...extra}));
test('restores jobs in createdAt order (id tie-break) regardless of readdir order',async()=>{
 writeJob('zz-first','2026-01-01T00:00:00.000Z');writeJob('b-tie','2026-01-02T00:00:00.000Z');writeJob('a-tie','2026-01-02T00:00:00.000Z');writeJob('aa-last','2026-01-03T00:00:00.000Z');
 const order:string[]=[];const q=new CodexBridgeQueue(dir,job=>({promise:(async()=>{order.push(job.id);})(),cancel:()=>{}}),{},()=>{});
 expect(q.list().map(j=>j.id)).toEqual(['zz-first','a-tie','b-tie','aa-last']);
 expect(q.page(2).jobs.map(j=>j.id)).toEqual(['aa-last','b-tie']);expect(q.page(2,2).jobs.map(j=>j.id)).toEqual(['a-tie','zz-first']);
 q.start();await tick();expect(order).toEqual(['zz-first','a-tie','b-tie','aa-last']);
});
test('quarantines corrupt sessions.json and job files instead of aborting startup',()=>{
 writeFileSync(join(dir,'sessions.json'),'{not json');writeFileSync(join(dir,'job-bad.json'),'{"id":');writeFileSync(join(dir,'job-evil.json'),JSON.stringify({...input('../x'),status:'queued',createdAt:'2026-01-01T00:00:00.000Z'}));writeJob('good','2026-01-01T00:00:00.000Z');
 const logs:string[]=[];const q=new CodexBridgeQueue(dir,()=>({promise:new Promise(()=>{}),cancel:()=>{}}),{},m=>logs.push(m));
 expect(q.list().map(j=>j.id)).toEqual(['good']);expect(logs).toHaveLength(3);
 for(const f of ['sessions.json','job-bad.json','job-evil.json']){expect(existsSync(join(dir,f))).toBe(false);expect(existsSync(join(dir,f+'.corrupt'))).toBe(true);}
});
test('retention prunes old/excess terminal jobs but never queued or running work',()=>{
 const old=new Date(Date.now()-30*86400_000).toISOString();const recent=(n:number)=>new Date(Date.now()-n*1000).toISOString();
 writeJob('old-done','2026-01-01T00:00:00.000Z','completed',{finishedAt:old});writeJob('old-queued','2026-01-01T00:00:01.000Z','queued');
 for(let i=0;i<4;i++)writeJob('done-'+i,recent(100-i),'failed',{finishedAt:recent(50-i)});
 const q=new CodexBridgeQueue(dir,()=>({promise:new Promise(()=>{}),cancel:()=>{}}),{maxTerminalJobs:2,maxTerminalAgeMs:7*86400_000,maxJobs:4},()=>{});
 expect(q.list().map(j=>j.id).sort()).toEqual(['done-2','done-3','old-queued']);expect(existsSync(join(dir,'job-old-done.json'))).toBe(false);expect(existsSync(join(dir,'job-done-0.json'))).toBe(false);
 q.submit(input('n1'));expect(q.get('old-queued')?.status).toBe('running');expect(q.get('n1')?.status).toBe('queued');expect(()=>q.submit(input('n2'))).toThrow('storage limit');
});
