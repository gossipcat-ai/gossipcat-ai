import { useState } from 'react';
import type { MemoryFile } from '@/lib/types';

interface MemoryCardProps {
  memory: MemoryFile;
}

export function MemoryCard({ memory }: MemoryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const type = memory.frontmatter?.type ?? 'unknown';
  const name = memory.frontmatter?.name ?? memory.filename;
  const preview = memory.content.split('\n').slice(0, 3).join('\n');

  const typeColors: Record<string, string> = {
    cognitive: 'text-primary border-primary/30 bg-primary/5',
    skill: 'text-confirmed border-confirmed/30 bg-confirmed/5',
    session: 'text-unverified border-unverified/30 bg-unverified/5',
    unknown: 'text-muted-foreground border-border bg-card',
  };

  return (
    <button
      onClick={() => setExpanded(!expanded)}
      className="w-full rounded-md border border-border bg-card p-3 text-left transition hover:border-primary/20"
    >
      <div className="flex items-center gap-2">
        <span className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${typeColors[type] ?? typeColors.unknown}`}>
          {type}
        </span>
        <span className="font-mono text-xs font-semibold text-foreground">{name}</span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
        {expanded ? memory.content : preview}
        {!expanded && memory.content.split('\n').length > 3 && '...'}
      </p>
    </button>
  );
}
