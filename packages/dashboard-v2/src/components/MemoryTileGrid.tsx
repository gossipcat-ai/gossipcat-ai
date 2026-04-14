import { useMemo } from 'react';
import type { MemoryFile } from '@/lib/types';
import { DISPLAY_TYPES, type DisplayType } from '@/lib/memory-taxonomy';
import { EmptyState } from './EmptyState';

interface MemoryTileGridProps {
  folder: DisplayType;
  memories: MemoryFile[];
  onBack: () => void;
  onOpen: (memory: MemoryFile) => void;
}

const TYPE_ACCENT: Record<DisplayType, string> = {
  backlog: 'text-primary',
  record: 'text-confirmed',
  session: 'text-unverified',
  rule: 'text-unique',
};

/**
 * Drilled-in folder view. Shows a breadcrumb back to "Memory" and a grid of
 * memory tiles for the selected folder.
 */
export function MemoryTileGrid({ folder, memories, onBack, onOpen }: MemoryTileGridProps) {
  const meta = DISPLAY_TYPES.find((d) => d.type === folder)!;
  const accent = TYPE_ACCENT[folder];

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
            const owner = mem.agentId === '_project' ? 'project' : mem.agentId || 'unknown';
            return (
              <button
                key={`${mem.agentId || ''}/${mem.filename}`}
                onClick={() => onOpen(mem)}
                className="group flex flex-col gap-1 rounded-md border border-border/40 bg-card/80 p-3 text-left transition hover:border-primary/40 hover:bg-accent/30"
              >
                <div className="flex items-center gap-2">
                  <span className={`shrink-0 rounded-sm border border-border/30 px-1 py-0.5 font-mono text-[9px] font-bold uppercase ${accent}`}>
                    {meta.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-foreground group-hover:text-primary">
                    {title}
                  </span>
                </div>
                <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground/60">
                  <span className="truncate">{mem.filename}</span>
                  <span className="shrink-0 rounded-sm border border-border/40 bg-card px-1.5 py-0.5 text-muted-foreground">
                    {owner}
                  </span>
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
