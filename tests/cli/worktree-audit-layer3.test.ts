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
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  auditFilesystemSinceSentinel,
  buildAuditExclusions,
  buildFindPruneArgs,
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

  it('excludes user-level OS/app churn dirs (~/Library, ~/.cache, ~/.npm, ~/.claude)', () => {
    // Live-fire 2026-04-16: 44 "boundary escape" violations were 100% OS noise
    // (Chrome cookies, Spotify cache, Claude Code session logs). These user-
    // level dirs are unreachable through Tool Server sandbox or Layer 2 hook,
    // so false positives under them are pure noise. Broadened
    // `.claude/projects` → whole `.claude` because the Claude Code harness
    // spawns new subtrees per release (caches, plugins, etc.).
    const excl = buildAuditExclusions('/tmp/projectroot', undefined);
    const home = homedir();
    expect(excl.some(e => e === `${home}/Library`)).toBe(true);
    expect(excl.some(e => e === `${home}/.cache`)).toBe(true);
    expect(excl.some(e => e === `${home}/.npm`)).toBe(true);
    expect(excl.some(e => e === `${home}/.claude`)).toBe(true);
  });

  it('excludes projectRoot/.git (orchestrator git runs inside collect() BEFORE audit)', () => {
    // worktreeManager.merge() + cleanup() at dispatch-pipeline.ts touches
    // .git/refs, .git/logs, .git/index, .git/objects/* — all newer than the
    // sentinel, none agent-attributable. Exclude projectRoot/.git so those
    // paths don't show up as Layer 3 violations.
    const excl = buildAuditExclusions('/tmp/projectroot', undefined);
    expect(excl.some(e => e === '/tmp/projectroot/.git')).toBe(true);
    // The /private/tmp twin must also appear for macOS symlink safety.
    expect(excl.some(e => e === '/private/tmp/projectroot/.git')).toBe(true);
  });

  it('excludes tmpdir OS-app patterns (com.apple.*, itunescloudd, TemporaryItems)', () => {
    // macOS darwin user temp dirs fill up during a dispatch regardless of
    // agent activity. Exclude the well-known prefixes.
    const excl = buildAuditExclusions('/tmp/projectroot', undefined);
    const tmp = tmpdir();
    expect(excl.some(e => e === `${tmp}/com.apple.*`)).toBe(true);
    expect(excl.some(e => e === `${tmp}/itunescloudd`)).toBe(true);
    expect(excl.some(e => e === `${tmp}/TemporaryItems`)).toBe(true);
  });

  it('exclusions never cover projectRoot itself (sanity — broad scan must still flag projectRoot bypass)', () => {
    // If projectRoot were in the exclusion set, worktree/sequential agents
    // writing outside their worktree but inside projectRoot (e.g. a peer
    // worktree leak) would vanish from the audit. Guard against that.
    const excl = buildAuditExclusions('/tmp/projectroot', undefined);
    expect(excl).not.toContain('/tmp/projectroot');
    expect(excl).not.toContain('/private/tmp/projectroot');
  });
});

