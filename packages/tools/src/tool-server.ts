import { GossipAgent } from '@gossip/client';
import { MessageType, MessageEnvelope, Message } from '@gossip/types';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { randomUUID } from 'crypto';
import { FileTools } from './file-tools';
import { ShellTools } from './shell-tools';
import { GitTools } from './git-tools';
import { SkillTools } from './skill-tools';
import { Sandbox } from './sandbox';
import { resolve, relative } from 'path';

export interface ToolServerConfig {
  relayUrl: string;
  projectRoot: string;
  agentId?: string;
  allowedCallers?: string[];  // If set, only these agent IDs can call tools
  perfWriter?: { appendSignal(signal: unknown): void };
}

function truncateAtLine(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.lastIndexOf('\n', maxLength);
  return text.slice(0, cut !== -1 ? cut : maxLength);
}

export class ToolServer {
  private agent: GossipAgent;
  private fileTools: FileTools;
  private shellTools: ShellTools;
  private gitTools: GitTools;
  private skillTools: SkillTools;
  private sandbox: Sandbox;
  private allowedCallers: Set<string> | null;
  private agentScopes: Map<string, string> = new Map();   // agentId → scope path
  private agentRoots: Map<string, string> = new Map();    // agentId → worktree root path
  private writeAgents: Set<string> = new Set();            // agents with any write mode active
  private pendingReviews: Map<string, { resolve: (r: string) => void; reject: (e: Error) => void }> = new Map();
  private agentWrittenFiles: Map<string, Set<string>> = new Map(); // agentId → written file paths
  private static readonly MAX_WRITTEN_FILES_PER_AGENT = 1024;
  private perfWriter?: { appendSignal(signal: unknown): void };

  constructor(config: ToolServerConfig) {
    this.allowedCallers = config.allowedCallers ? new Set(config.allowedCallers) : null;
    this.sandbox = new Sandbox(config.projectRoot);
    this.fileTools = new FileTools(this.sandbox);
    this.shellTools = new ShellTools();
    this.gitTools = new GitTools(config.projectRoot);
    this.skillTools = new SkillTools(config.projectRoot);
    this.perfWriter = config.perfWriter;
    this.agent = new GossipAgent({
      agentId: config.agentId || 'tool-server',
      relayUrl: config.relayUrl,
      reconnect: true
    });
  }

  async start(): Promise<void> {
    await this.agent.connect();
    this.agent.on('message', this.handleToolRequest.bind(this));
    this.agent.on('error', (err: Error) => console.error(`[ToolServer] Relay error: ${err.message}`));
    if (!this.allowedCallers) {
      console.warn('[ToolServer] WARNING: No allowedCallers configured — any relay agent can call any tool');
    }
  }

  async stop(): Promise<void> {
    await this.agent.disconnect();
  }

  get agentId(): string { return this.agent.agentId; }

  assignScope(agentId: string, scope: string): void {
    const normalized = scope.endsWith('/') ? scope : scope + '/';
    this.agentScopes.set(agentId, normalized);
    this.writeAgents.add(agentId);
  }

  assignRoot(agentId: string, root: string): void {
    this.agentRoots.set(agentId, root);
    this.writeAgents.add(agentId);
  }

  releaseAgent(agentId: string): void {
    this.agentScopes.delete(agentId);
    this.agentRoots.delete(agentId);
    this.writeAgents.delete(agentId);
    this.agentWrittenFiles.delete(agentId);
  }

