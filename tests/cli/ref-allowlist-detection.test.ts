/**
 * Tests for ref-allowlist Phase 1 detection layer.
 * Spec: docs/specs/2026-04-29-ref-allowlist-enforcement.md §"Phase 1 Minimum Viable"
 *
 * Verifies:
 *   (a) SHA unchanged → no signal, no JSONL append
 *   (b) SHA changed + merge entry → no signal (legitimate PR merge)
 *   (c) SHA changed + no merge entry → violation: JSONL appended + signal emitted + stderr message
 *   (d) Multiple commits + one PR merge → no signal (batched merges)
 *   (e) preDispatchSha null → no detection, no false positive
 *   (f) SHA changed + squash-merged PR commit → no signal (squash PR regression)
 */

import * as fs from 'fs';
import * as childProcess from 'child_process';

// ── mocks ────────────────────────────────────────────────────────────────────

// Mock @gossip/orchestrator so emitConsensusSignals can be spied on
jest.mock('@gossip/orchestrator', () => ({
  emitConsensusSignals: jest.fn(),
}));

// Mock child_process.execFileSync to control git output
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: jest.fn(),
}));

// Mock fs.appendFileSync so tests don't write real files
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  appendFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// ── imports after mocks ──────────────────────────────────────────────────────

import { capturePreDispatchSha, checkRefAllowlistViolation } from '../../apps/cli/src/handlers/ref-allowlist-detection';
import { resetBaseRefDiscoveryCache } from '../../apps/cli/src/handlers/base-ref-discovery';
import { emitConsensusSignals } from '@gossip/orchestrator';

const mockExecFileSync = childProcess.execFileSync as jest.Mock;
const mockEmitSignals = emitConsensusSignals as jest.Mock;
const mockAppendFileSync = fs.appendFileSync as jest.Mock;

// ── helpers ──────────────────────────────────────────────────────────────────

const PRE_SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const POST_SHA = 'ffff6666gggg7777hhhh8888iiii9999jjjj0000';

// ── tests ────────────────────────────────────────────────────────────────────

describe('capturePreDispatchSha', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetBaseRefDiscoveryCache();
  });

  it('returns the trimmed SHA on success', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(PRE_SHA + '\n'));
    const sha = capturePreDispatchSha();
    expect(sha).toBe(PRE_SHA);
  });

  it('returns null on git failure (offline/no remote)', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repository'); });
    const sha = capturePreDispatchSha();
    expect(sha).toBeNull();
  });
});

