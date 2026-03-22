import { GossipAgent } from '@gossip/client';
import { MessageType, MessageEnvelope, Message } from '@gossip/types';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { FileTools } from './file-tools';
import { ShellTools } from './shell-tools';
import { GitTools } from './git-tools';
import { SkillTools } from './skill-tools';
import { Sandbox } from './sandbox';

export interface ToolServerConfig {
  relayUrl: string;
  projectRoot: string;
  agentId?: string;
  allowedCallers?: string[];  // If set, only these agent IDs can call tools
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

  constructor(config: ToolServerConfig) {
    this.allowedCallers = config.allowedCallers ? new Set(config.allowedCallers) : null;
    this.sandbox = new Sandbox(config.projectRoot);
    this.fileTools = new FileTools(this.sandbox);
    this.shellTools = new ShellTools();
    this.gitTools = new GitTools(config.projectRoot);
    this.skillTools = new SkillTools(config.projectRoot);
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
  }

  private async handleToolRequest(data: unknown, envelope: MessageEnvelope): Promise<void> {
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
        // Normalize: append '/' so 'packages/relay' becomes 'packages/relay/'
        // This prevents 'packages/relay2' matching scope 'packages/relay/'
        // But also allows writing to the scope directory itself
        const pathWithSlash = filePath.endsWith('/') ? filePath : filePath + '/';
        if (!pathWithSlash.startsWith(scope)) {
          throw new Error(`Write blocked: "${filePath}" is outside scope "${scope}"`);
        }
      }
      if (root && !filePath.startsWith(root)) {
        throw new Error(`Write blocked: "${filePath}" is outside worktree root "${root}"`);
      }
    }

    if (toolName === 'shell_exec') {
      // Block shell entirely for scoped agents (can't constrain arbitrary commands)
      if (scope) {
        throw new Error('Shell execution blocked for scoped write agents');
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
      const writableTools = ['file_write', 'shell_exec', 'git_commit', 'git_branch'];
      if (writableTools.includes(name)) {
        this.enforceWriteScope(name, args, callerId);
      }
    }

    // Per-agent root for worktree isolation
    const agentRoot = callerId ? this.agentRoots.get(callerId) : undefined;

    switch (name) {
      case 'file_read':
        return this.fileTools.fileRead(args as { path: string; startLine?: number; endLine?: number });
      case 'file_write':
        return this.fileTools.fileWrite(args as { path: string; content: string });
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
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