  private async handleToolRequest(data: unknown, envelope: MessageEnvelope): Promise<void> {
    // Handle review responses from orchestrator
    if (envelope.t === MessageType.RPC_RESPONSE) {
      const correlationId = (envelope.rid_req || envelope.id) as string;
      const pending = this.pendingReviews.get(correlationId);
      if (pending) {
        this.pendingReviews.delete(correlationId);
        const payload = data as Record<string, unknown>;
        if (payload?.error) pending.reject(new Error(payload.error as string));
        else pending.resolve((payload?.result as string) || '');
      }
      return;
    }

    if (envelope.t !== MessageType.RPC_REQUEST) return;

    // Authorization: check if caller is allowed
    if (this.allowedCallers && !this.allowedCallers.has(envelope.sid)) {
      console.error(`[ToolServer] Unauthorized tool call from ${envelope.sid}`);
      return;
    }

    const payload = data as Record<string, unknown>;
    const toolName = payload?.tool as string;
    const args = (payload?.args || {}) as Record<string, unknown>;

    let result: string;
    let responsePayload: Record<string, unknown>;

    try {
      result = await this.executeTool(toolName, args, envelope.sid);
      responsePayload = { result };
    } catch (err) {
      responsePayload = { error: (err as Error).message };
    }

    // Send RPC_RESPONSE back to the requester.
    // Use envelope.rid_req (the caller's correlation ID) so the caller can
    // match the response to its pending promise.
    try {
      const body = Buffer.from(msgpackEncode(responsePayload)) as unknown as Uint8Array;
      const correlationId = (envelope.rid_req || envelope.id) as string;
      const response = Message.createRpcResponse(
        this.agent.agentId,
        envelope.sid,       // respond to the sender
        correlationId,      // echo caller's correlation ID
        body
      );
      await this.agent.sendEnvelope(response.toEnvelope());
    } catch (sendErr) {
      console.error('[ToolServer] Failed to send RPC_RESPONSE:', (sendErr as Error).message);
    }
  }

  private enforceWriteScope(toolName: string, args: Record<string, unknown>, callerId: string): void {
    const scope = this.agentScopes.get(callerId);
    const root = this.agentRoots.get(callerId);

    if (toolName === 'file_write') {
      const filePath = args.path as string;
      if (scope) {
        // Resolve path to prevent traversal attacks (e.g. 'packages/tools/../relay/evil.ts')
        const resolved = resolve(this.sandbox.projectRoot, filePath);
        const rel = relative(this.sandbox.projectRoot, resolved);
        if (rel.startsWith('..')) {
          throw new Error(`Write blocked: "${filePath}" resolves outside project root`);
        }
        const normalizedRel = rel.endsWith('/') ? rel : rel + '/';
        if (!normalizedRel.startsWith(scope)) {
          throw new Error(`Write blocked: "${filePath}" is outside scope "${scope}"`);
        }
      }
      if (root) {
        const resolved = resolve(root, filePath);
        if (!resolved.startsWith(root)) {
          throw new Error(`Write blocked: "${filePath}" is outside worktree root "${root}"`);
        }
      }
    }

    if (toolName === 'shell_exec') {
      // Allow ONLY read-only git commands for scoped agents
      if (scope) {
        const cmd = (args.command as string || '').trim();
        const isReadOnlyGit = /^git\s+(status|diff|log|show)\b/.test(cmd);
        if (!isReadOnlyGit) {
          throw new Error('shell_exec is restricted in scoped write mode. Only git status/diff/log/show are allowed. Use run_tests and run_typecheck for verification.');
        }
        // Block git flags that can write files or redirect exec
        if (/--(?:output|exec-path)[=\s]/i.test(cmd)) {
          throw new Error('shell_exec: --output and --exec-path flags are not permitted in scoped mode');
        }
      }
      // Worktree agents: block dangerous patterns
      if (root) {
        const fullCmd = [args.command as string, ...((args.args as string[]) || [])].join(' ');
        const blockedPatterns = [
          /\.git\/hooks/i,
          /\.git\/config/i,
          /core\.hookspath/i,
          /\.\.\//,
        ];
        for (const pattern of blockedPatterns) {
          if (pattern.test(fullCmd)) {
            throw new Error(`Shell command blocked for write-mode agent: matches ${pattern}`);
          }
        }
      }
    }

    if (toolName === 'file_delete') {
      const filePath = args.path as string;
      if (scope) {
        const resolved = resolve(this.sandbox.projectRoot, filePath);
        const rel = relative(this.sandbox.projectRoot, resolved);
        if (rel.startsWith('..')) {
          throw new Error(`Delete blocked: "${filePath}" resolves outside project root`);
        }
        const normalizedRel = rel.endsWith('/') ? rel : rel + '/';
        if (!normalizedRel.startsWith(scope)) {
          throw new Error(`Delete blocked: "${filePath}" is outside scope "${scope}"`);
        }
      }
      if (root) {
        const resolved = resolve(root, filePath);
        if (!resolved.startsWith(root)) {
          throw new Error(`Delete blocked: "${filePath}" is outside worktree root "${root}"`);
        }
      }
    }

    if (toolName === 'git_commit') {
      // Scoped agents: block git commit (they write files, main orchestrator commits)
      if (scope) {
        throw new Error('Git commit blocked for scoped write agents');
      }
      // Worktree agents: allow (they commit in their worktree)
    }

    if (toolName === 'git_branch') {
      if (scope) {
        throw new Error('Git branch blocked for scoped write agents');
      }
    }
  }

