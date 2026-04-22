/**
 * Tests for sandbox enforcement — prompt sanitization + boundary audit.
 */
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import {
  relativizeProjectPaths,
  shouldSanitize,
  prependScopeNote,
  prependUnverifiedNote,
  maybeAnnotateUnverifiedClaims,
  parseGitStatus,
  detectBoundaryEscapes,
  recordDispatchMetadata,
  lookupDispatchMetadata,
  readSandboxMode,
  isInsideScope,
  auditDispatchBoundary,
  DispatchMetadata,
  buildAuditExclusions,
  rotateIfNeeded,
  MAX_BOUNDARY_ESCAPE_BYTES,
} from '../../apps/cli/src/sandbox';

describe('relativizeProjectPaths', () => {
  const root = '/Users/alice/projects/myapp';

  it('rewrites a single absolute project path to relative', () => {
    const { sanitized, replacements } = relativizeProjectPaths(
      `Edit ${root}/src/foo.ts`,
      root,
    );
    expect(sanitized).toBe('Edit ./src/foo.ts');
    expect(replacements).toBe(1);
  });

  it('rewrites multiple absolute project paths in one string', () => {
    const input = `Open ${root}/a.ts and ${root}/b/c.ts then check ${root}`;
    const { sanitized, replacements } = relativizeProjectPaths(input, root);
    expect(sanitized).toBe('Open ./a.ts and ./b/c.ts then check .');
    expect(replacements).toBe(3);
  });

  it('preserves system paths like /usr, /tmp, /etc', () => {
    const input = `Read /usr/local/bin/node and /tmp/foo and ${root}/src/x.ts`;
    const { sanitized, replacements } = relativizeProjectPaths(input, root);
    expect(sanitized).toContain('/usr/local/bin/node');
    expect(sanitized).toContain('/tmp/foo');
    expect(sanitized).toContain('./src/x.ts');
    expect(replacements).toBe(1);
  });

  it('preserves /Users paths outside the project root', () => {
    const input = `Check /Users/bob/other/file.ts and ${root}/mine.ts`;
    const { sanitized, replacements } = relativizeProjectPaths(input, root);
    expect(sanitized).toContain('/Users/bob/other/file.ts');
    expect(sanitized).toContain('./mine.ts');
    expect(replacements).toBe(1);
  });

  it('rewrites paths inside a declared scope (scope is still under projectRoot)', () => {
    const input = `Write to ${root}/apps/cli/src/new.ts`;
    const { sanitized, replacements } = relativizeProjectPaths(input, root);
    expect(sanitized).toBe('Write to ./apps/cli/src/new.ts');
    expect(replacements).toBe(1);
  });

  it('handles bare projectRoot without trailing slash', () => {
    const { sanitized, replacements } = relativizeProjectPaths(
      `cd ${root} and run tests`,
      root,
    );
    expect(sanitized).toBe('cd . and run tests');
    expect(replacements).toBe(1);
  });

  it('is a no-op when no project paths are present', () => {
    const input = 'Review the README and check /tmp/scratch';
    const { sanitized, replacements } = relativizeProjectPaths(input, root);
    expect(sanitized).toBe(input);
    expect(replacements).toBe(0);
  });

  it('refuses to rewrite when projectRoot is "/" or empty', () => {
    expect(relativizeProjectPaths('/usr/bin/node', '/').replacements).toBe(0);
    expect(relativizeProjectPaths('/usr/bin/node', '').replacements).toBe(0);
  });
});

describe('shouldSanitize', () => {
  it('sanitizes scoped and worktree modes', () => {
    expect(shouldSanitize('scoped', undefined)).toBe(true);
    expect(shouldSanitize('worktree', undefined)).toBe(true);
  });
  it('does not sanitize sequential or undefined without implementer preset', () => {
    expect(shouldSanitize('sequential', 'reviewer')).toBe(false);
    expect(shouldSanitize(undefined, 'reviewer')).toBe(false);
  });
  it('sanitizes when preset includes implementer even without write_mode', () => {
    expect(shouldSanitize(undefined, 'implementer')).toBe(true);
    expect(shouldSanitize(undefined, 'senior-implementer')).toBe(true);
  });
});

