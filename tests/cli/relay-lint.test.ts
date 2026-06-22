/**
 * Path A relay-lint hardening — tests for handleNativeRelay's
 * `relay_findings_dropped` warning emission.
 *
 * Spec: docs/specs/2026-04-25-relay-lint-hardening.md
 *
 * Detection: when a native task was part of an active consensus round AND the
 * relayed `result` payload carries zero `<agent_finding>` tags, the
 * orchestrator likely paraphrased the agent's verbatim output. The relay path
 * (a) appends a JSON line to .gossip/relay-warnings.jsonl, (b) emits a
 * pipeline-typed `relay_findings_dropped` signal (best-effort), and (c) tags
 * the gossip_relay receipt with a one-line warning.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  handleNativeRelay,
  taskWasInConsensusRound,
  seedRecentConsensusTaskIds,
  seedRecentConsensusAgentIds,
  pruneExpiredRecentConsensusAgentIds,
} from '../../apps/cli/src/handlers/native-tasks';
import { ctx, RECENT_CONSENSUS_TASK_TTL_MS } from '../../apps/cli/src/mcp-context';
import * as signalHelpers from '@gossip/orchestrator/signal-helpers';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-relay-lint-test-'));
}

function makeMainAgent(projectRoot: string): any {
  return {
    dispatch: jest.fn().mockReturnValue({ taskId: 'mock' }),
    collect: jest.fn().mockResolvedValue({ results: [] }),
    getAgentConfig: jest.fn().mockReturnValue(null),
    getLLM: jest.fn().mockReturnValue(null),
    getAgentList: jest.fn().mockReturnValue([]),
    getSessionGossip: jest.fn().mockReturnValue([]),
    getPerfReader: jest.fn().mockReturnValue(undefined),
    recordNativeTask: jest.fn(),
    recordNativeTaskCompleted: jest.fn(),
    recordPlanStepResult: jest.fn(),
    publishNativeGossip: jest.fn().mockResolvedValue(undefined),
    scopeTracker: { release: jest.fn() },
    projectRoot,
  };
}

const AGENT_ID = 'sonnet-reviewer';
const TASK_ID = 'lint-task-1';
const CONSENSUS_ID = 'cafefeed-deadbeef';
const PROSE_PARAPHRASE = 'HIGH (e955d7d0:sonnet:f1) — recordCreated does not redactSecrets before logging.';
const TAGGED_RESULT =
  '<agent_finding type="finding" severity="HIGH">' +
  '  <cite tag="file">apps/cli/src/foo.ts:42</cite>\n' +
  '  recordCreated does not redactSecrets before logging.\n' +
  '</agent_finding>';

let testDir: string;
let originalCwd: string;
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  testDir = makeTmpDir();
  originalCwd = process.cwd();
  process.chdir(testDir);

  ctx.nativeTaskMap = new Map();
  ctx.nativeResultMap = new Map();
  ctx.pendingConsensusRounds = new Map();
  ctx.recentConsensusTaskIds = new Map();
  ctx.recentConsensusAgentIds = new Map();
  ctx.mainAgent = makeMainAgent(testDir);
  ctx.nativeUtilityConfig = null;
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;

  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  process.chdir(originalCwd);
  rmSync(testDir, { recursive: true, force: true });
});

function seedConsensusRound(taskId: string, agentId: string): void {
  ctx.pendingConsensusRounds.set(CONSENSUS_ID, {
    consensusId: CONSENSUS_ID,
    allResults: [
      { id: taskId, agentId, status: 'completed', result: '<agent_finding type="finding" severity="HIGH">peer</agent_finding>', task: 't' },
    ],
    relayCrossReviewEntries: [],
    relayCrossReviewSkipped: undefined,
    pendingNativeAgents: new Set([agentId]),
    participatingNativeAgents: new Set([agentId]),
    nativeCrossReviewEntries: [],
    deadline: Date.now() + 60_000,
    createdAt: Date.now(),
    nativePrompts: [],
  });
}

function seedTask(taskId: string, agentId: string): void {
  ctx.nativeTaskMap.set(taskId, {
    agentId,
    task: 'review repo for security',
    startedAt: Date.now() - 1000,
    timeoutMs: 120_000,
  });
}

function readWarnings(): any[] {
  const path = join(testDir, '.gossip', 'relay-warnings.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ── taskWasInConsensusRound unit tests ────────────────────────────────────────

describe('taskWasInConsensusRound', () => {
  it('returns true when task_id appears in any round.allResults', () => {
    const rounds = new Map();
    rounds.set('r1', {
      allResults: [{ id: 'tA', agentId: 'a' }],
      pendingNativeAgents: new Set(),
      nativeCrossReviewEntries: [],
    });
    expect(taskWasInConsensusRound('tA', undefined, rounds)).toBe(true);
  });

  it('returns true when agentId appears in pendingNativeAgents', () => {
    const rounds = new Map();
    rounds.set('r1', {
      allResults: [],
      pendingNativeAgents: new Set(['agent-x']),
      nativeCrossReviewEntries: [],
    });
    expect(taskWasInConsensusRound('unrelated', 'agent-x', rounds)).toBe(true);
  });

  it('returns false on empty rounds map', () => {
    expect(taskWasInConsensusRound('t', 'a', new Map())).toBe(false);
  });

  it('is defensive — never throws on malformed entries', () => {
    const rounds = new Map();
    rounds.set('r1', { allResults: 'not-an-array' as any });
    expect(() => taskWasInConsensusRound('t', 'a', rounds)).not.toThrow();
  });
});

// ── handleNativeRelay relay-lint integration tests ────────────────────────────

describe('handleNativeRelay — relay-lint Path A', () => {
  it('(a) prose result + consensus dispatch → warning fires', async () => {
    seedTask(TASK_ID, AGENT_ID);
    seedConsensusRound(TASK_ID, AGENT_ID);

    const res = await handleNativeRelay(TASK_ID, PROSE_PARAPHRASE);

    // jsonl persisted
    const warnings = readWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].taskId).toBe(TASK_ID);
    expect(warnings[0].agentId).toBe(AGENT_ID);
    expect(warnings[0].reason).toBe('relay_findings_dropped');
    expect(warnings[0].resultLength).toBe(PROSE_PARAPHRASE.length);
    expect(warnings[0].suspectedReason).toBe('orchestrator_paraphrase');
    expect(typeof warnings[0].timestamp).toBe('string');

    // receipt notice
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('relay_findings_dropped');
    expect(text).toContain('orchestrator may have paraphrased');
  });

  it('(b) tagged result + consensus dispatch → no warning', async () => {
    seedTask(TASK_ID, AGENT_ID);
    seedConsensusRound(TASK_ID, AGENT_ID);

    const res = await handleNativeRelay(TASK_ID, TAGGED_RESULT);

    expect(readWarnings()).toHaveLength(0);
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain('relay_findings_dropped');
  });

  it('(c) prose result + non-consensus (solo) dispatch → no warning', async () => {
    seedTask(TASK_ID, AGENT_ID);
    // Intentionally no seedConsensusRound — solo dispatch.

    const res = await handleNativeRelay(TASK_ID, PROSE_PARAPHRASE);

    expect(readWarnings()).toHaveLength(0);
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain('relay_findings_dropped');
  });

  it('(d) empty result + consensus dispatch → warning fires', async () => {
    seedTask(TASK_ID, AGENT_ID);
    seedConsensusRound(TASK_ID, AGENT_ID);

    const res = await handleNativeRelay(TASK_ID, '');

    const warnings = readWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].resultLength).toBe(0);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('relay_findings_dropped');
  });

  it('does not warn for utility tasks even when result is untagged prose', async () => {
    ctx.nativeTaskMap.set(TASK_ID, {
      agentId: '_utility',
      task: 'cognitive summary',
      startedAt: Date.now() - 500,
      timeoutMs: 120_000,
      utilityType: 'summary',
    });
    // Even if a consensus round somehow listed this taskId, utility tasks are exempt.
    seedConsensusRound(TASK_ID, '_utility');

    await handleNativeRelay(TASK_ID, 'short summary, no tags here');

    expect(readWarnings()).toHaveLength(0);
  });

  it('does not warn on the error path', async () => {
    seedTask(TASK_ID, AGENT_ID);
    seedConsensusRound(TASK_ID, AGENT_ID);

    await handleNativeRelay(TASK_ID, '', 'agent crashed mid-run');

    // Errors carry their own status — paraphrase detection skipped.
    expect(readWarnings()).toHaveLength(0);
  });
});

// ── emitPipelineSignals invocation (PR #270 review CRITICAL) ─────────────────
//
// The Path A relay-lint code calls `emitPipelineSignals` with a `pipeline`-typed
// `relay_findings_dropped` signal. Pre-fix, that signal name was NOT in
// VALID_PIPELINE_SIGNALS; validateSignal threw and the catch silently dropped
// every signal. The disk-side warning persisted, but the signal pipeline (and
// downstream agent scoring) never saw it. This test asserts the helper is
// invoked with the correct shape AND that it actually writes a row (proving
// the allowlist now accepts the name).

describe('handleNativeRelay — emitPipelineSignals invocation', () => {
  it('emits a pipeline signal with shape={signal,type,agentId,taskId,metadata,timestamp}', async () => {
    const spy = jest.spyOn(signalHelpers, 'emitPipelineSignals');

    seedTask(TASK_ID, AGENT_ID);
    seedConsensusRound(TASK_ID, AGENT_ID);

    await handleNativeRelay(TASK_ID, PROSE_PARAPHRASE);

    expect(spy).toHaveBeenCalledTimes(1);
    const [projectRoot, signals] = spy.mock.calls[0];
    expect(typeof projectRoot).toBe('string');
    expect(Array.isArray(signals)).toBe(true);
    expect(signals).toHaveLength(1);
    const sig: any = (signals as any[])[0];
    expect(sig.type).toBe('pipeline');
    expect(sig.signal).toBe('relay_findings_dropped');
    expect(sig.agentId).toBe(AGENT_ID);
    expect(sig.taskId).toBe(TASK_ID);
    expect(typeof sig.timestamp).toBe('string');
    expect(sig.metadata).toMatchObject({
      reason: 'no_tagged_findings_in_result',
      resultLength: PROSE_PARAPHRASE.length,
      suspectedReason: 'orchestrator_paraphrase',
    });

    // End-to-end: the signal lands on disk (proves VALID_PIPELINE_SIGNALS
    // accepts the name and validateSignal does not throw).
    const perfPath = join(testDir, '.gossip', 'agent-performance.jsonl');
    expect(existsSync(perfPath)).toBe(true);
    const rows = readFileSync(perfPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const pipelineRows = rows.filter((r) => r.type === 'pipeline' && r.signal === 'relay_findings_dropped');
    expect(pipelineRows.length).toBeGreaterThan(0);

    spy.mockRestore();
  });

  it('does NOT call emitPipelineSignals when the result carries tagged findings', async () => {
    const spy = jest.spyOn(signalHelpers, 'emitPipelineSignals');
    seedTask(TASK_ID, AGENT_ID);
    seedConsensusRound(TASK_ID, AGENT_ID);

    await handleNativeRelay(TASK_ID, TAGGED_RESULT);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── Round-deletion race fallback (PR #270 review HIGH) ───────────────────────
//
// When the live consensus round entry is deleted (timeout teardown or
// completion synthesis), late Phase 1 relays would lose membership detection
// and silently miss the warning. The fix maintains a `recentConsensusTaskIds`
// fallback Map seeded at round-creation time. taskWasInConsensusRound
// consults the Map when the live round entry is gone.

describe('taskWasInConsensusRound — round-deletion race fallback', () => {
  it('falls back to recentConsensusTaskIds when the live round is gone', () => {
    const now = Date.now();
    const fallback = new Map<string, number>([[TASK_ID, now + 60_000]]);
    // No live round in pendingConsensusRounds at all.
    expect(taskWasInConsensusRound(TASK_ID, AGENT_ID, new Map(), fallback)).toBe(true);
  });

  it('lazy-prunes expired entries on read and returns false', () => {
    const past = Date.now() - 1000;
    const fallback = new Map<string, number>([[TASK_ID, past]]);
    expect(taskWasInConsensusRound(TASK_ID, AGENT_ID, new Map(), fallback)).toBe(false);
  });

  it('uses ctx.recentConsensusTaskIds when no explicit map is passed', () => {
    seedRecentConsensusTaskIds([TASK_ID], RECENT_CONSENSUS_TASK_TTL_MS);
    expect(taskWasInConsensusRound(TASK_ID, AGENT_ID, new Map())).toBe(true);
  });
});

describe('handleNativeRelay — late relay after round deletion still warns', () => {
  it('warning STILL fires when round was seeded then deleted (race fix)', async () => {
    seedTask(TASK_ID, AGENT_ID);
    // Simulate the race: seed the round, then DELETE it (mimics Phase 1
    // timeout teardown at relay-cross-review.ts:32 or completion sweep at
    // relay-cross-review.ts:254). The fallback membership map MUST keep the
    // taskId reachable so the late prose relay still triggers the warning.
    seedConsensusRound(TASK_ID, AGENT_ID);
    seedRecentConsensusTaskIds([TASK_ID], RECENT_CONSENSUS_TASK_TTL_MS);
    ctx.pendingConsensusRounds.delete(CONSENSUS_ID);
    expect(ctx.pendingConsensusRounds.size).toBe(0);

    const res = await handleNativeRelay(TASK_ID, PROSE_PARAPHRASE);

    const warnings = readWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].taskId).toBe(TASK_ID);
    expect(warnings[0].reason).toBe('relay_findings_dropped');

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('relay_findings_dropped');
  });

  it('expired fallback entry → no warning even without live round', async () => {
    seedTask(TASK_ID, AGENT_ID);
    // Manually seed an already-expired entry; pendingConsensusRounds is empty.
    ctx.recentConsensusTaskIds.set(TASK_ID, Date.now() - 1000);

    await handleNativeRelay(TASK_ID, PROSE_PARAPHRASE);

    expect(readWarnings()).toHaveLength(0);
  });
});

// ── Cross-review-after-deletion fallback (PR #270 v2 review MEDIUM) ──────────
//
// The Phase 1 task-id seed at collect.ts only covers task IDs that exist at
// round-creation time. Phase 2 cross-review native agents are dispatched via
// a separate Agent() path with their own task IDs, which never enter
// recentConsensusTaskIds. While the round is alive, pendingNativeAgents.has()
// catches them at native-tasks.ts. After the round is torn down (timeout or
// completion), the agentId fallback (recentConsensusAgentIds, seeded
// snapshot-before-delete in relay-cross-review.ts) MUST keep them reachable.

describe('taskWasInConsensusRound — agentId fallback (cross-review-after-deletion)', () => {
  it('returns true via recentConsensusAgentIds when live round and taskId fallback are gone', () => {
    const now = Date.now();
    const agentMap = new Map<string, number>([[AGENT_ID, now + 60_000]]);
    expect(
      taskWasInConsensusRound('cross-review-task-id-not-in-task-fallback', AGENT_ID, new Map(), undefined, agentMap),
    ).toBe(true);
  });

  it('lazy-prunes expired agentId entries on read and returns false', () => {
    const past = Date.now() - 1000;
    const agentMap = new Map<string, number>([[AGENT_ID, past]]);
    expect(taskWasInConsensusRound('any-task', AGENT_ID, new Map(), undefined, agentMap)).toBe(false);
    // Lazy prune dropped the expired entry
    expect(agentMap.has(AGENT_ID)).toBe(false);
  });

  it('uses ctx.recentConsensusAgentIds when no explicit agentMap is passed', () => {
    seedRecentConsensusAgentIds([AGENT_ID], RECENT_CONSENSUS_TASK_TTL_MS);
    expect(taskWasInConsensusRound('any-task', AGENT_ID, new Map())).toBe(true);
  });

  it('returns false when agentId is undefined even with seeded fallback', () => {
    seedRecentConsensusAgentIds([AGENT_ID], RECENT_CONSENSUS_TASK_TTL_MS);
    expect(taskWasInConsensusRound('any-task', undefined, new Map())).toBe(false);
  });
});

describe('pruneExpiredRecentConsensusAgentIds', () => {
  it('removes only entries whose expiry is <= now', () => {
    const now = 10_000;
    const m = new Map<string, number>([
      ['fresh', now + 1000],
      ['stale', now - 1],
      ['exact', now], // expiry === now → expired
    ]);
    pruneExpiredRecentConsensusAgentIds(m, now);
    expect(m.has('fresh')).toBe(true);
    expect(m.has('stale')).toBe(false);
    expect(m.has('exact')).toBe(false);
  });

  it('is a no-op on empty map', () => {
    const m = new Map<string, number>();
    expect(() => pruneExpiredRecentConsensusAgentIds(m)).not.toThrow();
    expect(m.size).toBe(0);
  });

  it('defaults to ctx.recentConsensusAgentIds when no map is passed', () => {
    ctx.recentConsensusAgentIds.set('stale-agent', Date.now() - 1000);
    ctx.recentConsensusAgentIds.set('fresh-agent', Date.now() + 60_000);
    pruneExpiredRecentConsensusAgentIds();
    expect(ctx.recentConsensusAgentIds.has('stale-agent')).toBe(false);
    expect(ctx.recentConsensusAgentIds.has('fresh-agent')).toBe(true);
  });
});

describe('handleNativeRelay — late cross-review relay after round deletion', () => {
  it('warning STILL fires when cross-review agent relays after round was torn down', async () => {
    // Simulate: cross-review agent had a separate task ID (never in
    // recentConsensusTaskIds) and was in pendingNativeAgents. The round was
    // torn down (timeout or completion), but seedRecentConsensusAgentIds
    // captured the snapshot at the deletion site. A late prose relay from
    // that agent must still trigger the warning via the agentId fallback.
    const CROSS_REVIEW_TASK_ID = 'phase-2-task-not-seeded';
    seedTask(CROSS_REVIEW_TASK_ID, AGENT_ID);
    seedRecentConsensusAgentIds([AGENT_ID], RECENT_CONSENSUS_TASK_TTL_MS);
    // No live round, no taskId in recentConsensusTaskIds — only the agentId
    // fallback can save us here.
    expect(ctx.pendingConsensusRounds.size).toBe(0);
    expect(ctx.recentConsensusTaskIds.size).toBe(0);

    const res = await handleNativeRelay(CROSS_REVIEW_TASK_ID, PROSE_PARAPHRASE);

    const warnings = readWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].taskId).toBe(CROSS_REVIEW_TASK_ID);
    expect(warnings[0].agentId).toBe(AGENT_ID);
    expect(warnings[0].reason).toBe('relay_findings_dropped');

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('relay_findings_dropped');
  });
});

// ── Completion-path under-seed on parse failure (PR #270 v3 review HIGH) ─────
//
// Pre-fix: the completion path derived the agent-id snapshot from
// `nativeCrossReviewEntries[].agentId ∪ final-arrival agent_id`. Agents whose
// parseCrossReviewResponse threw (or returned zero entries) had ALREADY been
// deleted from pendingNativeAgents at handler entry, so they were missing from
// BOTH sources. Their late prose-only relays would then miss the warning even
// though they were legitimate cross-review participants.
//
// Fix: a separate `participatingNativeAgents` set is populated at
// round-creation and never mutated. The completion path seeds
// recentConsensusAgentIds from THIS set, guaranteeing every original
// participant is covered regardless of parse outcome.

describe('handleRelayCrossReview — parse-failure agents seeded into recentConsensusAgentIds', () => {
  const PARSE_FAIL_CONSENSUS = 'beadbead-feedfeed';
  const AGENT_A = 'reviewer-a';
  const AGENT_B = 'reviewer-b';
  const AGENT_C = 'reviewer-c';

  it('after completion, ALL participating agents (including parse-failed) end up in recentConsensusAgentIds', async () => {
    // Wire mainAgent so handleRelayCrossReview can build a parse-only engine.
    // getLlm() returns undefined → handler uses no-op shim, parseCrossReviewResponse runs.
    ctx.mainAgent = {
      ...ctx.mainAgent,
      projectRoot: testDir,
      getLlm: () => undefined,
      getAgentConfig: () => undefined,
    } as any;

    const pending = new Set([AGENT_A, AGENT_B, AGENT_C]);
    ctx.pendingConsensusRounds.set(PARSE_FAIL_CONSENSUS, {
      consensusId: PARSE_FAIL_CONSENSUS,
      allResults: [
        { agentId: AGENT_A, status: 'completed', result: '<agent_finding type="finding" severity="LOW">a</agent_finding>', task: 't' },
        { agentId: AGENT_B, status: 'completed', result: '<agent_finding type="finding" severity="LOW">b</agent_finding>', task: 't' },
        { agentId: AGENT_C, status: 'completed', result: '<agent_finding type="finding" severity="LOW">c</agent_finding>', task: 't' },
      ],
      relayCrossReviewEntries: [],
      relayCrossReviewSkipped: undefined,
      pendingNativeAgents: pending,
      participatingNativeAgents: new Set(pending),
      nativeCrossReviewEntries: [],
      deadline: Date.now() + 60_000,
      createdAt: Date.now(),
      nativePrompts: [],
    });

    const { handleRelayCrossReview } = await import('../../apps/cli/src/handlers/relay-cross-review');

    // Agent A: malformed payload — parseCrossReviewResponse throws.
    // Handler catches, records parseError, but does NOT re-add A to pendingNativeAgents.
    // Pre-fix: A is now invisible to the completion-path snapshot.
    await handleRelayCrossReview(PARSE_FAIL_CONSENSUS, AGENT_A, '{not valid json at all');

    // Agent B: valid payload, accepted entry (peer references AGENT_A).
    const validBPayload = JSON.stringify([
      { action: 'agree', findingId: `${AGENT_A}:f1`, peerAgentId: AGENT_A, finding: 'B agrees with A', confidence: 4 },
    ]);
    await handleRelayCrossReview(PARSE_FAIL_CONSENSUS, AGENT_B, validBPayload);

    // Agent C: final arrival, valid payload — triggers completion path.
    // Synthesis will bail (no LLM), but the seed happens BEFORE that.
    const validCPayload = JSON.stringify([
      { action: 'agree', findingId: `${AGENT_B}:f1`, peerAgentId: AGENT_B, finding: 'C agrees with B', confidence: 4 },
    ]);
    await handleRelayCrossReview(PARSE_FAIL_CONSENSUS, AGENT_C, validCPayload);

    // Round was deleted by completion path
    expect(ctx.pendingConsensusRounds.has(PARSE_FAIL_CONSENSUS)).toBe(false);

    // ALL THREE agents must be in recentConsensusAgentIds — including A who
    // contributed zero parsed entries due to malformed JSON.
    expect(ctx.recentConsensusAgentIds.has(AGENT_A)).toBe(true);
    expect(ctx.recentConsensusAgentIds.has(AGENT_B)).toBe(true);
    expect(ctx.recentConsensusAgentIds.has(AGENT_C)).toBe(true);
  });
});
