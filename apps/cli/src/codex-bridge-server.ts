import { startSharedChatWeb } from './shared-chat-web';
import { createServer } from 'http';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, openSync, closeSync, realpathSync, lstatSync } from 'fs';
import { join, resolve } from 'path';
import { CodexBridgeQueue, BridgeJob } from '../../../packages/orchestrator/src/codex-bridge-queue';
import { codexBridgeSocket } from '../../../packages/orchestrator/src/codex-bridge-client';
import { CodexWorker } from '../../../packages/orchestrator/src/codex-worker';

const root=realpathSync(resolve(process.argv[2] || process.cwd()));
const dir=join(root,'.gossip','codex-bridge');mkdirSync(dir,{recursive:true,mode:0o700});
const lock=join(dir,'owner.pid');
if(existsSync(lock)) {
 const pid=Number(readFileSync(lock,'utf8'));let alive=false;try {process.kill(pid,0);alive=true;}catch(e){if((e as NodeJS.ErrnoException).code==='EPERM')alive=true;}
 if(alive)throw new Error('Codex bridge already running');unlinkSync(lock);
}
const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);
const socket=codexBridgeSocket(root);const socketDir=join('/tmp','gossipcat-codex-'+process.getuid?.());if(!existsSync(socketDir))mkdirSync(socketDir,{mode:0o700});const st=lstatSync(socketDir);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.())throw new Error('Invalid bridge socket directory');chmodSync(socketDir,0o700);if(existsSync(socket))unlinkSync(socket);
const queue=new CodexBridgeQueue(dir,(job,threadId,emit)=>{
 const worker=new CodexWorker(job.agentId,job.instructions,undefined,300_000,threadId,true);
 return {promise:(async()=>{for await(const event of worker.executeTask(job.task,job.context,job.promptContent,job.id,undefined,root))emit(event);})(),cancel:reason=>worker.cancelTask(job.id,reason)};
});
function publicJob(job:BridgeJob, includeTask=false) {const {task,context,promptContent,instructions,digest,...publicFields}=job;return {...publicFields,...(includeTask?{task}:{}),source:job.id.startsWith('chat-')?'user':'claude'};}
const web = process.env.GOSSIP_CODEX_WEB === '0' ? undefined : startSharedChatWeb(root);
const server=createServer(async(req,res)=>{
 const json=(status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 try {
  if(req.headers.origin){json(403,{error:'Browser access is not allowed'});return;}
  const path=req.url||'';
  if(req.method==='GET'&&path==='/health'){json(200,{ok:true,pid:process.pid,root,model:'gpt-6.1-sol',jobs:queue.list().length});return;}
  if(req.method==='GET'&&path==='/jobs'){json(200,queue.list().map(job=>publicJob(job)));return;}
  if(req.method==='GET'&&path==='/conversation'){json(200,queue.list().slice(-100).map(job=>publicJob(job,true)));return;}
  const match=path.match(/^\/jobs\/([a-zA-Z0-9_-]{1,128})(\/cancel)?$/);
  if(match&&req.method==='GET'&&!match[2]){const job=queue.get(match[1]);json(job?200:404,job?publicJob(job):{error:'Unknown bridge task'});return;}
  if(match&&req.method==='POST'&&match[2]){let text='';for await(const chunk of req){text+=chunk;if(text.length>1024)throw new Error('Cancel payload too large');}const reason=text?JSON.parse(text).reason:undefined;if(reason && !['Cancelled by user','collect timeout','Codex task timeout'].includes(reason))throw new Error('Invalid cancellation reason');queue.cancel(match[1],reason);json(200,{ok:true});return;}
  if(req.method==='POST'&&path==='/jobs') {
   let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>1024*1024){json(413,{error:'Task payload limit exceeded'});return;}}
   const input=JSON.parse(text);const config=JSON.parse(readFileSync(join(root,'.gossip','config.json'),'utf8'));
   if(!config.agents?.[input.agentId]?.codexCli){json(403,{error:'Agent is not configured as a Codex CLI worker'});return;}
   const job=queue.submit(input);json(202,publicJob(job));return;
  }
  json(404,{error:'Unknown bridge endpoint'});
 } catch(e){json(400,{error:(e as Error).message});}
});
server.headersTimeout=10_000;server.requestTimeout=15_000;
server.on('error',error=>{if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);console.error('Codex bridge socket error: '+error.message);process.exit(1);});
server.listen(socket,()=>{chmodSync(socket,0o600);writeFileSync(join(dir,'enabled'),'1\n',{mode:0o600});queue.start();console.log('Codex bridge ready for '+root);});
const shutdown=()=>{web?.close();queue.shutdown();server.close(()=>{if(existsSync(socket))unlinkSync(socket);if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);process.exit(0);});setTimeout(()=>process.exit(0),3000).unref();};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
