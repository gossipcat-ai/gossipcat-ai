/**
 * Tests for Layer 3 sensitive-targets pass (issue #113 PR2).
 *
 * PR1 (#115) dropped $HOME from the main L3 scan to eliminate sibling-process
 * noise. That regressed coverage of exfiltration/persistence vectors under
 * $HOME (SSH keys, cloud credentials, LaunchAgents, etc.).
 *
 * PR2 restores coverage via a SECOND pass over a sparse, vetted watchlist
 * with ZERO noise-exclusions and a retractable `disagreement` signal under
 * `trust_boundaries`. See buildSensitiveTargets for the locked scope.
 *
 * These tests shim the $HOME lookup to a test tmpdir via mock of os.homedir
 * — DO NOT write to the real ~/.ssh etc. from CI.
 */
// Hoist the mutable fakeHome holder so jest.mock (which is hoisted above
// imports) can close over it. Tests set holder.value in beforeEach.
const fakeHomeHolder: { value: string | null } = { value: null };

// Mock `os.homedir` at the module boundary so buildSensitiveTargets resolves
// its watchlist entries against our test tmp dir, not the real $HOME. All
// other os exports pass through.
jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => fakeHomeHolder.value ?? actual.homedir(),
  };
});

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import * as os from 'os';
import { join } from 'path';
import {
  auditFilesystemSinceSentinel,
  buildSensitiveFindArgs,
  buildSensitiveTargets,
  DispatchMetadata,
  expandTmpVariants,
  stampTaskSentinel,
} from '../../apps/cli/src/sandbox';

const itOnPosix = process.platform === 'win32' ? it.skip : it;
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

function mkTmp(prefix = 'gossip-l3-sens-'): string {
  return mkdtempSync(join(os.tmpdir(), prefix));
}

function backdateSentinel(path: string, pastMs: number): void {
  const when = new Date(Date.now() - pastMs);
  utimesSync(path, when, when);
}

