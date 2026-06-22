/**
 * Tests for the Layer-3 main-pass noise filter (allowlist-rot fix).
 *
 * Context: .gossip/boundary-escapes.jsonl was flooded with test/environment
 * noise — 8446/8486 live entries were tmpdir writes from test fixtures whose
 * prefixes were NOT in the hand-maintained TEST_FIXTURE_PREFIXES allowlist
 * (jest_dx, finding-resolver-, siblingroots-, …), plus build artifacts
 * (dist-mcp/, dist-dashboard/, *.tsbuildinfo) and Cursor churn
 * (cursor-sandbox-cache). The fix replaces the finite allowlist with an
 * INVERTED gate (exclude every tmpdir child except the gossip-l3-* scan-root
 * keep-list used by the Layer-3 audit tests themselves), adds an always-on
 * cursor-sandbox-cache exclusion, and a build-artifact exclusion.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  auditFilesystemSinceSentinel,
  buildAuditExclusions,
  DispatchMetadata,
  isLayer3MainNoise,
  stampTaskSentinel,
} from '../../apps/cli/src/sandbox';

const itOnPosix = process.platform === 'win32' ? it.skip : it;
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

function mkTmp(prefix = 'gossip-l3-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

import { utimesSync } from 'fs';
function backdateSentinel(path: string, pastMs: number): void {
  const when = new Date(Date.now() - pastMs);
  utimesSync(path, when, when);
}

describeOnPosix('isLayer3MainNoise — inverted test-fixture gate', () => {
  itOnPosix('inTestRunner: a NON-keep tmpdir child (skill-engine-status-) is noise', () => {
    const tmp = tmpdir();
    const p = join(tmp, 'skill-engine-status-AbCd12', '.gossip', 'fake.jsonl');
    expect(isLayer3MainNoise(p, { inTestRunner: true })).toBe(true);
  });

  itOnPosix('inTestRunner: jest_dx and finding-resolver- children are noise', () => {
    const tmp = tmpdir();
    expect(isLayer3MainNoise(join(tmp, 'jest_dx-XYZ', 'f.txt'), { inTestRunner: true })).toBe(true);
    expect(isLayer3MainNoise(join(tmp, 'finding-resolver-9TZV2c', 'f.txt'), { inTestRunner: true })).toBe(true);
  });

  itOnPosix('inTestRunner: gossip-l3-scan- / gossip-l3-bin- / gossip-l3- children are KEPT (regression guard)', () => {
    const tmp = tmpdir();
    expect(isLayer3MainNoise(join(tmp, 'gossip-l3-scan-AAA', 'outside.txt'), { inTestRunner: true })).toBe(false);
    expect(isLayer3MainNoise(join(tmp, 'gossip-l3-bin-BBB', 'fake-find'), { inTestRunner: true })).toBe(false);
    expect(isLayer3MainNoise(join(tmp, 'gossip-l3-CCC', 'sentinel'), { inTestRunner: true })).toBe(false);
  });

  itOnPosix('NOT inTestRunner: a non-keep tmpdir child is NOT noise (gate closed)', () => {
    const tmp = tmpdir();
    const p = join(tmp, 'skill-engine-status-AbCd12', 'exfil.txt');
    expect(isLayer3MainNoise(p, { inTestRunner: false })).toBe(false);
  });

  itOnPosix('a NON-tmpdir path is never noise via the inverted gate', () => {
    expect(isLayer3MainNoise('/some/project/src/leak.ts', { inTestRunner: true })).toBe(false);
  });

  itOnPosix('a near-miss tmpdir dir that merely STARTS WITH a keep prefix is still FLAGGED (guards startsWith→equality drift)', () => {
    // `gossip-l3-evil` literally starts with the `gossip-l3-` keep prefix, so a
    // naive startsWith keeps it — which is intended (the keep-list is a prefix
    // match by design, the audit tests mkdtemp `gossip-l3-scan-<rand>` etc.).
    // What we assert here is the COMPLEMENT: a tmpdir child that does NOT start
    // with the keep prefix stays flagged, so a future startsWith→equality
    // refactor of the keep-list can't silently widen suppression. Use a
    // near-miss that shares a leading substring but not the full prefix.
    const tmp = tmpdir();
    const tmpRoots = undefined; // default discovery
    expect(
      isLayer3MainNoise(join(tmp, 'gossip-l3evil', 'f.txt'), { inTestRunner: true, tmpRoots }),
    ).toBe(true);
    // And a dir that does start with the keep prefix stays KEPT (false).
    expect(
      isLayer3MainNoise(join(tmp, 'gossip-l3-evil', 'f.txt'), { inTestRunner: true, tmpRoots }),
    ).toBe(false);
  });
});

describeOnPosix('isLayer3MainNoise — always-on Cursor + build-artifact exclusions', () => {
  itOnPosix('cursor-sandbox-cache tmpdir child is noise EVEN without the test gate', () => {
    const tmp = tmpdir();
    const p = join(tmp, 'cursor-sandbox-cache', 'blob.bin');
    expect(isLayer3MainNoise(p, { inTestRunner: false })).toBe(true);
  });

  itOnPosix('dist-mcp/ and dist-dashboard/ build outputs are noise WHEN under projectRoot', () => {
    const projectRoot = '/Users/x/gossip';
    expect(isLayer3MainNoise('/Users/x/gossip/dist-mcp/index.js', { inTestRunner: false, projectRoot })).toBe(true);
    expect(isLayer3MainNoise('/Users/x/gossip/dist-dashboard/assets/a.js', { inTestRunner: false, projectRoot })).toBe(true);
  });

  itOnPosix('*.tsbuildinfo is noise WHEN under projectRoot', () => {
    expect(
      isLayer3MainNoise('/Users/x/gossip/packages/dashboard-v2/tsconfig.tsbuildinfo', {
        inTestRunner: false,
        projectRoot: '/Users/x/gossip',
      }),
    ).toBe(true);
  });

  itOnPosix('build-artifact rule FAILS CLOSED when projectRoot is absent (cannot anchor → do not suppress)', () => {
    // Without projectRoot the build-artifact rule must NOT fire — otherwise an
    // agent could hide a real escape under a build-artifact-looking name.
    expect(isLayer3MainNoise('/Users/x/gossip/dist-mcp/index.js', { inTestRunner: false })).toBe(false);
    expect(isLayer3MainNoise('/Users/x/gossip/x.tsbuildinfo', { inTestRunner: false })).toBe(false);
  });

  itOnPosix('a tmpdir build-artifact-looking path OUTSIDE projectRoot is FLAGGED (no evasion via /tmp/dist-mcp or /tmp/*.tsbuildinfo)', () => {
    const tmp = tmpdir();
    const projectRoot = '/Users/x/gossip'; // distinct from tmpdir
    // tmpdir is itself a main-pass scan root; these must NOT be suppressed.
    expect(
      isLayer3MainNoise(join(tmp, 'dist-mcp', 'evil.js'), { inTestRunner: false, projectRoot }),
    ).toBe(false);
    expect(
      isLayer3MainNoise(join(tmp, 'anything.tsbuildinfo'), { inTestRunner: false, projectRoot }),
    ).toBe(false);
    expect(
      isLayer3MainNoise(join(tmp, 'dist-dashboard', 'a.js'), { inTestRunner: false, projectRoot }),
    ).toBe(false);
  });

  itOnPosix('a sibling real source path is NOT noise even alongside build artifacts', () => {
    const projectRoot = '/Users/x/gossip';
    expect(isLayer3MainNoise('/Users/x/gossip/apps/cli/src/sandbox.ts', { inTestRunner: false, projectRoot })).toBe(false);
    // dist-mcp as a substring of a filename (not a path segment) must NOT match.
    expect(isLayer3MainNoise('/Users/x/gossip/src/dist-mcp-notes.ts', { inTestRunner: false, projectRoot })).toBe(false);
  });
});

describeOnPosix('buildAuditExclusions — cursor-sandbox-cache always-on prune', () => {
  itOnPosix('adds cursor-sandbox-cache to the always-on tmpdir prune list (not test-gated)', () => {
    const excl = buildAuditExclusions('/tmp/projectroot', undefined);
    const tmp = tmpdir();
    expect(excl).toContain(`${tmp}/cursor-sandbox-cache`);
  });

  itOnPosix('no longer emits the dead TEST_FIXTURE_PREFIXES glob entries', () => {
    // Under the jest gate (JEST_WORKER_ID is set), the old code added ~60
    // `<tmp>/gossip-*-*` glob entries. The inversion deletes them.
    const excl = buildAuditExclusions('/tmp/projectroot', undefined);
    expect(excl.some(e => e.endsWith('gossip-test-*'))).toBe(false);
    expect(excl.some(e => e.endsWith('sandbox-test-*'))).toBe(false);
  });
});

describeOnPosix('auditFilesystemSinceSentinel — end-to-end noise suppression (gate ON under jest)', () => {
  itOnPosix('a non-keep tmpdir fixture write is EXCLUDED from violations', () => {
    // jest sets JEST_WORKER_ID, so the inverted gate is active.
    const projectRoot = mkTmp();
    const fixtureDir = mkdtempSync(join(tmpdir(), `skill-engine-status-${Date.now()}-`));
    try {
      const sentinel = stampTaskSentinel(projectRoot, 'noise-1')!;
      backdateSentinel(sentinel, 5000);
      const inner = join(fixtureDir, 'sub');
      mkdirSync(inner, { recursive: true });
      writeFileSync(join(inner, 'fixture.jsonl'), '{"x":1}\n');

      const meta: DispatchMetadata = {
        taskId: 'noise-1',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };
      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [tmpdir()],
        logFailures: false,
      });
      expect(res.violations.some(v => v.includes('fixture.jsonl'))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  itOnPosix('a gossip-l3-scan- write IS still recorded under the gate (regression guard)', () => {
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    try {
      const sentinel = stampTaskSentinel(projectRoot, 'keep-1')!;
      backdateSentinel(sentinel, 5000);
      writeFileSync(join(scanRoot, 'outside.txt'), 'exfil');

      const meta: DispatchMetadata = {
        taskId: 'keep-1',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };
      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        logFailures: false,
      });
      expect(res.violations.some(v => v.endsWith('outside.txt'))).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });

  itOnPosix('a build-artifact-looking write under a tmpdir scan root (NOT under projectRoot) is FLAGGED — closes the /tmp/dist-mcp + /tmp/*.tsbuildinfo evasion', () => {
    // Rule C is projectRoot-anchored. tmpdir is itself a main-pass scan root for
    // worktree/sequential dispatches, so an UNanchored Rule C would let an agent
    // hide a real escape as `/tmp/dist-mcp/evil` or `/tmp/x.tsbuildinfo`. Here
    // projectRoot and the scan root are DISTINCT tmp dirs, so these build-artifact
    // names land OUTSIDE projectRoot and must surface as violations.
    const projectRoot = mkTmp();
    const scanRoot = mkTmp('gossip-l3-scan-');
    try {
      const sentinel = stampTaskSentinel(projectRoot, 'evasion-1')!;
      backdateSentinel(sentinel, 5000);
      const distMcpDir = join(scanRoot, 'dist-mcp');
      mkdirSync(distMcpDir, { recursive: true });
      writeFileSync(join(distMcpDir, 'evil.js'), 'exfil');
      writeFileSync(join(scanRoot, 'anything.tsbuildinfo'), '{}');

      const meta: DispatchMetadata = {
        taskId: 'evasion-1',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };
      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [scanRoot],
        logFailures: false,
      });
      // Both build-artifact-looking tmpdir paths are now FLAGGED (no evasion).
      expect(res.violations.some(v => v.endsWith('evil.js'))).toBe(true);
      expect(res.violations.some(v => v.endsWith('.tsbuildinfo'))).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });

  itOnPosix('a *.tsbuildinfo / dist-mcp write GENUINELY under projectRoot IS excluded (real build output)', () => {
    // The legitimate case: build artifacts live inside the repo. When the
    // scan surfaces a path under projectRoot, Rule C suppresses it.
    const projectRoot = mkTmp();
    try {
      const sentinel = stampTaskSentinel(projectRoot, 'build-real-1')!;
      backdateSentinel(sentinel, 5000);
      const distMcpDir = join(projectRoot, 'dist-mcp');
      mkdirSync(distMcpDir, { recursive: true });
      writeFileSync(join(distMcpDir, 'index.js'), 'build');
      writeFileSync(join(projectRoot, 'tsconfig.tsbuildinfo'), '{}');
      writeFileSync(join(projectRoot, 'real-source.ts'), 'leak');

      const meta: DispatchMetadata = {
        taskId: 'build-real-1',
        agentId: 'opus-implementer',
        writeMode: 'worktree',
        timestamp: Date.now(),
        sentinelPath: sentinel,
      };
      // Scan projectRoot itself so the build artifacts surface as candidates.
      const res = auditFilesystemSinceSentinel(projectRoot, meta, {
        scanRoots: [projectRoot],
        logFailures: false,
      });
      expect(res.violations.some(v => v.endsWith('.tsbuildinfo'))).toBe(false);
      expect(res.violations.some(v => v.endsWith('dist-mcp/index.js') || v.includes('/dist-mcp/'))).toBe(false);
      // A real source path under projectRoot is NOT a build artifact — it must
      // still surface (projectRoot is the scan root here, so anything under it
      // that isn't a build artifact or excluded dir is a candidate violation).
      expect(res.violations.some(v => v.endsWith('real-source.ts'))).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
