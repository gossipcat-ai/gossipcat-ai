import { mkdirSync, existsSync, readFileSync, readdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { TaskStreamEvent } from './task-stream';

export interface BridgeInput { id:string; agentId:string; task:string; context?:string; promptContent?:string; instructions:string; }
export interface BridgeJob extends BridgeInput { digest:string; status:'queued'|'running'|'completed'|'failed'; createdAt:string; finishedAt?:string; progress?:string; threadId?:string; processId?:number; processStartedAt?:string; terminal?:TaskStreamEvent; }
export type BridgeRunner = (job:BridgeJob, threadId:string|undefined, emit:(event:TaskStreamEvent)=>void) => {promise:Promise<void>; cancel:(reason:string)=>void};
export interface BridgeRetention {
  /** Terminal jobs finished longer ago than this are deleted. Default 14 days. */
  maxTerminalAgeMs?:number;
  /** At most this many terminal jobs are kept (oldest deleted first). Default 500. */
  maxTerminalJobs?:number;
  /** Hard cap on stored jobs once pruning cannot free space (all live). Default 5000. */
  maxJobs?:number;
}
const safeId = (value:unknown): value is string => typeof value==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const STATUSES = new Set(['queued','running','completed','failed']);
const isTerminal = (job:BridgeJob) => job.status==='completed'||job.status==='failed';
/** FIFO order: createdAt, then id as a deterministic tie-break. */
const byCreated = (a:BridgeJob, b:BridgeJob) => a.createdAt<b.createdAt?-1:a.createdAt>b.createdAt?1:a.id<b.id?-1:a.id>b.id?1:0;
const finishedMs = (job:BridgeJob) => Date.parse(job.finishedAt||job.createdAt)||0;

function validStoredJob(job:unknown): job is BridgeJob {
  const j = job as BridgeJob;
  return !!j && typeof j==='object' && safeId(j.id) && safeId(j.agentId) && STATUSES.has(j.status)
    && typeof j.createdAt==='string' && !Number.isNaN(Date.parse(j.createdAt));
}

/** Single-owner persistent queue. Running jobs are never blindly replayed. */
export class CodexBridgeQueue {
  private jobs=new Map<string,BridgeJob>();
  private sessions:Record<string,string>={};
  private active?:{job:BridgeJob; cancel:(reason:string)=>void};
  private draining=false;
  private halted=false;
  private readonly retention:Required<BridgeRetention>;
  constructor(private readonly dir:string, private readonly runner:BridgeRunner, retention:BridgeRetention={}, private readonly log:(msg:string)=>void=msg=>console.error(msg)) {
    this.retention={maxTerminalAgeMs:14*24*3600_000,maxTerminalJobs:500,maxJobs:5000,...retention};
    mkdirSync(dir,{recursive:true,mode:0o700});
    this.loadSessions();
    const loaded:BridgeJob[]=[];
    for(const name of readdirSync(dir).filter(n=>n.startsWith('job-')&&n.endsWith('.json'))) {
      const job=this.readJob(name);
      if(job)loaded.push(job);
    }
    // readdir order is filesystem-defined; restore FIFO so drain() and
    // conversation views see oldest→newest regardless of on-disk order.
    loaded.sort(byCreated);
    for(const job of loaded) {
      if(job.status==='running') {
        try {if(job.processId && job.processStartedAt && execFileSync('ps',['-p',String(job.processId),'-o','lstart='],{encoding:'utf8'}).trim()===job.processStartedAt)process.kill(-job.processId,'SIGKILL');}catch{}
        job.status='failed';job.finishedAt=new Date().toISOString();job.terminal={type:'error' as any,payload:{error:'Bridge restarted during execution; task was not retried automatically'},timestamp:Date.now()};this.save(job); }
      this.jobs.set(job.id,job);
    }
    this.prune();
  }
  /** Move an unreadable file aside so one bad record cannot block startup. */
  private quarantine(path:string, error:unknown):void {
    const target=path+'.corrupt';
    try {renameSync(path,existsSync(target)?target+'-'+Date.now():target);}catch{/* leave in place; it is skipped either way */}
    this.log(`Codex bridge: quarantined unreadable ${path} (${(error as Error).message})`);
  }
  private loadSessions():void {
    const path=join(this.dir,'sessions.json');if(!existsSync(path))return;
    try {
      const parsed=JSON.parse(readFileSync(path,'utf8'));
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('not an object');
      for(const [agent,thread] of Object.entries(parsed))if(safeId(agent)&&typeof thread==='string')this.sessions[agent]=thread;
    } catch(e) {this.quarantine(path,e);}
  }
  private readJob(name:string):BridgeJob|undefined {
    const path=join(this.dir,name);
    try {
      const job:unknown=JSON.parse(readFileSync(path,'utf8'));
      if(!validStoredJob(job)||name!=='job-'+job.id+'.json')throw new Error('invalid stored bridge job');
      return job;
    } catch(e) {this.quarantine(path,e);return undefined;}
  }
  private atomic(path:string, value:unknown):void {
    const tmp=path+'.tmp';const fd=openSync(tmp,'w',0o600);
    try {writeSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);
  }
  private save(job:BridgeJob):void {this.atomic(join(this.dir,'job-'+job.id+'.json'),job);}
  /**
   * Retention: delete terminal jobs older than maxTerminalAgeMs and, beyond
   * maxTerminalJobs, the oldest-finished ones. Queued/running jobs are never
   * touched. A pruned task ID is forgotten, so resubmitting it runs again.
   */
  prune(now=Date.now()):number {
    const terminal=[...this.jobs.values()].filter(isTerminal).sort((a,b)=>finishedMs(a)-finishedMs(b));
    const excess=terminal.length-this.retention.maxTerminalJobs;
    let removed=0;
    terminal.forEach((job,index)=>{
      if(index>=excess&&now-finishedMs(job)<=this.retention.maxTerminalAgeMs)return;
      try {unlinkSync(join(this.dir,'job-'+job.id+'.json'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')return;}
      this.jobs.delete(job.id);removed++;
    });
    return removed;
  }
  submit(input:BridgeInput):BridgeJob {
    if(!safeId(input.id)||!safeId(input.agentId)||typeof input.task!=='string'||!input.task.trim()||typeof input.instructions!=='string'||(input.context!==undefined&&typeof input.context!=='string')||(input.promptContent!==undefined&&typeof input.promptContent!=='string'))throw new Error('Invalid bridge task');
    const digest=createHash('sha256').update(JSON.stringify([input.agentId,input.task,input.context||'',input.promptContent||'',input.instructions])).digest('hex');
    const previous=this.jobs.get(input.id);
    if(previous){if(previous.digest!==digest)throw new Error('Task ID already belongs to a different payload');return previous;}
    this.prune();
    if(this.jobs.size>=this.retention.maxJobs)throw new Error('Bridge queue storage limit reached: too many queued/running jobs');
    // Keep FIFO even if the wall clock steps backwards between submissions.
    const last=[...this.jobs.values()].pop();
    let createdAt=new Date().toISOString();if(last&&createdAt<last.createdAt)createdAt=last.createdAt;
    const job:BridgeJob={id:input.id,agentId:input.agentId,task:input.task,context:input.context,promptContent:input.promptContent,instructions:input.instructions,digest,status:'queued',createdAt};
    this.save(job);this.jobs.set(job.id,job);this.kick();return job;
  }
  get(id:string):BridgeJob|undefined {if(!safeId(id))throw new Error('Invalid task ID');return this.jobs.get(id);}
  /** All jobs, oldest first (FIFO). */
  list():BridgeJob[] {return [...this.jobs.values()];}
  /** Newest-first page for listing endpoints; callers must not return full results. */
  page(limit:number, offset=0):{total:number; jobs:BridgeJob[]} {
    const all=this.list();const end=Math.max(0,all.length-offset);
    return {total:all.length,jobs:all.slice(Math.max(0,end-limit),end).reverse()};
  }
  start():void {this.kick();}
  cancel(id:string, reason='Cancelled by user'):void {
    const job=this.get(id);if(!job)throw new Error('Unknown bridge task');
    if(isTerminal(job))return;
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