  async executeTool(name: string, args: Record<string, unknown>, callerId?: string): Promise<string> {
    // Fail-closed: write agents with no registered scope/root are rejected
    if (callerId && this.writeAgents.has(callerId)) {
      if (!this.agentScopes.has(callerId) && !this.agentRoots.has(callerId)) {
        throw new Error(`Agent ${callerId} is a write agent but has no scope/root registered — rejecting (fail-closed)`);
      }
      const writableTools = ['file_write', 'file_delete', 'shell_exec', 'git_commit', 'git_branch'];
      if (writableTools.includes(name)) {
        this.enforceWriteScope(name, args, callerId);
      }
    }

    // Per-agent root for worktree isolation
    const agentRoot = callerId ? this.agentRoots.get(callerId) : undefined;

    switch (name) {
      case 'file_read':
        return this.fileTools.fileRead(args as { path: string; startLine?: number; endLine?: number });
      case 'file_write': {
        // Check cap BEFORE write to avoid write-success-with-false-error
        if (callerId) {
          if (!this.agentWrittenFiles.has(callerId)) this.agentWrittenFiles.set(callerId, new Set());
          const tracked = this.agentWrittenFiles.get(callerId)!;
          if (tracked.size >= ToolServer.MAX_WRITTEN_FILES_PER_AGENT && !tracked.has(args.path as string)) {
            throw new Error(`Agent ${callerId} exceeded max tracked file writes (${ToolServer.MAX_WRITTEN_FILES_PER_AGENT})`);
          }
        }
        const result = await this.fileTools.fileWrite(args as { path: string; content: string });
        if (callerId) {
          this.agentWrittenFiles.get(callerId)!.add(args.path as string);
        }
        return result;
      }
      case 'file_delete':
        return this.fileTools.fileDelete(args as { path: string });
      case 'file_search':
        return this.fileTools.fileSearch(args as { pattern: string });
      case 'file_grep':
        return this.fileTools.fileGrep(args as { pattern: string; path?: string });
      case 'file_tree':
        return this.fileTools.fileTree(args as { path?: string; depth?: number });
      case 'shell_exec':
        return this.shellTools.shellExec({
          ...(args as { command: string; timeout?: number }),
          cwd: agentRoot || this.sandbox.projectRoot
        });
      case 'git_status':
        return agentRoot ? new GitTools(agentRoot).gitStatus() : this.gitTools.gitStatus();
      case 'git_diff':
        return agentRoot ? new GitTools(agentRoot).gitDiff(args as { staged?: boolean }) : this.gitTools.gitDiff(args as { staged?: boolean });
      case 'git_log':
        return agentRoot ? new GitTools(agentRoot).gitLog(args as { count?: number }) : this.gitTools.gitLog(args as { count?: number });
      case 'git_commit':
        return agentRoot ? new GitTools(agentRoot).gitCommit(args as { message: string; files?: string[] }) : this.gitTools.gitCommit(args as { message: string; files?: string[] });
      case 'git_branch':
        return agentRoot ? new GitTools(agentRoot).gitBranch(args as { name?: string }) : this.gitTools.gitBranch(args as { name?: string });
      case 'suggest_skill':
        return this.skillTools.suggestSkill(
          args as { skill_name: string; reason: string; task_context: string },
          callerId
        );
      case 'verify_write':
        return this.handleVerifyWrite(callerId || 'unknown', args.test_file as string | undefined);
      case 'run_tests':
        return this.handleRunTests(args as { fileGlob: string }, callerId);
      case 'run_typecheck':
        return this.handleRunTypecheck(callerId);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async handleVerifyWrite(callerId: string, testFile?: string): Promise<string> {
    // 1. Capture git diff scoped to files the agent actually wrote (avoids noisy unrelated changes)
    const writtenFiles = this.agentWrittenFiles.get(callerId);
    const scope = this.agentScopes.get(callerId);
    const paths = writtenFiles?.size ? [...writtenFiles] : scope ? [scope] : undefined;
    let fullDiff = '';
    try {
      const diff = await this.gitTools.gitDiff({ staged: false, paths });
      const staged = await this.gitTools.gitDiff({ staged: true, paths });
      // Include untracked (new) files — git diff doesn't show them
      const untracked = paths ? await this.gitTools.gitUntrackedDiff(paths) : '';
      fullDiff = [diff, staged, untracked].filter(Boolean).join('\n');
    } catch {
      // Silently skip — git diff can fail on new projects with no commits,
      // untracked directories, or other edge cases. Not critical for verify_write.
    }

    if (!fullDiff.trim()) {
      return 'No changes detected. Nothing to verify.';
    }

    // 2. Run tests — validate testFile is a safe file path (not a CLI flag or config override)
    if (testFile) {
      if (testFile.startsWith('-')) {
        throw new Error(`verify_write: test_file must be a file path, not a flag: "${testFile}"`);
      }
      this.sandbox.validatePath(testFile);
      if (/\.(js|json)$/i.test(testFile) && !testFile.includes('.test.') && !testFile.includes('.spec.')) {
        throw new Error(`verify_write: test_file must be a test file (.test.ts/.spec.ts), got: "${testFile}"`);
      }
    }
    const testArgs = ['jest', '--config', 'jest.config.base.js'];
    if (testFile) testArgs.push(testFile);
    testArgs.push('--verbose');
    let testResult: string;
    try {
      testResult = await this.shellTools.shellExec({ command: 'npx', args: testArgs, cwd: this.sandbox.projectRoot, timeout: 30000 });
    } catch (err) {
      testResult = `Tests failed: ${(err as Error).message}`;
    }

    // 3. Request peer review via RPC (best-effort)
    let reviewResult = '';
    try {
      reviewResult = await this.requestPeerReview(callerId, fullDiff, testResult);
    } catch (err) {
      reviewResult = `Peer review unavailable: ${(err as Error).message}`;
    }

    // Emit impl signals
    const testStatus = testResult.includes('FAIL') ? 'FAIL' : 'PASS';
    if (this.perfWriter) {
      const now = new Date().toISOString();
      this.perfWriter.appendSignal({
        type: 'impl',
        signal: testStatus === 'PASS' ? 'impl_test_pass' : 'impl_test_fail',
        agentId: callerId,
        taskId: callerId,
        evidence: testStatus === 'FAIL' ? testResult.slice(-500) : undefined,
        timestamp: now,
      });

      if (reviewResult && !reviewResult.includes('unavailable')) {
        const approved = !reviewResult.toLowerCase().includes('reject') && !reviewResult.toLowerCase().includes('fail');
        this.perfWriter.appendSignal({
          type: 'impl',
          signal: approved ? 'impl_peer_approved' : 'impl_peer_rejected',
          agentId: callerId,
          taskId: callerId,
          evidence: reviewResult.slice(0, 500),
          timestamp: now,
        });
      }
    }

    // 4. Format result
    return `## Verification Result\n\n### Tests: ${testStatus}\n${testResult.slice(-2000)}\n\n### Peer Review\n${reviewResult || 'No reviewer available'}\n\n### Diff Summary\n${truncateAtLine(fullDiff, 3000)}`;
  }

  private async requestPeerReview(callerId: string, diff: string, testResult: string): Promise<string> {
    const requestId = randomUUID();

    const reviewPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReviews.delete(requestId);
        reject(new Error('Review timed out'));
      }, 55_000);
      timer.unref();

      this.pendingReviews.set(requestId, {
        resolve: (r: string) => { clearTimeout(timer); resolve(r); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      });
    });

