/**
 * Tests for Option B native worktree isolation-failure detector.
 * Spec: docs/specs/2026-05-20-native-worktree-isolation-fix.md §"Option B"
 *
 * Covers:
 *   parsePorcelain           — porcelain v1 parsing + CRLF tolerance + sort stability
 *   diffIsolationSnapshots   — HEAD-equal + clean dirty → no violation
 *                             HEAD-equal + new dirty paths → violation (PR #422 case)
 *                             HEAD-moved + clean dirty → violation (drift-only)
 *                             null before.head → headChanged false, dirty diff still active
 *                             dirty paths present in both → not flagged as new
 *   buildIsolationSignal     — payload shape (type, signal, agentId, taskId, head_before/after, dirty_paths_added)
 *   checkIsolationViolation  — emits emitConsensusSignals when violation detected; silent when clean
 */

import * as childProcess from 'child_process';

// ── mocks ────────────────────────────────────────────────────────────────────

jest.mock('@gossip/orchestrator', () => ({
  emitConsensusSignals: jest.fn(),
}));

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: jest.fn(),
}));

// ── imports after mocks ──────────────────────────────────────────────────────

import {
  parsePorcelain,
  diffIsolationSnapshots,
  buildIsolationSignal,
  checkIsolationViolation,
  captureIsolationSnapshot,
  IsolationSnapshot,
} from '../../apps/cli/src/handlers/worktree-isolation-detection';
import { emitConsensusSignals } from '@gossip/orchestrator';

const mockExec = childProcess.execFileSync as jest.Mock;
const mockEmit = emitConsensusSignals as jest.Mock;

const SHA_BEFORE = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
const SHA_AFTER  = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';

describe('parsePorcelain', () => {
  it('parses standard porcelain v1 lines', () => {
    const out = ' M apps/cli/src/foo.ts\n?? new/file.ts\nMM packages/orchestrator/bar.ts\n';
    expect(parsePorcelain(out)).toEqual([
      'apps/cli/src/foo.ts',
      'new/file.ts',
      'packages/orchestrator/bar.ts',
    ]);
  });

  it('tolerates CRLF line endings', () => {
    const out = ' M a.ts\r\n M b.ts\r\n';
    expect(parsePorcelain(out)).toEqual(['a.ts', 'b.ts']);
  });

  it('returns [] on empty input', () => {
    expect(parsePorcelain('')).toEqual([]);
    expect(parsePorcelain('\n\n')).toEqual([]);
  });

  it('skips malformed short lines', () => {
    expect(parsePorcelain('ab\n M ok.ts\n')).toEqual(['ok.ts']);
  });

  it('returns paths sorted for diff stability', () => {
    const out = ' M z.ts\n M a.ts\n M m.ts\n';
    expect(parsePorcelain(out)).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });
});

describe('diffIsolationSnapshots', () => {
  function snap(head: string | null, dirty: string[]): IsolationSnapshot {
    return { head, dirty: [...dirty].sort(), takenAt: '2026-05-20T00:00:00Z' };
  }

  it('clean → no violation', () => {
    const d = diffIsolationSnapshots(snap(SHA_BEFORE, []), snap(SHA_BEFORE, []));
    expect(d).toEqual({ headChanged: false, dirtyPathsAdded: [], isViolation: false });
  });

  it('HEAD unchanged + new dirty path → violation (PR #422 case)', () => {
    const before = snap(SHA_BEFORE, []);
    const after = snap(SHA_BEFORE, ['apps/cli/src/leaked.ts']);
    const d = diffIsolationSnapshots(before, after);
    expect(d.headChanged).toBe(false);
    expect(d.dirtyPathsAdded).toEqual(['apps/cli/src/leaked.ts']);
    expect(d.isViolation).toBe(true);
  });

  it('HEAD moved + clean dirty → violation (drift-only)', () => {
    const d = diffIsolationSnapshots(snap(SHA_BEFORE, []), snap(SHA_AFTER, []));
    expect(d.headChanged).toBe(true);
    expect(d.dirtyPathsAdded).toEqual([]);
    expect(d.isViolation).toBe(true);
  });

  it('pre-existing dirty paths in both snapshots → not flagged', () => {
    const before = snap(SHA_BEFORE, ['existing.ts']);
    const after = snap(SHA_BEFORE, ['existing.ts', 'new.ts']);
    const d = diffIsolationSnapshots(before, after);
    expect(d.dirtyPathsAdded).toEqual(['new.ts']);
    expect(d.isViolation).toBe(true);
  });

  it('null before.head → headChanged false; dirty-diff still active', () => {
    const before = snap(null, []);
    const after = snap(SHA_AFTER, ['x.ts']);
    const d = diffIsolationSnapshots(before, after);
    expect(d.headChanged).toBe(false);
    expect(d.dirtyPathsAdded).toEqual(['x.ts']);
    expect(d.isViolation).toBe(true);
  });

  it('null after.head → headChanged false (fail-open)', () => {
    const before = snap(SHA_BEFORE, []);
    const after = snap(null, []);
    const d = diffIsolationSnapshots(before, after);
    expect(d.headChanged).toBe(false);
    expect(d.isViolation).toBe(false);
  });
});

