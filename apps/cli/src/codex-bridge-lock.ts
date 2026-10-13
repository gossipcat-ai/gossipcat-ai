import { readFileSync, writeFileSync, unlinkSync, linkSync } from 'fs';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';

/**
 * Single-owner lock for the Codex bridge daemon (`.gossip/codex-bridge/owner.pid`).
 *
 * Content is JSON `{pid, startedAt, token}`. A lock only blocks startup when its
 * pid is a live process whose identity matches: same `ps -o lstart=` start time
 * (or, for legacy plain-pid locks, a command line naming codex-bridge-server).
 * Empty, malformed, non-positive pids, dead pids, and pids reused by an
 * unrelated process after a reboot are all treated as stale.
 *
 * Acquisition is atomic: the full content is written to a private temp file
 * and then hard-linked into place, so the lock is never visible half-written
 * and `link` fails with EEXIST if another owner won the race.
 */
export interface OwnerLock { readonly token:string; release():void; }
interface LockRecord { pid:number; startedAt?:string; token?:string; }

function psField(pid:number, field:'lstart='|'command='):string|undefined {
  try {return execFileSync('ps',['-p',String(pid),'-o',field],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()||undefined;}
  catch {return undefined;}
}
export const processStartTime = (pid:number):string|undefined => psField(pid,'lstart=');

export function parseLock(text:string):LockRecord|undefined {
  const trimmed=text.trim();
  if(/^\d+$/.test(trimmed)){const pid=Number(trimmed);return Number.isSafeInteger(pid)&&pid>0?{pid}:undefined;}
  try {
    const value=JSON.parse(trimmed) as LockRecord;
    if(!value||!Number.isSafeInteger(value.pid)||value.pid<=0)return undefined;
    if(typeof value.startedAt!=='string'||typeof value.token!=='string')return undefined;
    return {pid:value.pid,startedAt:value.startedAt,token:value.token};
  } catch {return undefined;}
}

/** True only when the recorded owner is provably still the same live process. */
export function isLiveOwner(record:LockRecord|undefined):boolean {
  if(!record)return false;
  try {process.kill(record.pid,0);}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EPERM')return false;}
  if(record.startedAt!==undefined)return processStartTime(record.pid)===record.startedAt;
  return /codex-bridge-server/.test(psField(record.pid,'command=')||'');
}

function readLock(path:string):string|undefined {
  try {return readFileSync(path,'utf8');}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
}

export function acquireOwnerLock(path:string, pid=process.pid):OwnerLock {
  const token=randomBytes(16).toString('hex');
  const startedAt=processStartTime(pid);
  if(!startedAt)throw new Error('Codex bridge cannot determine its own process start time');
  const tmp=`${path}.${pid}.${token}.tmp`;
  writeFileSync(tmp,JSON.stringify({pid,startedAt,token}),{mode:0o600,flag:'wx'});
  try {
    for(let attempt=0;attempt<2;attempt++) {
      try {linkSync(tmp,path);break;}
      catch(e) {
        if((e as NodeJS.ErrnoException).code!=='EEXIST'||attempt>0)throw new Error('Codex bridge already running');
        const existing=readLock(path);
        if(existing!==undefined&&isLiveOwner(parseLock(existing)))throw new Error('Codex bridge already running');
        // Stale: remove only if nobody replaced it while we were checking.
        if(readLock(path)===existing){try {unlinkSync(path);}catch{/* raced; link retry decides */}}
      }
    }
  } finally {try {unlinkSync(tmp);}catch{/* already gone */}}
  return {token,release:()=>{
    try {const current=readLock(path);if(current!==undefined&&parseLock(current)?.token===token)unlinkSync(path);}
    catch {/* best-effort; a leftover lock is detected as stale next start */}
  }};
}
