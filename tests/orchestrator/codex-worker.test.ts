import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CodexWorker } from '../../packages/orchestrator/src/codex-worker';
import { configToAgentConfigs, validateConfig } from '../../apps/cli/src/config';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gossip-codex-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function fake(code: string) { const path = join(root, 'codex'); writeFileSync(path, '#!/usr/bin/env node\n' + code, { mode: 0o755 }); return path; }
async function run(worker: CodexWorker) { const events = []; for await (const e of worker.executeTask('inspect', 'context', 'skills', 'task-1', undefined, root)) events.push(e); return events; }
const success = `console.log(JSON.stringify({type:'thread.started',thread_id:'thread-1'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'completed',result:'file.ts:12 explanation'})}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:3}}));`;
test('isolates auth, passes model/cwd/context and returns mapped result', async () => {
 const cli = fake(`let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{require('fs').writeFileSync('capture.json',JSON.stringify({args:process.argv.slice(2),input,key:process.env.OPENAI_API_KEY}));${success}});`);
 const prior = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'not-a-real-secret';
 try {
 const events = await run(new CodexWorker('codex-sol', 'instructions', cli));
 expect(events.at(-1)).toMatchObject({type:'final_result',payload:{result:'file.ts:12 explanation',inputTokens:2,outputTokens:3,evidence:{agentId:'codex-sol',taskId:'task-1',threadId:'thread-1',model:'gpt-6.1-sol',cwd:root}}});
 const captured = JSON.parse(readFileSync(join(root,'capture.json'),'utf8'));
 expect(captured.key).toBeUndefined(); expect(captured.args).toContain('read-only'); expect(captured.args).toContain('gpt-6.1-sol'); expect(captured.input).toContain('context'); expect(captured.input).toContain('skills');
 } finally { if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior; }
});
test('nonzero exit cannot turn a completed event into success', async () => { expect((await run(new CodexWorker('a','',fake(success+'process.exit(9);')))).at(-1)?.type).toBe('error'); });
test('turn failure returns task error', async () => { expect((await run(new CodexWorker('a','',fake(`console.log(JSON.stringify({type:'turn.failed',error:{message:'model unavailable'}}));`)))).at(-1)).toMatchObject({type:'error',payload:{error:'model unavailable'}}); });
test('spawn failure returns task error', async () => { expect((await run(new CodexWorker('a','',join(root,'missing')))).at(-1)?.type).toBe('error'); });
test('timeout kills process and reports failure', async () => { expect((await run(new CodexWorker('a','',fake('setInterval(()=>{},1000);'),100))).at(-1)).toMatchObject({type:'error',payload:{error:'Codex task timeout'}}); });
test('cancellation terminates in-flight task', async () => {
 const w = new CodexWorker('a','',fake('setInterval(()=>{},1000);'));
 const it = w.executeTask('inspect','','','task-1',undefined,root); await it.next(); w.cancelTask('task-1','Cancelled by user');
 const events=[]; for await (const e of it) events.push(e); expect(events.at(-1)).toMatchObject({type:'error',payload:{error:'Cancelled by user'}});
});
test('rejects writes and images before launching', () => { const w=new CodexWorker('a'); expect(()=>w.validateDispatch({writeMode:'scoped'})).toThrow('read-only'); expect(()=>w.validateDispatch({images:['a.png']})).toThrow('unsupported'); });
test('config validates exact model and preserves native agents', () => {
 const c:any={main_agent:{provider:'none',model:'none'},agents:{claude:{provider:'anthropic',model:'claude-sonnet-4-6',native:true,skills:["research"]},codex:{provider:'openai',model:'gpt-6.1-sol',codexCli:true,skills:["research"]}}};
 validateConfig(c); expect(configToAgentConfigs(c).find(a=>a.id==='codex')?.codexCli).toBe(true); expect(c.agents.claude.native).toBe(true);
 c.agents.codex.model='gpt-6-sol'; expect(()=>validateConfig(c)).toThrow('gpt-6.1-sol');
});

test('pipeline forwards cancellation and does not resurrect a cancelled task', async () => {
 const { DispatchPipeline } = require('../../packages/orchestrator/src/dispatch-pipeline');
 let release!: () => void; const gate = new Promise<void>(r=>release=r);
 const worker = { cancelTask: jest.fn(() => release()), executeTask: async function* () { await gate; yield {type:'final_result',payload:{result:'late',inputTokens:0,outputTokens:0},timestamp:Date.now()}; } };
 const p = new DispatchPipeline({projectRoot:root,workers:new Map([['a',worker]]),registryGet:()=>({id:'a',provider:'openai',model:'gpt-6.1-sol',skills:['research']})});
 const dispatched=p.dispatch('a','inspect'); p.cancelRunningTasks(); await dispatched.finalResultPromise.catch(()=>{});
 expect(worker.cancelTask).toHaveBeenCalledWith(dispatched.taskId,'Cancelled by user'); expect(p.getTask(dispatched.taskId)?.status).toBe('failed');
});
test('pipeline rejects a prohibited mode before spawning', () => {
 const { DispatchPipeline } = require('../../packages/orchestrator/src/dispatch-pipeline');
 const p = new DispatchPipeline({projectRoot:root,workers:new Map([['a',new CodexWorker('a')]]),registryGet:()=>({id:'a',provider:'openai',model:'gpt-6.1-sol',skills:['research']})});
 expect(()=>p.dispatch('a','write',{writeMode:'worktree'})).toThrow('read-only');
});

test('model-reported task failure is not successful completion', async () => {
 const output = `console.log(JSON.stringify({type:'thread.started',thread_id:'thread-1'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'failed',result:'source inaccessible'})}}));console.log(JSON.stringify({type:'turn.completed'}));`;
 expect((await run(new CodexWorker('a','',fake(output)))).at(-1)).toMatchObject({type:'error',payload:{error:'source inaccessible'}});
});
