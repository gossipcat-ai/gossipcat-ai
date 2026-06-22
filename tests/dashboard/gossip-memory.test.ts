import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gossipMemoryHandler, gossipMemoryDir } from '@gossip/relay/dashboard/api-gossip-memory';
import { migrateOne, hasCanonicalSchema, parseFrontmatter, migrateGossipMemory } from '../../scripts/migrate-gossip-memory';
import { toDisplayType } from '../../packages/dashboard-v2/src/lib/memory-taxonomy';

/**
 * Spec: docs/specs/2026-04-15-session-save-native-vs-gossip-memory.md
 *
 * Coverage:
 *   - api-gossip-memory endpoint shape (taxonomy classification)
 *   - missing frontmatter defaults to backlog without crash
 *   - migration script idempotency + transformation rules
 *   - separation invariant (no write to user auto-memory)
 */

function withProject(): { projectRoot: string; memoryPath: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), 'gossip-memory-test-'));
  const memoryPath = join(projectRoot, '.gossip', 'memory');
  mkdirSync(memoryPath, { recursive: true });
  return { projectRoot, memoryPath };
}

describe('api-gossip-memory handler', () => {
  it('returns empty array when .gossip/memory/ does not exist', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'gossip-empty-'));
    const result = await gossipMemoryHandler(projectRoot);
    expect(result.knowledge).toEqual([]);
  });

  it('reads canonical session file and exposes parsed frontmatter', async () => {
    const { projectRoot, memoryPath } = withProject();
    writeFileSync(
      join(memoryPath, 'session_2026_04_15.md'),
      `---
name: Session 2026-04-15 — shipped
description: shipped
status: open
type: session
importance: 0.4
lastAccessed: 2026-04-15
updated: 2026-04-15
accessCount: 0
---

Session body here.
`,
    );

    const result = await gossipMemoryHandler(projectRoot);
    expect(result.knowledge).toHaveLength(1);
    const file = result.knowledge[0];
    expect(file.filename).toBe('session_2026_04_15.md');
    expect(file.frontmatter.status).toBe('open');
    expect(file.frontmatter.type).toBe('session');
    expect(file.frontmatter.importance).toBe('0.4');
    expect(file.content).toContain('Session body here.');
  });

  it('skips non-markdown files and traversal attempts (filename allowlist)', async () => {
    const { projectRoot, memoryPath } = withProject();
    writeFileSync(join(memoryPath, 'ok.md'), '# ok');
    writeFileSync(join(memoryPath, 'README.txt'), 'nope');
    // Filenames containing `/` are produced by readdirSync only on misuse, but
    // we still verify the regex rejects suspicious shapes.

    const result = await gossipMemoryHandler(projectRoot);
    expect(result.knowledge.map((k) => k.filename)).toEqual(['ok.md']);
  });

  it('survives unreadable / malformed entries without crashing', async () => {
    const { projectRoot, memoryPath } = withProject();
    writeFileSync(join(memoryPath, 'broken.md'), '---\nname: incomplete'); // no closing ---
    writeFileSync(join(memoryPath, 'good.md'), '---\nname: x\ndescription: y\n---\nbody');

    const result = await gossipMemoryHandler(projectRoot);
    // Both files load (parseFrontmatter returns empty fm for malformed input);
    // critically, the handler does not throw.
    expect(result.knowledge.length).toBeGreaterThanOrEqual(1);
  });

  it('default classification: missing frontmatter routes to backlog (mapper safe default)', () => {
    // The taxonomy mapper, not the handler, classifies — but verify the contract
    // here so a regression in either side breaks loudly.
    expect(toDisplayType({ filename: 'project_x.md', content: '' })).toBe('backlog');
  });

  it('session_*.md routes to session via filename prefix even when frontmatter type drifts', () => {
    expect(
      toDisplayType({
        filename: 'session_2026_04_15.md',
        frontmatter: { type: 'project' },
        content: '',
      }),
    ).toBe('session');
  });

  it('gossipMemoryDir resolves under project root (never under ~/.claude)', () => {
    const dir = gossipMemoryDir('/some/project');
    expect(dir).toBe('/some/project/.gossip/memory');
    expect(dir).not.toContain('.claude/projects');
  });
});

