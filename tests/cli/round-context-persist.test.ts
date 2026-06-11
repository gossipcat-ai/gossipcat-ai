/**
 * RoundContext disk back-compat + drain-rendering seams (spec
 * 2026-06-11-round-context-fail-loud.md §3.2/§5/§6.1, consensus
 * 5e9804d3-91fe440d).
 *
 * Covers:
 *   (c) old-flat-shape restore: a pre-PR-A pending-consensus.json (no embedded
 *       roundContext) restores with roots intact AND a reconstructed
 *       RoundContext.
 *   embedded roundContext persist→restore round-trip (resolutionRoots +
 *       warnings + lenses survive /mcp reconnect).
 *   (d) drain rendering: a consensus report carrying warnings renders a
 *       "Round warnings" block in the gossip_collect tool response.
 *
 * GAP NOTE: the MCP-boundary producer (mcp-server-sdk.ts gossip_collect handler
 * appending roots_rejected / roots_empty_after_validation) is inline in the
 * server tool closure and not independently importable. Its EFFECT — warnings
 * threaded through the round into report.warnings and rendered — is what these
 * tests pin, by injecting the warnings at the round boundary the producer feeds.
 * The producer logic itself (one warning per rejected entry, +1 when all
 * rejected) is small and unit-covered via the coordinator drain seam in
 * tests/orchestrator/round-context-seams.test.ts.
 */
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { persistPendingConsensus, restorePendingConsensus } from '../../apps/cli/src/handlers/relay-cross-review';
import { handleCollect } from '../../apps/cli/src/handlers/collect';
import { ctx } from '../../apps/cli/src/mcp-context';
import { makeRoundContext } from '@gossip/orchestrator';

