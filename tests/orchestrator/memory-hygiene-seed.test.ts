import { seedMemoryHygiene } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('seedMemoryHygiene', () => {
  const testDir = join(tmpdir(), `gossip-hygiene-seed-test-${Date.now()}`);
  afterAll(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('skips silently when CLAUDE.md does not exist (does not create one)', () => {
    const dir = join(testDir, 'no-claude-md');
    mkdirSync(dir, { recursive: true });
    const result = seedMemoryHygiene(dir);
    expect(result.action).toBe('skipped-no-claude-md');
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('appends hygiene block when heading is absent', () => {
    const dir = join(testDir, 'append');
    mkdirSync(dir, { recursive: true });
    const original = '# My Project\n\nSome existing content.\n';
    writeFileSync(join(dir, 'CLAUDE.md'), original, 'utf-8');

    const result = seedMemoryHygiene(dir);
    expect(result.action).toBe('appended');

    const updated = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    // Original content preserved
    expect(updated.startsWith(original)).toBe(true);
    // Canonical block appended
    expect(updated).toContain('## Memory hygiene (gossipcat convention)');
    expect(updated).toContain('status: open');
    expect(updated).toContain('status: shipped');
    expect(updated).toContain('status: closed');
    expect(updated).toContain('docs/specs/2026-04-17-memory-hygiene-propagation.md');
  });

  it('is idempotent — re-running on seeded CLAUDE.md is a no-op', () => {
    const dir = join(testDir, 'idempotent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n', 'utf-8');

    const first = seedMemoryHygiene(dir);
    expect(first.action).toBe('appended');
    const afterFirst = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');

    const second = seedMemoryHygiene(dir);
    expect(second.action).toBe('already-present');
    const afterSecond = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(afterSecond).toBe(afterFirst);
  });

  it('detects existing heading case-insensitively', () => {
    const dir = join(testDir, 'case-insensitive');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'),
      '# Project\n\n## MEMORY HYGIENE (custom form)\n\nUser wrote their own block.\n', 'utf-8');
    const result = seedMemoryHygiene(dir);
    expect(result.action).toBe('already-present');
  });

  it('handles CLAUDE.md without trailing newline (adds one before block)', () => {
    const dir = join(testDir, 'no-trailing-newline');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n\nLast line, no newline', 'utf-8');
    const result = seedMemoryHygiene(dir);
    expect(result.action).toBe('appended');
    const updated = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    // Should insert a newline before the block so heading starts at column 0
    expect(updated).toContain('no newline\n\n## Memory hygiene');
  });
});
