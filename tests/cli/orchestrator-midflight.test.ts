// tests/cli/orchestrator-midflight.test.ts
//
// Unit tests for UNIT 3 orchestrator mid-flight commit detection.
// All I/O (git, emitPipelineSignals) is injected via stubs — no real
// filesystem or shell access.

import {
  captureHeadSha,
  getCommitsSince,
  runMidFlightCheck,
  type MidFlightCheckDeps,
} from '../../apps/cli/src/handlers/orchestrator-precondition-runner';
import type { PerformanceSignal } from '@gossip/orchestrator';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeMidFlightDeps(overrides: Partial<MidFlightCheckDeps> = {}): MidFlightCheckDeps {
  return {
    execFile: jest.fn(),
    emitSignals: jest.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// captureHeadSha
// ---------------------------------------------------------------------------

describe('captureHeadSha', () => {
  it('returns the trimmed HEAD SHA on success', () => {
    const execFile = jest.fn().mockReturnValue('  abc123  \n');
    const result = captureHeadSha('/project', execFile);
    expect(result).toBe('abc123');
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf8' }),
    );
  });

  it('returns undefined when execFile throws', () => {
    const execFile = jest.fn().mockImplementation(() => { throw new Error('git not found'); });
    const result = captureHeadSha('/project', execFile);
    expect(result).toBeUndefined();
  });

  it('returns undefined when execFile returns empty string', () => {
    const execFile = jest.fn().mockReturnValue('   \n');
    const result = captureHeadSha('/project', execFile);
    expect(result).toBeUndefined();
  });

  it('uses process.cwd() when no projectRoot given and git succeeds', () => {
    const execFile = jest.fn().mockReturnValue('deadbeef\n');
    const result = captureHeadSha(undefined, execFile);
    expect(result).toBe('deadbeef');
  });
});

// ---------------------------------------------------------------------------
// getCommitsSince
// ---------------------------------------------------------------------------

describe('getCommitsSince', () => {
  it('parses multiple commit SHAs from git log output', () => {
    const execFile = jest.fn().mockReturnValue('sha1\nsha2\nsha3\n');
    const result = getCommitsSince('abc000', '/project', execFile);
    expect(result).toEqual(['sha1', 'sha2', 'sha3']);
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['log', 'abc000..HEAD', '--format=%H'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf8' }),
    );
  });

  it('returns empty array when git log output is empty', () => {
    const execFile = jest.fn().mockReturnValue('\n\n   \n');
    const result = getCommitsSince('abc000', '/project', execFile);
    expect(result).toEqual([]);
  });

  it('returns empty array when execFile throws (git error)', () => {
    const execFile = jest.fn().mockImplementation(() => { throw new Error('git error'); });
    const result = getCommitsSince('abc000', '/project', execFile);
    expect(result).toEqual([]);
  });

  it('filters out empty lines from git log output', () => {
    const execFile = jest.fn().mockReturnValue('sha1\n\nsha2\n\n');
    const result = getCommitsSince('abc000', '/project', execFile);
    expect(result).toEqual(['sha1', 'sha2']);
  });

  it('trims whitespace from each SHA line', () => {
    const execFile = jest.fn().mockReturnValue('  sha1  \n  sha2  \n');
    const result = getCommitsSince('abc000', '/project', execFile);
    expect(result).toEqual(['sha1', 'sha2']);
  });
});

// ---------------------------------------------------------------------------
// runMidFlightCheck
// ---------------------------------------------------------------------------

describe('runMidFlightCheck — no roundStartSha', () => {
  it('returns no warnings and emits no signals when roundStartSha is undefined', async () => {
    const deps = makeMidFlightDeps();
    const result = await runMidFlightCheck(
      { projectRoot: '/project', consensusId: 'cid-001', roundStartSha: undefined },
      deps,
    );
    expect(result.warnings).toHaveLength(0);
    expect(deps.emitSignals).not.toHaveBeenCalled();
    expect(deps.execFile).not.toHaveBeenCalled();
  });

  it('returns no warnings and emits no signals when roundStartSha is null', async () => {
    const deps = makeMidFlightDeps();
    const result = await runMidFlightCheck(
      { projectRoot: '/project', consensusId: 'cid-001', roundStartSha: null as any },
      deps,
    );
    expect(result.warnings).toHaveLength(0);
    expect(deps.emitSignals).not.toHaveBeenCalled();
  });

  it('returns no warnings and emits no signals when roundStartSha is empty string', async () => {
    const deps = makeMidFlightDeps();
    const result = await runMidFlightCheck(
      { projectRoot: '/project', consensusId: 'cid-001', roundStartSha: '' },
      deps,
    );
    expect(result.warnings).toHaveLength(0);
    expect(deps.emitSignals).not.toHaveBeenCalled();
  });
});

describe('runMidFlightCheck — commits detected', () => {
  it('emits mid_flight_fixup signal with agentId orchestrator when commits landed', async () => {
    const deps = makeMidFlightDeps({
      execFile: jest.fn().mockReturnValue('commit1\ncommit2\n'),
    });
    const result = await runMidFlightCheck(
      {
        projectRoot: '/project',
        consensusId: 'cid-abc',
        roundStartSha: 'startsha',
      },
      deps,
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(deps.emitSignals).toHaveBeenCalledTimes(1);
    const [projectRoot, signals]: [string, PerformanceSignal[]] = (deps.emitSignals as jest.Mock).mock.calls[0];
    expect(projectRoot).toBe('/project');
    expect(signals).toHaveLength(1);
    const signal = signals[0] as any;
    expect(signal.signal).toBe('mid_flight_fixup');
    expect(signal.agentId).toBe('orchestrator');
    expect(signal.taskId).toBe('cid-abc');
    expect(signal.consensusId).toBe('cid-abc');
    expect(signal.metadata.count).toBe(2);
    expect(signal.metadata.roundStartSha).toBe('startsha');
    expect(signal.metadata.commits).toEqual(['commit1', 'commit2']);
  });

  it('includes a warning message describing the mid-flight fixup', async () => {
    const deps = makeMidFlightDeps({
      execFile: jest.fn().mockReturnValue('deadbeef\n'),
    });
    const result = await runMidFlightCheck(
      { projectRoot: '/project', consensusId: 'cid-xyz', roundStartSha: 'base' },
      deps,
    );
    expect(result.warnings[0]).toMatch(/mid.flight/i);
  });
});

describe('runMidFlightCheck — zero commits', () => {
  it('emits no signal and no warning when no commits landed since round start', async () => {
    const deps = makeMidFlightDeps({
      execFile: jest.fn().mockReturnValue('\n'),
    });
    const result = await runMidFlightCheck(
      { projectRoot: '/project', consensusId: 'cid-clean', roundStartSha: 'startsha' },
      deps,
    );
    expect(result.warnings).toHaveLength(0);
    expect(deps.emitSignals).not.toHaveBeenCalled();
  });
});

describe('runMidFlightCheck — git error resilience', () => {
  it('does not throw when execFile throws', async () => {
    const deps = makeMidFlightDeps({
      execFile: jest.fn().mockImplementation(() => { throw new Error('git exploded'); }),
    });
    await expect(
      runMidFlightCheck(
        { projectRoot: '/project', consensusId: 'cid-err', roundStartSha: 'sha' },
        deps,
      ),
    ).resolves.toBeDefined();
  });

  it('returns no signal when execFile throws (git unavailable path)', async () => {
    const deps = makeMidFlightDeps({
      execFile: jest.fn().mockImplementation(() => { throw new Error('git unavailable'); }),
    });
    const result = await runMidFlightCheck(
      { projectRoot: '/project', consensusId: 'cid-err', roundStartSha: 'sha' },
      deps,
    );
    expect(deps.emitSignals).not.toHaveBeenCalled();
    expect(result.warnings).toHaveLength(0);
  });

  it('does not throw when emitSignals throws', async () => {
    const deps = makeMidFlightDeps({
      execFile: jest.fn().mockReturnValue('commit1\n'),
      emitSignals: jest.fn().mockImplementation(() => { throw new Error('emit failed'); }),
    });
    await expect(
      runMidFlightCheck(
        { projectRoot: '/project', consensusId: 'cid-emiterr', roundStartSha: 'sha' },
        deps,
      ),
    ).resolves.toBeDefined();
  });
});
