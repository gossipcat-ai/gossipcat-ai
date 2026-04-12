import { useState } from 'react';
import type { MemoryFile } from '@/lib/types';
import { EmptyState } from './EmptyState';

interface RecentMemoriesProps {
  memories: MemoryFile[];
}

function inferType(memory: MemoryFile): string {
  const fm = memory.frontmatter?.type;
  if (fm && fm !== 'unknown') return fm;

  const searchText = [
    memory.filename,
    memory.frontmatter?.name || '',
    memory.frontmatter?.description || '',
    memory.content.slice(0, 200),
  ].join(' ').toLowerCase();

  if (searchText.includes('session') || searchText.includes('next-session')) return 'session';
  if (searchText.includes('cognitive') || searchText.includes('session-gossip')) return 'cognitive';
  if (searchText.includes('skill') || searchText.includes('gap')) return 'skill';
  if (searchText.includes('consensus') || searchText.includes('finding') || searchText.includes('review') || searchText.includes('cross-review')) return 'review';
  if (searchText.includes('dispatch') || searchText.includes('implement')) return 'task';
  if (searchText.includes('design') || searchText.includes('architecture')) return 'review';
  if (searchText.includes('bug') || searchText.includes('fix') || searchText.includes('debug')) return 'task';
  if (memory.frontmatter?.name) return 'knowledge';

  return 'note';
}

// Neutral-first: only `session` and `skill` get color because they map to
// meaningful quality signals (a session memory is a review artifact; a skill
// memory is a capability delta). Everything else reads as neutral text so the
// list stops looking like a bag of skittles. User feedback: "too colorful" —
// type labels are text, they don't need color to be legible.
const TYPE_COLORS: Record<string, string> = {
  cognitive: 'text-muted-foreground bg-muted/40',
  knowledge: 'text-muted-foreground bg-muted/40',
  skill: 'text-confirmed bg-confirmed/10',
  review: 'text-muted-foreground bg-muted/40',
  task: 'text-muted-foreground bg-muted/40',
  session: 'text-primary bg-primary/10',
  note: 'text-muted-foreground bg-muted/40',
};

const TYPE_LABEL: Record<string, string> = {
  cognitive: 'cognitive',
  knowledge: 'knowledge',
  skill: 'skill',
  review: 'review',
  task: 'task',
  session: 'session',
  note: 'memory',
};

export function RecentMemories({ memories }: RecentMemoriesProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const unique = memories.filter((m, i, arr) =>
    arr.findIndex(x => x.filename === m.filename) === i
  );
  const display = unique.slice(0, 8);

  return (
    <section className="flex h-full flex-col">
      <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest text-foreground">
        Recent Memories <span className="text-foreground">{unique.length}</span>
      </h2>
      {display.length === 0 ? (
        <div className="flex-1">
          <EmptyState
            title="No memories yet"
            hint="Memories populate after gossip_session_save() or consensus rounds."
          />
        </div>
      ) : (
        <div className="flex-1 rounded-md border border-border/40 bg-card/80">
          {display.map((mem, i) => {
            const type = inferType(mem);
            const name = mem.frontmatter?.name || mem.content.split('\n')[0]?.slice(0, 80) || mem.filename.replace(/\.md$/, '');
            const isOpen = expandedIdx === i;
            const agent = mem.agentId || '_unknown';

            return (
              <div key={mem.filename} className={i > 0 ? 'border-t border-border/20' : ''}>
                <button
                  onClick={() => setExpandedIdx(isOpen ? null : i)}
                  className="flex h-11 w-full items-center gap-2 px-3.5 text-left transition hover:bg-accent/50"
                >
                  <span className={`font-mono text-xs ${isOpen ? 'text-primary' : 'text-muted-foreground/40'}`}>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span className={`shrink-0 rounded-sm border border-border/30 px-1 py-0.5 font-mono text-[10px] font-bold ${TYPE_COLORS[type] || TYPE_COLORS.note}`}>
                    {TYPE_LABEL[type] || 'NOTE'}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {name}
                  </span>
                  <span className="shrink-0 rounded-sm border border-border/40 bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {agent === '_project' ? 'project' : agent}
                  </span>
                </button>
                {isOpen && (
                  <div className="border-t border-border/10 px-4 py-2">
                    <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground" style={{ fontFamily: "'Inter', sans-serif" }}>
                      {mem.content}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
