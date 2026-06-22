// tests/orchestrator/orchestrator-preconditions.test.ts
//
// Unit tests for the pure orchestrator-preconditions module (UNIT 1).
// All functions are dependency-injected and have zero filesystem/shell access.
// TDD: these tests are written before the implementation.

import {
  detectStaleBase,
  findUnreadablePaths,
  detectMidFlightCommits,
} from '../../packages/orchestrator/src/orchestrator-preconditions';

// ---------------------------------------------------------------------------
// detectStaleBase
// ---------------------------------------------------------------------------

describe('detectStaleBase', () => {
  const ORIGIN = 'abc123';

  describe('fresh (dispatchSha === originMasterSha)', () => {
    it('returns { stale: false, reason: null } when SHAs match', () => {
      const result = detectStaleBase(ORIGIN, ORIGIN, null);
      expect(result).toEqual({ stale: false, reason: null });
    });

    it('returns { stale: false, reason: null } when SHAs match and mergeBase is provided', () => {
      const result = detectStaleBase(ORIGIN, ORIGIN, 'somemergebase');
      expect(result).toEqual({ stale: false, reason: null });
    });
  });

  describe('stale — behind_origin (mergeBaseSha === dispatchSha)', () => {
    it('returns behind_origin when dispatch is an ancestor of origin master', () => {
      const dispatchSha = 'old111';
      const originSha = 'new999';
      const mergeBaseSha = 'old111'; // mergeBase === dispatch → branch is behind origin
      const result = detectStaleBase(dispatchSha, originSha, mergeBaseSha);
      expect(result).toEqual({ stale: true, reason: 'behind_origin' });
    });

    it('returns behind_origin when mergeBase equals dispatch exactly', () => {
      const dispatchSha = 'deadbeef';
      const result = detectStaleBase(dispatchSha, 'headhash', dispatchSha);
      expect(result).toEqual({ stale: true, reason: 'behind_origin' });
    });
  });

  describe('stale — branched_pre_merge (dispatchSha !== originSha, mergeBase !== dispatch)', () => {
    it('returns branched_pre_merge when dispatch diverged before a merge landed', () => {
      const dispatchSha = 'branch111';
      const originSha = 'master999';
      const mergeBaseSha = 'commonancestor'; // differs from dispatchSha
      const result = detectStaleBase(dispatchSha, originSha, mergeBaseSha);
      expect(result).toEqual({ stale: true, reason: 'branched_pre_merge' });
    });

    it('returns branched_pre_merge when mergeBase is null but SHAs differ', () => {
      const dispatchSha = 'branch111';
      const originSha = 'master999';
      const result = detectStaleBase(dispatchSha, originSha, null);
      expect(result).toEqual({ stale: true, reason: 'branched_pre_merge' });
    });

    it('returns branched_pre_merge when all three values are distinct', () => {
      const result = detectStaleBase('sha-a', 'sha-b', 'sha-c');
      expect(result).toEqual({ stale: true, reason: 'branched_pre_merge' });
    });
  });

  describe('edge cases', () => {
    it('treats empty string dispatch SHA as different from non-empty origin (stale)', () => {
      const result = detectStaleBase('', 'origin123', null);
      expect(result.stale).toBe(true);
    });

    it('treats both SHAs as equal empty strings → fresh', () => {
      // Degenerate but should not crash
      const result = detectStaleBase('', '', null);
      expect(result).toEqual({ stale: false, reason: null });
    });
  });
});

// ---------------------------------------------------------------------------
// findUnreadablePaths
// ---------------------------------------------------------------------------

describe('findUnreadablePaths', () => {
  const alwaysTrue = (_p: string): boolean => true;
  const alwaysFalse = (_p: string): boolean => false;
  const isEven = (_p: string, i: number): boolean => i % 2 === 0;

  it('returns empty array when all paths are readable', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts'];
    expect(findUnreadablePaths(paths, alwaysTrue)).toEqual([]);
  });

  it('returns all paths when none are readable', () => {
    const paths = ['x.ts', 'y.ts'];
    expect(findUnreadablePaths(paths, alwaysFalse)).toEqual(['x.ts', 'y.ts']);
  });

  it('returns empty array for empty input', () => {
    expect(findUnreadablePaths([], alwaysFalse)).toEqual([]);
  });

  it('returns subset of unreadable paths', () => {
    const paths = ['readable.ts', 'missing.ts', 'also-readable.ts'];
    const canRead = (p: string): boolean => !p.startsWith('missing');
    expect(findUnreadablePaths(paths, canRead)).toEqual(['missing.ts']);
  });

  it('returns paths in original order', () => {
    const paths = ['a', 'b', 'c', 'd', 'e'];
    const canRead = (p: string): boolean => p === 'b' || p === 'd';
    expect(findUnreadablePaths(paths, canRead)).toEqual(['a', 'c', 'e']);
  });

  it('handles a single unreadable path', () => {
    expect(findUnreadablePaths(['/some/file.ts'], alwaysFalse)).toEqual(['/some/file.ts']);
  });

  it('handles a single readable path', () => {
    expect(findUnreadablePaths(['/some/file.ts'], alwaysTrue)).toEqual([]);
  });

  it('passes the full path string to canRead unchanged', () => {
    const seen: string[] = [];
    const canRead = (p: string): boolean => { seen.push(p); return true; };
    findUnreadablePaths(['/a/b/c.ts', 'relative/path'], canRead);
    expect(seen).toEqual(['/a/b/c.ts', 'relative/path']);
  });

  // isEven is only used for coverage of the _p param annotation — unused in suite
  void isEven;
});

// ---------------------------------------------------------------------------
// detectMidFlightCommits
// ---------------------------------------------------------------------------

describe('detectMidFlightCommits', () => {
  it('returns { detected: false, count: 0 } for empty array', () => {
    expect(detectMidFlightCommits([])).toEqual({ detected: false, count: 0 });
  });

  it('returns { detected: true, count: 1 } for one commit', () => {
    expect(detectMidFlightCommits(['abc123'])).toEqual({ detected: true, count: 1 });
  });

  it('returns { detected: true, count: N } for N commits', () => {
    const commits = ['sha1', 'sha2', 'sha3'];
    expect(detectMidFlightCommits(commits)).toEqual({ detected: true, count: 3 });
  });

  it('is not affected by commit content — only length matters', () => {
    expect(detectMidFlightCommits(['', '', ''])).toEqual({ detected: true, count: 3 });
  });

  it('handles a large array without issues', () => {
    const many = Array.from({ length: 100 }, (_, i) => `commit${i}`);
    const result = detectMidFlightCommits(many);
    expect(result).toEqual({ detected: true, count: 100 });
  });
});
