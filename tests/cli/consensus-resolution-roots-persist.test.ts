/**
 * Tests for PendingConsensusRound.resolutionRoots persistence and
 * consensus.autoDiscoverWorktrees config flag (#126 PR-B).
 */
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateConfig } from '../../apps/cli/src/config';
import { persistPendingConsensus, restorePendingConsensus } from '../../apps/cli/src/handlers/relay-cross-review';
import { ctx } from '../../apps/cli/src/mcp-context';

describe('config.consensus.autoDiscoverWorktrees', () => {
  it('accepts explicit true', () => {
    const cfg = validateConfig({
      main_agent: { provider: 'anthropic', model: 'x' },
      consensus: { autoDiscoverWorktrees: true },
    });
    expect(cfg.consensus?.autoDiscoverWorktrees).toBe(true);
  });

  it('accepts explicit false', () => {
    const cfg = validateConfig({
      main_agent: { provider: 'anthropic', model: 'x' },
      consensus: { autoDiscoverWorktrees: false },
    });
    expect(cfg.consensus?.autoDiscoverWorktrees).toBe(false);
  });

  it('defaults (omitted) is undefined', () => {
    const cfg = validateConfig({ main_agent: { provider: 'anthropic', model: 'x' } });
    expect(cfg.consensus).toBeUndefined();
  });

  it('rejects non-boolean', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'x' },
      consensus: { autoDiscoverWorktrees: 'yes' },
    })).toThrow(/boolean/);
  });

  it('rejects non-object consensus', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'x' },
      consensus: 'string',
    })).toThrow(/object/);
  });
});

describe('PendingConsensusRound.resolutionRoots persistence (Test 16)', () => {
  let tmp: string;
  let origCwd: string;
  let origMainAgent: any;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pcr-'));
    origCwd = process.cwd();
    process.chdir(tmp);
    mkdirSync(join(tmp, '.gossip'), { recursive: true });
    origMainAgent = (ctx as any).mainAgent;
    // Stub mainAgent.projectRoot for persistPendingConsensus.
    (ctx as any).mainAgent = { projectRoot: tmp } as any;
  });

  afterEach(() => {
    ctx.pendingConsensusRounds.clear();
    process.chdir(origCwd);
    (ctx as any).mainAgent = origMainAgent;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('persists and restores resolutionRoots across reconnect', () => {
    const roundId = 'deadbeef-cafebabe';
    const roots = [tmp + '/worktrees/feature-x'];
    ctx.pendingConsensusRounds.set(roundId, {
      consensusId: roundId,
      allResults: [],
      relayCrossReviewEntries: [],
      pendingNativeAgents: new Set(['sonnet']),
      nativeCrossReviewEntries: [],
      deadline: Date.now() + 60_000,
      createdAt: Date.now(),
      resolutionRoots: roots,
    });
    persistPendingConsensus();

    const persisted = join(tmp, '.gossip', 'pending-consensus.json');
    expect(existsSync(persisted)).toBe(true);
    const raw = JSON.parse(readFileSync(persisted, 'utf-8'));
    expect(raw[roundId].resolutionRoots).toEqual(roots);

    // Clear + restore
    ctx.pendingConsensusRounds.clear();
    restorePendingConsensus(tmp);
    const restored = ctx.pendingConsensusRounds.get(roundId);
    expect(restored).toBeDefined();
    expect(restored!.resolutionRoots).toEqual(roots);
  });

  it('restore tolerates a round written without resolutionRoots', () => {
    const roundId = 'aaaaaaaa-bbbbbbbb';
    ctx.pendingConsensusRounds.set(roundId, {
      consensusId: roundId,
      allResults: [],
      relayCrossReviewEntries: [],
      pendingNativeAgents: new Set(),
      nativeCrossReviewEntries: [],
      deadline: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    persistPendingConsensus();
    ctx.pendingConsensusRounds.clear();
    restorePendingConsensus(tmp);
    const restored = ctx.pendingConsensusRounds.get(roundId);
    expect(restored).toBeDefined();
    expect(restored!.resolutionRoots).toBeUndefined();
  });
});
