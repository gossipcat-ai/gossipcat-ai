/**
 * Tests for the worktree-isolation false-positive-attribution fix (issue #437).
 * Spec: docs/specs/2026-06-09-worktree-isolation-false-positive-attribution.md
 *       (incl. §8 consensus revisions).
 *
 * Two independent layers:
 *  - Layer A: orchestrator-owned path exclusion inside diffIsolationSnapshots.
 *    Built-in `.gossip/`/`.claude/` prefixes (never removable) + operator
 *    `orchestratorOwnedGlobs`, matched as STRING globs against repo-relative
 *    porcelain paths. `headChanged` stays a hard violation regardless.
 *  - Layer B: auto-restore becomes opt-in (GOSSIP_WORKTREE_AUTO_REVERT, default
 *    OFF). When OFF a detected leak is preserved + reported but master is left
 *    as-is; when ON the pre-#437 preserve-then-revert behaviour is byte-for-byte.
 *
 * Layer A / config are tested as pure functions; Layer B is tested through
 * handleNativeRelay with the same mock harness as relay-isolation-warning.test.ts.
 */
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  filterOrchestratorOwned,
  diffIsolationSnapshots,
  type IsolationSnapshot,
} from '../../apps/cli/src/handlers/worktree-isolation-detection';
import { validateConfig } from '../../apps/cli/src/config';

function snap(dirty: string[], head: string | null = 'a'.repeat(40)): IsolationSnapshot {
  return { head, dirty: [...dirty].sort(), takenAt: new Date().toISOString() };
}

// ─── Layer A — filterOrchestratorOwned (pure) ────────────────────────────────

describe('filterOrchestratorOwned', () => {
  it('excludes built-in .claude/ prefix paths', () => {
    const r = filterOrchestratorOwned(['.claude/knowledge-nominations.md']);
    expect(r.agentAttributable).toEqual([]);
    expect(r.excluded).toEqual(['.claude/knowledge-nominations.md']);
  });

  it('excludes built-in .gossip/ prefix paths', () => {
    const r = filterOrchestratorOwned(['.gossip/session-gossip.jsonl']);
    expect(r.agentAttributable).toEqual([]);
    expect(r.excluded).toEqual(['.gossip/session-gossip.jsonl']);
  });

  it('keeps source paths attributable while excluding infra paths', () => {
    const r = filterOrchestratorOwned([
      'packages/orchestrator/src/foo.ts',
      '.claude/notes.md',
    ]);
    expect(r.agentAttributable).toEqual(['packages/orchestrator/src/foo.ts']);
    expect(r.excluded).toEqual(['.claude/notes.md']);
  });

  it('honors operator extraGlobs (docs/journal/**) but not un-globbed siblings', () => {
    const r = filterOrchestratorOwned(
      ['docs/journal/x.md', 'docs/other.md'],
      ['docs/journal/**'],
    );
    expect(r.agentAttributable).toEqual(['docs/other.md']);
    expect(r.excluded).toEqual(['docs/journal/x.md']);
  });

  it('source-dir-overlap footgun: packages/tools/** excludes a real source file', () => {
    // §8.3 — asserts the footgun is real, justifying the config-validation warning.
    const r = filterOrchestratorOwned(
      ['packages/tools/src/index.ts'],
      ['packages/tools/**'],
    );
    expect(r.agentAttributable).toEqual([]);
    expect(r.excluded).toEqual(['packages/tools/src/index.ts']);
  });

  it('union, not replace: a custom glob does NOT remove built-in exclusions', () => {
    const r = filterOrchestratorOwned(
      ['.gossip/x.jsonl', '.claude/y.md', 'docs/journal/z.md', 'apps/cli/src/a.ts'],
      ['docs/journal/**'],
    );
    expect(r.agentAttributable).toEqual(['apps/cli/src/a.ts']);
    expect(r.excluded.sort()).toEqual(
      ['.claude/y.md', '.gossip/x.jsonl', 'docs/journal/z.md'].sort(),
    );
  });

  it('empty input → both empty; no extraGlobs is a no-op exclusion of source paths', () => {
    expect(filterOrchestratorOwned([])).toEqual({ agentAttributable: [], excluded: [] });
    const r = filterOrchestratorOwned(['apps/cli/src/foo.ts']);
    expect(r.agentAttributable).toEqual(['apps/cli/src/foo.ts']);
    expect(r.excluded).toEqual([]);
  });

  it('single-star glob does not cross a path separator', () => {
    const r = filterOrchestratorOwned(
      ['logs/a.log', 'logs/sub/b.log'],
      ['logs/*'],
    );
    // `logs/*` matches the top-level file only, not the nested one.
    expect(r.excluded).toEqual(['logs/a.log']);
    expect(r.agentAttributable).toEqual(['logs/sub/b.log']);
  });

  it('** before a literal segment enforces a path-separator boundary (consensus 9fe6d8db)', () => {
    // Regression for the globToRegExp `**/foo` boundary bug: `docs/**/foo` must
    // match `docs/foo` and `docs/a/b/foo` but NOT `docs/xfoo` (suffix match).
    const r = filterOrchestratorOwned(
      ['docs/xfoo', 'docs/foo', 'docs/a/b/foo'],
      ['docs/**/foo'],
    );
    expect(r.excluded.sort()).toEqual(['docs/a/b/foo', 'docs/foo'].sort());
    expect(r.agentAttributable).toEqual(['docs/xfoo']); // NOT silenced
  });
});

