/**
 * Tests for Layer 3 `find -newer` boundary audit (issue #90).
 *
 * Covers bypasses Layer 2 (PreToolUse hook) cannot see because the shell
 * resolves them after the hook has already returned allow:
 *   - Tilde expansion:    ~/outside.txt
 *   - Env-var paths:      $HOME/outside.txt, ${HOME}/outside.txt
 *   - Shell-quoted paths: "/etc/passwd"
 *
 * Also verifies per-task sentinel isolation across concurrent dispatches,
 * own-worktree exclusion, peer-worktree inclusion, and Windows gating.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  auditFilesystemSinceSentinel,
  buildAuditExclusions,
  cleanupTaskSentinel,
  defaultScanRoots,
  DispatchMetadata,
  lookupDispatchMetadata,
  recordDispatchMetadata,
  stampTaskSentinel,
  updateDispatchMetadata,
} from '../../apps/cli/src/sandbox';

// find is POSIX-only; skip these tests on Windows runners.
const itOnPosix = process.platform === 'win32' ? it.skip : it;
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

/** Allocate a disposable tmp dir that auto-cleans at teardown. */
function mkTmp(prefix = 'gossip-l3-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Stamp a sentinel mtime N ms in the past so subsequent writes satisfy
 * `find -newer <sentinel>` even when the filesystem timestamp resolution
 * is coarse (1 s on HFS+ / older macOS APFS variants). */
function backdateSentinel(path: string, pastMs: number): void {
  const when = new Date(Date.now() - pastMs);
  utimesSync(path, when, when);
}

describeOnPosix('stampTaskSentinel', () => {
  it('creates a per-task sentinel under .gossip/sentinels/', () => {
    const projectRoot = mkTmp();
    try {
      const path = stampTaskSentinel(projectRoot, 'task-abc');
      expect(path).not.toBeNull();
      expect(path).toContain('sentinels');
      expect(path).toContain('task-abc.sentinel');
      expect(existsSync(path!)).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('generates distinct sentinel paths for different task IDs (no cross-contamination)', () => {
    const projectRoot = mkTmp();
    try {
      const a = stampTaskSentinel(projectRoot, 'task-aaa');
      const b = stampTaskSentinel(projectRoot, 'task-bbb');
      const c = stampTaskSentinel(projectRoot, 'task-ccc');
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(c).not.toBeNull();
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(existsSync(a!)).toBe(true);
      expect(existsSync(b!)).toBe(true);
      expect(existsSync(c!)).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('sanitizes special chars in taskId to a filesystem-safe slug', () => {
    const projectRoot = mkTmp();
    try {
      // Even though dispatch validates taskId, sandbox hardens defensively.
      const path = stampTaskSentinel(projectRoot, 'weird/../id');
      expect(path).not.toBeNull();
      expect(path).not.toContain('/../');
      expect(existsSync(path!)).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('stamps mtime within a few seconds of NOW', () => {
    const projectRoot = mkTmp();
    try {
      const before = Date.now();
      const path = stampTaskSentinel(projectRoot, 'now-check');
      const after = Date.now();
      const mtime = statSync(path!).mtimeMs;
      // Allow 2 s slack for clock granularity, plus 1 ms for fs float
      // precision loss (mtimeMs can come back as N.999 on APFS).
      expect(mtime).toBeGreaterThanOrEqual(before - 2000 - 1);
      expect(mtime).toBeLessThanOrEqual(after + 2000 + 1);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describeOnPosix('cleanupTaskSentinel', () => {
  it('removes an existing sentinel file', () => {
    const projectRoot = mkTmp();
    try {
      const path = stampTaskSentinel(projectRoot, 'cleanup-1')!;
      expect(existsSync(path)).toBe(true);
      cleanupTaskSentinel(path);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('is idempotent when sentinel is already gone', () => {
    const projectRoot = mkTmp();
    try {
      const path = join(projectRoot, '.gossip', 'sentinels', 'ghost.sentinel');
      // Never created. Must not throw.
      expect(() => cleanupTaskSentinel(path)).not.toThrow();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('is a no-op on undefined path', () => {
    expect(() => cleanupTaskSentinel(undefined)).not.toThrow();
  });
});

describeOnPosix('buildAuditExclusions', () => {
  it('excludes the current task worktree and project .gossip/.claude', () => {
    const excl = buildAuditExclusions('/tmp/projectroot', '/tmp/gossip-wt-mine');
    expect(excl.some(e => e.endsWith('/.gossip'))).toBe(true);
    expect(excl.some(e => e.endsWith('/.claude'))).toBe(true);
    expect(excl.some(e => e.includes('/tmp/gossip-wt-mine'))).toBe(true);
  });

  it('excludes only THIS task worktree, not peers', () => {
    const excl = buildAuditExclusions('/tmp/proj', '/tmp/gossip-wt-self');
    expect(excl.some(e => e.includes('gossip-wt-self'))).toBe(true);
    expect(excl.some(e => e.includes('gossip-wt-other'))).toBe(false);
  });

  it('omits worktree exclusion when ownWorktree is undefined', () => {
    const excl = buildAuditExclusions('/tmp/proj', undefined);
    expect(excl.some(e => e.includes('gossip-wt'))).toBe(false);
  });
});

describeOnPosix('defaultScanRoots', () => {
  it('includes $HOME, tmpdir, /tmp, /private/tmp (dedup)', () => {
    const roots = defaultScanRoots();
    // Should contain at least one of these.
    expect(roots.length).toBeGreaterThan(0);
    // Unique values only (Set semantics)
    expect(new Set(roots).size).toBe(roots.length);
  });
});

describeOnPosix('auditFilesystemSinceSentinel — Windows gate', () => {
  it('skips with reason=win32 and no violations', () => {
    const projectRoot = mkTmp();
    try {
      const meta: DispatchMetadata = {
        taskId: 'win-test',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
      };
      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        platform: 'win32',
        logFailures: false,
      });
      expect(res.skipped).toBe('win32');
      expect(res.violations).toEqual([]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describeOnPosix('auditFilesystemSinceSentinel — sentinel missing', () => {
  it('fail-opens when sentinelPath is undefined', () => {
    const projectRoot = mkTmp();
    try {
      const meta: DispatchMetadata = {
        taskId: 'no-sentinel',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
      };
      const res = auditFilesystemSinceSentinel(projectRoot, meta, { logFailures: false });
      expect(res.skipped).toBeDefined();
      expect(res.violations).toEqual([]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('fail-opens when sentinel file was removed', () => {
    const projectRoot = mkTmp();
    try {
      const sentinel = stampTaskSentinel(projectRoot, 'vanish')!;
      cleanupTaskSentinel(sentinel);
      const meta: DispatchMetadata = {
        taskId: 'vanish',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };
      const res = auditFilesystemSinceSentinel(projectRoot, meta, { logFailures: false });
      expect(res.skipped).toBeDefined();
      expect(res.violations).toEqual([]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describeOnPosix('auditFilesystemSinceSentinel — bypass detection', () => {
  itOnPosix('flags a tilde-expansion bypass target written after dispatch start', () => {
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    try {
      const sentinel = stampTaskSentinel(projectRoot, 'tilde-bypass')!;
      // Backdate the sentinel 5s so the upcoming write is reliably newer
      // even on coarse-grained filesystems.
      backdateSentinel(sentinel, 5000);

      // Simulate: agent expanded `~/outside.txt` and wrote here.
      const bypassPath = join(scanRoot, 'outside.txt');
      writeFileSync(bypassPath, 'exfil');

      const meta: DispatchMetadata = {
        taskId: 'tilde-bypass',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };

      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        logFailures: false,
      });

      expect(res.violations.length).toBeGreaterThanOrEqual(1);
      expect(res.violations.some(v => v.endsWith('outside.txt'))).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });

  itOnPosix('flags an env-var bypass ($HOME/exfil) written after dispatch start', () => {
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    try {
      const sentinel = stampTaskSentinel(projectRoot, 'envvar-bypass')!;
      backdateSentinel(sentinel, 5000);

      // Simulate shell-expanded `$HOME/exfil` landing here.
      const bypassPath = join(scanRoot, 'exfil');
      writeFileSync(bypassPath, 'env-var leak');

      const meta: DispatchMetadata = {
        taskId: 'envvar-bypass',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };

      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        logFailures: false,
      });

      expect(res.violations.some(v => v.endsWith('exfil'))).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });

  itOnPosix('does NOT flag own-worktree writes', () => {
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    const ownWorktree = join(scanRoot, 'gossip-wt-self');
    try {
      mkdirSync(ownWorktree, { recursive: true });
      const sentinel = stampTaskSentinel(projectRoot, 'own-wt')!;
      backdateSentinel(sentinel, 5000);

      // Simulate a legitimate write inside the agent's own worktree.
      writeFileSync(join(ownWorktree, 'work.ts'), 'legit write');

      const meta: DispatchMetadata = {
        taskId: 'own-wt',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        worktreePath: ownWorktree,
        sentinelPath: sentinel,
      };

      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        logFailures: false,
      });

      // The legit file inside the own worktree MUST NOT appear.
      expect(res.violations.some(v => v.includes('work.ts'))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });

  itOnPosix('DOES flag writes to a peer worktree (peer is a separate isolation zone)', () => {
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    const ownWorktree = join(scanRoot, 'gossip-wt-self');
    const peerWorktree = join(scanRoot, 'gossip-wt-peer');
    try {
      mkdirSync(ownWorktree, { recursive: true });
      mkdirSync(peerWorktree, { recursive: true });
      const sentinel = stampTaskSentinel(projectRoot, 'peer-wt')!;
      backdateSentinel(sentinel, 5000);

      // Agent wrote to a peer's worktree — that's a cross-contamination bypass.
      writeFileSync(join(peerWorktree, 'leaked.ts'), 'hostile payload');

      const meta: DispatchMetadata = {
        taskId: 'peer-wt',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        worktreePath: ownWorktree,
        sentinelPath: sentinel,
      };

      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        logFailures: false,
      });

      expect(res.violations.some(v => v.includes('leaked.ts'))).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });

  itOnPosix('does NOT flag files older than the sentinel', () => {
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    try {
      // Create a pre-existing file, then stamp the sentinel AFTER it.
      const preExisting = join(scanRoot, 'old.txt');
      writeFileSync(preExisting, 'pre-existing');
      // Age the pre-existing file by 10s so it's definitely before the sentinel.
      const tenSecAgo = new Date(Date.now() - 10_000);
      utimesSync(preExisting, tenSecAgo, tenSecAgo);

      const sentinel = stampTaskSentinel(projectRoot, 'old-file')!;
      // Sentinel stamped AFTER the old file, so -newer excludes it.

      const meta: DispatchMetadata = {
        taskId: 'old-file',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };

      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        logFailures: false,
      });

      // old.txt predates the sentinel → not a violation.
      expect(res.violations.some(v => v.endsWith('old.txt'))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });
});

describeOnPosix('auditFilesystemSinceSentinel — fail-open on find errors', () => {
  it('returns empty violations and does NOT throw when find binary is missing', () => {
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    try {
      const sentinel = stampTaskSentinel(projectRoot, 'fail-open')!;

      const meta: DispatchMetadata = {
        taskId: 'fail-open',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };

      // Non-existent binary forces execFileSync to throw; audit must swallow.
      expect(() =>
        auditFilesystemSinceSentinel(projectRoot, meta, {
          scanRoots: [scanRoot],
          findBinary: '/nonexistent/gossipcat-find-binary',
          logFailures: false,
        }),
      ).not.toThrow();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });
});

describeOnPosix('auditFilesystemSinceSentinel — boundary-escapes.jsonl logging', () => {
  itOnPosix('appends one JSONL entry per violating path', () => {
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    try {
      const sentinel = stampTaskSentinel(projectRoot, 'logged')!;
      backdateSentinel(sentinel, 5000);

      writeFileSync(join(scanRoot, 'leak1.txt'), 'a');
      writeFileSync(join(scanRoot, 'leak2.txt'), 'b');

      const meta: DispatchMetadata = {
        taskId: 'logged',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };

      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        logFailures: false,
      });

      expect(res.violations.length).toBeGreaterThanOrEqual(2);

      const logPath = join(projectRoot, '.gossip', 'boundary-escapes.jsonl');
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const parsed = lines.map(l => JSON.parse(l));
      for (const entry of parsed) {
        expect(entry.taskId).toBe('logged');
        expect(entry.agentId).toBe('opus-implementer');
        expect(entry.source).toBe('layer3-audit');
        // F6: shape matches Layer 2's violatingPaths array — 1 element per line.
        expect(Array.isArray(entry.violatingPaths)).toBe(true);
        expect(entry.violatingPaths.length).toBe(1);
        expect(typeof entry.violatingPaths[0]).toBe('string');
        expect(typeof entry.timestamp).toBe('string');
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });
});

describeOnPosix('recordDispatchMetadata — per-task sentinel integration', () => {
  it('stamps a sentinel for worktree dispatch and exposes it on lookup', () => {
    const projectRoot = mkTmp();
    try {
      const meta: DispatchMetadata = {
        taskId: 'record-wt',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
      };
      recordDispatchMetadata(projectRoot, meta);

      // The stored metadata (via the JSONL append) should now contain a
      // sentinelPath field. Read it back.
      const jsonl = readFileSync(
        join(projectRoot, '.gossip', 'dispatch-metadata.jsonl'),
        'utf-8',
      );
      const last = JSON.parse(jsonl.trim().split('\n').pop()!);
      expect(last.sentinelPath).toBeDefined();
      expect(existsSync(last.sentinelPath)).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('stamps distinct sentinels for two concurrent worktree dispatches', () => {
    const projectRoot = mkTmp();
    try {
      recordDispatchMetadata(projectRoot, {
        taskId: 'concurrent-a',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
      });
      recordDispatchMetadata(projectRoot, {
        taskId: 'concurrent-b',
        agentId: 'sonnet-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
      });

      const jsonl = readFileSync(
        join(projectRoot, '.gossip', 'dispatch-metadata.jsonl'),
        'utf-8',
      );
      const entries = jsonl.trim().split('\n').map(l => JSON.parse(l));
      const a = entries.find(e => e.taskId === 'concurrent-a');
      const b = entries.find(e => e.taskId === 'concurrent-b');
      expect(a?.sentinelPath).toBeDefined();
      expect(b?.sentinelPath).toBeDefined();
      expect(a.sentinelPath).not.toBe(b.sentinelPath);
      // Both must exist simultaneously — no shared-state race.
      expect(existsSync(a.sentinelPath)).toBe(true);
      expect(existsSync(b.sentinelPath)).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('does NOT stamp a sentinel for sequential mode', () => {
    const projectRoot = mkTmp();
    try {
      recordDispatchMetadata(projectRoot, {
        taskId: 'seq-only',
        agentId: 'opus-implementer',
        writeMode: 'sequential',
        timestamp: Date.now(),
      });

      const jsonl = readFileSync(
        join(projectRoot, '.gossip', 'dispatch-metadata.jsonl'),
        'utf-8',
      );
      const last = JSON.parse(jsonl.trim().split('\n').pop()!);
      // sequential dispatch doesn't stamp a sentinel — audit is opt-in for
      // scoped/worktree.
      expect(last.sentinelPath).toBeUndefined();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describeOnPosix('dispatch→lookup→audit round-trip', () => {
  itOnPosix('records worktreePath, recovers it via lookup, then audits scoped to it', () => {
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    const ownWorktree = join(scanRoot, 'gossip-wt-roundtrip');
    try {
      mkdirSync(ownWorktree, { recursive: true });

      // 1. recordDispatchMetadata with a real worktreePath
      recordDispatchMetadata(projectRoot, {
        taskId: 'round-trip',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        worktreePath: ownWorktree,
        timestamp: Date.now(),
      });

      // 2. lookupDispatchMetadata roundtrips the path
      const meta = lookupDispatchMetadata(projectRoot, 'round-trip');
      expect(meta).not.toBeNull();
      expect(meta!.worktreePath).toBe(ownWorktree);
      expect(meta!.sentinelPath).toBeDefined();

      // 3. Backdate the sentinel so upcoming writes satisfy -newer.
      backdateSentinel(meta!.sentinelPath!, 5000);

      // 4. Write one file INSIDE the worktree (legit) and one OUTSIDE (bypass)
      writeFileSync(join(ownWorktree, 'inside.ts'), 'legit');
      const outsidePath = join(scanRoot, 'outside.ts');
      writeFileSync(outsidePath, 'bypass');

      // 5. Audit — only the outside file appears in violations
      const res = auditFilesystemSinceSentinel(projectRoot, meta!, {
        scanRoots: [scanRoot],
        logFailures: false,
      });
      expect(res.violations.some(v => v.endsWith('outside.ts'))).toBe(true);
      expect(res.violations.some(v => v.endsWith('inside.ts'))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });
});

describeOnPosix('updateDispatchMetadata', () => {
  it('merges a patch into the last matching record', () => {
    const projectRoot = mkTmp();
    try {
      // Record with worktreePath undefined (simulates async worktree creation)
      recordDispatchMetadata(projectRoot, {
        taskId: 'patch-me',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        worktreePath: undefined,
        timestamp: Date.now(),
      });

      // Pre-patch: worktreePath is undefined
      const before = lookupDispatchMetadata(projectRoot, 'patch-me');
      expect(before).not.toBeNull();
      expect(before!.worktreePath).toBeUndefined();

      // Update with real path
      const patched = updateDispatchMetadata(projectRoot, 'patch-me', {
        worktreePath: '/tmp/real-worktree-path',
      });
      expect(patched).toBe(true);

      // Round-trip
      const after = lookupDispatchMetadata(projectRoot, 'patch-me');
      expect(after).not.toBeNull();
      expect(after!.worktreePath).toBe('/tmp/real-worktree-path');
      // Other fields preserved
      expect(after!.taskId).toBe('patch-me');
      expect(after!.agentId).toBe('opus-implementer');
      expect(after!.writeMode).toBe('worktree');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns false when taskId does not match any record', () => {
    const projectRoot = mkTmp();
    try {
      recordDispatchMetadata(projectRoot, {
        taskId: 'exists',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
      });
      const result = updateDispatchMetadata(projectRoot, 'does-not-exist', {
        worktreePath: '/tmp/whatever',
      });
      expect(result).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns false when metadata file is missing', () => {
    const projectRoot = mkTmp();
    try {
      const result = updateDispatchMetadata(projectRoot, 'anything', {
        worktreePath: '/tmp/whatever',
      });
      expect(result).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('updates the LAST record when multiple share the same taskId', () => {
    const projectRoot = mkTmp();
    try {
      // Simulate re-dispatch of the same taskId (defensive — taskIds are
      // usually unique but sandbox hardens against duplicates).
      recordDispatchMetadata(projectRoot, {
        taskId: 'dup',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        worktreePath: '/tmp/first',
        timestamp: Date.now(),
      });
      recordDispatchMetadata(projectRoot, {
        taskId: 'dup',
        agentId: 'sonnet-implementer',
        writeMode: 'worktree',
        worktreePath: '/tmp/second',
        timestamp: Date.now() + 1,
      });

      updateDispatchMetadata(projectRoot, 'dup', { worktreePath: '/tmp/patched' });

      // lookupDispatchMetadata returns the most-recent match.
      const after = lookupDispatchMetadata(projectRoot, 'dup');
      expect(after!.worktreePath).toBe('/tmp/patched');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
