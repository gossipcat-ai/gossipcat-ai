/**
 * Tests for base-ref-discovery.ts — resolves the git ref used in place of a
 * hardcoded 'origin/master' for ref-allowlist snapshotting and the
 * dispatched_stale_base precondition. Issue #658.
 *
 * Precedence under test:
 *   1. GOSSIP_BASE_REF env override — wins unconditionally, no git calls.
 *   2. git symbolic-ref refs/remotes/origin/HEAD, parsed to 'origin/<branch>'.
 *   3. Fallback candidates origin/master, then origin/main (first that
 *      verifies via `rev-parse --verify --quiet`).
 *   4. Unresolvable → null with a diagnostic distinguishing offline/no-remote
 *      from "checked candidates, none resolved".
 *
 * Also covers per-process caching (discoverBaseRef only calls git once
 * across repeated calls, until resetBaseRefDiscoveryCache()).
 */

import {
  discoverBaseRef,
  resetBaseRefDiscoveryCache,
  type ExecFileLike,
} from '../../apps/cli/src/handlers/base-ref-discovery';

const CWD = '/repo';

function throwing(message: string): never {
  throw new Error(message);
}

beforeEach(() => {
  resetBaseRefDiscoveryCache();
  delete process.env.GOSSIP_BASE_REF;
});

afterEach(() => {
  delete process.env.GOSSIP_BASE_REF;
});

describe('discoverBaseRef — GOSSIP_BASE_REF override', () => {
  it('wins over everything else and makes no git calls', () => {
    process.env.GOSSIP_BASE_REF = 'upstream/develop';
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>(
      () => throwing('should not be called'),
    );
    const result = discoverBaseRef(CWD, execFile);
    expect(result).toEqual({ ref: 'upstream/develop' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace', () => {
    process.env.GOSSIP_BASE_REF = '  origin/release  ';
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>(
      () => throwing('should not be called'),
    );
    const result = discoverBaseRef(CWD, execFile);
    expect(result.ref).toBe('origin/release');
  });

  it('ignores an empty-string override and falls through to discovery', () => {
    process.env.GOSSIP_BASE_REF = '   ';
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --verify --quiet origin/master') return 'ok';
      return throwing(`unexpected: ${key}`);
    });
    const result = discoverBaseRef(CWD, execFile);
    expect(result.ref).toBe('origin/master');
  });
});

describe('discoverBaseRef — origin/HEAD symbolic-ref', () => {
  it('parses refs/remotes/origin/main to origin/main and verifies it', () => {
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') return 'refs/remotes/origin/main\n';
      if (key === 'rev-parse --verify --quiet origin/main') return 'sha123';
      return throwing(`unexpected: ${key}`);
    });
    const result = discoverBaseRef(CWD, execFile);
    expect(result).toEqual({ ref: 'origin/main' });
  });

  it('falls through to candidates when symbolic-ref points at a ref that does not verify', () => {
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') return 'refs/remotes/origin/stale-branch\n';
      if (key === 'rev-parse --verify --quiet origin/stale-branch') return throwing('fatal: ambiguous argument');
      if (key === 'rev-parse --verify --quiet origin/master') return 'ok';
      return throwing(`unexpected: ${key}`);
    });
    const result = discoverBaseRef(CWD, execFile);
    expect(result).toEqual({ ref: 'origin/master' });
  });

  it('handles unset origin/HEAD quietly (symbolic-ref throws) and falls through', () => {
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') {
        return throwing('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
      }
      if (key === 'rev-parse --verify --quiet origin/master') return 'ok';
      return throwing(`unexpected: ${key}`);
    });
    const result = discoverBaseRef(CWD, execFile);
    expect(result).toEqual({ ref: 'origin/master' });
    // No diagnostic noise — result is a clean success, no thrown error escaped.
  });
});