// ─── Layer A — diffIsolationSnapshots integration ────────────────────────────

describe('diffIsolationSnapshots — orchestrator-owned exclusion', () => {
  it('dirty .claude/knowledge-nominations.md only → no violation (6-07 13996c4c regression)', () => {
    const before = snap([]);
    const after = snap(['.claude/knowledge-nominations.md']);
    const diff = diffIsolationSnapshots(before, after);
    expect(diff.isViolation).toBe(false);
    expect(diff.dirtyPathsAdded).toEqual([]);
    expect(diff.excludedPaths).toEqual(['.claude/knowledge-nominations.md']);
  });

  it('dirty .gossip/session-gossip.jsonl only → excluded, no violation', () => {
    const diff = diffIsolationSnapshots(snap([]), snap(['.gossip/session-gossip.jsonl']));
    expect(diff.isViolation).toBe(false);
    expect(diff.excludedPaths).toEqual(['.gossip/session-gossip.jsonl']);
  });

  it('source file + .claude/notes.md → only source attributable; notes.md excluded', () => {
    const diff = diffIsolationSnapshots(
      snap([]),
      snap(['packages/orchestrator/src/foo.ts', '.claude/notes.md']),
    );
    expect(diff.isViolation).toBe(true);
    expect(diff.dirtyPathsAdded).toEqual(['packages/orchestrator/src/foo.ts']);
    expect(diff.excludedPaths).toEqual(['.claude/notes.md']);
  });

  it('operator glob docs/journal/** excludes journal write but not docs/other.md', () => {
    const diff = diffIsolationSnapshots(
      snap([]),
      snap(['docs/journal/x.md', 'docs/other.md']),
      ['docs/journal/**'],
    );
    expect(diff.isViolation).toBe(true);
    expect(diff.dirtyPathsAdded).toEqual(['docs/other.md']);
    expect(diff.excludedPaths).toEqual(['docs/journal/x.md']);
  });

  it('headChanged=true with only excluded dirty paths → STILL a violation', () => {
    const before = snap([], 'a'.repeat(40));
    const after = snap(['.claude/knowledge-nominations.md'], 'b'.repeat(40));
    const diff = diffIsolationSnapshots(before, after);
    expect(diff.headChanged).toBe(true);
    expect(diff.isViolation).toBe(true);
    expect(diff.dirtyPathsAdded).toEqual([]); // attribution still empty
    expect(diff.excludedPaths).toEqual(['.claude/knowledge-nominations.md']);
  });

  it('source-dir-overlap: orchestratorOwnedGlobs packages/tools/** suppresses a real leak', () => {
    const diff = diffIsolationSnapshots(
      snap([]),
      snap(['packages/tools/src/index.ts']),
      ['packages/tools/**'],
    );
    expect(diff.isViolation).toBe(false);
    expect(diff.excludedPaths).toEqual(['packages/tools/src/index.ts']);
  });

  it('no excluded paths → excludedPaths omitted (undefined)', () => {
    const diff = diffIsolationSnapshots(snap([]), snap(['apps/cli/src/foo.ts']));
    expect(diff.isViolation).toBe(true);
    expect(diff.dirtyPathsAdded).toEqual(['apps/cli/src/foo.ts']);
    expect(diff.excludedPaths).toBeUndefined();
  });
});