    try {
      const body = Buffer.from(msgpackEncode({
        tool: 'review_request',
        args: { callerId, diff: truncateAtLine(diff, 3000), testResult: truncateAtLine(testResult, 1000) },
      })) as unknown as Uint8Array;
      const msg = Message.createRpcRequest(this.agent.agentId, 'orchestrator', requestId, body);
      await this.agent.sendEnvelope(msg.toEnvelope());
    } catch (err) {
      // Clean up pending review if send fails
      const pending = this.pendingReviews.get(requestId);
      if (pending) {
        this.pendingReviews.delete(requestId);
        pending.reject(err as Error);
      }
    }

    return reviewPromise;
  }

  private async handleRunTests(args: { fileGlob: string }, callerId?: string): Promise<string> {
    const { fileGlob } = args;

    // Validate: no path traversal
    if (fileGlob.includes('../')) {
      throw new Error('run_tests: fileGlob must not contain path traversal (../)');
    }
    // Validate: block ALL flags — whitespace splitting could turn embedded flags into real jest args
    if (/\s-/.test(fileGlob) || fileGlob.startsWith('-')) {
      throw new Error('run_tests: fileGlob must not contain flags. Pass only file paths/globs.');
    }

    const scope = callerId ? this.agentScopes.get(callerId) : undefined;
    const cwd = scope
      ? this.sandbox.validatePath(resolve(this.sandbox.projectRoot, scope))
      : this.sandbox.projectRoot;

    let output: string;
    let success: boolean;
    try {
      // Pass fileGlob as args[] element — prevents whitespace splitting into separate jest flags
      output = await this.shellTools.shellExec({
        command: 'npx',
        args: ['jest', fileGlob, '--no-coverage', '--passWithNoTests', '--no-cache'],
        cwd,
        timeout: 60000,
      });
      success = true;
    } catch (err) {
      output = (err as Error).message;
      success = false;
    }

    const truncated = output.length > 4000 ? output.slice(output.length - 4000) : output;
    return JSON.stringify({ success, output: truncated });
  }

  private async handleRunTypecheck(callerId?: string): Promise<string> {
    const scope = callerId ? this.agentScopes.get(callerId) : undefined;
    const cwd = scope
      ? this.sandbox.validatePath(resolve(this.sandbox.projectRoot, scope))
      : this.sandbox.projectRoot;

    let output: string;
    let success: boolean;
    try {
      // Pin --project to root tsconfig — prevents agent-written tsconfig.json with malicious plugins
      const tsconfigPath = resolve(this.sandbox.projectRoot, 'tsconfig.json');
      output = await this.shellTools.shellExec({
        command: 'npx',
        args: ['tsc', '--noEmit', '--project', tsconfigPath],
        cwd,
        timeout: 120000,
      });
      success = true;
    } catch (err) {
      output = (err as Error).message;
      success = false;
    }

    return JSON.stringify({ success, output });
  }
}