describe('discoverBaseRef — fallback candidate order', () => {
  it('prefers origin/master when it resolves', () => {
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') return throwing('unset');
      if (key === 'rev-parse --verify --quiet origin/master') return 'ok';
      if (key === 'rev-parse --verify --quiet origin/main') return 'ok';
      return throwing(`unexpected: ${key}`);
    });
    const result = discoverBaseRef(CWD, execFile);
    expect(result.ref).toBe('origin/master');
  });

  it('falls back to origin/main when origin/master does not exist (main-default repo, issue #658)', () => {
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') return throwing('unset');
      if (key === 'rev-parse --verify --quiet origin/master') return throwing('fatal: ambiguous argument \'origin/master\'');
      if (key === 'rev-parse --verify --quiet origin/main') return 'ok';
      return throwing(`unexpected: ${key}`);
    });
    const result = discoverBaseRef(CWD, execFile);
    expect(result.ref).toBe('origin/main');
  });

  it('never lets a candidate-verify failure surface a "fatal:" style throw to the caller', () => {
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') return throwing('unset');
      if (key === 'rev-parse --verify --quiet origin/master') return throwing('fatal: ambiguous argument');
      if (key === 'rev-parse --verify --quiet origin/main') return throwing('fatal: ambiguous argument');
      if (key === 'remote') return 'origin\n';
      return throwing(`unexpected: ${key}`);
    });
    expect(() => discoverBaseRef(CWD, execFile)).not.toThrow();
  });
});

describe('discoverBaseRef — unresolvable diagnostic wording', () => {
  it('reports "no such base ref" when origin is reachable but no candidate resolves', () => {
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') return throwing('unset');
      if (key === 'rev-parse --verify --quiet origin/master') return throwing('fatal: ambiguous argument');
      if (key === 'rev-parse --verify --quiet origin/main') return throwing('fatal: ambiguous argument');
      if (key === 'remote') return 'origin\n';
      return throwing(`unexpected: ${key}`);
    });
    const result = discoverBaseRef(CWD, execFile);
    expect(result.ref).toBeNull();
    expect(result.diagnostic).toMatch(/no such base ref/i);
    expect(result.diagnostic).toContain('origin/master');
    expect(result.diagnostic).toContain('origin/main');
  });

  it('reports "offline or no remote" when there is no origin remote at all', () => {
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') return throwing('unset');
      if (key === 'rev-parse --verify --quiet origin/master') return throwing('fatal: ambiguous argument');
      if (key === 'rev-parse --verify --quiet origin/main') return throwing('fatal: ambiguous argument');
      if (key === 'remote') return ''; // no remotes configured
      return throwing(`unexpected: ${key}`);
    });
    const result = discoverBaseRef(CWD, execFile);
    expect(result.ref).toBeNull();
    expect(result.diagnostic).toMatch(/offline or no remote/i);
  });

  it('reports "offline or no remote" when git itself is unreachable (not a repo)', () => {
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>(
      () => throwing('fatal: not a git repository'),
    );
    const result = discoverBaseRef(CWD, execFile);
    expect(result.ref).toBeNull();
    expect(result.diagnostic).toMatch(/offline or no remote/i);
  });
});

describe('discoverBaseRef — per-process caching', () => {
  it('only calls git once across repeated calls until reset', () => {
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') return throwing('unset');
      if (key === 'rev-parse --verify --quiet origin/master') return 'ok';
      return throwing(`unexpected: ${key}`);
    });

    const first = discoverBaseRef(CWD, execFile);
    const callCountAfterFirst = execFile.mock.calls.length;
    const second = discoverBaseRef(CWD, execFile);

    expect(first).toEqual(second);
    expect(execFile.mock.calls.length).toBe(callCountAfterFirst); // no new calls — cache hit

    resetBaseRefDiscoveryCache();
    discoverBaseRef(CWD, execFile);
    expect(execFile.mock.calls.length).toBeGreaterThan(callCountAfterFirst); // cache reset → re-discovers
  });

  it('forceRefresh bypasses the cache without an explicit reset', () => {
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') return throwing('unset');
      if (key === 'rev-parse --verify --quiet origin/master') return 'ok';
      return throwing(`unexpected: ${key}`);
    });

    discoverBaseRef(CWD, execFile);
    const callCountAfterFirst = execFile.mock.calls.length;
    discoverBaseRef(CWD, execFile, true);
    expect(execFile.mock.calls.length).toBeGreaterThan(callCountAfterFirst);
  });
});