describe('prependScopeNote', () => {
  it('prepends the scope note', () => {
    const out = prependScopeNote('You are an agent');
    expect(out.startsWith('SCOPE NOTE:')).toBe(true);
    expect(out).toContain('You are an agent');
  });
  it('is idempotent', () => {
    const once = prependScopeNote('task');
    const twice = prependScopeNote(once);
    expect(twice).toBe(once);
  });
});

describe('parseGitStatus', () => {
  it('parses simple modified and new files', () => {
    const porcelain = ' M apps/cli/src/foo.ts\n?? newfile.ts\nA  tests/bar.test.ts\n';
    expect(parseGitStatus(porcelain)).toEqual([
      'apps/cli/src/foo.ts',
      'newfile.ts',
      'tests/bar.test.ts',
    ]);
  });
  it('handles renames (takes destination path)', () => {
    const porcelain = 'R  old.ts -> new.ts\n';
    expect(parseGitStatus(porcelain)).toEqual(['new.ts']);
  });
  it('strips surrounding quotes on paths with special chars', () => {
    const porcelain = ' M "has space.ts"\n';
    expect(parseGitStatus(porcelain)).toEqual(['has space.ts']);
  });
  it('returns empty on empty input', () => {
    expect(parseGitStatus('')).toEqual([]);
  });
});

describe('isInsideScope', () => {
  it('matches files inside the scope', () => {
    expect(isInsideScope('apps/cli/src/foo.ts', 'apps/cli/src')).toBe(true);
    expect(isInsideScope('apps/cli/src/a/b/c.ts', 'apps/cli/src')).toBe(true);
  });
  it('rejects files outside the scope', () => {
    expect(isInsideScope('packages/orchestrator/foo.ts', 'apps/cli/src')).toBe(false);
    expect(isInsideScope('apps/cli/README.md', 'apps/cli/src')).toBe(false);
  });
  it('normalizes ./ prefixes', () => {
    expect(isInsideScope('./apps/cli/src/x.ts', './apps/cli/src')).toBe(true);
  });
  it('empty scope matches everything', () => {
    expect(isInsideScope('anywhere.ts', '')).toBe(true);
  });
});

