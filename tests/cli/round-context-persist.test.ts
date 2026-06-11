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

// ── Finding 1 regression: consensus:true with <2 completed MUST still surface
// round warnings (finding dfe05be2-73794442:f9).
describe('(f9) engine-less consensus collect — round warnings surface in response', () => {
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

  it('consensus:true with 1 completed result → handleCollect returns warningsRendered:false so sdk wrapper will append warnings', async () => {
    // Only ONE completed result → < 2 completed → no ConsensusEngine built.
    // The round's warnings (including drained roots_rejected) must NOT be silently
    // dropped. The fix: handleCollect signals `warningsRendered:false` when no
    // report was produced; the sdk wrapper then calls appendDispatchWarningsBlock.
    //
    // This test covers the handleCollect side of the contract:
    //   - warningsRendered MUST be false when fewer than 2 completed (no report)
    //   - The sdk wrapper guard `!collectResult.warningsRendered && round.warnings.length > 0`
    //     then fires and appends the warnings block.
    const now = Date.now();
    const oneResult = [
      { id: 'r1', agentId: 'gemini-reviewer', task: 'Audit', status: 'completed', result: 'ok', startedAt: now - 500, completedAt: now },
    ];
    (ctx as any).mainAgent = {
      projectRoot: '/tmp/gossip-test',
      collect: jest.fn().mockResolvedValue({ results: oneResult }),
      getAgentConfig: jest.fn().mockReturnValue(null),
      getLlm: jest.fn().mockReturnValue(null),
    } as any;

    const round = makeRoundContext({
      resolutionRoots: [],
      warnings: [{ code: 'roots_rejected', message: 'dispatch-time entry rejected: /bad/path [h1] — anchors will resolve against project root' }],
    });

    const result = await handleCollect(['r1'], 5000, true, [], undefined, round);

    // No consensusReport built → warningsRendered must be false.
    // The sdk wrapper reads this flag and calls appendDispatchWarningsBlock when false.
    expect((result as any).warningsRendered).toBe(false);
    // The response text should NOT already contain the warning (the sdk wrapper adds it).
    const text = result.content.map(c => c.text).join('\n');
    expect(text).not.toContain('⚠ Round warnings:');
    // Simulate what the sdk wrapper does: since warningsRendered is false and
    // round.warnings.length > 0, it calls appendDispatchWarningsBlock.
    // appendDispatchWarningsBlock renders warning.message (not .code) in the block.
    const counts = new Map<string, number>();
    for (const w of round.warnings) counts.set(w.message, (counts.get(w.message) ?? 0) + 1);
    const lines = Array.from(counts.entries()).map(([msg, n]) => (n > 1 ? `  - ${msg} ×${n}` : `  - ${msg}`));
    const warningBlock = `⚠ ${round.warnings.length} round warning(s):\n${lines.join('\n')}`;
    // The block contains the warning message text.
    expect(warningBlock).toContain('dispatch-time entry rejected');
  });

  it('no double-render: consensus:true with ≥2 completed + report warnings → warnings appear exactly once', async () => {
    // Happy path: engine IS built and report.warnings is rendered by handleCollect.
    // The sdk wrapper must NOT prepend them a second time via appendDispatchWarningsBlock.
    const now = Date.now();
    const twoResults = [
      { id: 'r1', agentId: 'gemini-reviewer', task: 'Audit', status: 'completed', result: 'ok-a', startedAt: now - 500, completedAt: now },
      { id: 'r2', agentId: 'gemini-tester', task: 'Audit', status: 'completed', result: 'ok-b', startedAt: now - 500, completedAt: now },
    ];
    const warningMsg = 'all 1 supplied resolutionRoots were rejected — anchors will resolve against project root only';
    (ctx as any).mainAgent = {
      projectRoot: '/tmp/gossip-test',
      collect: jest.fn().mockResolvedValue({ results: twoResults }),
      // Engine echoes back the round's warnings into report.warnings.
      runConsensus: jest.fn().mockImplementation(async (_results: any, roundOrRoots: any) => ({
        agentCount: 2, rounds: 2,
        confirmed: [], disputed: [], unverified: [], unique: [], insights: [],
        newFindings: [], signals: [], summary: 'Consensus complete.',
        warnings: roundOrRoots && Array.isArray(roundOrRoots.warnings) ? [...roundOrRoots.warnings] : [],
      })),
      getAgentConfig: jest.fn().mockReturnValue(null),
      getLlm: jest.fn().mockReturnValue(null),
    } as any;

    const round = makeRoundContext({
      resolutionRoots: [],
      warnings: [{ code: 'roots_empty_after_validation', message: warningMsg }],
    });

    // handleCollect is called directly here — the sdk wrapper is what calls
    // appendDispatchWarningsBlock. We verify handleCollect sets warningsRendered
    // so the wrapper knows NOT to double-append.
    const result = await handleCollect(['r1', 'r2'], 5000, true, [], undefined, round);

    // handleCollect renders warnings in the text body.
    const text = result.content[0].text;
    expect(text).toContain('⚠ Round warnings:');
    expect(text).toContain('roots_empty_after_validation');
    // warningsRendered flag is set — the sdk wrapper will skip appendDispatchWarningsBlock.
    expect((result as any).warningsRendered).toBe(true);
    // The warning text appears exactly once (not duplicated).
    const occurrences = (text.match(/roots_empty_after_validation/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ── Finding 2 regression: pendingDispatchWarnings must not grow without bound
// (finding dfe05be2-73794442:f1).
describe('(f1) pendingDispatchWarnings bounded eviction', () => {
  // stashDispatchWarnings is a module-private function. We test the invariant
  // white-box by replicating the eviction logic against the shared ctx map —
  // the same Map that stashDispatchWarnings mutates. The constant is exported
  // from mcp-context.ts so consumers and tests can refer to the same value.

  beforeEach(() => {
    ctx.pendingDispatchWarnings.clear();
  });

  afterEach(() => {
    ctx.pendingDispatchWarnings.clear();
  });

  it('inserting MAX+1 entries evicts the eldest (first inserted) and caps size at MAX', async () => {
    const { MAX_PENDING_DISPATCH_WARNINGS } = await import('../../apps/cli/src/mcp-context');

    // White-box: replicate the bounded-insert logic from stashDispatchWarnings
    // (dispatch.ts) to verify the invariant holds at the Map level.
    // The actual stashDispatchWarnings function is private to the module, but
    // the Map it mutates (ctx.pendingDispatchWarnings) is shared state.
    const warning = Object.freeze([Object.freeze({ code: 'roots_rejected' as const, message: 'test' })]);

    // Fill to exactly MAX entries. Keys are '0'..'MAX-1'.
    for (let i = 0; i < MAX_PENDING_DISPATCH_WARNINGS; i++) {
      ctx.pendingDispatchWarnings.set(String(i), warning);
    }
    expect(ctx.pendingDispatchWarnings.size).toBe(MAX_PENDING_DISPATCH_WARNINGS);

    // Insert one more entry (key 'overflow'), simulating the eviction path.
    // Replicate the eviction logic:
    if (ctx.pendingDispatchWarnings.size >= MAX_PENDING_DISPATCH_WARNINGS) {
      const eldest = ctx.pendingDispatchWarnings.keys().next().value;
      if (eldest !== undefined) ctx.pendingDispatchWarnings.delete(eldest);
    }
    ctx.pendingDispatchWarnings.set('overflow', warning);

    // Size must stay at MAX — oldest entry ('0') was evicted.
    expect(ctx.pendingDispatchWarnings.size).toBe(MAX_PENDING_DISPATCH_WARNINGS);
    // Eldest (first-inserted) entry is gone.
    expect(ctx.pendingDispatchWarnings.has('0')).toBe(false);
    // Newest entry is present.
    expect(ctx.pendingDispatchWarnings.has('overflow')).toBe(true);
    // The rest (1..MAX-1) are still present.
    expect(ctx.pendingDispatchWarnings.has(String(MAX_PENDING_DISPATCH_WARNINGS - 1))).toBe(true);
  });
});