describeOnPosix('buildSensitiveTargets — watchlist shape', () => {
  const REAL_HOME = os.homedir();

  it('includes universal watchlist entries on both OS branches', () => {
    // Assert UNIVERSAL entries (both darwin and linux): credential stores,
    // cloud configs, system /etc files. These are identical cross-OS per
    // decision 3.
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const targets = buildSensitiveTargets(platform);
      const paths = targets.map(t => t.path);
      // Cloud credentials.
      expect(paths).toContain(`${REAL_HOME}/.aws/credentials`);
      expect(paths).toContain(`${REAL_HOME}/.aws/config`);
      // Claude Code (file-level, NOT the whole dir).
      expect(paths).toContain(`${REAL_HOME}/.claude/settings.json`);
      expect(paths).toContain(`${REAL_HOME}/.claude/credentials.json`);
      expect(paths).not.toContain(`${REAL_HOME}/.claude`);
      expect(paths).not.toContain(`${REAL_HOME}/.claude/plugins`);
      expect(paths).not.toContain(`${REAL_HOME}/.claude/caches`);
      expect(paths).not.toContain(`${REAL_HOME}/.claude/projects`);
      // SSH include-list (dir-level with -name filter).
      const ssh = targets.find(t => t.path === `${REAL_HOME}/.ssh`);
      expect(ssh).toBeDefined();
      expect(ssh!.nameIncludes).toContain('id_*');
      expect(ssh!.nameIncludes).toContain('*.key');
      expect(ssh!.nameIncludes).toContain('*.pem');
      expect(ssh!.nameIncludes).toContain('authorized_keys');
      expect(ssh!.nameIncludes).toContain('config');
      // known_hosts MUST NOT be in the include-list (churn).
      expect(ssh!.nameIncludes).not.toContain('known_hosts');
      expect(ssh!.nameIncludes).not.toContain('known_hosts.old');
      // GPG keyring (full subtree).
      expect(paths).toContain(`${REAL_HOME}/.gnupg`);
      // Git + netrc + GitHub CLI.
      expect(paths).toContain(`${REAL_HOME}/.git-credentials`);
      expect(paths).toContain(`${REAL_HOME}/.netrc`);
      expect(paths).toContain(`${REAL_HOME}/.config/gh/hosts.yml`);
      // Docker + Kubernetes.
      expect(paths).toContain(`${REAL_HOME}/.docker/config.json`);
      expect(paths).toContain(`${REAL_HOME}/.kube/config`);
      // DB credentials.
      expect(paths).toContain(`${REAL_HOME}/.pgpass`);
      expect(paths).toContain(`${REAL_HOME}/.my.cnf`);
      // System config.
      expect(paths).toContain('/etc/passwd');
      expect(paths).toContain('/etc/shadow');
    }
  });

  it('adds ~/Library/LaunchAgents ONLY on macOS', () => {
    const darwin = buildSensitiveTargets('darwin');
    const linux = buildSensitiveTargets('linux');
    const launchAgents = `${REAL_HOME}/Library/LaunchAgents`;

    expect(darwin.map(t => t.path)).toContain(launchAgents);
    const darwinEntry = darwin.find(t => t.path === launchAgents);
    expect(darwinEntry!.nameIncludes).toEqual(['*.plist']);
    expect(darwinEntry!.platform).toBe('darwin');

    // Linux: LaunchAgents MUST NOT be present.
    expect(linux.map(t => t.path)).not.toContain(launchAgents);
  });

  it('skips browser cookies and 1Password (denylist-grows pattern SKIPPED per decision 6)', () => {
    // Decision 6: Chrome FP during user browsing kills accuracy signal.
    // Browser cookies and 1Password vaults are INTENTIONALLY not in the
    // watchlist. Guard against accidental addition.
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const paths = buildSensitiveTargets(platform).map(t => t.path);
      expect(paths.some(p => /Chrome|Chromium|Firefox|Safari|1Password/i.test(p))).toBe(false);
      expect(paths.some(p => /[Cc]ookies/.test(p))).toBe(false);
    }
  });

  it('default platform argument is process.platform', () => {
    // Smoke test: calling with no args must not throw.
    expect(() => buildSensitiveTargets()).not.toThrow();
    const defaultList = buildSensitiveTargets();
    const explicit = buildSensitiveTargets(process.platform);
    expect(defaultList.map(t => t.path)).toEqual(explicit.map(t => t.path));
  });
});

describeOnPosix('buildSensitiveFindArgs — arg shape', () => {
  const SENT = '/tmp/fake-sentinel';

  it('emits plain find args when nameIncludes is empty', () => {
    const args = buildSensitiveFindArgs('/home/u/.aws/credentials', SENT);
    expect(args).toEqual([
      '/home/u/.aws/credentials',
      '-type', 'f',
      '-newer', SENT,
      '-print',
    ]);
  });

  it('emits a ( -name X -o -name Y ) group when nameIncludes is set', () => {
    const args = buildSensitiveFindArgs(
      '/home/u/.ssh',
      SENT,
      ['id_*', '*.key', '*.pem', 'authorized_keys', 'config'],
    );
    expect(args).toEqual([
      '/home/u/.ssh',
      '-type', 'f',
      '(',
      '-name', 'id_*',
      '-o',
      '-name', '*.key',
      '-o',
      '-name', '*.pem',
      '-o',
      '-name', 'authorized_keys',
      '-o',
      '-name', 'config',
      ')',
      '-newer', SENT,
      '-print',
    ]);
  });

  it('prepends a sentinel-dir carve-out with /private twin when sentinelDir is set', () => {
    const args = buildSensitiveFindArgs(
      '/etc/passwd',
      SENT,
      undefined,
      '/tmp/proj/.gossip/sentinels',
    );
    // Carve-out group must come BEFORE -type f.
    const openIdx = args.indexOf('(');
    const closeIdx = args.indexOf(')');
    const pruneIdx = args.indexOf('-prune');
    expect(openIdx).toBeGreaterThan(0);
    expect(closeIdx).toBeGreaterThan(openIdx);
    expect(pruneIdx).toBe(closeIdx + 1);
    // Twins: both /tmp/proj/.gossip/sentinels and /private/tmp/proj/.gossip/sentinels.
    expect(args).toContain('/tmp/proj/.gossip/sentinels');
    expect(args).toContain('/private/tmp/proj/.gossip/sentinels');
  });
});

