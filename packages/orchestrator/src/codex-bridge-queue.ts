import { mkdirSync, existsSync, readFileSync, readdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { TaskStreamEvent } from './task-stream';

export interface BridgeInput { id:string; agentId:string; task:string; context?:string; promptContent?:string; instructions:string; }
export interface BridgeJob extends BridgeInput { digest:string; status:'queued'|'running'|'completed'|'failed'; createdAt:string; finishedAt?:string; progress?:string; threadId?:string; processId?:number; processStartedAt?:string; terminal?:TaskStreamEvent; }
export type BridgeRunner = (job:BridgeJob, threadId:string|undefined, emit:(event:TaskStreamEvent)=>void) => {promise:Promise<void>; cancel:(reason:string)=>void};
const safeId = (value:unknown): value is string => typeof value==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

/** Single-owner persistent queue. Running jobs are never blindly replayed. */
export class CodexBridgeQueue {
  private jobs=new Map<string,BridgeJob>();
  private sessions:Record<string,string>={};
  private active?:{job:BridgeJob; cancel:(reason:string)=>void};
  private draining=false;
  private halted=false;
  constructor(private readonly dir:string, private readonly runner:BridgeRunner) {
    mkdirSync(dir,{recursive:true,mode:0o700});
    const sessions=join(dir,'sessions.json');if(existsSync(sessions))this.sessions=JSON.parse(readFileSync(sessions,'utf8'));
    for(const name of readdirSync(dir).filter(n=>n.startsWith('job-')&&n.endsWith('.json'))) {
      const job:BridgeJob=JSON.parse(readFileSync(join(dir,name),'utf8'));
      if(!safeId(job.id)||!safeId(job.agentId))throw new Error('Invalid stored bridge job');
      if(job.status==='running') {
        try {if(job.processId && job.processStartedAt && execFileSync('ps',['-p',String(job.processId),'-o','lstart='],{encoding:'utf8'}).trim()===job.processStartedAt)process.kill(-job.processId,'SIGKILL');}catch{}
        job.status='failed';job.finishedAt=new Date().toISOString();job.terminal={type:'error' as any,payload:{error:'Bridge restarted during execution; task was not retried automatically'},timestamp:Date.now()};this.save(job); }
      this.jobs.set(job.id,job);
    }
  }
  private atomic(path:string, value:unknown):void {
    const tmp=path+'.tmp';const fd=openSync(tmp,'w',0o600);
    try {writeSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);
  }
  private save(job:BridgeJob):void {this.atomic(join(this.dir,'job-'+job.id+'.json'),job);}
  submit(input:BridgeInput):BridgeJob {
    if(!safeId(input.id)||!safeId(input.agentId)||typeof input.task!=='string'||!input.task.trim()||typeof input.instructions!=='string'||(input.context!==undefined&&typeof input.context!=='string')||(input.promptContent!==undefined&&typeof input.promptContent!=='string'))throw new Error('Invalid bridge task');
    const digest=createHash('sha256').update(JSON.stringify([input.agentId,input.task,input.context||'',input.promptContent||'',input.instructions])).digest('hex');
    const previous=this.jobs.get(input.id);
    if(previous){if(previous.digest!==digest)throw new Error('Task ID already belongs to a different payload');return previous;}
    if(this.jobs.size>=5000)throw new Error('Bridge queue storage limit reached; archive completed jobs before adding more');
    const job:BridgeJob={...input,digest,status:'queued',createdAt:new Date().toISOString()};this.save(job);this.jobs.set(job.id,job);this.kick();return job;
  }
  get(id:string):BridgeJob|undefined {if(!safeId(id))throw new Error('Invalid task ID');return this.jobs.get(id);}
  list():BridgeJob[] {return [...this.jobs.values()];}
  start():void {this.kick();}
  cancel(id:string, reason='Cancelled by user'):void {
    const job=this.get(id);if(!job)throw new Error('Unknown bridge task');
    if(job.status==='completed'||job.status==='failed')return;
    if(this.active?.job.id===id)this.active.cancel(reason);
    job.status='failed';job.finishedAt=new Date().toISOString();job.terminal={type:'error' as any,payload:{error:reason},timestamp:Date.now()};this.save(job);
  }
  shutdown():void {this.halted=true;if(this.active)this.cancel(this.active.job.id,'Bridge service stopped during execution; task was not retried automatically');}
  private kick():void {if(!this.draining&&!this.halted)void this.drain();}
  private async drain():Promise<void> {
    this.draining=true;
    try {
      while(!this.halted) {
        const job=this.list().find(j=>j.status==='queued');if(!job)break;
        job.status='running';this.save(job);
        try {
          const run=this.runner(job,this.sessions[job.agentId],event=>{
            if(event.type==='partial_result'&&job.status==='running'&&typeof event.payload?.result==='string'){job.progress=event.payload.result.slice(0,64000);this.save(job);}
            if(event.type==='log'&&typeof event.payload==='string') {try {const e=JSON.parse(event.payload);if(e.processId){job.processId=e.processId;job.processStartedAt=e.processStartedAt;this.save(job);}if(e.threadId){job.threadId=e.threadId;this.sessions[job.agentId]=e.threadId;this.atomic(join(this.dir,'sessions.json'),this.sessions);}}catch {/* non-metadata log */}}
            if((event.type==='final_result'||event.type==='error')&&job.status==='running'){
              job.terminal=event;job.status=event.type==='final_result'?'completed':'failed';job.finishedAt=new Date().toISOString();this.save(job);
            }
          });
          this.active={job,cancel:run.cancel};await run.promise;
          if(job.status==='running')throw new Error('Worker ended without terminal result');
        } catch(e) {if(job.status==='running'){job.status='failed';job.finishedAt=new Date().toISOString();job.terminal={type:'error' as any,payload:{error:(e as Error).message},timestamp:Date.now()};this.save(job);}}
        finally {this.active=undefined;}
      }
    } finally {this.draining=false;}
  }
}
