import { useState } from 'react';
import type { MemoryFile } from '@/lib/types';

interface MemoryCardProps {
  memory: MemoryFile;
}

function inferType(memory: MemoryFile): string {
  const fm = memory.frontmatter?.type;
  if (fm && fm !== 'unknown') return fm;
  const f = memory.filename.toLowerCase();
  if (f.includes('cognitive') || f.includes('session-gossip')) return 'cognitive';
  if (f.includes('skill') || f.includes('gap')) return 'skill';
  if (f.includes('task') || f.includes('dispatch')) return 'task';
  if (f.includes('finding') || f.includes('consensus') || f.includes('review')) return 'review';
  if (f.includes('memory') || f.includes('knowledge')) return 'memory';
  const c = memory.content.toLowerCase();
  if (c.includes('peer findings') || c.includes('consensus review')) return 'review';
  if (c.includes('technology:') || c.includes('files:')) return 'task';
  return 'memory';
}

const typeColors: Record<string, string> = {
  cognitive: 'text-primary border-primary/30 bg-primary/5',
  skill: 'text-confirmed border-confirmed/30 bg-confirmed/5',
  session: 'text-unverified border-unverified/30 bg-unverified/5',
  review: 'text-unique border-unique/30 bg-unique/5',
  task: 'text-unverified border-unverified/30 bg-unverified/5',
  memory: 'text-muted-foreground border-border bg-muted/50',
};

export function MemoryCard({ memory }: MemoryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const type = inferType(memory);
  const name = memory.frontmatter?.name ?? memory.filename.replace(/\.md$/, '');

  return (
    <button
      onClick={() => setExpanded(!expanded)}
      className="w-full rounded-md border border-border bg-card p-3 text-left transition hover:border-primary/20"
    >
      <div className="flex items-center gap-2">
        <span className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${typeColors[type] ?? typeColors.memory}`}>
          {type}
        </span>
        <span className="truncate font-mono text-xs font-semibold text-foreground">{name}</span>
      </div>
      {expanded && (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {memory.content}
        </p>
      )}
    </button>
  );
}