describeOnPosix('expandTmpVariants — /etc and /var handling (PR2 addition)', () => {
  it('emits /etc and /private/etc twins', () => {
    expect(expandTmpVariants('/etc')).toEqual(['/etc', '/private/etc']);
    expect(expandTmpVariants('/etc/passwd')).toEqual(['/etc/passwd', '/private/etc/passwd']);
  });

  it('emits /private/etc and /etc twins (reverse direction)', () => {
    expect(expandTmpVariants('/private/etc/passwd')).toEqual(['/private/etc/passwd', '/etc/passwd']);
  });

  it('emits /var and /private/var twins', () => {
    expect(expandTmpVariants('/var/log')).toEqual(['/var/log', '/private/var/log']);
  });

  it('preserves legacy /tmp behavior', () => {
    expect(expandTmpVariants('/tmp')).toEqual(['/tmp', '/private/tmp']);
    expect(expandTmpVariants('/tmp/proj')).toEqual(['/tmp/proj', '/private/tmp/proj']);
  });

  it('does not twin unrelated paths', () => {
    expect(expandTmpVariants('/Users/u/code')).toEqual(['/Users/u/code']);
    expect(expandTmpVariants('/opt/foo')).toEqual(['/opt/foo']);
  });
});

/**
 * Shim-based tests for the two-pass audit. We spy on homedir() via a jest
 * module mock so buildSensitiveTargets resolves to our tmp dir rather than
 * the real $HOME. This lets us assert sensitive-pass detection without
 * touching the real host.
 */