describe('RoundContext disk persistence (spec §3.2)', () => {
  let tmp: string;
  let origCwd: string;
  let origMainAgent: any;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rcp-'));
    origCwd = process.cwd();
    process.chdir(tmp);
    mkdirSync(join(tmp, '.gossip'), { recursive: true });
    origMainAgent = (ctx as any).mainAgent;
    (ctx as any).mainAgent = { projectRoot: tmp } as any;
  });

  afterEach(() => {
    ctx.pendingConsensusRounds.clear();
    process.chdir(origCwd);
    (ctx as any).mainAgent = origMainAgent;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('persists + restores the embedded roundContext (roots + warnings + lenses)', () => {
    const roundId = 'deadbeef-cafebabe';
    const roots = [tmp + '/worktrees/feature-x'];
    const roundContext = makeRoundContext({
      consensusId: roundId,
      resolutionRoots: roots,
      lenses: { 'sonnet': 'security lens' },
      warnings: [{ code: 'roots_rejected', message: 'entry y rejected' }],
    });
    ctx.pendingConsensusRounds.set(roundId, {
      consensusId: roundId,
      allResults: [],
      relayCrossReviewEntries: [],
      pendingNativeAgents: new Set(['sonnet']),
      participatingNativeAgents: new Set(['sonnet']),
      nativeCrossReviewEntries: [],
      deadline: Date.now() + 60_000,
      createdAt: Date.now(),
      resolutionRoots: roots,
      roundContext,
    });
    persistPendingConsensus();

    const raw = JSON.parse(readFileSync(join(tmp, '.gossip', 'pending-consensus.json'), 'utf-8'));
    expect(raw[roundId].roundContext.resolutionRoots).toEqual(roots);
    expect(raw[roundId].roundContext.warnings).toHaveLength(1);
    expect(raw[roundId].roundContext.lenses).toEqual({ sonnet: 'security lens' });

    ctx.pendingConsensusRounds.clear();
    restorePendingConsensus(tmp);
    const restored = ctx.pendingConsensusRounds.get(roundId);
    expect(restored).toBeDefined();
    expect(restored!.roundContext).toBeDefined();
    expect(restored!.roundContext!.resolutionRoots).toEqual(roots);
    expect(restored!.roundContext!.warnings).toHaveLength(1);
    expect(restored!.roundContext!.warnings[0].code).toBe('roots_rejected');
    expect(restored!.roundContext!.lenses).toEqual({ sonnet: 'security lens' });
    // Flat field stays populated in parallel (alias mode).
    expect(restored!.resolutionRoots).toEqual(roots);
  });

  it('(c) old flat-shape file (no roundContext) restores with roots intact + reconstructed round', () => {
    const roundId = 'aaaabbbb-ccccdddd';
    const roots = [tmp + '/worktrees/legacy'];
    // Hand-write a PRE-MIGRATION pending-consensus.json: flat resolutionRoots,
    // NO roundContext field (the exact shape a pre-PR-A binary persisted).
    const flat = {
      [roundId]: {
        consensusId: roundId,
        allResults: [],
        relayCrossReviewEntries: [],
        relayCrossReviewSkipped: undefined,
        pendingNativeAgents: ['sonnet'],
        participatingNativeAgents: ['sonnet'],
        nativeCrossReviewEntries: [],
        deadline: Date.now() + 60_000,
        createdAt: Date.now(),
        nativePrompts: [],
        resolutionRoots: roots,
      },
    };
    writeFileSync(join(tmp, '.gossip', 'pending-consensus.json'), JSON.stringify(flat));

    restorePendingConsensus(tmp);
    const restored = ctx.pendingConsensusRounds.get(roundId);
    expect(restored).toBeDefined();
    // Flat roots survive.
    expect(restored!.resolutionRoots).toEqual(roots);
    // A RoundContext is reconstructed from the flat roots (per-field fallback).
    expect(restored!.roundContext).toBeDefined();
    expect(restored!.roundContext!.resolutionRoots).toEqual(roots);
    expect(restored!.roundContext!.warnings).toEqual([]);
    // No lenses field existed in the flat record — the reconstructed round must
    // not invent one (back-compat lenses behavior, spec §5 lens-propagation).
    expect(restored!.roundContext!.lenses).toBeUndefined();
  });

  it('new-format record with intentionally-empty roundContext.resolutionRoots is honored (not flat-fallback)', () => {
    // A NEW-format record may legitimately carry roundContext.resolutionRoots:[]
    // ("resolve against project root"). The restore MUST honor that empty array
    // as authoritative — NOT fall through to a stale flat resolutionRoots. This
    // pins the `??`-semantics fix (no length-gated fallback).
    const roundId = '11112222-33334444';
    const record = {
      [roundId]: {
        consensusId: roundId,
        allResults: [],
        relayCrossReviewEntries: [],
        pendingNativeAgents: ['sonnet'],
        participatingNativeAgents: ['sonnet'],
        nativeCrossReviewEntries: [],
        deadline: Date.now() + 60_000,
        createdAt: Date.now(),
        nativePrompts: [],
        // A divergent flat value that MUST be ignored in favor of the embedded
        // empty roundContext.resolutionRoots.
        resolutionRoots: [tmp + '/stale/flat'],
        roundContext: {
          consensusId: roundId,
          resolutionRoots: [],
          warnings: [{ code: 'roots_empty_after_validation', message: 'all rejected' }],
        },
      },
    };
    writeFileSync(join(tmp, '.gossip', 'pending-consensus.json'), JSON.stringify(record));

    restorePendingConsensus(tmp);
    const restored = ctx.pendingConsensusRounds.get(roundId);
    expect(restored).toBeDefined();
    expect(restored!.roundContext).toBeDefined();
    // Embedded empty roots win — the stale flat value is NOT resurrected.
    expect(restored!.roundContext!.resolutionRoots).toEqual([]);
    expect(restored!.roundContext!.warnings).toHaveLength(1);
  });

  it('(restore-hardening) drops malformed warnings/roots/lenses entries with a round_restore_malformed warning, fail-open', () => {
    const roundId = 'badc0ffe-0ddba11';
    const goodRoot = tmp + '/worktrees/ok';
    const record = {
      [roundId]: {
        consensusId: roundId,
        allResults: [],
        relayCrossReviewEntries: [],
        pendingNativeAgents: ['sonnet'],
        participatingNativeAgents: ['sonnet'],
        nativeCrossReviewEntries: [],
        deadline: Date.now() + 60_000,
        createdAt: Date.now(),
        nativePrompts: [],
        roundContext: {
          consensusId: roundId,
          // One valid string root + one non-string entry that must be dropped.
          resolutionRoots: [goodRoot, 42],
          // One valid warning + one missing message + one non-object.
          warnings: [
            { code: 'roots_rejected', message: 'ok one' },
            { code: 'roots_rejected' },          // missing message → drop
            'not-an-object',                       // non-object → drop
            { code: 'cross_review_skipped', message: 'm', agentId: 99 }, // non-string agentId → drop
          ],
          // Non-string lens value must be dropped; valid one kept.
          lenses: { good: 'lens text', bad: 123 },
        },
      },
    };
    writeFileSync(join(tmp, '.gossip', 'pending-consensus.json'), JSON.stringify(record));

    restorePendingConsensus(tmp);
    const restored = ctx.pendingConsensusRounds.get(roundId);
    expect(restored).toBeDefined();
    const rc = restored!.roundContext!;
    // Non-string root dropped, valid one kept.
    expect(rc.resolutionRoots).toEqual([goodRoot]);
    // Valid lens kept, non-string dropped.
    expect(rc.lenses).toEqual({ good: 'lens text' });
    // One valid warning + round_restore_malformed drop-notices appended.
    const valid = rc.warnings.filter(w => w.code === 'roots_rejected');
    const drops = rc.warnings.filter(w => w.code === 'round_restore_malformed');
    expect(valid).toHaveLength(1);
    expect(valid[0].message).toBe('ok one');
    // At least one drop notice (roots + warnings + lenses each produce one).
    expect(drops.length).toBeGreaterThanOrEqual(3);
    expect(drops.every(d => d.message.startsWith('restore dropped malformed'))).toBe(true);
  });

  it('(restore-hardening) a warnings field that is not an array is dropped-with-warning, round still restores', () => {
    const roundId = 'feed0000-1111feed';
    const record = {
      [roundId]: {
        consensusId: roundId,
        allResults: [],
        relayCrossReviewEntries: [],
        pendingNativeAgents: ['sonnet'],
        participatingNativeAgents: ['sonnet'],
        nativeCrossReviewEntries: [],
        deadline: Date.now() + 60_000,
        createdAt: Date.now(),
        nativePrompts: [],
        roundContext: {
          consensusId: roundId,
          resolutionRoots: [tmp + '/wt'],
          warnings: 'corrupt-not-array',
        },
      },
    };
    writeFileSync(join(tmp, '.gossip', 'pending-consensus.json'), JSON.stringify(record));

    restorePendingConsensus(tmp);
    const rc = ctx.pendingConsensusRounds.get(roundId)!.roundContext!;
    expect(rc.resolutionRoots).toEqual([tmp + '/wt']);
    const drops = rc.warnings.filter(w => w.code === 'round_restore_malformed');
    expect(drops).toHaveLength(1);
    expect(drops[0].message).toContain('warnings field');
  });

  it('(restore-hardening) old flat shape still restores cleanly (back-compat path intact)', () => {
    // The deep-hardening must NOT regress the data.roundContext?.x ?? data.x
    // flat-shape read path. A pre-PR-A flat record restores with NO spurious
    // round_restore_malformed warnings.
    const roundId = 'c0ffee00-babe1234';
    const roots = [tmp + '/worktrees/flat'];
    const flat = {
      [roundId]: {
        consensusId: roundId,
        allResults: [],
        relayCrossReviewEntries: [],
        pendingNativeAgents: ['sonnet'],
        participatingNativeAgents: ['sonnet'],
        nativeCrossReviewEntries: [],
        deadline: Date.now() + 60_000,
        createdAt: Date.now(),
        nativePrompts: [],
        resolutionRoots: roots,
      },
    };
    writeFileSync(join(tmp, '.gossip', 'pending-consensus.json'), JSON.stringify(flat));

    restorePendingConsensus(tmp);
    const rc = ctx.pendingConsensusRounds.get(roundId)!.roundContext!;
    expect(rc.resolutionRoots).toEqual(roots);
    expect(rc.warnings).toEqual([]);
  });

  it('(c) old flat-shape file with NO roots reconstructs no round (legacy rootless)', () => {
    const roundId = 'eeeeffff-00001111';
    const flat = {
      [roundId]: {
        consensusId: roundId,
        allResults: [],
        relayCrossReviewEntries: [],
        pendingNativeAgents: [],
        participatingNativeAgents: [],
        nativeCrossReviewEntries: [],
        deadline: Date.now() + 60_000,
        createdAt: Date.now(),
        nativePrompts: [],
      },
    };
    writeFileSync(join(tmp, '.gossip', 'pending-consensus.json'), JSON.stringify(flat));

    restorePendingConsensus(tmp);
    const restored = ctx.pendingConsensusRounds.get(roundId);
    expect(restored).toBeDefined();
    expect(restored!.resolutionRoots).toBeUndefined();
    expect(restored!.roundContext).toBeUndefined();
  });
});