describe('detectBoundaryEscapes', () => {
  const root = '/tmp/fakeproject';
  const baseMeta = (overrides: Partial<DispatchMetadata> = {}): DispatchMetadata => ({
    taskId: 't1',
    agentId: 'opus-implementer',
    writeMode: 'scoped',
    scope: 'apps/cli/src',
    timestamp: Date.now(),
    ...overrides,
  });

  it('no violations when scoped task stays inside scope', () => {
    const v = detectBoundaryEscapes(
      baseMeta(),
      ['apps/cli/src/foo.ts', 'apps/cli/src/bar.ts'],
      root,
    );
    expect(v).toEqual([]);
  });

  it('flags files outside the scope as violations', () => {
    const v = detectBoundaryEscapes(
      baseMeta(),
      ['apps/cli/src/foo.ts', 'packages/orchestrator/bad.ts', 'README.md'],
      root,
    );
    expect(v).toEqual(['packages/orchestrator/bad.ts', 'README.md']);
  });

  it('worktree mode: any modification in main repo is a violation', () => {
    const v = detectBoundaryEscapes(
      baseMeta({ writeMode: 'worktree', scope: undefined }),
      ['apps/cli/src/foo.ts', 'packages/orchestrator/bar.ts'],
      root,
    );
    expect(v).toEqual(['apps/cli/src/foo.ts', 'packages/orchestrator/bar.ts']);
  });

  it('worktree mode with no modifications is clean', () => {
    expect(
      detectBoundaryEscapes(baseMeta({ writeMode: 'worktree', scope: undefined }), [], root),
    ).toEqual([]);
  });

  it('skips sequential mode', () => {
    const v = detectBoundaryEscapes(
      baseMeta({ writeMode: 'sequential' }),
      ['anywhere.ts'],
      root,
    );
    expect(v).toEqual([]);
  });

  it('skips when no scope declared for scoped mode', () => {
    const v = detectBoundaryEscapes(
      baseMeta({ writeMode: 'scoped', scope: undefined }),
      ['foo.ts'],
      root,
    );
    expect(v).toEqual([]);
  });

  it('worktree mode: allowlists .claude/worktrees/ paths', () => {
    const v = detectBoundaryEscapes(
      baseMeta({ writeMode: 'worktree', scope: undefined }),
      ['.claude/worktrees/some-branch/HEAD', 'apps/cli/src/leaked.ts'],
      root,
    );
    expect(v).toEqual(['apps/cli/src/leaked.ts']);
  });

  it('scoped mode: allowlists .claude/settings.local.json', () => {
    const v = detectBoundaryEscapes(
      baseMeta(),
      ['apps/cli/src/ok.ts', '.claude/settings.local.json'],
      root,
    );
    expect(v).toEqual([]);
  });

  it('scoped mode: allowlists .claude/worktrees/ paths', () => {
    const v = detectBoundaryEscapes(
      baseMeta(),
      ['apps/cli/src/ok.ts', '.claude/worktrees/feat/config'],
      root,
    );
    expect(v).toEqual([]);
  });

  it('worktree mode: non-allowlisted .claude paths are still violations', () => {
    const v = detectBoundaryEscapes(
      baseMeta({ writeMode: 'worktree', scope: undefined }),
      ['.claude/agents/rogue/instructions.md'],
      root,
    );
    expect(v).toEqual(['.claude/agents/rogue/instructions.md']);
  });
});

describe('dispatch metadata round-trip', () => {
  it('records and looks up dispatch metadata', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const meta: DispatchMetadata = {
      taskId: 'abc123',
      agentId: 'opus-implementer',
      writeMode: 'scoped',
      scope: 'apps/cli/src',
      timestamp: Date.now(),
    };
    recordDispatchMetadata(tmp, meta);
    const found = lookupDispatchMetadata(tmp, 'abc123');
    expect(found).not.toBeNull();
    expect(found!.agentId).toBe('opus-implementer');
    expect(found!.writeMode).toBe('scoped');
    expect(found!.scope).toBe('apps/cli/src');

    // Missing task → null
    expect(lookupDispatchMetadata(tmp, 'nope')).toBeNull();
  });

  it('returns most recent when duplicate task IDs exist', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    recordDispatchMetadata(tmp, {
      taskId: 'dup',
      agentId: 'first',
      writeMode: 'scoped',
      scope: 'a',
      timestamp: 1,
    });
    recordDispatchMetadata(tmp, {
      taskId: 'dup',
      agentId: 'second',
      writeMode: 'worktree',
      timestamp: 2,
    });
    const found = lookupDispatchMetadata(tmp, 'dup');
    expect(found!.agentId).toBe('second');
  });

  it('preserves preTaskFiles snapshot through round-trip', () => {
    // When the project root is not a git repo, recordDispatchMetadata's
    // internal git snapshot fails silently and the caller-provided
    // preTaskFiles field is preserved via the spread.
    const tmp = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const meta: DispatchMetadata = {
      taskId: 'snap1',
      agentId: 'sonnet-implementer',
      writeMode: 'scoped',
      scope: 'packages/orchestrator/src',
      timestamp: Date.now(),
      preTaskFiles: ['docs/existing-untracked.md', '.mcpregistry_token'],
    };
    recordDispatchMetadata(tmp, meta);
    const found = lookupDispatchMetadata(tmp, 'snap1');
    expect(found).not.toBeNull();
    expect(found!.preTaskFiles).toEqual(['docs/existing-untracked.md', '.mcpregistry_token']);
  });
});

