import { mkdtempSync, writeFileSync, rmSync, mkdirSync, appendFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { codexBridgeRequest } from './codex-bridge-client';
import { spawn, execFileSync } from 'child_process';
import { TaskStreamEvent, TaskStreamEventType as T } from './task-stream';

/**
 * Environment allowlist for the Codex child (B7). Codex authenticates from its
 * own ChatGPT login under CODEX_HOME (default ~/.codex), so it needs HOME /
 * CODEX_HOME, PATH (to locate helpers), locale + temp + terminal basics, and
 * network/TLS settings for corporate proxies. Everything else from the Claude
 * host — API keys, tokens, provider config — is deliberately NOT inherited.
 */
const CODEX_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'CODEX_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CODEX_CA_CERTIFICATE'];
export function codexChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (CODEX_ENV_KEYS.includes(key) || key.startsWith('LC_'))) env[key] = value;
  }
  return env;
}

/** ChatGPT-authenticated CLI worker. Deliberately read-only; no API fallback. */
export class CodexWorker {
  private active = new Map<string, (reason: string) => void>();
  constructor(private readonly agentId: string, private instructions = '', private readonly executable = process.env.GOSSIP_CODEX_BIN || (process.platform === 'darwin' && existsSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex') ? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex' : 'codex'), private readonly timeoutMs = 300_000, private readonly resumeThreadId?: string, private readonly forceLocal = false) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> { for (const cancel of this.active.values()) cancel('Worker stopped'); }
  setInstructions(text: string): void { this.instructions = text; }
  getInstructions(): string { return this.instructions; }
  async subscribeToBatch(_id: string): Promise<void> {}
  async unsubscribeFromBatch(_id: string): Promise<void> {}
  cancelTask(id: string, reason: string): void { this.active.get(id)?.(reason); }
  validateDispatch(options?: { writeMode?: string; images?: string[] }): void {
    if (options?.writeMode) throw new Error('Codex CLI supports read-only tasks only; write_mode is unsupported');
    if (options?.images?.length) throw new Error('Codex CLI task images are unsupported');
  }
  async *executeTask(task: string, context?: string, promptContent?: string, taskId?: string, images?: string[], projectRoot?: string): AsyncGenerator<TaskStreamEvent, void, undefined> {
    const event = (type: T, payload: unknown): TaskStreamEvent => ({ type, payload, timestamp: Date.now() });
    if (!taskId || !projectRoot || this.active.has(taskId)) { yield event(T.ERROR, { error: 'Codex requires unique task ID and project root' }); return; }
    try { this.validateDispatch({ images }); } catch (e) { yield event(T.ERROR, { error: (e as Error).message }); return; }
    if (!this.forceLocal && existsSync(join(projectRoot, '.gossip', 'codex-bridge', 'enabled'))) {
      let cancelled = '', detached = false;
      this.active.set(taskId, reason => {
        if (reason === 'Worker stopped') { detached = true; return; }
        cancelled = reason;
        void codexBridgeRequest(projectRoot!, 'POST', '/jobs/' + taskId + '/cancel', {reason}).catch(() => {});
      });
      try {
        await codexBridgeRequest(projectRoot, 'POST', '/jobs', {id:taskId,agentId:this.agentId,task,context,promptContent,instructions:this.instructions});
        yield event(T.LOG, `Persistent Codex bridge accepted ${taskId}`);
        while (!detached) {
          const job = await codexBridgeRequest(projectRoot, 'GET', '/jobs/' + taskId);
          if (job.terminal) { yield job.terminal; return; }
          if (cancelled) await codexBridgeRequest(projectRoot, 'POST', '/jobs/' + taskId + '/cancel', {reason:cancelled});
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        yield event(T.ERROR, {error:'MCP detached; task remains in the persistent bridge queue'});
      } catch(e) { yield event(T.ERROR, {error:`Persistent Codex bridge: ${(e as Error).message}`}); }
      finally {this.active.delete(taskId);}
      return;
    }
    // Exclude user MCP servers/hooks/providers/policies; retain existing auth
    // and project AGENTS.md. Never inherit API keys from the Claude host.
    const schemaDir = mkdtempSync(join(tmpdir(), 'gossip-codex-schema-'));
    const schemaPath = join(schemaDir, 'result.json');
    writeFileSync(schemaPath, JSON.stringify({type:'object',properties:{status:{type:'string',enum:['completed','failed']},result:{type:'string'}},required:['status','result'],additionalProperties:false}), {mode:0o600});
    const args = ['exec', '--output-schema', schemaPath, '--ignore-user-config', '--skip-git-repo-check', '--model', 'gpt-6.1-sol', '--sandbox', 'read-only', '--json', '--color', 'never', '-c', 'approval_policy="never"', '-C', projectRoot];
    if (this.resumeThreadId) args.push('resume', this.resumeThreadId);
    args.push('-');
    const child = spawn(this.executable, args, { cwd: projectRoot, env: codexChildEnv(), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let reason = '', threadId = '', failure = '', buffer = '', result = '';
    let inputTokens = 0, outputTokens = 0, toolCalls = 0, completed = false, bytes = 0;
    let hardKill: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* exited */ }
    };
    const cancel = (message: string) => {
      if (reason) return; reason = message; kill('SIGTERM');
      hardKill = setTimeout(() => kill('SIGKILL'), 1000); hardKill.unref();
    };
    this.active.set(taskId, cancel);
    const timer = setTimeout(() => cancel('Codex task timeout'), this.timeoutMs);
    const updates:ReturnType<typeof event>[]=[];
    const parse = (line: string) => {
      if (!line.trim()) return;
      let data: any; try { data = JSON.parse(line); } catch { failure = 'Invalid Codex JSON event'; cancel(failure); return; }
      if (data.type === 'thread.started') {threadId = data.thread_id;updates.push(event(T.LOG,JSON.stringify({threadId})));updates.push(event(T.PARTIAL_RESULT,{result:'Codex oturumu görevi aldı; yanıt hazırlanıyor…'}));}
      if (data.type === 'turn.completed') { completed = true; inputTokens = data.usage?.input_tokens || 0; outputTokens = data.usage?.output_tokens || 0; }
      if (data.type === 'turn.failed' || data.type === 'error') failure = data.error?.message || data.message || 'Codex turn failed';
      if (data.type === 'item.completed' && data.item?.type === 'agent_message') {result = data.item.text;try{const parsed=JSON.parse(result);if(typeof parsed.result==='string')updates.push(event(T.PARTIAL_RESULT,{result:parsed.result}));}catch{ /* structured output may be incomplete */ }};
      if (data.type === 'item.completed' && data.item?.type === 'command_execution') toolCalls++;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk); if (bytes > 32 * 1024 * 1024) { cancel('Codex event output limit exceeded'); return; }
      buffer += chunk;
      let end: number; while ((end = buffer.indexOf('\n')) >= 0) { parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    child.stderr.on('data', () => {}); // Drain, never log raw diagnostics/credentials.
    child.stdin.on('error', () => {});
    const closed = new Promise<number | null>(resolve => {
      child.once('error', err => { failure = `Codex process error: ${err.message}`; });
      child.once('close', code => resolve(code));
    });
    child.stdin.end(`Gossipcat agent_id=${this.agentId}, task_id=${taskId}. Required model: gpt-6.1-sol.\nRead-only. Follow project AGENTS.md. Return schema status failed if you cannot complete the task or access required source; completed only for verified results. Never modify files, send messages or delegate. Cite real file:line references.\nAgent instructions:\n${this.instructions}\nDispatch instructions/skills:\n${promptContent || ''}\nContext:\n${context || ''}\nTask:\n${task}`);
    let processStartedAt='';
    try {if(child.pid)processStartedAt=execFileSync('ps',['-p',String(child.pid),'-o','lstart='],{encoding:'utf8'}).trim();}catch{}
    yield event(T.LOG, JSON.stringify({agentId:this.agentId,taskId,processId:child.pid,processStartedAt}));
    yield event(T.LOG, `Codex started: agent=${this.agentId} task=${taskId} model=gpt-6.1-sol cwd=${projectRoot}`);
    try {
      let ended=false;void closed.then(()=>{ended=true;});while(!ended){while(updates.length)yield updates.shift()!;await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,100))]);}while(updates.length)yield updates.shift()!;
      const code = await closed; if (buffer) parse(buffer);
      const evidence = { agentId: this.agentId, taskId, threadId, model: 'gpt-6.1-sol', cwd: projectRoot, exitCode: code };
      yield event(T.LOG, JSON.stringify(evidence));
      let outcome: {status?: string; result?: string} = {};
      try { outcome = JSON.parse(result); } catch { failure = failure || 'Codex returned invalid structured task result'; }
      if (outcome.status === 'failed') failure = outcome.result || 'Codex task failed';
      const valid = !reason && !failure && code === 0 && completed && threadId && outcome.status === 'completed' && typeof outcome.result === 'string' && outcome.result;
      try {
        mkdirSync(join(projectRoot, '.gossip'), {recursive:true});
        appendFileSync(join(projectRoot, '.gossip', 'codex-runs.jsonl'), JSON.stringify({...evidence,status:valid ? 'completed' : 'failed',timestamp:new Date().toISOString()}) + '\n', {mode:0o600});
      } catch { /* result remains available even if audit storage is unwritable */ }

      if (reason || failure || code !== 0 || !completed || !threadId || outcome.status !== 'completed' || typeof outcome.result !== 'string' || !outcome.result) {
        yield event(T.ERROR, { error: reason || failure || `Codex incomplete/failed (exit ${code})`, evidence });
      } else yield event(T.FINAL_RESULT, { result: outcome.result, inputTokens, outputTokens, toolCalls, evidence, memoryQueryCalled: false });
    } finally {
      rmSync(schemaDir, {recursive:true,force:true});
      clearTimeout(timer); if (hardKill) clearTimeout(hardKill); this.active.delete(taskId);
      if (child.exitCode === null && child.signalCode === null) kill('SIGKILL');
    }
  }
}