describeOnPosix('auditFilesystemSinceSentinel — two-pass detection + dedup', () => {
  let fakeHome: string;
  let projectRoot: string;
  let scanRoot: string;

  beforeEach(() => {
    fakeHome = mkTmp('gossip-l3-home-');
    projectRoot = mkTmp();
    scanRoot = mkTmp('gossip-l3-scan-');
    fakeHomeHolder.value = fakeHome;
  });

  afterEach(() => {
    fakeHomeHolder.value = null;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(scanRoot, { recursive: true, force: true });
  });

  function runAudit(scanRoots: string[] = [scanRoot]) {
    const sentinel = stampTaskSentinel(projectRoot, 'sens-test')!;
    backdateSentinel(sentinel, 5000);
    const meta: DispatchMetadata = {
      taskId: 'sens-test',
      agentId: 'opus-implementer',
      writeMode: 'worktree',
      timestamp: Date.now(),
      sentinelPath: sentinel,
    };
    return auditFilesystemSinceSentinel(projectRoot, meta, {
      scanRoots,
      logFailures: false,
    });
  }

  itOnPosix('DETECTS writes to ~/.ssh/id_rsa', () => {
    mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
    writeFileSync(join(fakeHome, '.ssh', 'id_rsa'), 'FAKE KEY');

    const res = runAudit();
    expect(res.violations.some(v => v.endsWith('/.ssh/id_rsa'))).toBe(true);
  });

  itOnPosix('DETECTS writes to ~/.aws/credentials', () => {
    mkdirSync(join(fakeHome, '.aws'), { recursive: true });
    writeFileSync(join(fakeHome, '.aws', 'credentials'), '[default]\naws_access_key_id=AKIA...');

    const res = runAudit();
    expect(res.violations.some(v => v.endsWith('/.aws/credentials'))).toBe(true);
  });

  itOnPosix('DETECTS writes to ~/.docker/config.json', () => {
    mkdirSync(join(fakeHome, '.docker'), { recursive: true });
    writeFileSync(join(fakeHome, '.docker', 'config.json'), '{"auths":{}}');

    const res = runAudit();
    expect(res.violations.some(v => v.endsWith('/.docker/config.json'))).toBe(true);
  });

  itOnPosix('DETECTS writes to ~/.claude/settings.json (file-level scope)', () => {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude', 'settings.json'), '{}');

    const res = runAudit();
    expect(res.violations.some(v => v.endsWith('/.claude/settings.json'))).toBe(true);
  });

  itOnPosix('IGNORES ~/.ssh/known_hosts (excluded from SSH include-list)', () => {
    mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
    writeFileSync(join(fakeHome, '.ssh', 'known_hosts'), 'github.com ssh-rsa ...');

    const res = runAudit();
    expect(res.violations.some(v => v.endsWith('/known_hosts'))).toBe(false);
  });

  itOnPosix('IGNORES ~/.claude/plugins/* (harness churn, NOT in file-level watchlist)', () => {
    mkdirSync(join(fakeHome, '.claude', 'plugins', 'foo'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude', 'plugins', 'foo', 'manifest.json'), '{}');

    const res = runAudit();
    // .claude/plugins/foo/manifest.json MUST NOT appear — only settings.json
    // and credentials.json are in the sensitive watchlist.
    expect(res.violations.some(v => v.includes('/.claude/plugins/'))).toBe(false);
  });

  itOnPosix('IGNORES ~/.claude/caches/* (harness churn)', () => {
    mkdirSync(join(fakeHome, '.claude', 'caches'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude', 'caches', 'ast.cache'), 'binary');

    const res = runAudit();
    expect(res.violations.some(v => v.includes('/.claude/caches/'))).toBe(false);
  });

  itOnPosix('sentinel-dir stamping does NOT self-match in sensitive pass when sentinel is under $HOME', () => {
    // Simulate scenario where projectRoot is under $HOME (so the sentinel
    // dir might overlap with a sensitive watchlist entry). Stamp a sentinel,
    // write an unrelated sensitive file, audit — the sentinel itself must
    // NOT show up as a violation.
    const hostedProject = join(fakeHome, 'project');
    mkdirSync(hostedProject, { recursive: true });
    const sentinel = stampTaskSentinel(hostedProject, 'self-match')!;
    backdateSentinel(sentinel, 5000);

    // Touch NO sensitive files — so if the sentinel itself matched, we'd
    // see it in violations. It must not.
    const meta: DispatchMetadata = {
      taskId: 'self-match',
      agentId: 'opus-implementer',
      writeMode: 'worktree',
      timestamp: Date.now(),
      sentinelPath: sentinel,
    };
    const res = auditFilesystemSinceSentinel(hostedProject, meta, {
      scanRoots: [scanRoot],
      logFailures: false,
    });
    // The sentinel path must never appear as a violation.
    expect(res.violations.every(v => !v.includes('sentinels'))).toBe(true);
  });

  itOnPosix('dedups a path that appears in both passes (one JSONL entry, sensitive-only)', () => {
    // Contrive a case: write an SSH key path and also put scanRoot at
    // $HOME so the MAIN pass would normally flag the same file. We use a
    // scanRoot that IS fakeHome so both passes can see the SSH file.
    mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
    const keyPath = join(fakeHome, '.ssh', 'id_ed25519');
    writeFileSync(keyPath, 'FAKE KEY');

    const sentinel = stampTaskSentinel(projectRoot, 'dedup-test')!;
    backdateSentinel(sentinel, 5000);
    const meta: DispatchMetadata = {
      taskId: 'dedup-test',
      agentId: 'opus-implementer',
      writeMode: 'worktree',
      timestamp: Date.now(),
      sentinelPath: sentinel,
    };
    // Force main pass to scan fakeHome so it ALSO finds the key (normally
    // $HOME is dropped from defaultScanRoots; this test's scanRoots override
    // simulates "what if both passes saw it").
    auditFilesystemSinceSentinel(projectRoot, meta, {
      scanRoots: [fakeHome],
      logFailures: false,
    });

    const logPath = join(projectRoot, '.gossip', 'boundary-escapes.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const entries = readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));

    // Count entries mentioning the id_ed25519 path. After dedup we expect
    // exactly ONE (the sensitive entry) — the main-pass duplicate is
    // removed in the Set dedup.
    const hits = entries.filter(e =>
      (e.violatingPaths as string[]).some(p => p.endsWith('/id_ed25519')),
    );
    expect(hits.length).toBe(1);
    expect(hits[0].source).toBe('layer3-sensitive');
  });
});

describeOnPosix('recordLayer3Violations — source discriminator + signal emission', () => {
  let fakeHome: string;
  let projectRoot: string;
  let scanRoot: string;

  beforeEach(() => {
    fakeHome = mkTmp('gossip-l3-home-');
    projectRoot = mkTmp();
    scanRoot = mkTmp('gossip-l3-scan-');
    fakeHomeHolder.value = fakeHome;
  });

  afterEach(() => {
    fakeHomeHolder.value = null;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(scanRoot, { recursive: true, force: true });
  });

  itOnPosix('sensitive-pass hit: JSONL entry has source=layer3-sensitive AND appendSignals fires', () => {
    // Arrange: sensitive file under fake $HOME.
    mkdirSync(join(fakeHome, '.aws'), { recursive: true });
    writeFileSync(join(fakeHome, '.aws', 'credentials'), 'secret');

    const sentinel = stampTaskSentinel(projectRoot, 'sig-test')!;
    backdateSentinel(sentinel, 5000);
    const meta: DispatchMetadata = {
      taskId: 'sig-test',
      agentId: 'opus-implementer',
      writeMode: 'worktree',
      timestamp: Date.now(),
      sentinelPath: sentinel,
    };
    auditFilesystemSinceSentinel(projectRoot, meta, {
      scanRoots: [scanRoot], // main pass finds nothing — only sensitive pass hits
      logFailures: false,
    });

    // JSONL assertion.
    const logPath = join(projectRoot, '.gossip', 'boundary-escapes.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const entries = readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
    const sensitiveEntries = entries.filter(e => e.source === 'layer3-sensitive');
    expect(sensitiveEntries.length).toBeGreaterThanOrEqual(1);
    expect(sensitiveEntries.some(e =>
      (e.violatingPaths as string[]).some(p => p.endsWith('/credentials')),
    )).toBe(true);

    // Signal assertion: PerformanceWriter writes to .gossip/performance.jsonl.
    // We decide ONCE-PER-DISPATCH (not per-violation) — evidence string
    // lists up to 10 paths; one dispatch = one signal line regardless of
    // how many sensitive files the agent touched.
    const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
    expect(existsSync(perfPath)).toBe(true);
    const perfEntries = readFileSync(perfPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
    const disagreement = perfEntries.find(e =>
      e.type === 'consensus' &&
      e.signal === 'boundary_escape' &&
      e.category === 'trust_boundaries' &&
      e.taskId === 'sig-test',
    );
    expect(disagreement).toBeDefined();
    expect(disagreement.agentId).toBe('opus-implementer');
    expect(disagreement.evidence).toContain('Sensitive-target exfiltration');
    expect(disagreement.evidence).toContain('credentials');
  });

  itOnPosix('main-pass hit: JSONL entry has source=layer3-main AND appendSignals does NOT fire', () => {
    // Arrange: file only in scanRoot (main pass hit), NO sensitive target touched.
    writeFileSync(join(scanRoot, 'bypass.txt'), 'leaked');

    const sentinel = stampTaskSentinel(projectRoot, 'main-only')!;
    backdateSentinel(sentinel, 5000);
    const meta: DispatchMetadata = {
      taskId: 'main-only',
      agentId: 'opus-implementer',
      writeMode: 'worktree',
      timestamp: Date.now(),
      sentinelPath: sentinel,
    };
    auditFilesystemSinceSentinel(projectRoot, meta, {
      scanRoots: [scanRoot],
      logFailures: false,
    });

    // JSONL must have a layer3-main entry.
    const logPath = join(projectRoot, '.gossip', 'boundary-escapes.jsonl');
    const entries = readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
    const mainEntries = entries.filter(e => e.source === 'layer3-main');
    expect(mainEntries.some(e =>
      (e.violatingPaths as string[]).some(p => p.endsWith('/bypass.txt')),
    )).toBe(true);
    // No sensitive entries — nothing in the watchlist was touched.
    expect(entries.some(e => e.source === 'layer3-sensitive')).toBe(false);

    // Signal: PerformanceWriter MUST NOT have fired for main-pass hits
    // (PR1 behavior preserved). performance.jsonl must either not exist OR
    // contain no disagreement for this taskId.
    const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
    if (existsSync(perfPath)) {
      const perfEntries = readFileSync(perfPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l));
      const fromThisTask = perfEntries.filter(e =>
        e.taskId === 'main-only' &&
        (e.signal === 'disagreement' || e.signal === 'boundary_escape'),
      );
      expect(fromThisTask.length).toBe(0);
    }
  });
});

describeOnPosix('auditFilesystemSinceSentinel — /etc/passwd detection (canonicalize assertion)', () => {
  itOnPosix('/etc/passwd write is reported in SOME stable form (handles macOS /private/etc)', () => {
    // We can't actually write to /etc/passwd in a test — it's system-owned.
    // Instead, shim `find` so it reports /etc/passwd as a hit when the
    // sensitive pass queries it.
    const projectRoot = mkTmp();
    const binDir = mkTmp('gossip-l3-bin-');
    const shim = join(binDir, 'etc-shim-find');
    try {
      // Shim: if first arg is /etc/passwd, emit /etc/passwd and exit 0.
      // For every other invocation (including main pass and other
      // sensitive targets), exit 0 silently.
      writeFileSync(
        shim,
        `#!/bin/sh\n` +
          `if [ "$1" = "/etc/passwd" ] || [ "$1" = "/private/etc/passwd" ]; then\n` +
          `  echo "$1"\n` +
          `fi\n` +
          `exit 0\n`,
      );
      chmodSync(shim, 0o755);

      const sentinel = stampTaskSentinel(projectRoot, 'etc-test')!;
      backdateSentinel(sentinel, 5000);
      const meta: DispatchMetadata = {
        taskId: 'etc-test',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };

      // Also point scanRoots to a tmp dir so main pass has nothing to find.
      const emptyScan = mkTmp('gossip-l3-empty-');
      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [emptyScan],
        findBinary: shim,
        logFailures: false,
      });

      // /etc/passwd must be in violations in SOME form — either /etc/passwd
      // or /private/etc/passwd (macOS realpath). Canonicalize for assertion.
      const hasEtcPasswd = res.violations.some(v =>
        v === '/etc/passwd' || v === '/private/etc/passwd',
      );
      expect(hasEtcPasswd).toBe(true);

      rmSync(emptyScan, { recursive: true, force: true });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describeOnPosix('buildSensitiveTargets — macOS LaunchAgents detection', () => {
  let fakeHome: string;
  let projectRoot: string;
  let scanRoot: string;

  beforeEach(() => {
    fakeHome = mkTmp('gossip-l3-home-');
    projectRoot = mkTmp();
    scanRoot = mkTmp('gossip-l3-scan-');
    fakeHomeHolder.value = fakeHome;
  });

  afterEach(() => {
    fakeHomeHolder.value = null;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(scanRoot, { recursive: true, force: true });
  });

  itOnPosix('on macOS: detects ~/Library/LaunchAgents/evil.plist write', () => {
    if (process.platform !== 'darwin') {
      // Skip on non-darwin; watchlist doesn't include LaunchAgents there.
      return;
    }
    const laDir = join(fakeHome, 'Library', 'LaunchAgents');
    mkdirSync(laDir, { recursive: true });
    writeFileSync(join(laDir, 'evil.plist'), '<plist/>');

    const sentinel = stampTaskSentinel(projectRoot, 'la-test')!;
    backdateSentinel(sentinel, 5000);
    const meta: DispatchMetadata = {
      taskId: 'la-test',
      agentId: 'opus-implementer',
      writeMode: 'worktree',
      timestamp: Date.now(),
      sentinelPath: sentinel,
    };
    const res = auditFilesystemSinceSentinel(projectRoot, meta, {
      scanRoots: [scanRoot],
      logFailures: false,
    });

    expect(res.violations.some(v => v.endsWith('/evil.plist'))).toBe(true);
  });
});