// ─── Config validation ───────────────────────────────────────────────────────

describe('validateConfig — orchestratorOwnedGlobs / worktreeAutoRevert', () => {
  const base = { main_agent: { provider: 'anthropic', model: 'claude-opus-4-6' } };

  it('accepts valid orchestratorOwnedGlobs + worktreeAutoRevert', () => {
    const cfg = validateConfig({
      ...base,
      consensus: { worktreeAutoRevert: true, orchestratorOwnedGlobs: ['docs/journal/**'] },
    });
    expect(cfg.consensus?.worktreeAutoRevert).toBe(true);
    expect(cfg.consensus?.orchestratorOwnedGlobs).toEqual(['docs/journal/**']);
  });

  it('rejects wildcard-only entry **', () => {
    expect(() =>
      validateConfig({ ...base, consensus: { orchestratorOwnedGlobs: ['**'] } }),
    ).toThrow(/wildcard-only/);
  });

  it('rejects wildcard-only entry *', () => {
    expect(() =>
      validateConfig({ ...base, consensus: { orchestratorOwnedGlobs: ['*'] } }),
    ).toThrow(/wildcard-only/);
  });

  it('rejects traversal entry ../../*', () => {
    expect(() =>
      validateConfig({ ...base, consensus: { orchestratorOwnedGlobs: ['../../*'] } }),
    ).toThrow(/traversal/);
  });

  it('rejects non-string / empty members', () => {
    expect(() =>
      validateConfig({ ...base, consensus: { orchestratorOwnedGlobs: [123] } }),
    ).toThrow(/non-empty strings/);
    expect(() =>
      validateConfig({ ...base, consensus: { orchestratorOwnedGlobs: [''] } }),
    ).toThrow(/non-empty strings/);
  });

  it('rejects non-array orchestratorOwnedGlobs', () => {
    expect(() =>
      validateConfig({ ...base, consensus: { orchestratorOwnedGlobs: 'docs/**' } }),
    ).toThrow(/array of strings/);
  });

  it('rejects non-boolean worktreeAutoRevert', () => {
    expect(() =>
      validateConfig({ ...base, consensus: { worktreeAutoRevert: 'yes' } }),
    ).toThrow(/must be a boolean/);
  });
});

// ─── Layer B — auto-restore opt-in through handleNativeRelay ─────────────────

// Mock the detector module so we can deterministically return a violation diff
// without standing up a real git working tree (mirrors relay-isolation-warning).
const mockCheck = jest.fn();
const mockRevert = jest.fn();
const mockPreserve = jest.fn();
jest.mock('../../apps/cli/src/handlers/worktree-isolation-detection', () => {
  const actual = jest.requireActual('../../apps/cli/src/handlers/worktree-isolation-detection');
  return {
    __esModule: true,
    ...actual,
    checkIsolationViolation: (...args: any[]) => mockCheck(...args),
    revertLeakedPaths: (...args: any[]) => mockRevert(...args),
    preserveLeakedPaths: (...args: any[]) => mockPreserve(...args),
  };
});

import { handleNativeRelay, worktreeAutoRevertEnabled } from '../../apps/cli/src/handlers/native-tasks';
import { ctx } from '../../apps/cli/src/mcp-context';
import { writeFileSync, mkdirSync } from 'fs';

