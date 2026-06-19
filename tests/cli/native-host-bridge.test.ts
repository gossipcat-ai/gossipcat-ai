/**
 * Regression: Claude Code native dispatch strings must stay byte-identical to the
 * pre-bridge dispatch.ts output. Cursor gets a separate branch only.
 */
import {
  buildNativeDispatchSingleResponse,
  detectNativeHost,
  formatNativeAgentCall,
  formatNativePromptInstruction,
  nativeDispatchConsensusFooter,
  nativeDispatchParallelHeader,
  nativeWorktreeBanner,
} from '../../apps/cli/src/native-host-bridge';

const CLAUDE: 'claude-code' = 'claude-code';
const CURSOR: 'cursor' = 'cursor';
const OTHER: 'other' = 'other';

describe('detectNativeHost precedence', () => {
  const env = process.env;

  afterEach(() => {
    process.env = env;
  });

  it('prefers Claude Code when both Claude and Cursor env vars are set', () => {
    process.env = {
      ...env,
      CLAUDECODE: '1',
      CURSOR: '1',
      CURSOR_TRACE_ID: 'trace-123',
    };
    expect(detectNativeHost()).toBe('claude-code');
  });
});

describe('Claude Code output parity (legacy strings)', () => {
  it('formatNativeAgentCall — simple', () => {
    expect(formatNativeAgentCall({
      agentId: 'unity-reviewer',
      model: 'claude-sonnet-4-6',
      promptRef: '<AGENT_PROMPT:abc123 below>',
      host: CLAUDE,
    })).toBe(
      'Agent(model: "claude-sonnet-4-6", prompt: <AGENT_PROMPT:abc123 below>, run_in_background: true)',
    );
  });

  it('formatNativeAgentCall — worktree', () => {
    expect(formatNativeAgentCall({
      agentId: 'unity-implementer',
      model: 'claude-sonnet-4-6',
      promptRef: '<AGENT_PROMPT:wt01 below>',
      useWorktree: true,
      host: CLAUDE,
    })).toBe(
      'Agent(\n' +
      '  model: "claude-sonnet-4-6",\n' +
      '  prompt: <AGENT_PROMPT:wt01 below>,\n' +
      '  isolation: "worktree",           // REQUIRED — do not omit\n' +
      '  run_in_background: true\n' +
      ')',
    );
  });

  it('formatNativePromptInstruction — inline', () => {
    const call = 'Agent(model: "sonnet", prompt: <AGENT_PROMPT:t1 below>, run_in_background: true)';
    expect(formatNativePromptInstruction('t1', 'reviewer', call, false, undefined, CLAUDE)).toBe(
      'Step 1 — Pass the AGENT_PROMPT:t1 content item below verbatim to Agent(prompt: ...):\n' +
      `${call}\n\n`,
    );
  });

  it('nativeWorktreeBanner — worktree', () => {
    expect(nativeWorktreeBanner(true, CLAUDE)).toBe(
      '\n  Worktree isolation: REQUIRED — Agent() MUST be invoked with isolation: "worktree"',
    );
  });

  it('nativeDispatchParallelHeader — no duplicate REQUIRED_NEXT_ACTION', () => {
    const header = nativeDispatchParallelHeader(2, CLAUDE);
    expect(header).not.toContain('REQUIRED_NEXT_ACTION');
    expect(header).toContain('Execute these 2 Agent calls in parallel');
    expect(header).toContain('Agent(prompt: ...)');
  });

  it('buildNativeDispatchSingleResponse — full banner', () => {
    const agentCall = 'Agent(model: "claude-sonnet-4-6", prompt: <AGENT_PROMPT:ab12 below>, run_in_background: true)';
    const promptInstruction = formatNativePromptInstruction('ab12', 'unity-reviewer', agentCall, false, undefined, CLAUDE);
    const text = buildNativeDispatchSingleResponse({
      taskId: 'ab12',
      agentId: 'unity-reviewer',
      model: 'claude-sonnet-4-6',
      relayToken: 'tok123',
      agentCall,
      promptInstruction,
      host: CLAUDE,
    });

    expect(text).toContain('⚠️ REQUIRED_NEXT_ACTION: Agent() dispatch — this is a TODO, not a result.');
    expect(text).toContain('NATIVE_DISPATCH: Execute this via Claude Code Agent tool, then relay the result.');
    expect(text).toContain('gossip_relay(task_id: "ab12", relay_token: "tok123", result: "<agent output>")');
    expect(text).not.toContain('Task(');
  });

  // Pins the full legacy consensus-footer string so a future nativeToolName change
  // or wording drift on the claude-code branch fails loudly (cross-review F1/F8).
  it('nativeDispatchConsensusFooter — byte-identical legacy string', () => {
    expect(nativeDispatchConsensusFooter(CLAUDE)).toBe(
      '\n\n⚠️ NATIVE_DISPATCH — pass each AGENT_PROMPT content item VERBATIM to Agent(prompt: ...). ' +
      'Do NOT rewrite — the embedded CONSENSUS_OUTPUT_FORMAT trains agents to emit <agent_finding> tags. ' +
      'Call gossip_relay for EVERY native agent after completion.\n\n',
    );
  });

  // Pins the full legacy parallel header (cross-review F10 — toContain was too loose).
  it('nativeDispatchParallelHeader — byte-identical legacy string', () => {
    expect(nativeDispatchParallelHeader(2, CLAUDE)).toBe(
      '\n\nNATIVE_DISPATCH: Execute these 2 Agent calls in parallel, then relay ALL results. ' +
      'Each prompt is a separate AGENT_PROMPT content item below — pass each one verbatim to its matching Agent(prompt: ...):\n\n',
    );
  });

  // The single-dispatch worktree banner is computed inline inside
  // buildNativeDispatchSingleResponse (NOT nativeWorktreeBanner), so it needs its
  // own parity guard for useWorktree=true on claude-code (cross-review F9).
  it('buildNativeDispatchSingleResponse — worktree=true claude banner parity', () => {
    const text = buildNativeDispatchSingleResponse({
      taskId: 'wt9',
      agentId: 'unity-implementer',
      model: 'claude-sonnet-4-6',
      relayToken: 'tok9',
      agentCall: 'Agent(\n  model: "claude-sonnet-4-6",\n  prompt: <x>,\n  isolation: "worktree",           // REQUIRED — do not omit\n  run_in_background: true\n)',
      promptInstruction: 'Step 1 — ...\n',
      useWorktree: true,
      host: CLAUDE,
    });
    expect(text).toContain('Worktree isolation: REQUIRED — Agent() MUST be invoked with isolation: "worktree"\n\n');
    expect(text).not.toContain('Cursor: no isolation');
  });

  // Regression: a non-cursor, non-claude-code host (the value detectNativeHost()
  // returns under CI, where neither CLAUDECODE nor CURSOR is set) MUST get the
  // Agent()-style banner — not an empty worktree note or a Cursor/Task header.
  // Keying the banner on `=== 'claude-code'` dropped it for host='other' and broke
  // dispatch-native-prompt.test.ts only in CI. The discriminator is cursor-vs-not.
  it("buildNativeDispatchSingleResponse — host='other' falls back to Agent-style banner", () => {
    const text = buildNativeDispatchSingleResponse({
      taskId: 'o1',
      agentId: 'unity-implementer',
      model: 'claude-sonnet-4-6',
      relayToken: 'tokO',
      agentCall: 'Agent(model: "claude-sonnet-4-6", prompt: <x>, run_in_background: true)',
      promptInstruction: 'Step 1 — ...\n',
      useWorktree: true,
      host: OTHER,
    });
    expect(text).toContain('⚠️ REQUIRED_NEXT_ACTION: Agent() dispatch — this is a TODO, not a result.');
    expect(text).toContain('Worktree isolation: REQUIRED — Agent() MUST be invoked with isolation: "worktree"\n\n');
    expect(text).not.toContain('Task() dispatch');
    expect(text).not.toContain('Cursor Task tool');
  });
});

