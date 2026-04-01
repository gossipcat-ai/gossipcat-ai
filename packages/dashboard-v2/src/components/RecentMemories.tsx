import type { MemoryFile } from '@/lib/types';
import { MemoryCard } from './MemoryCard';

interface RecentMemoriesProps {
  memories: MemoryFile[];
}

export function RecentMemories({ memories }: RecentMemoriesProps) {
  return (
    <section>
      <h2 className="mb-4 font-mono text-xs font-bold uppercase tracking-widest text-foreground">
        Recent Memories <span className="text-primary">{memories.length}</span>
      </h2>
      <div className="grid grid-cols-2 gap-2">
        {memories.map((m, i) => (
          <MemoryCard key={m.filename + i} memory={m} />
        ))}
      </div>
      {memories.length === 0 && (
        <div className="py-8 text-center text-sm text-muted-foreground">No memories yet.</div>
      )}
    </section>
  );
}