const AGENT_ID = 'sonnet-implementer';
const TASK_ID = 'iso-fp-task-1';

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
    getWorktreeManager: jest.fn().mockReturnValue({
      cleanup: jest.fn().mockResolvedValue(undefined),
      pruneOrphans: jest.fn().mockResolvedValue(undefined),
    }),
    projectRoot,
  };
}

function seedWorktreeTask(taskId: string, agentId: string): void {
  ctx.nativeTaskMap.set(taskId, {
    agentId,
    task: 'implement thing in worktree',
    startedAt: Date.now() - 1000,
    timeoutMs: 120_000,
    writeMode: 'worktree',
    isolationSnapshot: {
      head: 'a'.repeat(40),
      dirty: [],
      takenAt: new Date(Date.now() - 1000).toISOString(),
    },
  } as any);
}

function readWarnings(dir: string): any[] {
  try {
    const raw = readFileSync(join(dir, '.gossip', 'relay-warnings.jsonl'), 'utf8').trim();
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('handleNativeRelay — Layer B auto-restore opt-in', () => {
  let testDir: string;
  let originalCwd: string;
  let stderrSpy: jest.SpyInstance;
  let prevAutoRevert: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'gossip-iso-fp-test-'));
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

    mockCheck.mockReset();
    mockRevert.mockReset();
    mockPreserve.mockReset();
    mockRevert.mockReturnValue({ restored: [], skipped: [], rejected: [] });
    mockPreserve.mockReturnValue({
      preserved: ['apps/cli/src/leaked.ts'],
      skipped: [],
      rejected: [],
      patchPath: join(testDir, '.gossip', 'recovery', `${TASK_ID}.patch`),
    });
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    prevAutoRevert = process.env.GOSSIP_WORKTREE_AUTO_REVERT;
    delete process.env.GOSSIP_WORKTREE_AUTO_REVERT;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
    if (prevAutoRevert === undefined) delete process.env.GOSSIP_WORKTREE_AUTO_REVERT;
    else process.env.GOSSIP_WORKTREE_AUTO_REVERT = prevAutoRevert;
  });

  it('DEFAULT (flag unset): real source leak → patch preserved, NO revert, working tree untouched', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID);
    mockCheck.mockReturnValue({
      headChanged: false,
      dirtyPathsAdded: ['apps/cli/src/leaked.ts'],
      isViolation: true,
    });

    const res = await handleNativeRelay(
      TASK_ID,
      '<agent_finding type="finding" severity="LOW">x</agent_finding>',
    );

    // The destructive revert must NOT run under the default-OFF posture.
    expect(mockRevert).not.toHaveBeenCalled();

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('worktree_isolation_failed');
    expect(text).toContain('leaked work preserved at .gossip/recovery/iso-fp-task-1.patch');
    expect(text).toContain('master left as-is (auto-revert disabled)');
    expect(text).toContain('git restore <paths>');
    expect(text).toContain('GOSSIP_WORKTREE_AUTO_REVERT=1');

    const warnings = readWarnings(testDir);
    const entry = warnings.find((e) => e.reason === 'isolation_recovery_preserved_no_revert');
    expect(entry).toBeDefined();
    expect(entry.taskId).toBe(TASK_ID);
    expect(entry.suspectedReason).toContain('auto_revert_disabled');
  });

  it('flag=1 (env): same leak → preserve THEN revert, master cleaned (pre-#437 behaviour)', async () => {
    process.env.GOSSIP_WORKTREE_AUTO_REVERT = '1';
    seedWorktreeTask(TASK_ID, AGENT_ID);
    mockCheck.mockReturnValue({
      headChanged: false,
      dirtyPathsAdded: ['apps/cli/src/leaked.ts'],
      isViolation: true,
    });
    mockRevert.mockReturnValue({ restored: ['apps/cli/src/leaked.ts'], skipped: [], rejected: [] });

    const res = await handleNativeRelay(
      TASK_ID,
      '<agent_finding type="finding" severity="LOW">x</agent_finding>',
    );

    expect(mockRevert).toHaveBeenCalledTimes(1);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('master restored (1 path(s))');
    expect(text).not.toContain('auto-revert disabled');

    const warnings = readWarnings(testDir);
    expect(warnings.find((e) => e.reason === 'isolation_recovery_preserved')).toBeDefined();
    expect(warnings.find((e) => e.reason === 'isolation_recovery_preserved_no_revert')).toBeUndefined();
  });

  it('emits isolation_excluded_orchestrator_paths audit when excludedPaths present', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID);
    // No violation, but the detector reports excluded orchestrator-owned paths.
    mockCheck.mockReturnValue({
      headChanged: false,
      dirtyPathsAdded: [],
      isViolation: false,
      excludedPaths: ['.claude/knowledge-nominations.md', '.gossip/x.jsonl'],
    });

    await handleNativeRelay(
      TASK_ID,
      '<agent_finding type="finding" severity="LOW">x</agent_finding>',
    );

    const warnings = readWarnings(testDir);
    const excludedEntry = warnings.find((e) => e.reason === 'isolation_excluded_orchestrator_paths');
    expect(excludedEntry).toBeDefined();
    expect(excludedEntry.taskId).toBe(TASK_ID);
    expect(excludedEntry.resultLength).toBe(2);
    expect(excludedEntry.suspectedReason).toContain('.claude/knowledge-nominations.md');
  });
});

