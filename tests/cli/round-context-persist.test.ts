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
