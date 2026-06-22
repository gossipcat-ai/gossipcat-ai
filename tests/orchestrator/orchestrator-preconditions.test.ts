// tests/orchestrator/orchestrator-preconditions.test.ts
//
// Unit tests for the pure orchestrator-preconditions module (UNIT 1).
// All functions are dependency-injected and have zero filesystem/shell access.
// TDD: these tests are written before the implementation.

import {
  detectStaleBase,
  findUnreadablePaths,
  detectMidFlightCommits,
  extractReferencedPaths,
  extractReferencedPathsWithMeta,
  findUnreadableReferencedPaths,
  findUnreadableReferencedPathsWithMeta,
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

  describe('strictly ahead of origin (mergeBaseSha === originMasterSha)', () => {
    it('returns { stale: false, reason: ahead_of_origin } when origin is an ancestor of HEAD', () => {
      // mergeBase === originSha → origin is an ancestor of HEAD; branch is strictly ahead
      const result = detectStaleBase('feature-tip', 'origin-head', 'origin-head');
      expect(result).toEqual({ stale: false, reason: 'ahead_of_origin' });
    });

    it('returns ahead_of_origin for any feature branch strictly ahead of origin', () => {
      const result = detectStaleBase('abc999', 'abc111', 'abc111');
      expect(result).toEqual({ stale: false, reason: 'ahead_of_origin' });
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

// ---------------------------------------------------------------------------
// extractReferencedPaths
// ---------------------------------------------------------------------------

describe('extractReferencedPaths', () => {
  it('returns [] for empty text', () => {
    expect(extractReferencedPaths('')).toEqual([]);
  });

  it('extracts a backtick-quoted path', () => {
    const text = 'Implement BUG A from spec `docs/specs/2026-06-22-fix.md` now.';
    expect(extractReferencedPaths(text)).toEqual(['docs/specs/2026-06-22-fix.md']);
  });

  it('extracts a bare whitespace-delimited path', () => {
    const text = 'Edit packages/orchestrator/src/orchestrator-preconditions.ts please.';
    expect(extractReferencedPaths(text)).toEqual([
      'packages/orchestrator/src/orchestrator-preconditions.ts',
    ]);
  });

  it('extracts mixed backtick and bare tokens', () => {
    const text = 'Read `a/b.md` then update c/d.ts and e.json';
    expect(extractReferencedPaths(text)).toEqual(['a/b.md', 'c/d.ts', 'e.json']);
  });

  it('accepts a leading ./ prefix', () => {
    expect(extractReferencedPaths('see ./src/index.ts')).toEqual(['./src/index.ts']);
  });

  it('ignores non-path tokens (prose, version strings, e.g.)', () => {
    const text = 'Implement this now, e.g. quickly, version 1.2.3 of the thing.';
    expect(extractReferencedPaths(text)).toEqual([]);
  });

  it('ignores tokens without a known extension', () => {
    expect(extractReferencedPaths('go to packages/orchestrator/src and look')).toEqual([]);
  });

  it('rejects absolute paths', () => {
    expect(extractReferencedPaths('read /etc/passwd.txt and /tmp/x.md')).toEqual([]);
  });

  it('rejects traversal tokens containing ..', () => {
    expect(extractReferencedPaths('read ../secrets/key.json and ../../a.ts')).toEqual([]);
  });

  it('strips surrounding punctuation/parentheses', () => {
    expect(extractReferencedPaths('see (foo/bar.md), then baz.ts.')).toEqual([
      'foo/bar.md',
      'baz.ts',
    ]);
  });

  it('de-duplicates repeated paths (first-seen order)', () => {
    const text = 'edit a.ts, then b.ts, then a.ts again';
    expect(extractReferencedPaths(text)).toEqual(['a.ts', 'b.ts']);
  });

  it('caps the result at 20 distinct paths', () => {
    const tokens = Array.from({ length: 30 }, (_, i) => `file${i}.ts`);
    const text = tokens.join(' ');
    const result = extractReferencedPaths(text);
    expect(result).toHaveLength(20);
    expect(result[0]).toBe('file0.ts');
    expect(result[19]).toBe('file19.ts');
  });

  it('accepts each allowed extension', () => {
    const text = 'a.md b.ts c.tsx d.js e.json f.txt g.yaml h.yml';
    expect(extractReferencedPaths(text)).toEqual([
      'a.md', 'b.ts', 'c.tsx', 'd.js', 'e.json', 'f.txt', 'g.yaml', 'h.yml',
    ]);
  });

  // Fix 2: strip a trailing path:line (and path:line:col) citation suffix
  // before the shape test, since this codebase cites path:line pervasively.
  it('strips a trailing :line citation suffix', () => {
    expect(extractReferencedPaths('see docs/specs/x.md:12 now')).toEqual([
      'docs/specs/x.md',
    ]);
  });

  it('strips a trailing :line:col citation suffix', () => {
    expect(extractReferencedPaths('at src/index.ts:12:5 there')).toEqual([
      'src/index.ts',
    ]);
  });

  it('strips a :line suffix inside a backtick-quoted citation', () => {
    expect(extractReferencedPaths('`packages/orchestrator/src/x.ts:99`')).toEqual([
      'packages/orchestrator/src/x.ts',
    ]);
  });

  it('does not strip digits that are part of the filename (no trailing colon)', () => {
    // 2026-06-22-fix.md has no `:line` suffix — must survive intact.
    expect(extractReferencedPaths('docs/specs/2026-06-22-fix.md')).toEqual([
      'docs/specs/2026-06-22-fix.md',
    ]);
  });

  it('dedupes path:12 and path (same path) to a single entry', () => {
    expect(extractReferencedPaths('foo.ts:12 and foo.ts again')).toEqual(['foo.ts']);
  });
});

// ---------------------------------------------------------------------------
// extractReferencedPathsWithMeta — over-cap drop count (Fix 3)
// ---------------------------------------------------------------------------

describe('extractReferencedPathsWithMeta', () => {
  it('reports droppedOverCap 0 when under the cap', () => {
    const result = extractReferencedPathsWithMeta('a.ts b.ts c.ts');
    expect(result.paths).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(result.droppedOverCap).toBe(0);
  });

  it('reports the number of distinct tokens dropped over the 20-path cap', () => {
    const tokens = Array.from({ length: 25 }, (_, i) => `file${i}.ts`);
    const result = extractReferencedPathsWithMeta(tokens.join(' '));
    expect(result.paths).toHaveLength(20);
    expect(result.paths[0]).toBe('file0.ts');
    expect(result.paths[19]).toBe('file19.ts');
    // 25 distinct − 20 kept = 5 dropped over cap.
    expect(result.droppedOverCap).toBe(5);
  });

  it('does not count duplicate tokens beyond the cap as drops', () => {
    const distinct = Array.from({ length: 22 }, (_, i) => `f${i}.ts`);
    // Append 5 repeats of already-seen paths — those must NOT inflate the count.
    const text = [...distinct, 'f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts'].join(' ');
    const result = extractReferencedPathsWithMeta(text);
    expect(result.paths).toHaveLength(20);
    expect(result.droppedOverCap).toBe(2);
  });

  it('returns empty + 0 for empty input', () => {
    expect(extractReferencedPathsWithMeta('')).toEqual({ paths: [], droppedOverCap: 0 });
  });
});

// ---------------------------------------------------------------------------
// findUnreadableReferencedPathsWithMeta — propagates the drop count (Fix 3)
// ---------------------------------------------------------------------------

describe('findUnreadableReferencedPathsWithMeta', () => {
  it('propagates droppedOverCap from the extractor', () => {
    const tokens = Array.from({ length: 23 }, (_, i) => `g${i}.ts`);
    const result = findUnreadableReferencedPathsWithMeta(tokens.join(' '), {
      writeMode: 'sequential',
      pathExists: () => true,
      isGitignoredOrUntracked: () => false,
    });
    expect(result.droppedOverCap).toBe(3);
    expect(result.unreadable).toEqual([]); // all readable
  });

  it('reports unreadable entries plus a zero drop count under cap', () => {
    const result = findUnreadableReferencedPathsWithMeta('read `docs/typo.md`', {
      writeMode: 'worktree',
      pathExists: () => false,
      isGitignoredOrUntracked: () => false,
    });
    expect(result.unreadable).toEqual([{ path: 'docs/typo.md', reason: 'missing' }]);
    expect(result.droppedOverCap).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findUnreadableReferencedPaths
// ---------------------------------------------------------------------------

describe('findUnreadableReferencedPaths', () => {
  const allExist = (_p: string): boolean => true;
  const noneExist = (_p: string): boolean => false;
  const neverIgnored = (_p: string): boolean => false;
  const alwaysIgnored = (_p: string): boolean => true;

  it('returns [] when there are no referenced paths', () => {
    const result = findUnreadableReferencedPaths('no paths here at all', {
      writeMode: 'worktree',
      pathExists: allExist,
      isGitignoredOrUntracked: alwaysIgnored,
    });
    expect(result).toEqual([]);
  });

  describe('worktree write mode', () => {
    it('flags a gitignored existing path as gitignored_in_worktree', () => {
      const result = findUnreadableReferencedPaths('read `docs/specs/x.md`', {
        writeMode: 'worktree',
        pathExists: allExist,
        isGitignoredOrUntracked: alwaysIgnored,
      });
      expect(result).toEqual([
        { path: 'docs/specs/x.md', reason: 'gitignored_in_worktree' },
      ]);
    });

    it('flags a nonexistent path as missing (typo case)', () => {
      const result = findUnreadableReferencedPaths('read `docs/typo.md`', {
        writeMode: 'worktree',
        pathExists: noneExist,
        isGitignoredOrUntracked: neverIgnored,
      });
      expect(result).toEqual([{ path: 'docs/typo.md', reason: 'missing' }]);
    });

    it('does not flag a tracked, existing path', () => {
      const result = findUnreadableReferencedPaths('read `src/index.ts`', {
        writeMode: 'worktree',
        pathExists: allExist,
        isGitignoredOrUntracked: neverIgnored,
      });
      expect(result).toEqual([]);
    });

    it('reports missing for nonexistent and gitignored_in_worktree for ignored together', () => {
      const result = findUnreadableReferencedPaths('read present.md and absent.md', {
        writeMode: 'worktree',
        pathExists: (p: string) => p === 'present.md',
        isGitignoredOrUntracked: (p: string) => p === 'present.md',
      });
      expect(result).toEqual([
        { path: 'present.md', reason: 'gitignored_in_worktree' },
        { path: 'absent.md', reason: 'missing' },
      ]);
    });
  });

  describe('non-worktree (sequential / scoped / undefined) write mode', () => {
    it('flags a missing path as missing', () => {
      const result = findUnreadableReferencedPaths('read `docs/typo.md`', {
        writeMode: 'sequential',
        pathExists: noneExist,
        isGitignoredOrUntracked: alwaysIgnored,
      });
      expect(result).toEqual([{ path: 'docs/typo.md', reason: 'missing' }]);
    });

    it('does NOT flag a gitignored-but-existing path (readable from repo root)', () => {
      const result = findUnreadableReferencedPaths('read `docs/specs/x.md`', {
        writeMode: 'sequential',
        pathExists: allExist,
        isGitignoredOrUntracked: alwaysIgnored, // ignored, but writeMode != worktree
      });
      expect(result).toEqual([]);
    });

    it('returns [] for a readable path', () => {
      const result = findUnreadableReferencedPaths('read `src/index.ts`', {
        writeMode: undefined,
        pathExists: allExist,
        isGitignoredOrUntracked: neverIgnored,
      });
      expect(result).toEqual([]);
    });
  });
});
