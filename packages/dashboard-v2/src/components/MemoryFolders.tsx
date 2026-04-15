import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { MemoryFile } from '@/lib/types';
import { DISPLAY_TYPES, toDisplayType, type DisplayType } from '@/lib/memory-taxonomy';
import { MemoryTileGrid } from './MemoryTileGrid';
import { MemoryDialog } from './MemoryDialog';

interface MemoryFoldersProps {
  memories: MemoryFile[];
  /**
   * Section heading override. Defaults to "Memory" for backward-compat with
   * the pre-split single-section layout; pass "Gossip Memory" when rendering
   * the `.gossip/memory/` store alongside a sibling `<NativeMemories>` block.
   */
  heading?: string;
  /**
   * When true, show an additional status-based filter (open / shipped / all).
   * Used by the gossip-memory view per the native-vs-gossip separation spec.
   * Native memories don't carry a canonical `status` field, so the filter is
   * off by default.
   */
  statusFilter?: boolean;
}

/** Status values that count as "shipped/closed" in the status filter. */
const SHIPPED_STATUSES = new Set(['shipped', 'closed']);
type StatusFilter = 'all' | 'open' | 'shipped';

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
export function MemoryFolders({ memories, heading = 'Memory', statusFilter = false }: MemoryFoldersProps) {
  const [folder, setFolder] = useState<DisplayType | null>(null);
  const [open, setOpen] = useState<MemoryFile | null>(null);
  const [statusView, setStatusView] = useState<StatusFilter>('all');

  // De-dupe by filename: the same file can be returned for both its agent and
  // _project when an agent shares it.
  const unique = useMemo(
    () => memories.filter((m, i, arr) => arr.findIndex((x) => x.filename === m.filename) === i),
    [memories],
  );

  // Apply status filter (gossip-memory only). Native store doesn't carry status
  // consistently, so we only filter when the caller opts in.
  const filtered = useMemo(() => {
    if (!statusFilter || statusView === 'all') return unique;
    return unique.filter((m) => {
      const s = (m.frontmatter?.status || '').toLowerCase();
      if (statusView === 'shipped') return SHIPPED_STATUSES.has(s);
      // 'open' means explicitly open OR missing — missing status is treated as
      // open backlog per the memory-taxonomy default-to-backlog rule.
      return s === 'open' || !s;
    });
  }, [unique, statusFilter, statusView]);

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
    for (const m of filtered) {
      const t = toDisplayType(m);
      buckets[t].push(m);
      if (!recent[t] && isRecent(m, now)) recent[t] = true;
    }
    return { buckets, recent };
  }, [filtered]);

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
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          {heading} <span className="text-primary">{filtered.length}</span>
        </h2>
        {statusFilter && (
          <div className="flex gap-1 font-mono text-[10px]" role="tablist" aria-label="Status filter">
            {(['all', 'open', 'shipped'] as const).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={statusView === s}
                onClick={() => setStatusView(s)}
                className={`rounded-sm border px-2 py-0.5 uppercase tracking-widest transition ${
                  statusView === s
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border/30 text-muted-foreground hover:border-primary/30 hover:text-foreground'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
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
  // lastAccessed is the canonical gossip-memory freshness key (see
  // memory-writer.ts frontmatter schema); updated is included as a duplicate
  // for the native store's "updated" convention. The extra keys stay for
  // defensive parsing across both stores.
  for (const key of ['lastAccessed', 'updated', 'timestamp', 'updatedAt', 'modified', 'created', 'date']) {
    const v = fm[key];
    if (!v) continue;
    const t = new Date(v).getTime();
    if (!isNaN(t) && now - t <= DAY_MS) return true;
  }
  return false;
}

/**
 * Gossip-memory wrapper — 4-folder taxonomy with status filter. Used to render
 * `.gossip/memory/` entries alongside `<NativeMemories>` in the dashboard per
 * docs/specs/2026-04-15-session-save-native-vs-gossip-memory.md.
 */
export function GossipMemories({ memories }: { memories: MemoryFile[] }) {
  return <MemoryFolders memories={memories} heading="Gossip Memory" statusFilter />;
}

/**
 * Native-memory wrapper — flat list view of Claude Code's auto-memory. No
 * taxonomy, no status filter (Claude Code doesn't write a canonical status).
 * The separation invariant (spec risk matrix) forbids merging native + gossip
 * arrays; render them as two distinct sections.
 */
export function NativeMemories({ memories }: { memories: MemoryFile[] }) {
  const [open, setOpen] = useState<MemoryFile | null>(null);
  const unique = useMemo(
    () => memories.filter((m, i, arr) => arr.findIndex((x) => x.filename === m.filename) === i),
    [memories],
  );
  const now = Date.now();

  return (
    <section className="flex h-full flex-col">
      <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest text-foreground">
        Native Memory <span className="text-primary">{unique.length}</span>
      </h2>
      {unique.length === 0 ? (
        <p className="font-mono text-[11px] text-muted-foreground">No native memories yet.</p>
      ) : (
        <ul className="space-y-1 font-mono text-[11px]">
          {unique.slice(0, 20).map((m) => {
            const recent = isRecent(m, now);
            const desc = m.frontmatter?.description || m.frontmatter?.name || '';
            return (
              <li key={m.filename}>
                <button
                  onClick={() => setOpen(m)}
                  className="flex w-full items-center justify-between gap-3 rounded-sm border border-border/20 bg-muted/40 px-3 py-2 text-left transition hover:border-primary/30 hover:bg-accent/40"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {recent && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                        style={{ boxShadow: '0 0 8px rgba(139, 92, 246, 0.6)' }}
                        aria-label="Activity in the last 24h"
                      />
                    )}
                    <span className="truncate text-foreground">{m.filename}</span>
                  </span>
                  {desc && <span className="shrink-0 truncate text-muted-foreground/80">{desc.slice(0, 60)}</span>}
                </button>
              </li>
            );
          })}
          {unique.length > 20 && (
            <li className="pl-3 text-[10px] text-muted-foreground">… and {unique.length - 20} more</li>
          )}
        </ul>
      )}
      <MemoryDialog memory={open} onClose={() => setOpen(null)} />
    </section>
  );
}
