import { GossipAgent } from '@gossip/client';
import { MessageType, MessageEnvelope, Message } from '@gossip/types';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { randomUUID } from 'crypto';
import { FileTools } from './file-tools';
import { ShellTools } from './shell-tools';
import { GitTools } from './git-tools';
import { SkillTools } from './skill-tools';
import { Sandbox } from './sandbox';
import { isKnownTool, validateToolArgs } from './tool-schemas';
import { resolve } from 'path';
import { canonicalizeForBoundary, validatePathInScope } from './scope';

/**
 * Structural shape of MemorySearcher from @gossip/orchestrator. Defined here as
 * a structural type rather than a value import to avoid the orchestrator→tools
 * circular dependency. Inject the real MemorySearcher instance from the MCP
 * boot path; both gossip_remember and memory_query then call the same backend.
 */
export interface MemorySearcherLike {
  search(agentId: string, query: string, maxResults?: number): Array<{
    source: string;
    name: string;
    description: string;
    score: number;
    snippets: string[];
  }>;
}

/** Identity record returned by self_identity and injected into prompts at dispatch. */
export interface AgentIdentity {
  agent_id: string;
  runtime: 'native' | 'relay';
  provider: string;
  model: string;
}

/** Lookup callback wired by the MCP boot path; tool-server uses it for self_identity. */
export type AgentLookup = (agentId: string) => AgentIdentity | undefined;

/**
 * Render an AgentIdentity as a markdown ## Identity block. Used by both the
 * native dispatch path (dispatch.ts) and the relay worker bootstrap so every
 * agent sees the same shape at the top of its system prompt.
 *
 * Includes a ready-to-copy memory recall example with the literal agent_id
 * pre-substituted. Without this, agents have been observed inventing an
 * agent_id from their role description (e.g. "senior-reviewer" from "You are
 * a senior code reviewer") instead of using the actual string from the block.
 */
export function formatIdentityBlock(identity: AgentIdentity): string {
  const base = `## Identity\nagent_id: ${identity.agent_id}\nruntime: ${identity.runtime}\nprovider: ${identity.provider}\nmodel: ${identity.model}\n`;
  const example = identity.runtime === 'native'
    ? `\nYour agent_id is \`${identity.agent_id}\`. When a tool asks for an agent_id, use this exact string — it identifies you in the memory store and the consensus signal pipeline. Role descriptions like "senior reviewer" are not your agent_id.\n\nExample memory recall:\n  mcp__gossipcat__gossip_remember(agent_id: "${identity.agent_id}", query: "<topic>")\n`
    : `\nYour agent_id is \`${identity.agent_id}\`. Role descriptions like "senior reviewer" are not your agent_id — the literal string above is. For relay tools, your identity travels with the relay message automatically, so you do not pass agent_id as an argument.\n\nExample memory recall:\n  memory_query(query: "<topic>")\n`;
  return base + example;
}

export interface ToolServerConfig {
  relayUrl: string;
  projectRoot: string;
  agentId?: string;
  allowedCallers?: string[];  // If set, only these agent IDs can call tools
  apiKey?: string;            // Relay auth key — must match the relay's configured key
  perfWriter?: { appendSignal(signal: unknown): void };
  memorySearcher?: MemorySearcherLike;  // Injected from MCP boot path for memory_query
  agentLookup?: AgentLookup;             // Injected from MCP boot path for self_identity
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
  private memorySearcher?: MemorySearcherLike;
  private agentLookup?: AgentLookup;