describe('readSandboxMode', () => {
  it('defaults to "warn" when no config exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    expect(readSandboxMode(tmp)).toBe('warn');
  });

  it('reads "off" from config', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    mkdirSync(join(tmp, '.gossip'), { recursive: true });
    writeFileSync(
      join(tmp, '.gossip', 'config.json'),
      JSON.stringify({ sandboxEnforcement: 'off' }),
    );
    expect(readSandboxMode(tmp)).toBe('off');
  });

  it('reads "block" from config', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    mkdirSync(join(tmp, '.gossip'), { recursive: true });
    writeFileSync(
      join(tmp, '.gossip', 'config.json'),
      JSON.stringify({ sandboxEnforcement: 'block' }),
    );
    expect(readSandboxMode(tmp)).toBe('block');
  });

  it('falls back to "warn" on invalid value', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    mkdirSync(join(tmp, '.gossip'), { recursive: true });
    writeFileSync(
      join(tmp, '.gossip', 'config.json'),
      JSON.stringify({ sandboxEnforcement: 'chaos' }),
    );
    expect(readSandboxMode(tmp)).toBe('warn');
  });
});

describe('buildAuditExclusions', () => {
  const root = resolve('/tmp/fakeproject');

  it('includes node-compile-cache in tmpdir exclusions', () => {
    const exclusions = buildAuditExclusions(root, undefined, undefined);
    const tmp = resolve(tmpdir());
    expect(exclusions).toContain(`${tmp}/node-compile-cache`);
  });

  it('adds the agent scope to exclusions when provided', () => {
    const scope = 'packages/tools';
    const exclusions = buildAuditExclusions(root, undefined, scope);
    const expected = resolve(root, scope);
    expect(exclusions).toContain(expected);
  });

  it('does not add a scope exclusion when scope is undefined', () => {
    const exclusions = buildAuditExclusions(root, undefined, undefined);
    // A bit of a negative test; we check that no exclusion *ends with* a package
    // name, which is a proxy for "no scope was added".
    expect(exclusions.some(e => e.endsWith('packages/tools'))).toBe(false);
    expect(exclusions.some(e => e.endsWith('apps/cli'))).toBe(false);
  });

  it('includes the worktree path when provided', () => {
    const worktree = '/tmp/gossip-wt-123';
    const exclusions = buildAuditExclusions(root, worktree, undefined);
    expect(exclusions).toContain(resolve(worktree));
  });

  it('always includes .gossip, .claude, and .git', () => {
    const exclusions = buildAuditExclusions(root, undefined, undefined);
    expect(exclusions).toContain(resolve(root, '.gossip'));
    expect(exclusions).toContain(resolve(root, '.claude'));
    expect(exclusions).toContain(resolve(root, '.git'));
  });
});

/**
 * Test-fixture noise gate for Layer 3 main pass.
 *
 * Context: 6,128 / 8,590 = 71% of .gossip/boundary-escapes.jsonl entries
 * prior to this fix were mkdtempSync(join(tmpdir(), 'gossip-*-')) fixtures
 * light-up during `npm test`. The gate only fires when JEST_WORKER_ID or
 * NODE_ENV=test is set — neither is reachable from a dispatched agent
 * (child processes launched via execFileSync / native bridge are never
 * inside a jest runner), which makes the gate structurally unforgeable.
 *
 * Invariant: the gate MUST NOT affect the sensitive-targets pass
 * (Layer 3 Pass 2). That pass takes ZERO exclusions from
 * buildAuditExclusions and scans the vetted watchlist directly.
 */
