// tests/cli/collect-legacy-verifier-truncation.test.ts
//
// Issue #749: apps/cli/src/handlers/collect.ts's legacy two-phase consensus
// path (`handleCollect`, reached whenever `!consensusReport` because at least
// one completed agent is native) has its OWN hand-rolled inline tool loop
// (`runOneRelayCrossReview`'s `runToolCalls`) serving file_read/file_grep
// results to RELAY cross-reviewers. #731 (PR #743) fixed the byte-aware,
// idempotent truncation in packages/orchestrator/src/consensus-engine.ts's
// `runToolCalls` but never touched this second, independent copy, which kept
// the old raw `if (out.length > 8000) out = out.slice(0, 8000) + marker`
// char-based cut — reintroducing the exact UTF-8 surrogate-pair-splitting bug
// #731 already fixed once, plus a disagreement on cap (8000 chars vs 16384
// bytes) and marker format (inline literal vs shared TRUNCATION_MARKER).
//
// This test drives `handleCollect` through the REAL legacy two-phase branch
// (one native + one relay completed result — the `hasNative` gate that skips
// the server-side Phase 2 path) with a relay cross-reviewer LLM stub that
// requests a `file_read` on a huge on-disk fixture, then asserts the tool
// result the loop hands back is byte-capped at VERIFIER_TOOL_RESULT_MAX_BYTES
// and carries exactly one shared TRUNCATION_MARKER — proving collect.ts now
// shares truncateVerifierToolResult with consensus-engine.ts instead of
// hand-rolling its own.
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleCollect } from '../../apps/cli/src/handlers/collect';
import { ctx } from '../../apps/cli/src/mcp-context';
import { VERIFIER_TOOL_RESULT_MAX_BYTES } from '@gossip/orchestrator';
import { TRUNCATION_MARKER } from '@gossip/tools';

// startConsensusTimeout schedules a real ~30-minute setTimeout on the
// pending round — stub it so the test doesn't leave a dangling timer/open
// handle. persistPendingConsensus stays real (writes under the tmp
// projectRoot set below, harmless and cleaned up in afterEach).
jest.mock('../../apps/cli/src/handlers/relay-cross-review', () => ({
  ...jest.requireActual('../../apps/cli/src/handlers/relay-cross-review'),
  startConsensusTimeout: jest.fn(),
}));