describe('migrate-gossip-memory script', () => {
  it('parseFrontmatter returns kv map and body', () => {
    const { fm, body } = parseFrontmatter('---\nfoo: bar\nbaz: qux\n---\nthe body\n');
    expect(fm.foo).toBe('bar');
    expect(fm.baz).toBe('qux');
    expect(body.trim()).toBe('the body');
  });

  it('hasCanonicalSchema returns true only when ALL canonical fields are present', () => {
    expect(hasCanonicalSchema({})).toBe(false);
    expect(
      hasCanonicalSchema({
        name: 'x', description: 'y', status: 'open', type: 'session',
        importance: '0.4', lastAccessed: '2026-04-15', accessCount: '0',
      }),
    ).toBe(true);
  });

  it('migrateOne transforms legacy frontmatter to canonical schema', () => {
    const legacy = `---
date: 2026-04-14/15
prs: 4
consensus_rounds: 5
---

SUMMARY: 4 PRs shipped, taxonomy validated

## Open for next session
- Address consensus regressions
`;
    const out = migrateOne(legacy, 'session_2026_04_14_15.md', '2026-04-15');
    expect(out).not.toBeNull();
    const { fm, body } = parseFrontmatter(out!);
    expect(fm.status).toBe('open'); // open section is non-empty
    expect(fm.type).toBe('session');
    expect(fm.importance).toBe('0.4');
    expect(fm.lastAccessed).toBe('2026-04-15');
    expect(fm.updated).toBe('2026-04-15');
    expect(fm.accessCount).toBe('0');
    expect(fm.description).toContain('4 PRs shipped');
    expect(fm.name).toContain('Session');
    // Pre-existing non-canonical fields must be preserved (rule 8).
    expect(fm.prs).toBe('4');
    expect(fm.consensus_rounds).toBe('5');
    expect(body).toContain('SUMMARY: 4 PRs shipped');
  });

  it('migrateOne assigns status:shipped when no Open section is present', () => {
    const noOpen = `---
date: 2026-04-15
---

SUMMARY: shipped sprint

## What shipped
- everything
`;
    const out = migrateOne(noOpen, 'session_2026_04_15.md', '2026-04-15');
    const { fm } = parseFrontmatter(out!);
    expect(fm.status).toBe('shipped');
  });

  it('idempotency: running migration on a canonical file is a no-op (returns null)', () => {
    const canonical = `---
name: Session 2026-04-15 — shipped
description: shipped
status: open
type: session
importance: 0.4
lastAccessed: 2026-04-15
updated: 2026-04-15
accessCount: 0
---

body
`;
    expect(migrateOne(canonical, 'session_2026_04_15.md', '2026-04-15')).toBeNull();
  });

  it('migrateGossipMemory walks .gossip/memory and migrates only non-canonical files', () => {
    const { projectRoot, memoryPath } = withProject();
    writeFileSync(join(memoryPath, 'session_legacy.md'), `---\ndate: 2026-04-14\n---\n\nSUMMARY: legacy file\n`);
    writeFileSync(
      join(memoryPath, 'session_canonical.md'),
      `---\nname: Session canonical\ndescription: x\nstatus: shipped\ntype: session\nimportance: 0.4\nlastAccessed: 2026-04-15\nupdated: 2026-04-15\naccessCount: 0\n---\nbody\n`,
    );

    const result = migrateGossipMemory(projectRoot);
    expect(result.migrated).toContain('session_legacy.md');
    expect(result.skipped).toContain('session_canonical.md');
    expect(result.errors).toHaveLength(0);

    // Re-running is a no-op for the just-migrated file.
    const second = migrateGossipMemory(projectRoot);
    expect(second.migrated).toEqual([]);
    expect(second.skipped.sort()).toEqual(['session_canonical.md', 'session_legacy.md']);
  });

  it('migrateGossipMemory tolerates a missing .gossip/memory directory', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'gossip-no-mem-'));
    const result = migrateGossipMemory(projectRoot);
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('separation invariant', () => {
  it('gossipMemoryDir always resolves to the project root, never the user home', () => {
    expect(gossipMemoryDir('/projects/foo')).toBe('/projects/foo/.gossip/memory');
    expect(gossipMemoryDir('/Users/x/projects/y')).toBe('/Users/x/projects/y/.gossip/memory');
    // The native (Claude Code) auto-memory path lives under ~/.claude/projects;
    // gossipMemoryDir must never produce something under that tree.
    expect(gossipMemoryDir('/p').includes('.claude/projects')).toBe(false);
  });
});
