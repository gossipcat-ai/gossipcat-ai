import { refreshMemoryIndex, applyStatusTags } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeFrontmatter(status?: string): string {
  const lines = ['---', 'name: Foo', 'description: A memory', 'type: project'];
  if (status) lines.push(`status: ${status}`);
  lines.push('originSessionId: abc');
  lines.push('---');
  lines.push('');
  lines.push('Body content here.');
  return lines.join('\n') + '\n';
}

describe('memory-index refreshMemoryIndex', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `gossip-memindex-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeIndex(body: string) {
    writeFileSync(join(testDir, 'MEMORY.md'), body);
  }
  function readIndex(): string {
    return readFileSync(join(testDir, 'MEMORY.md'), 'utf-8');
  }

  it('returns {0,0} when MEMORY.md absent', async () => {
    const r = await refreshMemoryIndex(testDir);
    expect(r).toEqual({ updated: 0, skipped: 0 });
  });

  it('adds a [SHIPPED] tag to a matching line', async () => {
    writeFileSync(join(testDir, 'project_foo.md'), makeFrontmatter('shipped'));
    writeIndex('# Index\n\n- [Foo feature](project_foo.md) — did stuff\n');
    const r = await refreshMemoryIndex(testDir);
    expect(r.updated).toBe(1);
    expect(readIndex()).toContain('- [SHIPPED] [Foo feature](project_foo.md) — did stuff');
  });

  it('handles multiple statuses (shipped/open/closed)', async () => {
    writeFileSync(join(testDir, 'project_a.md'), makeFrontmatter('shipped'));
    writeFileSync(join(testDir, 'project_b.md'), makeFrontmatter('open'));
    writeFileSync(join(testDir, 'feedback_c.md'), makeFrontmatter('closed'));
    writeIndex([
      '# Index',
      '',
      '## Project',
      '- [A](project_a.md) — a',
      '- [B](project_b.md) — b',
      '',
      '## Feedback',
      '- [C](feedback_c.md) — c',
      '',
    ].join('\n'));
    const r = await refreshMemoryIndex(testDir);
    expect(r.updated).toBe(3);
    const out = readIndex();
    expect(out).toContain('- [SHIPPED] [A](project_a.md)');
    expect(out).toContain('- [OPEN] [B](project_b.md)');
    expect(out).toContain('- [CLOSED] [C](feedback_c.md)');
    expect(out).toContain('## Project');
    expect(out).toContain('## Feedback');
  });

  it('replaces an existing tag when status changes', async () => {
    writeFileSync(join(testDir, 'project_foo.md'), makeFrontmatter('shipped'));
    writeIndex('- [OPEN] [Foo](project_foo.md) — x\n');
    const r = await refreshMemoryIndex(testDir);
    expect(r.updated).toBe(1);
    expect(readIndex()).toContain('- [SHIPPED] [Foo](project_foo.md) — x');
    expect(readIndex()).not.toContain('[OPEN]');
  });

  it('strips a tag when the file no longer has a status', async () => {
    writeFileSync(join(testDir, 'project_foo.md'), makeFrontmatter(undefined));
    writeIndex('- [SHIPPED] [Foo](project_foo.md) — x\n');
    const r = await refreshMemoryIndex(testDir);
    expect(r.updated).toBe(1);
    const out = readIndex();
    expect(out).toContain('- [Foo](project_foo.md) — x');
    expect(out).not.toContain('[SHIPPED]');
  });

  it('is idempotent: second call reports updated: 0', async () => {
    writeFileSync(join(testDir, 'project_foo.md'), makeFrontmatter('shipped'));
    writeIndex('- [Foo](project_foo.md) — x\n');
    const r1 = await refreshMemoryIndex(testDir);
    expect(r1.updated).toBe(1);
    const r2 = await refreshMemoryIndex(testDir);
    expect(r2.updated).toBe(0);
  });

  it('leaves unchanged when linked file is missing', async () => {
    writeIndex('- [Ghost](project_ghost.md) — x\n');
    const r = await refreshMemoryIndex(testDir);
    expect(r.updated).toBe(0);
    expect(readIndex()).toContain('- [Ghost](project_ghost.md) — x');
  });

  it('does not tag user_*.md or reference_*.md even if they have status', async () => {
    writeFileSync(join(testDir, 'user_profile.md'), makeFrontmatter('shipped'));
    writeFileSync(join(testDir, 'reference_x.md'), makeFrontmatter('open'));
    writeIndex([
      '- [Profile](user_profile.md) — p',
      '- [Ref](reference_x.md) — r',
      '',
    ].join('\n'));
    const r = await refreshMemoryIndex(testDir);
    expect(r.updated).toBe(0);
    const out = readIndex();
    expect(out).not.toContain('[SHIPPED]');
    expect(out).not.toContain('[OPEN]');
  });

  it('preserves section headers and blank lines verbatim', async () => {
    writeFileSync(join(testDir, 'project_a.md'), makeFrontmatter('shipped'));
    const input = [
      '# MEMORY Index',
      '',
      '## Project (most recent)',
      '',
      '- [A](project_a.md) — a',
      '',
      '## Sessions',
      'Some free prose.',
      '',
    ].join('\n');
    writeIndex(input);
    await refreshMemoryIndex(testDir);
    const out = readIndex();
    expect(out).toContain('# MEMORY Index');
    expect(out).toContain('## Project (most recent)');
    expect(out).toContain('## Sessions');
    expect(out).toContain('Some free prose.');
    expect(out).toContain('- [SHIPPED] [A](project_a.md) — a');
  });

  it('writes atomically: no stray .tmp file after refresh', async () => {
    writeFileSync(join(testDir, 'project_foo.md'), makeFrontmatter('shipped'));
    writeIndex('- [Foo](project_foo.md) — x\n');
    await refreshMemoryIndex(testDir);
    const entries = readdirSync(testDir);
    expect(entries).toContain('MEMORY.md');
    expect(entries).not.toContain('MEMORY.md.tmp');
    expect(existsSync(join(testDir, 'MEMORY.md.tmp'))).toBe(false);
  });

  it('skips write when output === input (idempotent no-op)', async () => {
    // No linked files have status → existing untagged line should not rewrite.
    writeFileSync(join(testDir, 'project_foo.md'), makeFrontmatter(undefined));
    writeIndex('- [Foo](project_foo.md) — x\n');
    const before = readFileSync(join(testDir, 'MEMORY.md'));
    // Give filesystem a moment, then refresh.
    const r = await refreshMemoryIndex(testDir);
    expect(r.updated).toBe(0);
    const after = readFileSync(join(testDir, 'MEMORY.md'));
    expect(after.equals(before)).toBe(true);
  });

  it('passes non-bullet lines through unchanged', () => {
    // Unit test of the pure transform — exercises header/blank/sub-bullet handling.
    const input = [
      '# Heading',
      '> quote',
      '  - indented sub-bullet [X](project_x.md)',
      'plain text [Y](project_y.md)',
      '- [Real](project_real.md) — ok',
      '',
    ].join('\n');
    const map = new Map<string, 'shipped' | 'open' | 'closed'>([
      ['project_real.md', 'shipped'],
      ['project_x.md', 'shipped'],
      ['project_y.md', 'open'],
    ]);
    const { output, changed } = applyStatusTags(input, map);
    expect(changed).toBe(1);
    expect(output).toContain('- [SHIPPED] [Real](project_real.md) — ok');
    // Non-matching lines unchanged.
    expect(output).toContain('  - indented sub-bullet [X](project_x.md)');
    expect(output).toContain('plain text [Y](project_y.md)');
    expect(output).toContain('# Heading');
  });
});
