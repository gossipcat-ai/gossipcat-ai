import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { TaskMemoryEntry, ArchivedTaskEntry } from './types';

export class MemoryCompactor {
  constructor(private projectRoot: string) {}

  calculateWarmth(importance: number, timestamp: string): number {
    const days = (Date.now() - new Date(timestamp).getTime()) / 86400000;
    return importance * (1 / (1 + days / 30));
  }

  compactIfNeeded(agentId: string, maxEntries: number = 20): { archived: number; message?: string } {
    const memDir = join(this.projectRoot, '.gossip', 'agents', agentId, 'memory');
    const tasksPath = join(memDir, 'tasks.jsonl');

    if (!existsSync(tasksPath)) return { archived: 0 };

    const lines = readFileSync(tasksPath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length <= maxEntries) return { archived: 0 };

    const entries: Array<{ entry: TaskMemoryEntry; warmth: number; line: string }> = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as TaskMemoryEntry;
        const warmth = this.calculateWarmth(entry.importance, entry.timestamp);
        entries.push({ entry, warmth, line });
      } catch { /* skip malformed */ }
    }

    entries.sort((a, b) => a.warmth - b.warmth);

    const toArchive = entries.slice(0, entries.length - maxEntries);
    const toKeep = entries.slice(entries.length - maxEntries);

    const archivePath = join(memDir, 'archive.jsonl');
    for (const item of toArchive) {
      const archived: ArchivedTaskEntry = {
        archivedAt: new Date().toISOString(),
        reason: 'warmth_below_threshold',
        warmth: item.warmth,
        entry: item.entry,
      };
      appendFileSync(archivePath, JSON.stringify(archived) + '\n');
    }

    writeFileSync(tasksPath, toKeep.map(e => e.line).join('\n') + '\n');

    return { archived: toArchive.length, message: `Compacted ${toArchive.length} memories for ${agentId}` };
  }
}
