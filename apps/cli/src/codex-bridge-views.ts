import type { BridgeJob } from '@gossip/orchestrator';

/**
 * Response shapes for the bridge socket. Listing endpoints must stay well under
 * the client's 8MB response cap (codex-bridge-client.ts), so they never carry
 * full task payloads or full terminal results. GET /jobs/:id is the only route
 * that returns a complete result.
 */
export const JOBS_PAGE_DEFAULT=50;
export const JOBS_PAGE_MAX=200;
export const CONVERSATION_LIMIT=100;
/** 100 entries x (task + result + progress) at 16KB each stays < 5MB. */
export const CONVERSATION_FIELD_MAX=16_000;

const clip=(text:string|undefined,max:number)=>text===undefined||text.length<=max?text:text.slice(0,max)+`\n…[truncated ${text.length-max} chars; fetch /jobs/<id> for the full text]`;
const source=(job:BridgeJob)=>job.id.startsWith('chat-')?'user':'claude';

/** Full job minus private dispatch inputs (per-job GET). */
export function publicJob(job:BridgeJob, includeTask=false) {
  const {task,context,promptContent,instructions,digest,...publicFields}=job;
  return {...publicFields,...(includeTask?{task}:{}),source:source(job)};
}

/** Bounded metadata for listings: no task, progress or result text. */
export function jobSummary(job:BridgeJob) {
  const payload=job.terminal?.payload as {error?:unknown;result?:unknown}|undefined;
  return {id:job.id,agentId:job.agentId,status:job.status,createdAt:job.createdAt,finishedAt:job.finishedAt,threadId:job.threadId,source:source(job),
    hasResult:typeof payload?.result==='string',
    ...(typeof payload?.error==='string'?{error:clip(payload.error,500)}:{})};
}

/** Chat-timeline entry: task/progress/result included but clipped. */
export function conversationJob(job:BridgeJob) {
  const view=publicJob(job,true);
  const payload=job.terminal?.payload as Record<string,unknown>|undefined;
  const terminal=job.terminal&&payload?{...job.terminal,payload:{
    ...(typeof payload.result==='string'?{result:clip(payload.result,CONVERSATION_FIELD_MAX)}:{}),
    ...(typeof payload.error==='string'?{error:clip(payload.error,CONVERSATION_FIELD_MAX)}:{}),
  }}:job.terminal;
  return {...view,task:clip(job.task,CONVERSATION_FIELD_MAX),progress:clip(job.progress,CONVERSATION_FIELD_MAX),terminal};
}

export function parsePage(params:URLSearchParams):{limit:number;offset:number} {
  const num=(name:string,fallback:number)=>{const raw=params.get(name);if(raw===null)return fallback;if(!/^\d{1,6}$/.test(raw))throw new Error('Invalid '+name);return Number(raw);};
  return {limit:Math.min(Math.max(num('limit',JOBS_PAGE_DEFAULT),1),JOBS_PAGE_MAX),offset:num('offset',0)};
}
