/**
 * Issue #675 stage 3 — auto-bind mode resolution.
 *
 * Both auto-bind sites in apps/cli/src/mcp-server-sdk.ts previously hardcoded
 * `mode: 'permanent'`. They now delegate to resolveAutoBindMode() so a
 * generated skill declaring `mode: contextual` is bound contextual, while a
 * skill with no frontmatter (or no `mode:` key) still binds permanent.
 *
 * The develop handler itself is not exported, so — following the convention in
 * tests/cli/mcp-skills-develop-throttle.test.ts — the semantics are asserted on
 * the building-block function, plus a source assertion that both bind sites
 * actually route through it and no longer hardcode a mode.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { resolveAutoBindMode } from '../../packages/orchestrator/src/skill-parser';
import { SkillIndex } from '../../packages/orchestrator/src/skill-index';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

function skillFile(fields: string[], body = '\n## Body\n\ntext\n'): string {
  return ['---', ...fields, '---', body].join('\n');
}

describe('resolveAutoBindMode', () => {
  it('returns contextual when the frontmatter declares mode: contextual', () => {
    const content = skillFile(['name: trust-boundaries', 'mode: contextual', 'status: passed']);
    expect(resolveAutoBindMode(content, 'trust-boundaries.md')).toBe('contextual');
  });

  it('returns contextual for a quoted declaration', () => {
    const content = skillFile(['name: trust-boundaries', 'mode: "contextual"']);
    expect(resolveAutoBindMode(content, 'trust-boundaries.md')).toBe('contextual');
  });

  it('returns permanent when mode is explicitly permanent', () => {
    const content = skillFile(['name: trust-boundaries', 'mode: permanent']);
    expect(resolveAutoBindMode(content)).toBe('permanent');
  });

  it('defaults to permanent when the frontmatter omits mode', () => {
    const content = skillFile(['name: trust-boundaries', 'status: passed']);
    expect(resolveAutoBindMode(content)).toBe('permanent');
  });

  it('defaults to permanent when the file has no frontmatter block', () => {
    expect(resolveAutoBindMode('# memory-retrieval\n\nCall gossip_remember first.\n')).toBe('permanent');
  });

  it('defaults to permanent on an unknown mode token', () => {
    const content = skillFile(['name: trust-boundaries', 'mode: sometimes']);
    expect(resolveAutoBindMode(content)).toBe('permanent');
  });

  it('defaults to permanent on empty content', () => {
    expect(resolveAutoBindMode('')).toBe('permanent');
  });
});

describe('auto-bind slot written from a declared mode', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-autobind-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('binds a generated skill declaring mode: contextual as a contextual slot', () => {
    const index = new SkillIndex(root);
    const content = skillFile(['name: trust-boundaries', 'mode: contextual', 'status: passed']);

    const slot = index.bind('opus-implementer', 'trust-boundaries', {
      source: 'auto',
      mode: resolveAutoBindMode(content, 'trust-boundaries.md'),
    });

    expect(slot.mode).toBe('contextual');
    expect(slot.source).toBe('auto');
  });

  it('binds a generated skill with no frontmatter as a permanent slot', () => {
    const index = new SkillIndex(root);

    const slot = index.bind('opus-implementer', 'memory-retrieval', {
      source: 'auto',
      mode: resolveAutoBindMode('# memory-retrieval\n\nbody\n', 'memory-retrieval.md'),
    });

    expect(slot.mode).toBe('permanent');
    expect(slot.source).toBe('auto');
  });
});

describe('mcp-server-sdk auto-bind sites', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
    'utf8',
  );

  it('no auto bind site hardcodes a mode any more', () => {
    expect(source).not.toContain("{ source: 'auto', mode: 'permanent' }");
  });

  it('both auto bind sites pass a resolved mode', () => {
    const matches = source.match(/skillIndex\.bind\(agent_id, skillName, \{ source: 'auto', mode: declaredMode \}\)/g);
    expect(matches).toHaveLength(2);
  });

  it('both auto bind sites derive declaredMode via resolveAutoBindMode', () => {
    const matches = source.match(/const declaredMode = resolveAutoBindMode\(result\.content, result\.path\);/g);
    expect(matches).toHaveLength(2);
  });
});