  constructor(config: ToolServerConfig) {
    this.allowedCallers = config.allowedCallers ? new Set(config.allowedCallers) : null;
    this.sandbox = new Sandbox(config.projectRoot);
    this.fileTools = new FileTools(this.sandbox);
    this.shellTools = new ShellTools();
    this.gitTools = new GitTools(config.projectRoot);
    this.skillTools = new SkillTools(config.projectRoot);
    this.perfWriter = config.perfWriter;
    this.memorySearcher = config.memorySearcher;
    this.agentLookup = config.agentLookup;
    this.agent = new GossipAgent({
      agentId: config.agentId || 'tool-server',
      relayUrl: config.relayUrl,
      apiKey: config.apiKey,
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
    // Canonicalize (symlink-resolve, case-fold, trailing-slash) so all four
    // guard sites can do a plain startsWith check against the stored value.
    const abs = resolve(this.sandbox.projectRoot, scope);
    this.agentScopes.set(agentId, canonicalizeForBoundary(abs));
    this.writeAgents.add(agentId);
  }

  assignRoot(agentId: string, root: string): void {
    const abs = resolve(root);
    this.agentRoots.set(agentId, canonicalizeForBoundary(abs));
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
        // canonicalizeForBoundary resolves symlinks, case-folds on
        // case-insensitive filesystems, and appends a trailing slash so
        // sibling-prefix bypass is impossible. scope is already canonical.
        const canonical = canonicalizeForBoundary(resolve(this.sandbox.projectRoot, filePath));
        if (!validatePathInScope(scope, canonical)) {
          throw new Error(`Write blocked: "${filePath}" is outside scope "${scope}"`);
        }
      }
      if (root) {
        const canonical = canonicalizeForBoundary(resolve(root, filePath));
        if (!validatePathInScope(root, canonical)) {
          throw new Error(`Write blocked: "${filePath}" is outside worktree root "${root}"`);
        }
      }
    }

    if (toolName === 'shell_exec') {
      // Allow ONLY read-only git commands for scoped agents
      if (scope) {
        // Join command + args[] so flag injection via args array is also caught (fix #7)
        const fullCmd = [args.command as string || '', ...((args.args as string[]) || [])].join(' ').trim();
        const isReadOnlyGit = /^git\s+(status|diff|log|show)\b/.test(fullCmd);
        if (!isReadOnlyGit) {
          throw new Error('shell_exec is restricted in scoped write mode. Only git status/diff/log/show are allowed. Use run_tests and run_typecheck for verification.');
        }
        // Block git flags that can write files or redirect exec
        if (/--(?:output|exec-path)[=\s]/i.test(fullCmd)) {
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
        const canonical = canonicalizeForBoundary(resolve(this.sandbox.projectRoot, filePath));
        if (!validatePathInScope(scope, canonical)) {
          throw new Error(`Delete blocked: "${filePath}" is outside scope "${scope}"`);
        }
      }
      if (root) {
        // Match file_write hardening: resolve symlinks + trailing-slash guard
        // so planted symlinks and sibling-prefix roots cannot escape.
        const canonical = canonicalizeForBoundary(resolve(root, filePath));
        if (!validatePathInScope(root, canonical)) {
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
    // Runtime arg validation per consensus a8911b95:f1 — every dispatched tool
    // gets its args parsed by a Zod schema before any handler sees them, so
    // missing fields, wrong types, and oversized payloads fail fast at the
    // entry point instead of crashing inside an `as` cast.
    if (!isKnownTool(name)) {
      throw new Error(`Unknown tool: ${name}`);
    }
    args = validateToolArgs(name, args);

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
      case 'file_read': {
        // For scoped agents, restrict reads to within their assigned scope
        const readScope = callerId ? this.agentScopes.get(callerId) : undefined;
        if (readScope) {
          // canonicalizeForBoundary follows symlinks so a planted symlink
          // inside scope cannot redirect the read to an out-of-scope target.
          const canonical = canonicalizeForBoundary(resolve(this.sandbox.projectRoot, args.path as string));
          if (!validatePathInScope(readScope, canonical)) {
            throw new Error(`Read blocked: "${args.path}" is outside scope "${readScope}"`);
          }
        }
        return this.fileTools.fileRead(args as { path: string; startLine?: number; endLine?: number }, agentRoot);
      }
      case 'file_write': {
        // Check cap BEFORE write to avoid write-success-with-false-error
        if (callerId) {
          if (!this.agentWrittenFiles.has(callerId)) this.agentWrittenFiles.set(callerId, new Set());
          const tracked = this.agentWrittenFiles.get(callerId)!;
          if (tracked.size >= ToolServer.MAX_WRITTEN_FILES_PER_AGENT && !tracked.has(args.path as string)) {
            throw new Error(`Agent ${callerId} exceeded max tracked file writes (${ToolServer.MAX_WRITTEN_FILES_PER_AGENT})`);
          }
        }
        const result = await this.fileTools.fileWrite(args as { path: string; content: string }, agentRoot);
        if (callerId) {
          this.agentWrittenFiles.get(callerId)!.add(args.path as string);
        }
        return result;
      }
      case 'file_delete':
        return this.fileTools.fileDelete(args as { path: string }, agentRoot);
      case 'file_search':
        return this.fileTools.fileSearch(args as { pattern: string }, agentRoot);
      case 'file_grep':
        return this.fileTools.fileGrep(args as { pattern: string; path?: string }, agentRoot);
      case 'file_tree':
        return this.fileTools.fileTree(args as { path?: string; depth?: number }, agentRoot);
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
      case 'memory_query':
        return this.handleMemoryQuery(args as { query: string; max_results?: number | string }, callerId);
      case 'self_identity':
        return this.handleSelfIdentity(callerId);
      default:
        // Unreachable: isKnownTool gate at the top of executeTool rejects
        // unknown names before validation. Kept for type-narrowing.
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * memory_query — return the calling agent's own archived knowledge in the
   * same markdown shape that gossip_remember produces. Scope is always the
   * caller (envelope.sid via allowedCallers gate); cross-agent recall has no
   * code path. Output format mirrors mcp-server-sdk.ts:2662-2673 exactly so
   * citation patterns roundtrip between native and relay agents.
   */
  private async handleMemoryQuery(
    args: { query: string; max_results?: number | string },
    callerId?: string,
  ): Promise<string> {
    if (!this.memorySearcher) {
      return 'memory_query unavailable: tool-server has no memorySearcher injected.';
    }
    if (!callerId) {
      return 'memory_query requires a caller identity (envelope.sid). Refusing.';
    }
    const query = (args.query || '').toString();
    if (!query.trim()) return 'memory_query requires a non-empty query string.';
    const maxRaw = args.max_results;
    const max = typeof maxRaw === 'string' ? parseInt(maxRaw, 10) : (typeof maxRaw === 'number' ? maxRaw : 3);
    const maxResults = Number.isFinite(max) && max > 0 ? Math.min(max, 10) : 3;
    const results = this.memorySearcher.search(callerId, query, maxResults);
    if (results.length === 0) {
      return `No knowledge found for agent "${callerId}" matching query: "${query}"`;
    }
    const lines: string[] = [`Knowledge search results for agent "${callerId}" (query: "${query}"):\n`];
    for (const r of results) {
      lines.push(`## ${r.name} (score: ${r.score.toFixed(2)})`);
      lines.push(`Source: ${r.source}`);
      if (r.description) lines.push(`Description: ${r.description}`);
      if (r.snippets.length > 0) {
        lines.push('Snippets:');
        for (const s of r.snippets) lines.push(`  - ${s}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * self_identity — return the calling agent's runtime identity. Always
   * resolves the callerId from envelope.sid (never trusts a body field), so
   * agents cannot impersonate each other to read foreign identity. Falls back
   * to a minimal record when no agentLookup is wired.
   */
  private async handleSelfIdentity(callerId?: string): Promise<string> {
    if (!callerId) {
      return JSON.stringify({ error: 'self_identity requires a caller identity (envelope.sid)' });
    }
    if (!this.agentLookup) {
      return JSON.stringify({ agent_id: callerId, runtime: 'relay', provider: 'unknown', model: 'unknown', note: 'tool-server has no agentLookup injected' });
    }
    const identity = this.agentLookup(callerId);
    if (!identity) {
      return JSON.stringify({ agent_id: callerId, runtime: 'relay', provider: 'unknown', model: 'unknown', note: 'no registry entry' });
    }
    return JSON.stringify(identity);
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
      // Distinct per-signal timestamps so the test signal and the peer-review signal
      // are deterministically ordered (test result happens before peer review).
      const baseMs = Date.now();
      this.perfWriter.appendSignal({
        type: 'impl',
        signal: testStatus === 'PASS' ? 'impl_test_pass' : 'impl_test_fail',
        agentId: callerId,
        taskId: callerId,
        evidence: testStatus === 'FAIL' ? testResult.slice(-500) : undefined,
        timestamp: new Date(baseMs).toISOString(),
      });

      if (reviewResult && !reviewResult.includes('unavailable')) {
        const approved = !reviewResult.toLowerCase().includes('reject') && !reviewResult.toLowerCase().includes('fail');
        this.perfWriter.appendSignal({
          type: 'impl',
          signal: approved ? 'impl_peer_approved' : 'impl_peer_rejected',
          agentId: callerId,
          taskId: callerId,
          evidence: reviewResult.slice(0, 500),
          timestamp: new Date(baseMs + 1).toISOString(),
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

    // Validate: no path traversal — resolve and check boundary instead of string-contains
    // (string-contains '../' is bypassable via %2e%2e/ or unicode variants) (fix #8)
    const resolvedGlob = resolve(this.sandbox.projectRoot, fileGlob.replace(/\*/g, '_'));
    if (!resolvedGlob.startsWith(this.sandbox.projectRoot)) {
      throw new Error('run_tests: fileGlob must not contain path traversal');
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