describe('checkRefAllowlistViolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetBaseRefDiscoveryCache();
  });

  it('(a) SHA unchanged → no signal, no JSONL append', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return Buffer.from(PRE_SHA + '\n');
      return Buffer.from('');
    });

    checkRefAllowlistViolation('task-abc', 'sonnet-implementer', PRE_SHA);

    expect(mockEmitSignals).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('(b) SHA changed + PR merge entry → no signal (legitimate merge)', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return Buffer.from(POST_SHA + '\n');
      if (args[0] === 'log' && args.includes(`--grep=(#[0-9]`) && !args.includes('--merges')) {
        // getPrMergeCommits: returns a traditional merge commit (no --merges flag needed)
        return Buffer.from(`${POST_SHA} Merge pull request (#42) from feature/foo\n`);
      }
      return Buffer.from('');
    });

    checkRefAllowlistViolation('task-abc', 'sonnet-implementer', PRE_SHA);

    expect(mockEmitSignals).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('(c) SHA changed + no merge entry → violation: JSONL + signal + stderr', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return Buffer.from(POST_SHA + '\n');
      if (args[0] === 'log' && args.includes(`--grep=(#[0-9]`)) return Buffer.from('');
      if (args[0] === 'log') return Buffer.from(`${POST_SHA} feat: sneak push to master\n`);
      return Buffer.from('');
    });

    checkRefAllowlistViolation('task-xyz', 'sonnet-implementer', PRE_SHA);

    // Signal emitted with boundary_escape + process_discipline
    expect(mockEmitSignals).toHaveBeenCalledTimes(1);
    const [, signals] = mockEmitSignals.mock.calls[0];
    expect(signals).toHaveLength(1);
    expect(signals[0].signal).toBe('boundary_escape');
    expect(signals[0].category).toBe('process_discipline');
    expect(signals[0].findingId).toBe('proc:task-xyz:master_push');
    expect(signals[0].severity).toBe('high');
    expect(signals[0].agentId).toBe('sonnet-implementer');

    // JSONL appended
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const appendCall = mockAppendFileSync.mock.calls[0];
    const written = JSON.parse(appendCall[1].replace(/\n$/, ''));
    expect(written.taskId).toBe('task-xyz');
    expect(written.agentId).toBe('sonnet-implementer');
    expect(written.preSha).toBe(PRE_SHA);
    expect(written.postSha).toBe(POST_SHA);
    expect(written.detectedAt).toBeTruthy();
    expect(Array.isArray(written.commits)).toBe(true);

    // Stderr message
    const stderrCalls = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(stderrCalls).toContain('REF-ALLOWLIST VIOLATION');
    expect(stderrCalls).toContain('task-xyz');
    expect(stderrCalls).toContain('sonnet-implementer');

    stderrSpy.mockRestore();
  });

  it('(d) Multiple commits + one PR merge → no signal (batched merges)', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return Buffer.from(POST_SHA + '\n');
      // getPrMergeCommits uses --grep; getCommitRange does not
      if (args[0] === 'log' && args.includes(`--grep=(#[0-9]`)) {
        // One PR-ref commit among several
        return Buffer.from(`${POST_SHA} Merge pull request (#99) from feature/bar\n`);
      }
      if (args[0] === 'log') {
        return Buffer.from(
          `aaa Merge pull request (#99) from feature/bar\nbbb feat: step 1\nccc feat: step 2\n`,
        );
      }
      return Buffer.from('');
    });

    checkRefAllowlistViolation('task-batch', 'sonnet-implementer', PRE_SHA);

    expect(mockEmitSignals).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('(e) every git call fails → base ref never resolves, detection skipped cleanly', () => {
    // Every git invocation throws, so base-ref discovery itself fails and
    // checkRefAllowlistViolation takes the `if (!ref) return` early exit. This
    // is the "no base ref" path, NOT the postSha-read-failure path — see (e2),
    // which isolates that separately.
    mockExecFileSync.mockImplementation(() => { throw new Error('git: command not found'); });

    expect(() => checkRefAllowlistViolation('task-null', 'sonnet-implementer', PRE_SHA)).not.toThrow();

    expect(mockEmitSignals).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('(e2) base ref resolves but the postSha read fails → no throw, no false positive', () => {
    // Isolates the postSha try/catch: discovery succeeds, then the `rev-parse
    // <ref>` that reads the CURRENT sha fails. Without this, (e) masked the
    // branch because it broke discovery before postSha was ever attempted.
    mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      const key = (args as string[]).join(' ');
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') return 'refs/remotes/origin/master\n';
      if (key === 'rev-parse --verify --quiet origin/master') return `${PRE_SHA}\n`;
      // The post-dispatch SHA read is the one that fails.
      if (key === 'rev-parse origin/master') throw new Error('fatal: bad object');
      throw new Error(`unexpected git call: ${key}`);
    });

    expect(() => checkRefAllowlistViolation('task-postsha', 'sonnet-implementer', PRE_SHA)).not.toThrow();

    expect(mockEmitSignals).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('(f) SHA changed + squash-merged PR commit → no signal (squash PR regression)', () => {
    // Regression: previously --merges excluded single-parent squash commits,
    // causing false-positive violations for every `gh pr merge --squash`.
    // Empirical proof: git log 5318c87..6a3d92e --merges --grep="(#[0-9]" → empty
    //                  git log 5318c87..6a3d92e          --grep="(#[0-9]" → 6a3d92e (#331)
    // Fix: drop --merges so squash commits (single-parent) are matched by --grep alone.
    const SQUASH_SHA = 'squash999aaa888bbb777ccc666ddd555eee444fff';

    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return Buffer.from(SQUASH_SHA + '\n');
      // getPrMergeCommits (with --grep, without --merges): returns squash commit
      if (args[0] === 'log' && args.includes(`--grep=(#[0-9]`)) {
        return Buffer.from(`${SQUASH_SHA} fix(cli): ref-allowlist detector — drop --merges to support squash PRs (#331)\n`);
      }
      return Buffer.from('');
    });

    checkRefAllowlistViolation('task-squash', 'sonnet-implementer', PRE_SHA);

    // No violation — squash-merged PR is a legitimate master move
    expect(mockEmitSignals).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });
});
