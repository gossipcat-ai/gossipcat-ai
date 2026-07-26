/**
 * Tests for base-ref-discovery.ts — resolves the git ref used in place of a
 * hardcoded 'origin/master' for ref-allowlist snapshotting and the
 * dispatched_stale_base precondition. Issue #658.
 *
 * Precedence under test:
 *   1. GOSSIP_BASE_REF env override — wins, but is VALIDATED: it must be
 *      ref-shaped, must resolve, and must be remote-tracking. An override
 *      naming a local branch is rejected, because the direct-push detector
 *      would then flag any unrelated local commit as a violation against an
 *      innocent agent.
 *   2. git symbolic-ref refs/remotes/origin/HEAD, parsed to 'origin/<branch>'.
 *   3. Fallback candidates origin/master, then origin/main (first that
 *      verifies via `rev-parse --verify --quiet`).
 *   4. Unresolvable → null with a diagnostic. Every git call here is a local
 *      lookup, so the wording never claims "offline".
 *
 * Also covers caching semantics: POSITIVE results are cached per cwd; negative
 * results are NOT cached (so adding a remote mid-session recovers without a
 * restart), and the env override is read BEFORE the cache.
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
  // A validated override DOES call git — it must prove the ref resolves and is
  // remote-tracking. Accepting it blind is what let GOSSIP_BASE_REF=master fire
  // a bogus REF-ALLOWLIST VIOLATION against an innocent agent.
  const remoteTrackingExec = (ref: string) =>
    jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      if (args[0] === 'rev-parse' && args.includes('--verify')) return 'abc123\n';
      if (args[0] === 'rev-parse' && args.includes('--symbolic-full-name')) return `refs/remotes/${ref}\n`;
      return throwing(`unexpected git call: ${args.join(' ')}`);
    });

  it('wins over everything else when it names a resolvable remote-tracking ref', () => {
    process.env.GOSSIP_BASE_REF = 'upstream/develop';
    const execFile = remoteTrackingExec('upstream/develop');
    expect(discoverBaseRef(CWD, execFile)).toEqual({ ref: 'upstream/develop' });
    // No symbolic-ref/remote discovery calls — the override short-circuits them.
    expect(execFile.mock.calls.every(([, args]) => args[0] === 'rev-parse')).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    process.env.GOSSIP_BASE_REF = '  origin/release  ';
    expect(discoverBaseRef(CWD, remoteTrackingExec('origin/release')).ref).toBe('origin/release');
  });

  it('REJECTS an override naming a local branch (would flag an innocent agent)', () => {
    process.env.GOSSIP_BASE_REF = 'master';
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      if (args[0] === 'rev-parse' && args.includes('--verify')) return 'abc123\n';
      if (args[0] === 'rev-parse' && args.includes('--symbolic-full-name')) return 'refs/heads/master\n';
      return throwing(`unexpected git call: ${args.join(' ')}`);
    });
    const result = discoverBaseRef(CWD, execFile);
    expect(result.ref).toBeNull();
    expect(result.diagnostic).toContain('not a remote-tracking ref');
    expect(result.diagnostic).toContain('origin/master');
  });

  it('REJECTS an override that does not resolve', () => {
    process.env.GOSSIP_BASE_REF = 'origin/mian';
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>(
      () => throwing('unknown revision'),
    );
    const result = discoverBaseRef(CWD, execFile);
    expect(result.ref).toBeNull();
    expect(result.diagnostic).toContain('does not resolve');
  });

  it.each(['--all', '-e', 'origin/main extra', 'origin/\tmain'])(
    'REJECTS a non-ref-shaped override without calling git: %j',
    (bad) => {
      process.env.GOSSIP_BASE_REF = bad;
      const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>(
        () => throwing('should not be called'),
      );
      const result = discoverBaseRef(CWD, execFile);
      expect(result.ref).toBeNull();
      expect(result.diagnostic).toContain('not a valid ref name');
      expect(execFile).not.toHaveBeenCalled();
    },
  );

  it('is read BEFORE the cache, so it recovers a cached-negative session', () => {
    const failing = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>(
      () => throwing('no refs'),
    );
    expect(discoverBaseRef(CWD, failing).ref).toBeNull();

    process.env.GOSSIP_BASE_REF = 'origin/main';
    expect(discoverBaseRef(CWD, remoteTrackingExec('origin/main')).ref).toBe('origin/main');
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

  it('names the honest causes when there is no origin remote at all', () => {
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
    expect(result.diagnostic).toContain('no remote named "origin"');
    // Every git call in this module is a local ref/config lookup, so "offline"
    // can never be the true cause and must not be claimed.
    expect(result.diagnostic).not.toMatch(/offline/i);
  });

  it('names the honest causes when git itself is unreachable (not a repo)', () => {
    const execFile = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>(
      () => throwing('fatal: not a git repository'),
    );
    const result = discoverBaseRef(CWD, execFile);
    expect(result.ref).toBeNull();
    expect(result.diagnostic).toContain('not a git repository');
    expect(result.diagnostic).not.toMatch(/offline/i);
  });
});

describe('discoverBaseRef — cache semantics', () => {
  const resolvingExec = (which: string) =>
    jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>((_cmd, args) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') return throwing('unset');
      if (key === `rev-parse --verify --quiet ${which}`) return 'abc123\n';
      if (key.startsWith('rev-parse --verify --quiet')) return throwing('fatal: ambiguous argument');
      return throwing(`unexpected: ${key}`);
    });

  it('does NOT cache a negative result — adding a remote mid-session recovers', () => {
    const failing = jest.fn<ReturnType<ExecFileLike>, Parameters<ExecFileLike>>(
      () => throwing('no refs yet'),
    );
    expect(discoverBaseRef(CWD, failing).ref).toBeNull();

    // Operator runs `git remote add origin ... && git fetch`. No restart.
    expect(discoverBaseRef(CWD, resolvingExec('origin/main')).ref).toBe('origin/main');
  });

  it('keys the cache by cwd — a second root does not inherit the first ref', () => {
    expect(discoverBaseRef('/repoA', resolvingExec('origin/main')).ref).toBe('origin/main');
    expect(discoverBaseRef('/repoB', resolvingExec('origin/master')).ref).toBe('origin/master');
    // /repoA still served from its own cache entry, not overwritten by /repoB.
    expect(discoverBaseRef('/repoA', resolvingExec('origin/main')).ref).toBe('origin/main');
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
