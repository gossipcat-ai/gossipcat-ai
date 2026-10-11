import {mkdtempSync,rmSync,statSync} from 'fs';
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
