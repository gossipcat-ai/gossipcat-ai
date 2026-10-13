import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {spawn} from 'child_process';
import {acquireOwnerLock,parseLock,isLiveOwner,processStartTime} from '../../apps/cli/src/codex-bridge-lock';
let dir:string,lock:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'codex-lock-'));lock=join(dir,'owner.pid');});afterEach(()=>rmSync(dir,{recursive:true,force:true}));
test('parseLock accepts only positive integer pids and complete records',()=>{
 for(const bad of ['','  ','abc','0','-1','1.5','{"pid":0,"startedAt":"x","token":"t"}','{"pid":"12","startedAt":"x","token":"t"}','{"pid":12}'])expect(parseLock(bad)).toBeUndefined();
 expect(parseLock('42\n')).toEqual({pid:42});expect(parseLock('{"pid":7,"startedAt":"s","token":"t"}')).toEqual({pid:7,startedAt:'s',token:'t'});
});
test('acquires atomically with identity, blocks a live owner, releases only its own lock',()=>{
 const owner=acquireOwnerLock(lock);const record=JSON.parse(readFileSync(lock,'utf8'));
 expect(record).toEqual({pid:process.pid,startedAt:processStartTime(process.pid),token:owner.token});
 expect(()=>acquireOwnerLock(lock)).toThrow('already running');
 expect(readdirSync(dir).filter(n=>n.endsWith('.tmp'))).toEqual([]);
 writeFileSync(lock,JSON.stringify({...record,token:'someone-else'}));owner.release();expect(existsSync(lock)).toBe(true);
});
test('treats empty, invalid, dead and reused pids as stale',async()=>{
 const child=spawn('sleep',['30']);await new Promise(r=>child.once('spawn',r));const pid=child.pid!;
 try {
  expect(isLiveOwner({pid})).toBe(false); // legacy plain pid: live, but not a bridge process
  expect(isLiveOwner({pid,startedAt:'Mon Jan  1 00:00:00 2001',token:'t'})).toBe(false); // pid reused
  expect(isLiveOwner({pid,startedAt:processStartTime(pid),token:'t'})).toBe(true);
 } finally {child.kill('SIGKILL');}
 await new Promise(r=>child.once('exit',r));expect(isLiveOwner({pid,startedAt:'x',token:'t'})).toBe(false);
 for(const content of ['','not-a-pid','0',String(pid),JSON.stringify({pid:process.pid,startedAt:'Mon Jan  1 00:00:00 2001',token:'t'})]){
  writeFileSync(lock,content);const owner=acquireOwnerLock(lock);expect(JSON.parse(readFileSync(lock,'utf8')).token).toBe(owner.token);owner.release();expect(existsSync(lock)).toBe(false);
 }
});