describe('(d) drain rendering — warnings block in gossip_collect response', () => {
  let origMainAgent: any;
  let origBoot: any;
  let origNativeConfigs: any;

  beforeEach(() => {
    origMainAgent = (ctx as any).mainAgent;
    origBoot = ctx.boot;
    origNativeConfigs = ctx.nativeAgentConfigs;
    ctx.boot = jest.fn().mockResolvedValue(undefined) as any;
    ctx.nativeAgentConfigs = new Map();
    ctx.pendingConsensusRounds = new Map();
    ctx.nativeResultMap = new Map();
    ctx.nativeTaskMap = new Map();
  });

  afterEach(() => {
    (ctx as any).mainAgent = origMainAgent;
    ctx.boot = origBoot;
    ctx.nativeAgentConfigs = origNativeConfigs;
    ctx.pendingConsensusRounds.clear();
  });

  it('renders a "Round warnings" block when the report carries warnings', async () => {
    const now = Date.now();
    const twoRelayResults = [
      { id: 't1', agentId: 'gemini-reviewer', task: 'Audit', status: 'completed', result: 'ok-a', startedAt: now - 1000, completedAt: now },
      { id: 't2', agentId: 'gemini-tester', task: 'Audit', status: 'completed', result: 'ok-b', startedAt: now - 1000, completedAt: now },
    ];
    (ctx as any).mainAgent = {
      projectRoot: '/tmp/gossip-test',
      collect: jest.fn().mockResolvedValue({ results: twoRelayResults }),
      // Emulate the engine drain: report carries the round's warnings.
      runConsensus: jest.fn().mockResolvedValue({
        agentCount: 2, rounds: 2,
        confirmed: [], disputed: [], unverified: [], unique: [], insights: [],
        newFindings: [], signals: [], summary: 'Consensus complete.',
        warnings: [
          { code: 'roots_empty_after_validation', message: 'all 2 supplied resolutionRoots were rejected' },
        ],
      }),
      getAgentConfig: jest.fn().mockReturnValue(null),
      getLlm: jest.fn().mockReturnValue(null),
    } as any;

    // Pass a round whose warnings the (mocked) engine will drain.
    const round = makeRoundContext({
      resolutionRoots: [],
      warnings: [{ code: 'roots_empty_after_validation', message: 'all 2 supplied resolutionRoots were rejected' }],
    });
    const result = await handleCollect(['t1', 't2'], 5000, true, [], undefined, round);
    const text = result.content[0].text;
    expect(text).toContain('⚠ Round warnings:');
    expect(text).toContain('roots_empty_after_validation');
    expect(text).toContain('all 2 supplied resolutionRoots were rejected');
  });

  it('renders NO warnings block when the report has none (clean round regression)', async () => {
    const now = Date.now();
    const twoRelayResults = [
      { id: 't1', agentId: 'gemini-reviewer', task: 'Audit', status: 'completed', result: 'ok-a', startedAt: now - 1000, completedAt: now },
      { id: 't2', agentId: 'gemini-tester', task: 'Audit', status: 'completed', result: 'ok-b', startedAt: now - 1000, completedAt: now },
    ];
    (ctx as any).mainAgent = {
      projectRoot: '/tmp/gossip-test',
      collect: jest.fn().mockResolvedValue({ results: twoRelayResults }),
      runConsensus: jest.fn().mockResolvedValue({
        agentCount: 2, rounds: 2,
        confirmed: [], disputed: [], unverified: [], unique: [], insights: [],
        newFindings: [], signals: [], summary: 'Consensus complete.',
      }),
      getAgentConfig: jest.fn().mockReturnValue(null),
      getLlm: jest.fn().mockReturnValue(null),
    } as any;

    const result = await handleCollect(['t1', 't2'], 5000, true, [], undefined, makeRoundContext());
    expect(result.content[0].text).not.toContain('Round warnings');
  });
});