describe('Cursor branch (isolated from Claude)', () => {
  it('formatNativeAgentCall — Task with subagent_type', () => {
    const out = formatNativeAgentCall({
      agentId: 'unity-architect',
      model: 'claude-opus-4-6',
      promptRef: '<AGENT_PROMPT:x1 below>',
      host: CURSOR,
    });
    expect(out).toContain('Task(subagent_type: "unity-architect"');
    expect(out).not.toContain('Agent(');
  });

  // Model fidelity: the simple (non-worktree) Cursor dispatch path MUST carry
  // `model:` so Cursor runs the per-agent model rather than defaulting to the
  // parent orchestrator. Without it, consensus scores attribute orchestrator
  // work to the dispatched agent_id. Regression guard for that bug.
  it('formatNativeAgentCall — simple Cursor form carries model:', () => {
    const out = formatNativeAgentCall({
      agentId: 'unity-implementer',
      model: 'claude-sonnet-4-6',
      promptRef: '<AGENT_PROMPT:m1 below>',
      host: CURSOR,
    });
    expect(out).toBe(
      'Task(subagent_type: "unity-implementer", model: "claude-sonnet-4-6",' +
      ' description: "gossipcat native dispatch (unity-implementer)",' +
      ' prompt: <AGENT_PROMPT:m1 below>, run_in_background: true)',
    );
  });

  it('formatNativeAgentCall — worktree Cursor form carries model:', () => {
    const out = formatNativeAgentCall({
      agentId: 'unity-architect',
      model: 'claude-opus-4-6',
      promptRef: '<AGENT_PROMPT:m2 below>',
      useWorktree: true,
      host: CURSOR,
    });
    expect(out).toContain('model: "claude-opus-4-6"');
    expect(out).toContain('subagent_type: "unity-architect"');
  });

  it('formatNativeAgentCall — omits model: when none provided', () => {
    const out = formatNativeAgentCall({
      agentId: 'unity-reviewer',
      model: '',
      promptRef: '<AGENT_PROMPT:m3 below>',
      host: CURSOR,
    });
    expect(out).not.toContain('model:');
  });

  it('buildNativeDispatchSingleResponse — Cursor banner', () => {
    const text = buildNativeDispatchSingleResponse({
      taskId: 'c1',
      agentId: 'unity-architect',
      model: 'claude-opus-4-6',
      relayToken: 'rt',
      agentCall: 'Task(...)',
      promptInstruction: 'Step 1 — ...\n',
      host: CURSOR,
    });
    expect(text).toContain('Task() dispatch');
    expect(text).toContain('Cursor Task tool');
    expect(text).not.toContain('Claude Code Agent tool');
  });
});
