/**
 * RoundContext + fail-loud seam tests (spec 2026-06-11-round-context-fail-loud.md §5,
 * consensus 5e9804d3-91fe440d).
 *
 * These tests pin the PR-A alias-mode threading at the layers the existing test
 * utilities can drive without a giant new harness:
 *   (a) coordinator-level: a RoundContext passed to runConsensus reaches the
 *       ConsensusEngine config (the Test 21 e2e content path is covered by
 *       consensus-engine-resolution-roots.test.ts:289; here we prove the round
 *       OBJECT — carrying warnings — reaches the engine).
 *   (d) boundary producer: round.warnings drain into report.warnings.
 *   (e) round supplied at coordinator.runConsensus WINS over the legacy roots arg.
 *   (f) lenses Record survives a JSON.stringify/parse round-trip.
 *   (g) legacy mode regression: no round → engine seeds from loose resolutionRoots,
 *       byte-identical to the pre-RoundContext path.
 *
 * The handleCollect-level all-relay seam (a') and the timeout-synthesis seam (b)
 * are driven through the disk-restore boundary in
 * tests/cli/round-context-persist.test.ts (closest layer the CLI utilities
 * support without mocking the relay transport). See the gap note there.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  makeRoundContext,
  testRound,
  type RoundContext,
  type RoundWarning,
} from '../../packages/orchestrator/src/round-context';

// Capture the config each ConsensusEngine is constructed with, while stubbing
// out the heavy run()/synthesize() path. Mirrors the plumbing-suite stub so the
// coordinator test stays fast and deterministic. The stub's run() RETURNS the
// round's warnings inside the report so we can assert the drain end-to-end at
// the coordinator boundary without exercising the real synthesize().
const engineConfigs: Array<{ resolutionRoots?: readonly string[]; round?: RoundContext }> = [];

jest.mock('../../packages/orchestrator/src/consensus-engine', () => {
  const actual = jest.requireActual('../../packages/orchestrator/src/consensus-engine');
  class StubEngine {
    config: any;
    constructor(config: any) {
      this.config = config;
      engineConfigs.push(config);
    }
    async run() {
      // Emulate the real synthesize() drain: copy round.warnings into the
      // report when a round carries any (spec §6.1).
      const warnings = this.config.round?.warnings ?? [];
      return {
        agentCount: 2,
        rounds: 2,
        confirmed: [], disputed: [], unverified: [], unique: [],
        insights: [], newFindings: [], signals: [],
        summary: 'stub',
        ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
      };
    }
  }
  return { ...actual, ConsensusEngine: StubEngine };
});

import { ConsensusCoordinator } from '../../packages/orchestrator/src/consensus-coordinator';
import type { TaskEntry } from '../../packages/orchestrator/src/types';

const makeLlm = (): any => ({
  generate: jest.fn(async () => ({ text: '[]', usage: { inputTokens: 0, outputTokens: 0 } })),
});

const completed = (agentId: string): TaskEntry => ({
  id: `t-${agentId}`,
  agentId,
  task: 'review X',
  status: 'completed',
  result: '<agent_finding type="finding" severity="low">noted</agent_finding>',
  startedAt: Date.now(),
});

describe('round-context.ts — makeRoundContext / testRound shape', () => {
  it('makeRoundContext defaults resolutionRoots to [] and warnings to a fresh array', () => {
    const r = makeRoundContext();
    expect(r.resolutionRoots).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.consensusId).toBeUndefined();
    expect(r.lenses).toBeUndefined();
  });

  it('makeRoundContext never aliases warnings arrays between rounds', () => {
    const a = makeRoundContext();
    const b = makeRoundContext();
    a.warnings.push({ code: 'roots_rejected', message: 'x' });
    expect(b.warnings).toHaveLength(0);
  });

  it('makeRoundContext preserves a supplied warnings array reference (boundary producer pattern)', () => {
    const shared: RoundWarning[] = [{ code: 'roots_rejected', message: 'a' }];
    const r = makeRoundContext({ resolutionRoots: ['/abs/x'], warnings: shared });
    expect(r.warnings).toBe(shared);
    expect(r.resolutionRoots).toEqual(['/abs/x']);
  });

  it('testRound fixture is overridable per field', () => {
    const r = testRound({ consensusId: 'abc', resolutionRoots: ['/r'] });
    expect(r.consensusId).toBe('abc');
    expect(r.resolutionRoots).toEqual(['/r']);
    expect(r.warnings).toEqual([]);
  });

  it('(f) lenses Record survives a JSON.stringify/parse round-trip intact', () => {
    const r = makeRoundContext({
      resolutionRoots: ['/abs/wt'],
      lenses: { 'agent-a': 'security lens', 'agent-b': 'perf lens' },
    });
    const roundTripped = JSON.parse(JSON.stringify(r)) as RoundContext;
    expect(roundTripped.lenses).toEqual({ 'agent-a': 'security lens', 'agent-b': 'perf lens' });
    // A Map would have serialized to {} — assert it did NOT.
    expect(Object.keys(roundTripped.lenses ?? {})).toHaveLength(2);
  });
});

describe('(a/e/g) coordinator.runConsensus alias-mode threading', () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    engineConfigs.length = 0;
    tmp = mkdtempSync(join(tmpdir(), 'rcs-'));
    root = realpathSync(tmp);
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('(a) a RoundContext passed to runConsensus reaches the engine config as `round`', async () => {
    const wt = realpathSync(mkdtempSync(join(tmp, 'wt')));
    const round = makeRoundContext({ resolutionRoots: [wt], consensusId: 'cafef00d' });
    const coordinator = new ConsensusCoordinator({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: root, keyProvider: null,
    });

    await coordinator.runConsensus([completed('relay-a'), completed('relay-b')], round);

    expect(engineConfigs).toHaveLength(1);
    expect(engineConfigs[0].round).toBe(round);
    // Round wins → the loose resolutionRoots field is NOT set in alias mode.
    expect(engineConfigs[0].resolutionRoots).toBeUndefined();
  });

  it('(e) a round arg WINS over the constructor default round', async () => {
    const ctorRound = makeRoundContext({ resolutionRoots: [realpathSync(mkdtempSync(join(tmp, 'ctor')))] });
    const perRoundRound = makeRoundContext({ resolutionRoots: [realpathSync(mkdtempSync(join(tmp, 'round')))] });
    const coordinator = new ConsensusCoordinator({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: root, keyProvider: null,
      round: ctorRound,
    });

    await coordinator.runConsensus([completed('relay-a'), completed('relay-b')], perRoundRound);
    expect(engineConfigs[engineConfigs.length - 1].round).toBe(perRoundRound);

    // No per-round arg → constructor default round is used.
    await coordinator.runConsensus([completed('relay-a'), completed('relay-b')]);
    expect(engineConfigs[engineConfigs.length - 1].round).toBe(ctorRound);
  });

  it('(g) legacy mode: no round, loose roots arg → engine gets resolutionRoots, no round (byte-identical)', async () => {
    const wt = realpathSync(mkdtempSync(join(tmp, 'legacy')));
    const coordinator = new ConsensusCoordinator({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: root, keyProvider: null,
    });

    await coordinator.runConsensus([completed('relay-a'), completed('relay-b')], [wt]);

    expect(engineConfigs[0].round).toBeUndefined();
    expect(engineConfigs[0].resolutionRoots).toEqual([wt]);
  });

  it('(d) round.warnings drain into the consensus report', async () => {
    const round = makeRoundContext({
      resolutionRoots: [],
      warnings: [
        { code: 'roots_empty_after_validation', message: 'all roots rejected' },
        { code: 'roots_rejected', message: 'entry x rejected' },
      ],
    });
    const coordinator = new ConsensusCoordinator({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: root, keyProvider: null,
    });

    const report = await coordinator.runConsensus([completed('relay-a'), completed('relay-b')], round);
    expect(report?.warnings).toBeDefined();
    expect(report!.warnings).toHaveLength(2);
    expect(report!.warnings!.map(w => w.code)).toEqual([
      'roots_empty_after_validation',
      'roots_rejected',
    ]);
  });
});

describe('(g) ConsensusEngine constructor — round-vs-legacy seeding parity', () => {
  let tmp: string;
  let root: string;
  let wt: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rcs-eng-'));
    root = realpathSync(tmp);
    wt = realpathSync(mkdtempSync(join(tmp, 'wt')));
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, 'src', 'A.ts'), 'worktree-copy');
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('round.resolutionRoots seeds currentWorktreeRoots identically to loose resolutionRoots', () => {
    // Use the REAL engine (the module mock above only swaps for the coordinator
    // import; here we requireActual to exercise the constructor seeding).
    const { ConsensusEngine: RealEngine } = jest.requireActual(
      '../../packages/orchestrator/src/consensus-engine',
    );
    const llm = makeLlm();

    const viaLegacy = new RealEngine({
      llm, registryGet: () => undefined, projectRoot: root, resolutionRoots: [wt],
    });
    const viaRound = new RealEngine({
      llm, registryGet: () => undefined, projectRoot: root,
      round: makeRoundContext({ resolutionRoots: [wt] }),
    });

    const legacyRoots: Set<string> = (viaLegacy as any).currentWorktreeRoots;
    const roundRoots: Set<string> = (viaRound as any).currentWorktreeRoots;
    expect([...roundRoots].sort()).toEqual([...legacyRoots].sort());
    expect(roundRoots.has(wt)).toBe(true);
  });

  it('round path enforces the same absolute-path invariant (throws on relative)', () => {
    const { ConsensusEngine: RealEngine } = jest.requireActual(
      '../../packages/orchestrator/src/consensus-engine',
    );
    expect(() => new RealEngine({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: root,
      round: makeRoundContext({ resolutionRoots: ['relative/path'] }),
    })).toThrow(/absolute/);
  });
});