describe('handleCollect legacy two-phase verifier tool loop (#749)', () => {
  let tmp: string;
  let origMainAgent: any;
  let origBoot: any;
  let origNativeConfigs: any;
  let origPending: any;
  let origNativeResultMap: any;
  let origNativeTaskMap: any;
  let origKeychain: any;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'collect-749-')));

    origMainAgent = (ctx as any).mainAgent;
    origBoot = ctx.boot;
    origNativeConfigs = ctx.nativeAgentConfigs;
    origPending = ctx.pendingConsensusRounds;
    origNativeResultMap = ctx.nativeResultMap;
    origNativeTaskMap = ctx.nativeTaskMap;
    origKeychain = (ctx as any).keychain;

    ctx.boot = jest.fn().mockResolvedValue(undefined) as any;
    ctx.pendingConsensusRounds = new Map();
    ctx.nativeTaskMap = new Map();
    ctx.nativeResultMap = new Map();
    (ctx as any).keychain = { getKey: jest.fn().mockResolvedValue(null) };

    // One native agent config — this is what flips `nativeAgentIds.size > 0`
    // and forces handleCollect down the legacy two-phase branch instead of
    // the server-side Phase 2 path.
    ctx.nativeAgentConfigs = new Map([
      ['native-agent', { model: 'sonnet', instructions: '', description: '', skills: [] }],
    ]);
  });

  afterEach(() => {
    (ctx as any).mainAgent = origMainAgent;
    ctx.boot = origBoot;
    ctx.nativeAgentConfigs = origNativeConfigs;
    ctx.pendingConsensusRounds = origPending;
    ctx.nativeResultMap = origNativeResultMap;
    ctx.nativeTaskMap = origNativeTaskMap;
    (ctx as any).keychain = origKeychain;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('byte-caps a file_read result at VERIFIER_TOOL_RESULT_MAX_BYTES with the shared TRUNCATION_MARKER (not the old 8000-char slice)', async () => {
    const now = Date.now();

    // Fixture: pure ASCII, well over VERIFIER_TOOL_RESULT_MAX_BYTES (16384)
    // once file_read prepends its "1\t" line-number prefix. Single line (no
    // newlines) so truncateToBytes's "cut at the last newline" adjustment
    // never kicks in — the cut lands at EXACTLY budget bytes, giving an exact
    // expected length to assert against. This is the load-bearing fixture
    // property: the OLD `slice(0, 8000)` bug caps at ~8000 bytes, the FIXED
    // shared helper caps at VERIFIER_TOOL_RESULT_MAX_BYTES (16384) — an
    // order-of-magnitude difference an "ends with marker" check alone can't
    // catch, since TRUNCATION_MARKER is byte-identical to the old inline
    // literal it replaced.
    const bigContent = 'a'.repeat(20_000);
    const bigFilePath = join(tmp, 'big-fixture.txt');
    writeFileSync(bigFilePath, bigContent, 'utf-8');

    const mockGenerate = jest.fn()
      // Turn 1: the relay reviewer asks to read the huge fixture.
      .mockImplementationOnce(async () => ({
        text: '',
        toolCalls: [{ id: 'tc1', name: 'file_read', arguments: { path: bigFilePath } }],
      }))
      // Turn 2: no more tool calls — emit a text-only (empty-array) response
      // so the loop breaks without needing a real synthesis pass.
      .mockImplementationOnce(async () => ({ text: '[]', toolCalls: [] }));

    (ctx as any).mainAgent = {
      projectRoot: tmp,
      collect: jest.fn().mockResolvedValue({
        results: [{
          id: 'relay-task-1', agentId: 'relay-agent', task: 'Review the code',
          status: 'completed', result: 'Reviewed the code, looks fine.',
          startedAt: now - 1000, completedAt: now,
        }],
      }),
      getAgentConfig: jest.fn().mockReturnValue(null),
      // agentLlmCache stays empty (getAgentConfig returns null for everyone),
      // so runOneRelayCrossReview falls back to this mainLlm for the relay agent.
      getLlm: jest.fn().mockReturnValue({ generate: mockGenerate }),
      getAgentList: jest.fn().mockReturnValue([]),
      getSkillIndex: jest.fn().mockReturnValue(null),
      runConsensus: jest.fn(),
    } as any;

    ctx.nativeResultMap.set('native-task-1', {
      id: 'native-task-1', agentId: 'native-agent', task: 'Review the code',
      status: 'completed', result: 'Reviewed, no issues found.',
      startedAt: now - 1000, completedAt: now,
    });

    await handleCollect(['relay-task-1', 'native-task-1'], 5000, true, [tmp]);

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    const messages = mockGenerate.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const toolMsg = messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();

    const content = toolMsg!.content;
    // Exact-length assertion is the real regression discriminator: pure-ASCII
    // + no newlines means truncateToBytes's cut lands at EXACTLY
    // VERIFIER_TOOL_RESULT_MAX_BYTES bytes (budget + marker). The old
    // `slice(0, 8000)` bug would land at ~8015 bytes instead — a magnitude
    // this assertion catches even though the marker text itself is identical.
    expect(Buffer.byteLength(content, 'utf8')).toBe(VERIFIER_TOOL_RESULT_MAX_BYTES);
    // Shared marker (not the old inline '\n…[truncated]' literal reimplemented
    // separately — same constant, so this also pins the format).
    expect(content.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(content.split(TRUNCATION_MARKER)).toHaveLength(2);
  });

  it('never splits a multi-byte UTF-8 character at the cut boundary (surrogate-pair-splitting regression, #731)', async () => {
    const now = Date.now();

    // Position an emoji (4-byte UTF-8 sequence) straddling the exact byte
    // offset truncateVerifierToolResult cuts at (budget = MAX_BYTES -
    // TRUNCATION_MARKER bytes), so a naive Buffer#slice at that boundary
    // would split it mid-sequence and decode to a replacement character.
    const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
    const budget = VERIFIER_TOOL_RESULT_MAX_BYTES - markerBytes;
    const linePrefixBytes = 2; // fileRead prepends "1\t"
    // Place the emoji so its 4 bytes span [budget - 2, budget + 1] — 2 bytes
    // before the cut, 2 bytes after.
    const asciiBeforeEmoji = budget - linePrefixBytes - 2;
    const emoji = '😀';
    const bigContent = 'a'.repeat(asciiBeforeEmoji) + emoji + 'b'.repeat(5000);
    const bigFilePath = join(tmp, 'emoji-fixture.txt');
    writeFileSync(bigFilePath, bigContent, 'utf-8');

    const mockGenerate = jest.fn()
      .mockImplementationOnce(async () => ({
        text: '',
        toolCalls: [{ id: 'tc1', name: 'file_read', arguments: { path: bigFilePath } }],
      }))
      .mockImplementationOnce(async () => ({ text: '[]', toolCalls: [] }));

    (ctx as any).mainAgent = {
      projectRoot: tmp,
      collect: jest.fn().mockResolvedValue({
        results: [{
          id: 'relay-task-1', agentId: 'relay-agent', task: 'Review the code',
          status: 'completed', result: 'Reviewed the code, looks fine.',
          startedAt: now - 1000, completedAt: now,
        }],
      }),
      getAgentConfig: jest.fn().mockReturnValue(null),
      getLlm: jest.fn().mockReturnValue({ generate: mockGenerate }),
      getAgentList: jest.fn().mockReturnValue([]),
      getSkillIndex: jest.fn().mockReturnValue(null),
      runConsensus: jest.fn(),
    } as any;

    ctx.nativeResultMap.set('native-task-1', {
      id: 'native-task-1', agentId: 'native-agent', task: 'Review the code',
      status: 'completed', result: 'Reviewed, no issues found.',
      startedAt: now - 1000, completedAt: now,
    });

    await handleCollect(['relay-task-1', 'native-task-1'], 5000, true, [tmp]);

    const messages = mockGenerate.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const toolMsg = messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const content = toolMsg!.content;

    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(VERIFIER_TOOL_RESULT_MAX_BYTES);
    expect(content.endsWith(TRUNCATION_MARKER)).toBe(true);
    // No replacement character — a split multi-byte sequence would decode to
    // one via the old raw Buffer#slice-then-toString('utf8') path.
    expect(content).not.toContain('�');
  });
});
