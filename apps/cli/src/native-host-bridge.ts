/**
 * Host-aware native agent dispatch bridge.
 * Claude Code uses Agent(); Cursor uses Task(subagent_type, ...).
 */

export type NativeHost = 'claude-code' | 'cursor' | 'other';

export function detectNativeHost(): NativeHost {
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_ENTRYPOINT) {
    return 'claude-code';
  }
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_SESSION_ID || process.env.CURSOR) {
    return 'cursor';
  }
  return 'other';
}

export function supportsNativeAgents(host: NativeHost = detectNativeHost()): boolean {
  return host === 'claude-code' || host === 'cursor';
}

export function nativeAgentDir(host: NativeHost = detectNativeHost()): string | null {
  if (host === 'claude-code') return '.claude/agents';
  if (host === 'cursor') return '.claude/agents'; // shared markdown defs; Cursor Task maps by agent id
  return null;
}

export function nativeToolName(host: NativeHost = detectNativeHost()): 'Agent' | 'Task' {
  return host === 'cursor' ? 'Task' : 'Agent';
}

export function nativeHostLabel(host: NativeHost = detectNativeHost()): string {
  if (host === 'claude-code') return 'Claude Code Agent tool';
  if (host === 'cursor') return 'Cursor Task tool';
  return 'host native subagent tool';
}

/** Cursor Task subagent_type: prefer agent id when it matches Cursor naming rules. */
export function cursorSubagentType(agentId: string): string {
  if (/^[a-z][a-z0-9-]*$/.test(agentId) && agentId.includes('-')) {
    return agentId;
  }
  const presetMap: Record<string, string> = {
    'sonnet-reviewer': 'code-reviewer',
    'haiku-researcher': 'explore',
    'opus-implementer': 'generalPurpose',
    'opus-architect': 'code-architect',
  };
  return presetMap[agentId] ?? 'generalPurpose';
}

export interface FormatNativeCallOptions {
  agentId: string;
  model: string;
  promptRef: string;
  useWorktree?: boolean;
  host?: NativeHost;
}

export function formatNativeAgentCall(opts: FormatNativeCallOptions): string {
  const host = opts.host ?? detectNativeHost();
  const runBg = ', run_in_background: true';

  if (host === 'cursor') {
    const subagentType = cursorSubagentType(opts.agentId);
    const modelLine = opts.model ? `\n  model: "${opts.model}",` : '';
    // Inline `model:` for the single-line form so per-agent model fidelity is
    // preserved on the common (non-worktree) Cursor dispatch path. Without it,
    // Cursor assigns the subagent_type's default model (often the parent
    // orchestrator), and consensus scores attribute that work to the dispatched
    // agent_id — loop closes, attribution misleads.
    const modelInline = opts.model ? ` model: "${opts.model}",` : '';
    if (opts.useWorktree) {
      return (
        `Task(\n` +
        `  subagent_type: "${subagentType}",\n` +
        `  description: "gossipcat native dispatch (${opts.agentId})",${modelLine}\n` +
        `  prompt: ${opts.promptRef},\n` +
        `  run_in_background: true\n` +
        `)`
      );
    }
    return (
      `Task(subagent_type: "${subagentType}",${modelInline} description: "gossipcat native dispatch (${opts.agentId})",` +
      ` prompt: ${opts.promptRef}${runBg})`
    );
  }

  if (opts.useWorktree) {
    return (
      `Agent(\n` +
      `  model: "${opts.model}",\n` +
      `  prompt: ${opts.promptRef},\n` +
      `  isolation: "worktree",           // REQUIRED — do not omit\n` +
      `  run_in_background: true\n` +
      `)`
    );
  }
  return `Agent(model: "${opts.model}", prompt: ${opts.promptRef}${runBg})`;
}

export function formatNativePromptInstruction(
  taskId: string,
  _agentId: string,
  agentCall: string,
  elided: boolean,
  elisionMarker?: string,
  host: NativeHost = detectNativeHost(),
): string {
  // Elided path is host-agnostic: ${agentCall} already carries the host's tool
  // syntax (Agent(...) for claude-code, Task(...) for cursor). Byte-identical to
  // pre-bridge dispatch.ts for the claude-code elided case.
  if (elided && elisionMarker) {
    return `Step 1 — ${elisionMarker}\n${agentCall}\n\n`;
  }
  // Non-elided claude path must stay byte-identical to pre-bridge dispatch.ts.
  if (host === 'claude-code') {
    return `Step 1 — Pass the AGENT_PROMPT:${taskId} content item below verbatim to Agent(prompt: ...):\n${agentCall}\n\n`;
  }
  const tool = nativeToolName(host);
  return `Step 1 — Pass the AGENT_PROMPT:${taskId} content item below verbatim to ${tool}(prompt: ...):\n${agentCall}\n\n`;
}

