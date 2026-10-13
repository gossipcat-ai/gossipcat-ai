import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join,resolve} from 'path';
import {spawn,execFileSync,ChildProcess} from 'child_process';
import {codexBridgeRequest} from '../../packages/orchestrator/src/codex-bridge-client';
let root:string,bundle:string,server:ChildProcess,fake:string;
async function start():Promise<ChildProcess>{
 const child=spawn(process.execPath,[bundle,root],{env:{...process.env,GOSSIP_CODEX_BIN:fake,GOSSIP_CODEX_WEB:'0',NODE_PATH:resolve('node_modules')},stdio:['ignore','pipe','pipe']});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server startup timeout')),5000);child.stdout!.on('data',x=>{if(String(x).includes('ready')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('server exit '+code));});});return child;
}
async function stop(child:ChildProcess){await new Promise<void>(r=>{child.once('exit',()=>r());child.kill('SIGTERM');});}
async function wait(id:string){for(let i=0;i<100;i++){const job=await codexBridgeRequest(root,'GET','/jobs/'+id);if(job.terminal)return job;await new Promise(r=>setTimeout(r,20));}throw new Error('job timeout');}
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),'codex-server-'));bundle=join(root,'server.js');
 execFileSync(resolve('node_modules/.bin/esbuild'),[resolve('apps/cli/src/codex-bridge-server.ts'),'--bundle','--platform=node','--target=node22','--external:re2','--external:bufferutil','--external:utf-8-validate','--outfile='+bundle,'--tsconfig='+resolve('tsconfig.json')],{stdio:'pipe'});
 mkdirSync(join(root,'.gossip'));writeFileSync(join(root,'.gossip','config.json'),JSON.stringify({agents:{'codex-sol':{codexCli:true}}}));
 fake=join(root,'fake-codex');writeFileSync(fake,`#!/usr/bin/env node\nrequire('fs').appendFileSync('argv.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');process.stdin.resume();process.stdin.on('end',()=>{for(const e of [{type:'thread.started',thread_id:'thread-persisted'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'completed',result:'verified result'})}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:2}}])console.log(JSON.stringify(e));});`,{mode:0o755});
 server=await start();
});
afterEach(async()=>{if(server&&server.exitCode===null)await stop(server);rmSync(root,{recursive:true,force:true});});
test('HTTP queue survives actual restart, resumes thread, and deduplicates tasks',async()=>{
 const input={id:'one',agentId:'codex-sol',task:'inspect',instructions:'read only'};
 await codexBridgeRequest(root,'POST','/jobs',input);expect((await wait('one')).status).toBe('completed');
 const conversation=await codexBridgeRequest(root,'GET','/conversation');expect(conversation[0].task).toBe('inspect');expect(conversation[0].instructions).toBeUndefined();expect(conversation[0].context).toBeUndefined();
 const metadata=await codexBridgeRequest(root,'GET','/jobs/one');expect(metadata.task).toBeUndefined();
 await stop(server);server=await start();
 const stored=await codexBridgeRequest(root,'POST','/jobs',input);expect(stored.status).toBe('completed');
 await codexBridgeRequest(root,'POST','/jobs',{...input,id:'two'});expect((await wait('two')).threadId).toBe('thread-persisted');
 const calls=readFileSync(join(root,'argv.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));expect(calls).toHaveLength(2);expect(calls[1]).toContain('resume');expect(calls[1]).toContain('thread-persisted');expect(calls[1]).toContain('read-only');
});
test('duplicate daemon cannot take ownership of the live queue',async()=>{
 const second=spawn(process.execPath,[bundle,root],{env:{...process.env,GOSSIP_CODEX_BIN:fake,GOSSIP_CODEX_WEB:'0',NODE_PATH:resolve('node_modules')},stdio:'ignore'});
 const code=await new Promise<number|null>(r=>second.once('exit',r));expect(code).not.toBe(0);
 const health=await codexBridgeRequest(root,'GET','/health');expect(health.pid).toBe(server.pid);expect(JSON.parse(readFileSync(join(root,'.gossip/codex-bridge/owner.pid'),'utf8')).pid).toBe(server.pid);
});
test('rejects unconfigured agents and returns explicit missing-task errors',async()=>{
 await expect(codexBridgeRequest(root,'POST','/jobs',{id:'one',agentId:'unknown',task:'inspect',instructions:''})).rejects.toThrow('not configured');
 await expect(codexBridgeRequest(root,'GET','/jobs/missing')).rejects.toThrow('Unknown bridge task');
});
test('GET /jobs is a bounded summary page; per-job GET keeps the full result',async()=>{
 const input={id:'one',agentId:'codex-sol',task:'inspect',instructions:'read only'};
 await codexBridgeRequest(root,'POST','/jobs',input);await wait('one');
 const page=await codexBridgeRequest(root,'GET','/jobs?limit=1');expect(page).toMatchObject({total:1,limit:1,offset:0});
 expect(page.jobs[0]).toMatchObject({id:'one',status:'completed',hasResult:true});expect(page.jobs[0].terminal).toBeUndefined();expect(page.jobs[0].task).toBeUndefined();
 expect((await codexBridgeRequest(root,'GET','/jobs/one')).terminal.payload.result).toBe('verified result');
 await expect(codexBridgeRequest(root,'GET','/jobs?limit=abc')).rejects.toThrow('Invalid limit');
});
test('stale or reused-pid owner locks do not block startup',async()=>{
 await stop(server);const lock=join(root,'.gossip/codex-bridge/owner.pid');
 for(const content of ['', 'garbage', '-5', JSON.stringify({pid:process.pid,startedAt:'Thu Jan  1 00:00:00 1970',token:'old'})]){
  writeFileSync(lock,content);server=await start();expect(JSON.parse(readFileSync(lock,'utf8')).pid).toBe(server.pid);await stop(server);
 }
 server=await start();
});