describe('(§3.2 boundary #1) dispatch-time warnings stash → collect drain', () => {
  let origMainAgent: any;
  let origBoot: any;
  let origNativeConfigs: any;

  beforeEach(() => {
    origMainAgent = (ctx as any).mainAgent;
    origBoot = ctx.boot;
    origNativeConfigs = ctx.nativeAgentConfigs;
    ctx.boot = jest.fn().mockResolvedValue(undefined) as any;
    ctx.nativeAgentConfigs = new Map();
    ctx.pendingConsensusRounds = new Map();
    ctx.nativeResultMap = new Map();
    ctx.nativeTaskMap = new Map();
    ctx.pendingDispatchWarnings = new Map();
  });

  afterEach(() => {
    (ctx as any).mainAgent = origMainAgent;
    ctx.boot = origBoot;
    ctx.nativeAgentConfigs = origNativeConfigs;
    ctx.pendingConsensusRounds.clear();
    ctx.pendingDispatchWarnings.clear();
  });

  it('a dispatch-time rejection stashed under a task_id is drained into the collect-built round and surfaces in report.warnings', async () => {
    const now = Date.now();
    const twoRelayResults = [
      { id: 't1', agentId: 'gemini-reviewer', task: 'Audit', status: 'completed', result: 'ok-a', startedAt: now - 1000, completedAt: now },
      { id: 't2', agentId: 'gemini-tester', task: 'Audit', status: 'completed', result: 'ok-b', startedAt: now - 1000, completedAt: now },
    ];

    // Simulate what stashDispatchWarnings did: stash the SAME frozen array
    // under every minted task_id (no consensus round exists at dispatch time).
    const dispatchWarning = { code: 'roots_rejected' as const, message: 'dispatch-time entry rejected: not found [h0]' };
    const stashed = Object.freeze([Object.freeze({ ...dispatchWarning })]) as readonly typeof dispatchWarning[];
    ctx.pendingDispatchWarnings.set('t1', stashed);
    ctx.pendingDispatchWarnings.set('t2', stashed);

    // Reproduce the collect-handler drain: pull stashed warnings for the
    // task_ids into the round (dedup by stored array reference), consume the
    // stash, then build the round the handler forwards to handleCollect.
    const round = makeRoundContext({ resolutionRoots: [], warnings: [] });
    const seen = new Set<readonly typeof dispatchWarning[]>();
    for (const tid of ['t1', 't2']) {
      const stashed = ctx.pendingDispatchWarnings.get(tid) as readonly typeof dispatchWarning[] | undefined;
      if (stashed && stashed.length > 0 && !seen.has(stashed)) {
        seen.add(stashed);
        for (const w of stashed) round.warnings.push({ ...w });
      }
      ctx.pendingDispatchWarnings.delete(tid);
    }
    // Both task_ids shared the SAME array reference → drained exactly once.
    expect(round.warnings).toHaveLength(1);
    // Stash consumed.
    expect(ctx.pendingDispatchWarnings.size).toBe(0);

    (ctx as any).mainAgent = {
      projectRoot: '/tmp/gossip-test',
      collect: jest.fn().mockResolvedValue({ results: twoRelayResults }),
      // Emulate the engine drain: the round's warnings reach report.warnings.
      runConsensus: jest.fn().mockImplementation(async (_results: any, roundOrRoots: any) => ({
        agentCount: 2, rounds: 2,
        confirmed: [], disputed: [], unverified: [], unique: [], insights: [],
        newFindings: [], signals: [], summary: 'Consensus complete.',
        warnings: roundOrRoots && Array.isArray(roundOrRoots.warnings) ? [...roundOrRoots.warnings] : [],
      })),
      getAgentConfig: jest.fn().mockReturnValue(null),
      getLlm: jest.fn().mockReturnValue(null),
    } as any;

    const result = await handleCollect(['t1', 't2'], 5000, true, [], undefined, round);
    const text = result.content[0].text;
    // The dispatch-time rejection is visible in the collect-built round's report.
    expect(text).toContain('⚠ Round warnings:');
    expect(text).toContain('roots_rejected');
    expect(text).toContain('dispatch-time entry rejected');
  });
});