describeOnPosix('defaultScanRoots', () => {
  it('worktree mode includes projectRoot + tmpdir + /tmp + /private/tmp and EXCLUDES $HOME (PR1 issue #113)', () => {
    const roots = defaultScanRoots('worktree', '/some/project');
    // Should contain at least one of these.
    expect(roots.length).toBeGreaterThan(0);
    // Unique values only (Set semantics)
    expect(new Set(roots).size).toBe(roots.length);
    expect(roots).toContain('/some/project');
    expect(roots).toContain('/tmp');
    expect(roots).toContain('/private/tmp');
    // $HOME dropped in PR1 — sibling-process churn produced unbounded false
    // positives. PR2 will restore coverage via sensitive-targets pass.
    expect(roots).not.toContain(homedir());
  });

  it('scoped mode returns ONLY canonicalized projectRoot (no $HOME scan)', () => {
    // Tool Server's shell_exec for scoped agents is read-only-git, so $HOME
    // scan has zero true-positive capacity. Narrow to projectRoot only.
    const roots = defaultScanRoots('scoped', '/some/project');
    expect(roots.length).toBe(1);
    // canonicalize may resolve /some/project → /some/project verbatim
    // (resolve is lexical for non-existent paths).
    expect(roots[0]).toBe('/some/project');
    // Must NOT include $HOME or tmpdir roots.
    expect(roots).not.toContain(homedir());
    expect(roots).not.toContain('/tmp');
    expect(roots).not.toContain('/private/tmp');
  });

  it('undefined writeMode behaves as worktree (narrow scan, no $HOME)', () => {
    const roots = defaultScanRoots(undefined, '/some/project');
    expect(roots).toContain('/some/project');
    expect(roots).toContain('/tmp');
    expect(roots).toContain('/private/tmp');
    expect(roots).not.toContain(homedir());
  });

  it('sequential writeMode behaves as worktree (narrow scan, no $HOME)', () => {
    const roots = defaultScanRoots('sequential', '/some/project');
    expect(roots).toContain('/some/project');
    expect(roots).toContain('/tmp');
    expect(roots).toContain('/private/tmp');
    expect(roots).not.toContain(homedir());
  });

  it('regression #113: sibling .gossip dir in $HOME is not a scan root for worktree/sequential', () => {
    // Live-fire 2026-04-16: sibling gossipcat projects under $HOME attributed
    // 830 writes per dispatch via mtime (no per-process attribution in find).
    // Verify homedir() never appears as a scan root for any mode that might
    // catch a sibling project.
    for (const mode of ['worktree', 'sequential', undefined] as const) {
      const roots = defaultScanRoots(mode, '/some/project');
      expect(roots).not.toContain(homedir());
    }
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

describeOnPosix('auditFilesystemSinceSentinel — macOS TCC partial stdout parse (Bug B)', () => {
  /**
   * macOS Transparency, Consent, and Control (TCC) denies `find` read access
   * to sandboxed Library paths (Group Containers, Safari SandboxBroker, etc.)
   * even when the parent scan root is readable. `find` prints a permission
   * error to stderr, writes the files it COULD see to stdout, and exits
   * non-zero. execFileSync throws on non-zero exit, but the error object
   * still carries `.stdout` — we must parse it instead of dropping it.
   */
  itOnPosix('parses err.stdout when find exits non-zero with partial output', () => {
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    // Synthetic find shim that emits two partial paths then exits 1.
    // Mirrors macOS TCC behavior: some paths visible, process exits non-zero.
    const binDir = mkTmp('gossip-l3-bin-');
    const shim = join(binDir, 'fake-find');
    const leakedA = join(scanRoot, 'leaked-a.txt');
    const leakedB = join(scanRoot, 'leaked-b.txt');
    try {
      writeFileSync(
        shim,
        `#!/bin/sh\n` +
          `echo '${leakedA}'\n` +
          `echo '${leakedB}'\n` +
          `echo "find: /Users/x/Library/Group Containers/com.apple.x: Operation not permitted" 1>&2\n` +
          `exit 1\n`,
      );
      chmodSync(shim, 0o755);

      const sentinel = stampTaskSentinel(projectRoot, 'tcc-partial')!;
      const meta: DispatchMetadata = {
        taskId: 'tcc-partial',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };

      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        findBinary: shim,
        logFailures: false,
      });

      // Both paths from stdout MUST end up in violations, even though find exited 1.
      expect(res.violations).toContain(leakedA);
      expect(res.violations).toContain(leakedB);
      expect(res.violations.length).toBe(2);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  itOnPosix('returns empty violations when find exits non-zero with NO stdout', () => {
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    const binDir = mkTmp('gossip-l3-bin-');
    const shim = join(binDir, 'fake-find-empty');
    try {
      // Exit 1 with stderr only — nothing to parse. Audit must not throw and
      // must not invent violations from nothing.
      writeFileSync(
        shim,
        `#!/bin/sh\necho "find: permission denied" 1>&2\nexit 1\n`,
      );
      chmodSync(shim, 0o755);

      const sentinel = stampTaskSentinel(projectRoot, 'tcc-empty')!;
      const meta: DispatchMetadata = {
        taskId: 'tcc-empty',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };

      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        findBinary: shim,
        logFailures: false,
      });

      expect(res.violations).toEqual([]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describeOnPosix('auditFilesystemSinceSentinel — user-level OS/app dir exclusions', () => {
  /**
   * Live-fire 2026-04-16 produced 44 boundary-escape violations that were
   * 100% OS-level churn under $HOME/Library (Chrome cookies, Spotify cache)
   * and $HOME/.claude/projects (Claude Code session logs). These dirs are
   * unreachable through the Tool Server sandbox or Layer 2 hook, so
   * violations under them are noise.
   *
   * We use a synthetic find shim to emit candidate paths that would
   * otherwise NOT be filtered by `find -not -path` (since the shim ignores
   * its args and just prints). This tests the downstream filter logic.
   * Actually, the production `find` filters via args — so what we really
   * want to verify is that the exclusion args are PASSED to find. The
   * simplest way: confirm audit output ignores matching paths regardless of
   * how find surfaces them, by asserting on the real find with files in the
   * excluded dirs. But we can't write to ~/Library in a test.
   *
   * Pragmatic approach: shim echoes candidate paths including one under
   * $HOME/Library and one under $HOME/some-other-dir. The shim does NOT
   * filter (real find would). That means the audit itself MUST NOT post-
   * filter either — exclusions are enforced via find args, not code. So a
   * shim-based "does NOT flag ~/Library" test would incorrectly fail even
   * after the fix. Instead, we verify the args-passed behavior: the shim
   * writes the full argv to a side-channel file, and we assert the
   * exclusion flags are present.
   */
  itOnPosix('passes $HOME/Library exclusion arg to find using -prune shape', () => {
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    const binDir = mkTmp('gossip-l3-bin-');
    const shim = join(binDir, 'arg-capture-find');
    const argLog = join(binDir, 'args.log');
    try {
      // Shim writes its argv (one per line) to argLog, then exits 0 with no
      // stdout. This lets us assert on the exact args the audit passed.
      writeFileSync(
        shim,
        `#!/bin/sh\nfor a in "$@"; do echo "$a" >> '${argLog}'; done\nexit 0\n`,
      );
      chmodSync(shim, 0o755);

      const sentinel = stampTaskSentinel(projectRoot, 'arg-capture')!;
      const meta: DispatchMetadata = {
        taskId: 'arg-capture',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };

      auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        findBinary: shim,
        logFailures: false,
      });

      const args = readFileSync(argLog, 'utf-8').split('\n').filter(Boolean);
      const home = homedir();

      // Exclusion paths are passed as literal -path args inside a
      // ( ... ) -prune group. The bare exclusion path MUST appear.
      expect(args).toContain(`${home}/Library`);
      expect(args).toContain(`${home}/.cache`);
      expect(args).toContain(`${home}/.npm`);
      // Broadened 2026-04-16: whole .claude, not just .claude/projects.
      expect(args).toContain(`${home}/.claude`);

      // The new shape must include the -prune skeleton.
      expect(args).toContain('(');
      expect(args).toContain(')');
      expect(args).toContain('-prune');
      expect(args).toContain('-o');
      expect(args).toContain('-print');
      expect(args).toContain('-type');
      expect(args).toContain('f');
      expect(args).toContain('-newer');
      expect(args).toContain(sentinel);

      // Legacy -not syntax MUST be gone — it descends into TCC-denied dirs
      // before filtering, which is exactly the noise the -prune fix eliminates.
      expect(args).not.toContain('-not');

      // No `<path>/*` trailing-glob variants. With -prune, the directory path
      // itself is enough — find never descends, so descendant matching is
      // unnecessary and wrong.
      expect(args.some(a => a.endsWith('/*'))).toBe(false);

      // Structural check: first positional arg is the scan root, then the
      // exclusion group opens with '(' and closes with ')' followed by
      // '-prune', '-o'.
      expect(args[0]).toBe(scanRoot);
      const openIdx = args.indexOf('(');
      const closeIdx = args.indexOf(')');
      expect(openIdx).toBeGreaterThan(0);
      expect(closeIdx).toBeGreaterThan(openIdx);
      expect(args[closeIdx + 1]).toBe('-prune');
      expect(args[closeIdx + 2]).toBe('-o');

      // -print is the terminator for the right-hand side of -prune -o ...
      // Without it, find prints nothing.
      expect(args[args.length - 1]).toBe('-print');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  itOnPosix('end-to-end arg shape has exactly one ( ) -prune -o group (main pass)', () => {
    // Guards against duplicate grouping (e.g. one -prune group per scan root
    // inside a loop). The per-root build emits exactly ONE group.
    //
    // NOTE PR2: the shim is also invoked by the sensitive-targets pass for
    // any watchlist path that exists on the host. Their args get appended
    // to the same log. We slice to the FIRST invocation (main pass) by
    // locating the scanRoot marker — subsequent invocations start with a
    // different first-arg (the sensitive target path).
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    const binDir = mkTmp('gossip-l3-bin-');
    const shim = join(binDir, 'arg-capture-find-2');
    const argLog = join(binDir, 'args.log');
    try {
      writeFileSync(
        shim,
        `#!/bin/sh\nfor a in "$@"; do echo "$a" >> '${argLog}'; done\nexit 0\n`,
      );
      chmodSync(shim, 0o755);

      const sentinel = stampTaskSentinel(projectRoot, 'shape-check')!;
      const meta: DispatchMetadata = {
        taskId: 'shape-check',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };

      auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        findBinary: shim,
        logFailures: false,
      });

      const allArgs = readFileSync(argLog, 'utf-8').split('\n').filter(Boolean);

      // Isolate the first invocation (main pass). Each invocation's argv
      // ends with '-print'; subsequent invocations start with a different
      // first token. Slice up through the first '-print'.
      const firstPrintIdx = allArgs.indexOf('-print');
      expect(firstPrintIdx).toBeGreaterThan(-1);
      const args = allArgs.slice(0, firstPrintIdx + 1);

      // Only ONE '(' and ONE ')' in the main-pass invocation.
      expect(args.filter(a => a === '(').length).toBe(1);
      expect(args.filter(a => a === ')').length).toBe(1);
      // Only ONE -prune, one -print in the main-pass invocation.
      expect(args.filter(a => a === '-prune').length).toBe(1);
      expect(args.filter(a => a === '-print').length).toBe(1);
      // -type f -newer <sentinel> comes AFTER the `-prune -o` pair, never
      // before `(`.
      const openIdx = args.indexOf('(');
      const typeIdx = args.indexOf('-type');
      expect(typeIdx).toBeGreaterThan(openIdx);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describeOnPosix('buildFindPruneArgs', () => {
  const SENT = '/tmp/fake-sentinel';

  it('emits the full ( ... ) -prune -o -type f -newer <sentinel> -print shape with multiple exclusions', () => {
    const args = buildFindPruneArgs('/scan/root', ['/home/a', '/home/b', '/home/c'], SENT);
    expect(args).toEqual([
      '/scan/root',
      '(',
      '-path', '/home/a',
      '-o',
      '-path', '/home/b',
      '-o',
      '-path', '/home/c',
      ')', '-prune', '-o',
      '-type', 'f',
      '-newer', SENT,
      '-print',
    ]);
  });

  it('emits no parens/-prune/-o when exclusions is empty — just <root> -type f -newer <sentinel> -print', () => {
    // Defensive branch: if buildAuditExclusions AND expandTmpVariants both
    // ever returned empty, the args must degenerate cleanly. Find with a
    // dangling `( ) -prune -o` would crash.
    const args = buildFindPruneArgs('/scan/root', [], SENT);
    expect(args).toEqual(['/scan/root', '-type', 'f', '-newer', SENT, '-print']);
    expect(args).not.toContain('(');
    expect(args).not.toContain(')');
    expect(args).not.toContain('-prune');
    expect(args).not.toContain('-o');
  });

  it('emits a single exclusion without a dangling -o', () => {
    const args = buildFindPruneArgs('/scan/root', ['/home/only'], SENT);
    expect(args).toEqual([
      '/scan/root',
      '(', '-path', '/home/only', ')', '-prune', '-o',
      '-type', 'f', '-newer', SENT, '-print',
    ]);
    // Exactly one -o (the one after ')' ), none inside the group.
    expect(args.filter(a => a === '-o').length).toBe(1);
  });

  it('never emits a trailing-glob `<path>/*` variant — -prune skips descent so dir path alone suffices', () => {
    const args = buildFindPruneArgs('/scan/root', ['/home/a', '/home/b'], SENT);
    expect(args.some(a => a.endsWith('/*'))).toBe(false);
  });

  it('never emits legacy -not syntax', () => {
    const args = buildFindPruneArgs('/scan/root', ['/home/a'], SENT);
    expect(args).not.toContain('-not');
  });

  itOnPosix('still flags files in $HOME outside the exclusion list (no over-exclusion)', () => {
    // Guards against the fix being too broad — e.g. if someone accidentally
    // excluded all of $HOME. A real agent bypass to $HOME/some-other-dir must
    // still surface.
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    const binDir = mkTmp('gossip-l3-bin-');
    const shim = join(binDir, 'echo-find');
    const home = homedir();
    const flaggedPath = `${home}/some-other-dir/file.txt`;
    const excludedPath = `${home}/Library/foo.log`;
    try {
      // Shim ignores args and echoes both candidate paths. Real `find` would
      // filter via -not -path, but since this shim doesn't implement filtering,
      // both paths come back. The audit code does NOT post-filter — filtering
      // is delegated to find. So this test documents that contract: if find
      // emits a path, the audit surfaces it. The REAL protection is at the
      // find-args level, which the sibling arg-capture test verifies.
      writeFileSync(
        shim,
        `#!/bin/sh\necho '${flaggedPath}'\necho '${excludedPath}'\nexit 0\n`,
      );
      chmodSync(shim, 0o755);

      const sentinel = stampTaskSentinel(projectRoot, 'no-over-exclude')!;
      const meta: DispatchMetadata = {
        taskId: 'no-over-exclude',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };

      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        findBinary: shim,
        logFailures: false,
      });

      // The non-excluded $HOME path must still surface — fix must not be
      // over-broad.
      expect(res.violations).toContain(flaggedPath);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
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
        // PR2 renamed source: 'layer3-audit' → 'layer3-main' to distinguish
        // from the new 'layer3-sensitive' pass.
        expect(entry.source).toBe('layer3-main');
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