// ─── Layer B — worktreeAutoRevertEnabled config→flag precedence ──────────────
// Regression for the consensus 9fe6d8db HIGH finding: consensus.worktreeAutoRevert
// in .gossip/config.json must actually seed the flag when no env override is set.
// (The original impl passed the seed to getRuntimeFlagBool's defaultValue, which
// is dead code because the registry default '0' pre-empts it.)
describe('worktreeAutoRevertEnabled — config→flag seeding precedence', () => {
  let root: string;
  let prevEnv: string | undefined;

  function writeConfig(worktreeAutoRevert?: boolean): void {
    mkdirSync(join(root, '.gossip'), { recursive: true });
    const cfg: any = { main_agent: { provider: 'anthropic', model: 'claude-opus-4-6' } };
    if (worktreeAutoRevert !== undefined) cfg.consensus = { worktreeAutoRevert };
    writeFileSync(join(root, '.gossip', 'config.json'), JSON.stringify(cfg));
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'iso-fp-cfg-'));
    prevEnv = process.env.GOSSIP_WORKTREE_AUTO_REVERT;
    delete process.env.GOSSIP_WORKTREE_AUTO_REVERT;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.GOSSIP_WORKTREE_AUTO_REVERT;
    else process.env.GOSSIP_WORKTREE_AUTO_REVERT = prevEnv;
    rmSync(root, { recursive: true, force: true });
  });

  it('config worktreeAutoRevert:true with NO env → enabled (the dead-config bug)', () => {
    writeConfig(true);
    expect(worktreeAutoRevertEnabled(root)).toBe(true);
  });

  it('config worktreeAutoRevert:false → disabled', () => {
    writeConfig(false);
    expect(worktreeAutoRevertEnabled(root)).toBe(false);
  });

  it('config absent / no consensus block → registry default OFF', () => {
    writeConfig(undefined);
    expect(worktreeAutoRevertEnabled(root)).toBe(false);
  });

  it('no config file at all → registry default OFF (fail-open)', () => {
    expect(worktreeAutoRevertEnabled(root)).toBe(false);
  });

  it('env=1 overrides config false', () => {
    writeConfig(false);
    process.env.GOSSIP_WORKTREE_AUTO_REVERT = '1';
    expect(worktreeAutoRevertEnabled(root)).toBe(true);
  });

  it('explicit empty-string env forces OFF even with config true', () => {
    writeConfig(true);
    process.env.GOSSIP_WORKTREE_AUTO_REVERT = '';
    expect(worktreeAutoRevertEnabled(root)).toBe(false);
  });
});