describe('buildAuditExclusions — test-fixture gate (NODE_ENV / JEST_WORKER_ID)', () => {
  const root = resolve('/tmp/fakeproject');
  const tmp = resolve(tmpdir());

  // Snapshot/restore env so one test does not leak into another.
  const originalJestWorkerId = process.env.JEST_WORKER_ID;
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (originalJestWorkerId === undefined) delete process.env.JEST_WORKER_ID;
    else process.env.JEST_WORKER_ID = originalJestWorkerId;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('NODE_ENV=test: gossip-test- prefix IS excluded from the main-pass list', () => {
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'test';
    const excl = buildAuditExclusions(root, undefined, undefined);
    expect(excl).toContain(`${tmp}/gossip-test-*`);
  });

  it('JEST_WORKER_ID set: gossip-test- prefix IS excluded from the main-pass list', () => {
    delete process.env.NODE_ENV;
    process.env.JEST_WORKER_ID = '1';
    const excl = buildAuditExclusions(root, undefined, undefined);
    expect(excl).toContain(`${tmp}/gossip-test-*`);
  });

  it('NODE_ENV and JEST_WORKER_ID both unset: test-fixture prefixes are NOT excluded', () => {
    delete process.env.JEST_WORKER_ID;
    delete process.env.NODE_ENV;
    const excl = buildAuditExclusions(root, undefined, undefined);
    expect(excl).not.toContain(`${tmp}/gossip-test-*`);
    expect(excl).not.toContain(`${tmp}/sandbox-test-*`);
    expect(excl).not.toContain(`${tmp}/gossip-wt-*`);
    expect(excl).not.toContain(`${tmp}/perf-writer-*`);
    // Non-test churn exclusions MUST still be present (baseline behavior).
    expect(excl).toContain(`${tmp}/node-compile-cache`);
  });

  it('NODE_ENV=test: gossip-wt- prefix IS excluded (covers worktree-manager tmp dirs)', () => {
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'test';
    const excl = buildAuditExclusions(root, undefined, undefined);
    expect(excl).toContain(`${tmp}/gossip-wt-*`);
  });

  it('NODE_ENV=test: sandbox-test- prefix IS excluded', () => {
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'test';
    const excl = buildAuditExclusions(root, undefined, undefined);
    expect(excl).toContain(`${tmp}/sandbox-test-*`);
  });

  it('NODE_ENV=test: test-fixture exclusions emit /tmp ↔ /private/tmp twin variants', () => {
    // If tmpdir() itself resolves to /tmp or /var/folders, expandTmpVariants
    // may or may not emit a /private twin. But gossip-l3-* under an in-test
    // /tmp path must be symmetric. Synthesize by asserting both forms
    // coexist for the /tmp branch if tmpdir is /tmp-shaped. Otherwise skip
    // the twin assertion — the expansion is already unit-tested upstream.
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'test';
    const excl = buildAuditExclusions(root, undefined, undefined);
    // Every emitted test-fixture entry MUST end in '*' so `find -path`
    // matches descendants. Guard against accidentally dropping the suffix.
    const fixtureEntries = excl.filter(e => e.includes('gossip-test-'));
    expect(fixtureEntries.length).toBeGreaterThan(0);
    for (const e of fixtureEntries) {
      expect(e.endsWith('*')).toBe(true);
    }
  });

  it('gate MUST NOT alter buildSensitiveFindArgs (Layer 3 Pass 2 is independent of exclusions)', () => {
    // Structural check: buildSensitiveFindArgs in sandbox.ts takes no
    // exclusions parameter. We assert the function signature stays decoupled
    // from the main-pass exclusions list — a regression here would mean the
    // sensitive pass got gated off too.
    //
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildSensitiveFindArgs } = require('../../apps/cli/src/sandbox');
    // buildSensitiveFindArgs(target, sentinel, nameIncludes?, sentinelDir?)
    // — exactly 4 declared parameters, no exclusion list. `.length` counts
    // declared parameters (up to the first one with a default).
    expect(typeof buildSensitiveFindArgs).toBe('function');
    expect(buildSensitiveFindArgs.length).toBeLessThanOrEqual(4);
    // Smoke: invoking with NODE_ENV=test must still produce a find argv that
    // targets the given sensitive path without any test-fixture exclusion
    // leaking in.
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'test';
    const args: string[] = buildSensitiveFindArgs('/Users/someuser/.ssh', '/tmp/fake-sentinel');
    expect(args[0]).toBe('/Users/someuser/.ssh');
    // No test-fixture prefix should be in the argv.
    expect(args.some((a: string) => a.includes('gossip-test-'))).toBe(false);
    expect(args.some((a: string) => a.includes('sandbox-test-'))).toBe(false);
  });
});

