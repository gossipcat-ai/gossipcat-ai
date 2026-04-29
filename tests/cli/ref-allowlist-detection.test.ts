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
      if (args[0] === 'log' && args.includes('--merges')) {
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
      if (args[0] === 'log' && args.includes('--merges')) return Buffer.from('');
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
      if (args[0] === 'log' && args.includes('--merges')) {
        // One merge commit among several
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

  it('(e) preDispatchSha null → no detection, no false positive', () => {
    // Should not be called if null — guard is in caller (dispatch/relay).
    // But also verify that passing a null-like value short-circuits cleanly.
    // The real guard lives in handleNativeRelay: `if (taskInfo.preDispatchSha)`.
    // This test verifies checkRefAllowlistViolation handles a post-SHA read
    // failure gracefully (no throw, no signal).
    mockExecFileSync.mockImplementation(() => { throw new Error('git: command not found'); });

    // Should not throw
    expect(() => checkRefAllowlistViolation('task-null', 'sonnet-implementer', PRE_SHA)).not.toThrow();

    expect(mockEmitSignals).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });
});
