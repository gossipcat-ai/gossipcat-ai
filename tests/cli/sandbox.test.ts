/**
 * Tests for sandbox enforcement — prompt sanitization + boundary audit.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  relativizeProjectPaths,
  shouldSanitize,
  prependScopeNote,
  parseGitStatus,
  detectBoundaryEscapes,
  recordDispatchMetadata,
  lookupDispatchMetadata,
  readSandboxMode,
  isInsideScope,
  DispatchMetadata,
  buildAuditExclusions,
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