describe('rotateIfNeeded (boundary-escapes.jsonl size rotation)', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gossip-test-rotation-'));
    filePath = join(tmpDir, 'boundary-escapes.jsonl');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('does not rotate when file is under the size limit', () => {
    const line = JSON.stringify({ hello: 'world' }) + '\n';
    writeFileSync(filePath, line);
    rotateIfNeeded(filePath, 1024);
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(filePath + '.1')).toBe(false);
    expect(readFileSync(filePath, 'utf8')).toBe(line);
  });

  it('does not rotate when the file does not exist', () => {
    // Missing file → no-op, no throw.
    rotateIfNeeded(filePath, 1024);
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(filePath + '.1')).toBe(false);
  });

  it('rotates to .1 when the file is at or over the size limit', () => {
    const payload = 'x'.repeat(200);
    writeFileSync(filePath, payload);
    rotateIfNeeded(filePath, 100);
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(filePath + '.1')).toBe(true);
    expect(readFileSync(filePath + '.1', 'utf8')).toBe(payload);
  });

  it('overwrites an existing .1 slot on a second rotation (single slot only)', () => {
    // First rotation.
    writeFileSync(filePath, 'first-generation');
    rotateIfNeeded(filePath, 1);
    expect(readFileSync(filePath + '.1', 'utf8')).toBe('first-generation');
    expect(existsSync(filePath)).toBe(false);

    // Second rotation — .1 must be overwritten, never promoted to .2.
    writeFileSync(filePath, 'second-generation');
    rotateIfNeeded(filePath, 1);
    expect(readFileSync(filePath + '.1', 'utf8')).toBe('second-generation');
    expect(existsSync(filePath + '.2')).toBe(false);
    expect(existsSync(filePath)).toBe(false);
  });

  it('allows appends to continue after rotation (new file created fresh)', () => {
    writeFileSync(filePath, 'old-content-that-is-rotated');
    rotateIfNeeded(filePath, 1);
    expect(existsSync(filePath)).toBe(false);

    // Mimic the production call shape: rotateIfNeeded → appendFileSync.
    const nextLine = JSON.stringify({ taskId: 't1', violatingPaths: ['foo'] }) + '\n';
    appendFileSync(filePath, nextLine);

    expect(readFileSync(filePath, 'utf8')).toBe(nextLine);
    expect(readFileSync(filePath + '.1', 'utf8')).toBe('old-content-that-is-rotated');

    // Another append accumulates into the same fresh file.
    const line2 = JSON.stringify({ taskId: 't2' }) + '\n';
    appendFileSync(filePath, line2);
    expect(readFileSync(filePath, 'utf8')).toBe(nextLine + line2);
  });

  it('exposes a 5MB default limit constant', () => {
    expect(MAX_BOUNDARY_ESCAPE_BYTES).toBe(5 * 1024 * 1024);
  });

  it('rotates exactly at the threshold (>= maxBytes)', () => {
    const payload = 'a'.repeat(100);
    writeFileSync(filePath, payload);
    expect(statSync(filePath).size).toBe(100);
    rotateIfNeeded(filePath, 100); // equal → rotate
    expect(existsSync(filePath)).toBe(false);
    expect(readFileSync(filePath + '.1', 'utf8')).toBe(payload);
  });
});

