import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { MemoryFile } from '@/lib/types';
import { DISPLAY_TYPES, toDisplayType, type DisplayType } from '@/lib/memory-taxonomy';
import { MemoryTileGrid } from './MemoryTileGrid';
import { MemoryDialog } from './MemoryDialog';

interface MemoryFoldersProps {
  memories: MemoryFile[];
}

/**
 * Per-folder accent — text color class applied to count + icon stroke.
 * Mirrors mockup lines 118-122 where each category owns a semantic color.
 */
const TYPE_ACCENT: Record<DisplayType, string> = {
  backlog: 'text-primary',
  record: 'text-text-dim',
  session: 'text-confirmed',
  rule: 'text-unverified',
};

/**
 * Activity-dot background + matching glow color. The glow (box-shadow) uses
 * the same hue at low alpha to mimic mockup line 152 (`0 0 8px primary-soft`).
 */
const TYPE_DOT: Record<DisplayType, { bg: string; glow: string }> = {
  backlog: { bg: 'bg-primary', glow: 'rgba(139, 92, 246, 0.6)' },
  record: { bg: 'bg-text-dim', glow: 'rgba(102, 102, 116, 0.55)' },
  session: { bg: 'bg-confirmed', glow: 'rgba(52, 211, 153, 0.55)' },
  rule: { bg: 'bg-unverified', glow: 'rgba(251, 191, 36, 0.55)' },
};

/**
 * Icon box tint — faint category background + soft ring. Keyed per folder so
 * each tile reads as its own "chapter" at a glance (mockup lines 117-122).
 */
const TYPE_ICON_BOX: Record<DisplayType, string> = {
  backlog: 'bg-primary/[0.06] border-primary/30',
  record: 'bg-text-dim/[0.08] border-text-dim/20',
  session: 'bg-confirmed/[0.06] border-confirmed/25',
  rule: 'bg-unverified/[0.06] border-unverified/25',
};

/**
 * SVG glyphs — inline paths adapted from the mockup. Each folder gets a shape
 * that matches its semantic role in the hybrid taxonomy spec:
 *   - backlog → folder (open work container)
 *   - record  → bookmark/book (archived reference)
 *   - session → clock (time-ordered recaps)
 *   - rule    → chat bubble (feedback / directives)
 */
const TYPE_ICON: Record<DisplayType, JSX.Element> = {
  backlog: (
    <path d="M20 7h-7L10.3 4.3A1 1 0 0 0 9.6 4H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
  ),
  record: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </>
  ),
  session: (
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>
  ),
  rule: (
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  ),
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Top-level "Memory" panel: 4 folder tiles (Backlog / Record / Session / Rule)
 * with counts and a recent-activity indicator. Clicking a folder drills into a
 * tile grid; clicking a tile opens the full memory in a dialog.
 *
 * Visual language follows docs/designs/memory-brain-v3.html (3-column tile
 * grid: icon | name+desc | count).
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
          const iconBox = TYPE_ICON_BOX[type];
          const empty = count === 0;
          return (
            <button
              key={type}
              onClick={() => setFolder(type)}
              disabled={empty}
              className={`group relative grid grid-cols-[auto_1fr_auto] grid-rows-[auto_auto] items-center gap-x-3 gap-y-1 rounded-md border bg-muted p-3.5 text-left transition ${
                empty
                  ? 'cursor-default border-border/20 opacity-55'
                  : 'border-border/40 hover:border-primary/30 hover:bg-accent/40'
              }`}
            >
              {active && (
                <span
                  className={`pointer-events-none absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full ${dot.bg}`}
                  style={{ boxShadow: `0 0 8px ${dot.glow}` }}
                  data-tooltip="Activity in the last 24h"
                  aria-label="Activity in the last 24h"
                />
              )}
              <span
                className={`row-span-2 flex h-9 w-9 items-center justify-center rounded-sm border ${iconBox} ${accent}`}
                aria-hidden
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {TYPE_ICON[type]}
                </svg>
              </span>
              <span className="self-end font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
                {label}
              </span>
              <span
                className={`row-span-2 self-center font-mono text-sm font-bold tabular-nums ${
                  empty ? 'text-muted-foreground/40' : accent
                }`}
              >
                {count}
              </span>
              <span className="self-start font-mono text-[10px] leading-snug text-muted-foreground/70">
                {blurb}
              </span>
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
