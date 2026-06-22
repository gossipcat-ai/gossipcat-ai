import {
  dedupeMemories,
  memoryDedupeKey,
} from '../../packages/dashboard-v2/src/lib/memory-dedupe';
import type { MemoryFile } from '../../packages/dashboard-v2/src/lib/types';

/**
 * Spec: docs/specs/2026-04-17-unified-memory-view.md
 *
 * Covers:
 *   - Merge at view layer: two arrays concatenate and both render.
 *   - Dedupe key includes `origin` so cross-store collisions stay visible.
 *   - Legacy callers without `origin` keep filename-only behavior.
 */

function mem(over: Partial<MemoryFile>): MemoryFile {
  return {
    filename: over.filename ?? 'x.md',
    frontmatter: over.frontmatter ?? {},
    content: over.content ?? '',
    ...(over.origin !== undefined ? { origin: over.origin } : {}),
  };
}

describe('memoryDedupeKey', () => {
  it('prefixes origin when present', () => {
    expect(memoryDedupeKey(mem({ filename: 'a.md', origin: 'gossip' }))).toBe('gossip/a.md');
    expect(memoryDedupeKey(mem({ filename: 'a.md', origin: 'native' }))).toBe('native/a.md');
  });

  it('falls back to filename-only when origin is missing (legacy callers)', () => {
    expect(memoryDedupeKey(mem({ filename: 'a.md' }))).toBe('a.md');
  });
});

describe('dedupeMemories — merge at view layer', () => {
  it('preserves a same-named file across both stores (cross-store collision visible)', () => {
    const input = [
      mem({ filename: 'session_2026_04_16.md', origin: 'gossip' }),
      mem({ filename: 'session_2026_04_16.md', origin: 'native' }),
    ];
    const out = dedupeMemories(input);
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.origin)).toEqual(['gossip', 'native']);
  });

  it('dedupes same-origin duplicates (legacy agent+_project duplication stays collapsed)', () => {
    const input = [
      mem({ filename: 'project_x.md', origin: 'native', frontmatter: { source: 'first' } }),
      mem({ filename: 'project_x.md', origin: 'native', frontmatter: { source: 'second' } }),
    ];
    const out = dedupeMemories(input);
    expect(out).toHaveLength(1);
    expect(out[0].frontmatter.source).toBe('first'); // first occurrence wins
  });

  it('merged gossip + native array: each store contributes its unique files', () => {
    const gossip = [
      mem({ filename: 'session_2026_04_15.md', origin: 'gossip' }),
      mem({ filename: 'session_2026_04_16.md', origin: 'gossip' }),
    ];
    const native = [
      mem({ filename: 'project_foo.md', origin: 'native' }),
      mem({ filename: 'feedback_bar.md', origin: 'native' }),
      mem({ filename: 'session_2026_04_16.md', origin: 'native' }), // collision on filename
    ];
    const out = dedupeMemories([...gossip, ...native]);
    // 2 gossip + 3 native = 5; the collision is preserved because keys differ.
    expect(out).toHaveLength(5);
    const keys = out.map(memoryDedupeKey);
    expect(keys).toContain('gossip/session_2026_04_16.md');
    expect(keys).toContain('native/session_2026_04_16.md');
  });

  it('legacy callers without origin still collapse filename duplicates', () => {
    const input = [
      mem({ filename: 'a.md' }),
      mem({ filename: 'a.md' }),
      mem({ filename: 'b.md' }),
    ];
    const out = dedupeMemories(input);
    expect(out.map((m) => m.filename)).toEqual(['a.md', 'b.md']);
  });

  it('empty input returns empty array', () => {
    expect(dedupeMemories([])).toEqual([]);
  });
});