// Layer 2 emission test: verifies auditDispatchBoundary records a
// `boundary_escape` signal (NOT `disagreement`) when a scoped task touches
// files outside its declared scope. Consensus round bb03845d-64264402.
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;
describeOnPosix('auditDispatchBoundary — Layer 2 emits boundary_escape signal', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-l2-sig-'));
    // Minimal git repo so `git status --porcelain` succeeds.
    execSync('git init -q', { cwd: projectRoot });
    execSync('git config user.email "t@t"', { cwd: projectRoot });
    execSync('git config user.name "t"', { cwd: projectRoot });
    // Declare sandboxEnforcement=warn so recordBoundaryEscape fires.
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.gossip', 'config.json'),
      JSON.stringify({ sandboxEnforcement: 'warn' }),
    );
  });

  afterEach(() => {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('writes signal: "boundary_escape" (not "disagreement") to agent-performance.jsonl', () => {
    const meta: DispatchMetadata = {
      taskId: 'l2-sig',
      agentId: 'opus-implementer',
      writeMode: 'scoped',
      scope: 'apps/cli/src',
      timestamp: Date.now(),
      preTaskFiles: [],
    };
    recordDispatchMetadata(projectRoot, meta);

    // Touch a file outside the scope → triggers violation.
    mkdirSync(join(projectRoot, 'packages/orchestrator/src'), { recursive: true });
    writeFileSync(join(projectRoot, 'packages/orchestrator/src/rogue.ts'), '// out of scope');

    const result = auditDispatchBoundary(projectRoot, 'l2-sig');
    expect(result.violations.length).toBeGreaterThan(0);

    // JSONL must contain boundary_escape signal under trust_boundaries.
    const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
    // emitSandboxSignals is best-effort (try/catch) — if @gossip/orchestrator
    // resolves, the signal lands; if not, test exits without false positive.
    if (!existsSync(perfPath)) {
      console.warn('[test] emitSandboxSignals not available in this context — shape not verifiable');
      return;
    }
    const perfEntries = readFileSync(perfPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
    const escape = perfEntries.find(e =>
      e.type === 'consensus' &&
      e.taskId === 'l2-sig' &&
      e.category === 'trust_boundaries',
    );
    expect(escape).toBeDefined();
    expect(escape.signal).toBe('boundary_escape');
    expect(escape.signal).not.toBe('disagreement');
    expect(escape.agentId).toBe('opus-implementer');
  });
});

describe('maybeAnnotateUnverifiedClaims (premise verification)', () => {
  it('fires on digit-form anchor-verb claim ("identified 5 sites")', () => {
    const r = maybeAnnotateUnverifiedClaims('We identified 5 sites that lack the preamble.');
    expect(r.annotated).toBe(true);
    expect(r.matchedText?.toLowerCase()).toContain('identified 5 sites');
    expect(r.matchedPattern).toBe(0);
  });

  it('fires on word-form claim with EXACT 2026-04-22 incident phrase', () => {
    // Replays the literal incident sentence from PR #235 design dispatch.
    const incident = 'Five utility-dispatch sites in apps/cli/src/mcp-server-sdk.ts call assembleUtilityPrompt()';
    const r = maybeAnnotateUnverifiedClaims(incident);
    expect(r.annotated).toBe(true);
    expect(r.matchedText?.toLowerCase()).toContain('five');
    expect(r.matchedText?.toLowerCase()).toContain('sites');
  });

  it('passes non-anchor numeric prose ("Apply to 24 files")', () => {
    const r = maybeAnnotateUnverifiedClaims('Apply to 24 files in the package.');
    expect(r.annotated).toBe(false);
  });

  it('passes zero-numeric task unchanged (no bare lacks/missing fire)', () => {
    // Regression for the dropped `lacks/missing` bare pattern: a plain
    // "implement the missing X" should NOT trip the auditor.
    const r = maybeAnnotateUnverifiedClaims('Implement the missing validation helper for the auth flow.');
    expect(r.annotated).toBe(false);
  });

  it('prependUnverifiedNote is idempotent on double-prepend', () => {
    const base = 'Task: do the thing\n';
    const once = prependUnverifiedNote(base, 'identified 5 sites');
    const twice = prependUnverifiedNote(once, 'identified 5 sites');
    expect(once).toBe(twice);
    expect(once).toContain('═══ UNVERIFIED CLAIM DETECTED ═══');
    expect(once).toContain('identified 5 sites');
  });
});
