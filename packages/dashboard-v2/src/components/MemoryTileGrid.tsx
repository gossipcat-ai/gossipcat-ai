import { useMemo } from 'react';
import type { MemoryFile } from '@/lib/types';
import { DISPLAY_TYPES, type DisplayType } from '@/lib/memory-taxonomy';
import { timeAgo } from '@/lib/utils';
import { EmptyState } from './EmptyState';

interface MemoryTileGridProps {
  folder: DisplayType;
  memories: MemoryFile[];
  onBack: () => void;
  onOpen: (memory: MemoryFile) => void;
}

const TYPE_ACCENT: Record<DisplayType, string> = {
  backlog: 'text-primary',
  record: 'text-text-dim',
  session: 'text-confirmed',
  rule: 'text-unverified',
};

const TYPE_TAG_RING: Record<DisplayType, string> = {
  backlog: 'border-primary/30 bg-primary/[0.06]',
  record: 'border-text-dim/30 bg-text-dim/[0.08]',
  session: 'border-confirmed/30 bg-confirmed/[0.06]',
  rule: 'border-unverified/30 bg-unverified/[0.06]',
};

/**
 * Drilled-in folder view. Shows a breadcrumb back to "Memory" and a grid of
 * memory tiles for the selected folder.
 *
 * Tile layout (mockup lines 204-224):
 *   [ tag ]              ← own line, colored pill
 *   Title text...        ← two-line clamp
 *   context     2h ago   ← mono meta row
 */
export function MemoryTileGrid({ folder, memories, onBack, onOpen }: MemoryTileGridProps) {
  const meta = DISPLAY_TYPES.find((d) => d.type === folder)!;
  const accent = TYPE_ACCENT[folder];
  const tagRing = TYPE_TAG_RING[folder];

  const sorted = useMemo(
    () => [...memories].sort((a, b) => (a.filename < b.filename ? 1 : -1)),
    [memories],
  );

  return (
    <section className="flex h-full flex-col">
      {/* Breadcrumb */}
      <div className="mb-3 flex items-center gap-2 font-mono text-xs">
        <button
          onClick={onBack}
          className="font-bold uppercase tracking-widest text-muted-foreground transition hover:text-primary"
        >
          Memory
        </button>
        <span className="text-muted-foreground/40">›</span>
        <span className={`font-bold uppercase tracking-widest ${accent}`}>{meta.label}</span>
        <span className="ml-1 text-muted-foreground/60">{sorted.length}</span>
      </div>

      {sorted.length === 0 ? (
        <div className="flex-1">
          <EmptyState
            title={`No ${meta.label.toLowerCase()} memories`}
            hint={meta.blurb}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {sorted.map((mem) => {
            const title = titleOf(mem);
            const context = contextOf(mem);
            const ts = pickTimestamp(mem.frontmatter);
            return (
              <button
                key={`${mem.agentId || ''}/${mem.filename}`}
                onClick={() => onOpen(mem)}
                className="group flex flex-col gap-1.5 rounded-md border border-border/40 bg-muted p-3 text-left transition hover:border-primary/30 hover:bg-accent/40"
              >
                <span
                  className={`inline-block w-fit rounded-sm border px-1.5 py-[1px] font-mono text-[9px] font-bold uppercase tracking-[0.14em] ${tagRing} ${accent}`}
                >
                  {meta.label}
                </span>
                <span
                  className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground group-hover:text-primary"
                >
                  {title}
                </span>
                <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground/70">
                  <span className="min-w-0 truncate">{context}</span>
                  {ts && <span className="shrink-0">{timeAgo(ts)}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Best-effort title for a memory tile. Prefers an explicit `name` field in
 * frontmatter, then the first markdown heading, then a stripped filename.
 */
function titleOf(mem: MemoryFile): string {
  const fmName = mem.frontmatter?.name;
  if (fmName) return fmName;
  const firstLine = mem.content.split('\n').find((l) => l.trim().length > 0);
  if (firstLine) {
    const stripped = firstLine.replace(/^#+\s*/, '').trim();
    if (stripped) return stripped.slice(0, 80);
  }
  return mem.filename.replace(/\.md$/, '');
}

/**
 * Left-side meta cell: prefer the filename (stable author-chosen identifier)
 * and fall back to owner. Gives each tile a grep-able anchor without the
 * redundant "project" badge that used to live on the right.
 */
function contextOf(mem: MemoryFile): string {
  const fname = mem.filename.replace(/\.md$/, '');
  if (fname) return fname;
  return mem.agentId === '_project' ? 'project' : mem.agentId || 'unknown';
}

/**
 * Pull the most likely timestamp from frontmatter. Memory files don't carry
 * mtime through the dashboard API, so we fall back to common frontmatter keys
 * authors actually use; returns undefined if none parse to a real Date.
 */
function pickTimestamp(fm?: Record<string, string>): string | undefined {
  if (!fm) return undefined;
  for (const key of ['timestamp', 'updated', 'updatedAt', 'modified', 'created', 'date']) {
    const v = fm[key];
    if (v && !isNaN(new Date(v).getTime())) return v;
  }
  return undefined;
}