describe('buildIsolationSignal', () => {
  it('produces a well-formed worktree_isolation_failed payload', () => {
    const before: IsolationSnapshot = { head: SHA_BEFORE, dirty: [], takenAt: 'T0' };
    const after: IsolationSnapshot = { head: SHA_BEFORE, dirty: ['leaked.ts'], takenAt: 'T1' };
    const diff = diffIsolationSnapshots(before, after);
    const sig = buildIsolationSignal({
      agentId: 'opus-implementer',
      taskId: 'task-abc',
      before,
      after,
      diff,
    });
    expect(sig.type).toBe('consensus');
    expect(sig.signal).toBe('worktree_isolation_failed');
    expect(sig.agentId).toBe('opus-implementer');
    expect(sig.taskId).toBe('task-abc');
    expect(sig.head_before).toBe(SHA_BEFORE);
    expect(sig.head_after).toBe(SHA_BEFORE);
    expect(sig.dirty_paths_added).toEqual(['leaked.ts']);
    expect(sig.evidence).toMatch(/HEAD unchanged/);
    expect(sig.evidence).toMatch(/1 new dirty path/);
    expect(sig.timestamp).toMatch(/T/);
  });

  it('summarises HEAD drift in evidence', () => {
    const before: IsolationSnapshot = { head: SHA_BEFORE, dirty: [], takenAt: 'T0' };
    const after: IsolationSnapshot = { head: SHA_AFTER, dirty: [], takenAt: 'T1' };
    const sig = buildIsolationSignal({
      agentId: 'a',
      taskId: 't',
      before,
      after,
      diff: diffIsolationSnapshots(before, after),
    });
    expect(sig.evidence).toMatch(/HEAD aaaa1111→bbbb2222/);
  });
});

describe('checkIsolationViolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits consensus signal when dirty paths leak in', () => {
    const before: IsolationSnapshot = { head: SHA_BEFORE, dirty: [], takenAt: 'T0' };
    // Mock re-snapshot: git rev-parse HEAD, then git status --porcelain
    mockExec
      .mockReturnValueOnce(Buffer.from(SHA_BEFORE + '\n'))   // rev-parse HEAD
      .mockReturnValueOnce(Buffer.from(' M apps/cli/src/leaked.ts\n')); // status

    const diff = checkIsolationViolation('opus-implementer', 'task-abc', before, '/tmp');

    expect(diff.isViolation).toBe(true);
    expect(diff.dirtyPathsAdded).toEqual(['apps/cli/src/leaked.ts']);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const [, signals] = mockEmit.mock.calls[0];
    expect(signals[0].signal).toBe('worktree_isolation_failed');
    expect(signals[0].dirty_paths_added).toEqual(['apps/cli/src/leaked.ts']);
  });

  it('no emit when after-state matches before-state', () => {
    const before: IsolationSnapshot = { head: SHA_BEFORE, dirty: [], takenAt: 'T0' };
    mockExec
      .mockReturnValueOnce(Buffer.from(SHA_BEFORE + '\n'))
      .mockReturnValueOnce(Buffer.from(''));
    const diff = checkIsolationViolation('a', 't', before, '/tmp');
    expect(diff.isViolation).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('fail-open: git error during re-snapshot → no violation, no throw', () => {
    const before: IsolationSnapshot = { head: SHA_BEFORE, dirty: [], takenAt: 'T0' };
    mockExec.mockImplementation(() => { throw new Error('git not found'); });
    const diff = checkIsolationViolation('a', 't', before, '/tmp');
    expect(diff.isViolation).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('captureIsolationSnapshot', () => {
  beforeEach(() => jest.clearAllMocks());

  it('captures HEAD + porcelain output', () => {
    mockExec
      .mockReturnValueOnce(Buffer.from(SHA_BEFORE + '\n'))   // rev-parse
      .mockReturnValueOnce(Buffer.from(' M a.ts\n M b.ts\n')); // status
    const snap = captureIsolationSnapshot('/tmp');
    expect(snap.head).toBe(SHA_BEFORE);
    expect(snap.dirty).toEqual(['a.ts', 'b.ts']);
    expect(snap.takenAt).toMatch(/T/);
  });

  it('fail-open: HEAD probe failure → head:null', () => {
    mockExec
      .mockImplementationOnce(() => { throw new Error('not a git repo'); })
      .mockReturnValueOnce(Buffer.from(''));
    const snap = captureIsolationSnapshot('/tmp');
    expect(snap.head).toBeNull();
    expect(snap.dirty).toEqual([]);
  });
});
