/**
 * Memory dedupe helpers — pure, JSX-free so tests can import them without a
 * JSX transform. Used by MemoryFolders to collapse duplicate files while
 * preserving cross-store collisions.
 *
 * Spec: docs/specs/2026-04-17-unified-memory-view.md
 */

import type { MemoryFile } from './types';

/**
 * Build the dedupe key for a memory file. When `origin` is set (post-merge),
 * include it so a same-named file in both stores isn't silently hidden.
 * Without `origin` (pre-merge callers), fall back to filename-only — matches
 * the original behavior before the unified-memory-view change.
 */
export function memoryDedupeKey(m: MemoryFile): string {
  return m.origin ? `${m.origin}/${m.filename}` : m.filename;
}

/**
 * Return the first occurrence of each memory keyed by `memoryDedupeKey`.
 * Exported so tests can exercise merge + dedupe behavior without mounting
 * the React component.
 */
export function dedupeMemories(memories: MemoryFile[]): MemoryFile[] {
  const seen = new Set<string>();
  const out: MemoryFile[] = [];
  for (const m of memories) {
    const key = memoryDedupeKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}