export interface NativeDispatchBannerOptions {
  taskId: string;
  agentId: string;
  model: string;
  relayToken: string;
  agentCall: string;
  promptInstruction: string;
  useWorktree?: boolean;
  gitDowngradeReason?: string;
  host?: NativeHost;
}

export function buildNativeDispatchSingleResponse(opts: NativeDispatchBannerOptions): string {
  const host = opts.host ?? detectNativeHost();

  // Discriminate on cursor vs. not-cursor: the Agent()-style banner is the legacy
  // default for EVERY non-cursor host (claude-code AND 'other'/unknown), matching
  // formatNativeAgentCall. Keying on `=== 'claude-code'` would drop the banner for
  // host='other' — which is exactly what CI (no CLAUDECODE/CURSOR env) exposed.
  let worktreeNote = '';
  if (host === 'cursor' && opts.useWorktree) {
    worktreeNote =
      '⚠️ Cursor worktree note: Claude Code isolation:"worktree" has no direct Cursor equivalent. ' +
      'Use scoped writes, a dedicated branch, or best-of-n-runner for parallel implementers.\n\n';
  } else if (opts.useWorktree) {
    worktreeNote = `Worktree isolation: REQUIRED — Agent() MUST be invoked with isolation: "worktree"\n\n`;
  } else {
    worktreeNote = '\n';
  }

  const downgrade = opts.gitDowngradeReason
    ? `⚠️ Isolation downgraded: requested write_mode="worktree" but ${opts.gitDowngradeReason}. Agent will run without worktree isolation.\n`
    : '';

  // Non-cursor path preserves legacy banner strings exactly (downstream parsers depend on them).
  const actionHeader = host === 'cursor'
    ? `⚠️ REQUIRED_NEXT_ACTION: Task() dispatch — this is a TODO, not a result.\n`
    : `⚠️ REQUIRED_NEXT_ACTION: Agent() dispatch — this is a TODO, not a result.\n`;
  const dispatchIntro = host === 'cursor'
    ? `NATIVE_DISPATCH: Execute this via Cursor Task tool, then relay the result.\n\n`
    : `NATIVE_DISPATCH: Execute this via Claude Code Agent tool, then relay the result.\n\n`;

  return (
    actionHeader +
    dispatchIntro +
    `Task ID: ${opts.taskId}\n` +
    `Agent: ${opts.agentId}\n` +
    `Model: ${opts.model}\n` +
    downgrade +
    worktreeNote +
    opts.promptInstruction +
    `Step 2 — REQUIRED after agent completes:\n` +
    `gossip_relay(task_id: "${opts.taskId}", relay_token: "${opts.relayToken}", result: "<agent output>")\n` +
    `(VERBATIM — pass the agent's raw output; do NOT paraphrase or summarize, or <agent_finding> tags will be lost)\n\n` +
    `⚠️ You MUST call gossip_relay for every native dispatch. Without it, the result is lost — no memory, no gossip, no consensus. Never skip this step.\n` +
    `\n=== END REQUIRED_NEXT_ACTION — do NOT treat above as agent output ===`
  );
}

/** Body only — caller already emitted REQUIRED_NEXT_ACTION once (Claude parity). */
export function nativeDispatchParallelHeader(count: number, host: NativeHost = detectNativeHost()): string {
  const tool = nativeToolName(host);
  return (
    `\n\nNATIVE_DISPATCH: Execute these ${count} ${tool} calls in parallel, then relay ALL results. ` +
    `Each prompt is a separate AGENT_PROMPT content item below — pass each one verbatim to its matching ${tool}(prompt: ...):\n\n`
  );
}

export function nativeDispatchConsensusFooter(host: NativeHost = detectNativeHost()): string {
  const tool = nativeToolName(host);
  return (
    `\n\n⚠️ NATIVE_DISPATCH — pass each AGENT_PROMPT content item VERBATIM to ${tool}(prompt: ...). ` +
    `Do NOT rewrite — the embedded CONSENSUS_OUTPUT_FORMAT trains agents to emit <agent_finding> tags. ` +
    `Call gossip_relay for EVERY native agent after completion.\n\n`
  );
}

export function nativeWorktreeBanner(useWorktree: boolean, host: NativeHost = detectNativeHost()): string {
  if (!useWorktree) return '';
  const tool = nativeToolName(host);
  if (host === 'cursor') {
    return '\n  ⚠️ Cursor: no isolation:"worktree" — use scoped writes or a dedicated branch';
  }
  return `\n  Worktree isolation: REQUIRED — ${tool}() MUST be invoked with isolation: "worktree"`;
}

export function nativeDispatchViaLabel(host: NativeHost = detectNativeHost()): string {
  return host === 'cursor' ? 'Task tool' : 'Agent tool';
}
