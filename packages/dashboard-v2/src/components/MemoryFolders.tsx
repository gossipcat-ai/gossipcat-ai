import { useMemo, useState } from 'react';
import type { MemoryFile } from '@/lib/types';
import { DISPLAY_TYPES, toDisplayType, type DisplayType } from '@/lib/memory-taxonomy';
import { MemoryTileGrid } from './MemoryTileGrid';
import { MemoryDialog } from './MemoryDialog';

interface MemoryFoldersProps {
  memories: MemoryFile[];
}

const TYPE_ACCENT: Record<DisplayType, string> = {
  backlog: 'text-primary',
  record: 'text-confirmed',
  session: 'text-unverified',
  rule: 'text-unique',
};

const TYPE_DOT: Record<DisplayType, string> = {
  backlog: 'bg-primary',
  record: 'bg-confirmed',
  session: 'bg-unverified',
  rule: 'bg-unique',
};

const TYPE_GLYPH: Record<DisplayType, string> = {
  backlog: '◐',
  record: '◉',
  session: '◍',
  rule: '◆',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Top-level "Memory" panel: 4 folder tiles (Backlog / Record / Session / Rule)
 * with counts and a recent-activity indicator. Clicking a folder drills into a
 * tile grid; clicking a tile opens the full memory in a dialog.
 *
 * Uses the dashboard's existing visual language (purple primary, mono caps
 * headings, shadcn-style card panels) — no new design tokens introduced.
 *
 * Spec: docs/specs/2026-04-15-memory-taxonomy-hybrid.md
 */
export function MemoryFolders({ memories }: MemoryFoldersProps) {
  const [folder, setFolder] = useState<DisplayType | null>(null);
  const [open, setOpen] = useState<MemoryFile | null>(null);

  // De-dupe by filename: the same file can be returned for both its agent and
  // _project when an agent shares it.
  const unique = useMemo(
    () => memories.filter((m, i, arr) => arr.findIndex((x) => x.filename === m.filename) === i),
    [memories],
  );

  // Group memories by display folder, plus per-folder "active in last 24h" flag.
  const byFolder = useMemo(() => {
    const buckets: Record<DisplayType, MemoryFile[]> = {
      backlog: [],
      record: [],
      session: [],
      rule: [],
    };
    const recent: Record<DisplayType, boolean> = {
      backlog: false,
      record: false,
      session: false,
      rule: false,
    };
    const now = Date.now();
    for (const m of unique) {
      const t = toDisplayType(m);
      buckets[t].push(m);
      if (!recent[t] && isRecent(m, now)) recent[t] = true;
    }
    return { buckets, recent };
  }, [unique]);

  if (folder) {
    return (
      <>
        <MemoryTileGrid
          folder={folder}
          memories={byFolder.buckets[folder]}
          onBack={() => setFolder(null)}
          onOpen={setOpen}
        />
        <MemoryDialog memory={open} onClose={() => setOpen(null)} />
      </>
    );
  }

  return (
    <section className="flex h-full flex-col">
      <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest text-foreground">
        Memory <span className="text-foreground">{unique.length}</span>
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {DISPLAY_TYPES.map(({ type, label, blurb }) => {
          const count = byFolder.buckets[type].length;
          const active = byFolder.recent[type];
          const accent = TYPE_ACCENT[type];
          const dot = TYPE_DOT[type];
          const glyph = TYPE_GLYPH[type];
          const empty = count === 0;
          return (
            <button
              key={type}
              onClick={() => setFolder(type)}
              disabled={empty}
              className={`group relative flex h-full flex-col gap-2 rounded-md border bg-card/80 p-4 text-left transition ${
                empty
                  ? 'cursor-default border-border/20 opacity-60'
                  : 'border-border/40 hover:border-primary/40 hover:bg-accent/30'
              }`}
            >
              {active && (
                <span
                  className={`absolute right-3 top-3 h-1.5 w-1.5 rounded-full ${dot}`}
                  data-tooltip="Activity in the last 24h"
                  aria-label="Activity in the last 24h"
                />
              )}
              <div className="flex items-center gap-2">
                <span className={`font-mono text-base ${accent}`} aria-hidden>{glyph}</span>
                <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
                  {label}
                </span>
              </div>
              <div className={`font-mono text-2xl font-bold tabular-nums ${empty ? 'text-muted-foreground/40' : accent}`}>
                {count}
              </div>
              <div className="font-mono text-[10px] leading-snug text-muted-foreground/70">
                {blurb}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Heuristic "active in last 24h" check. Memories don't carry mtime through the
 * dashboard API, so we look at common frontmatter timestamp keys; if none
 * parse to a Date, we treat the memory as not-recent (no false positives).
 */
function isRecent(mem: MemoryFile, now: number): boolean {
  const fm = mem.frontmatter;
  if (!fm) return false;
  for (const key of ['timestamp', 'updated', 'updatedAt', 'modified', 'created', 'date']) {
    const v = fm[key];
    if (!v) continue;
    const t = new Date(v).getTime();
    if (!isNaN(t) && now - t <= DAY_MS) return true;
  }
  return false;
}
