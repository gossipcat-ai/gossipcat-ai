import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, openSync, closeSync, constants } from 'fs';
import { join } from 'path';
import { TaskMemoryEntry, ArchivedTaskEntry } from './types';

const MAX_ARCHIVE_LINES = 5000;

export class MemoryCompactor {
  constructor(private projectRoot: string) {}

  calculateWarmth(importance: number, timestamp: string): number {
    const raw = (Date.now() - new Date(timestamp).getTime()) / 86400000;
    const days = Math.max(0, raw); // Clamp: future timestamps don't produce Infinity/negative
    return (importance ?? 0.5) * (1 / (1 + days / 30)); // Default importance if missing
  }

  compactIfNeeded(agentId: string, maxEntries: number = 20): { archived: number; dropped?: number; message?: string } {
    if (!agentId || agentId === '.' || agentId === '..' || agentId.includes('/') || agentId.includes('\\') || agentId.includes('\0')) {
      return { archived: 0, message: `Invalid agentId: ${agentId.slice(0, 50)}` };
    }
    const memDir = join(this.projectRoot, '.gossip', 'agents', agentId, 'memory');
    const tasksPath = join(memDir, 'tasks.jsonl');
    const lockPath = join(memDir, 'tasks.jsonl.lock');

    if (!existsSync(tasksPath)) return { archived: 0 };

    // Lock to prevent race condition with concurrent MemoryWriter.writeTaskEntry
    if (existsSync(lockPath)) {
      // Expire stale locks older than 60 seconds (process crash recovery)
      try {
        const lockTs = parseInt(readFileSync(lockPath, 'utf-8'), 10);
        if (!Number.isNaN(lockTs) && (Date.now() - lockTs) < 60000) return { archived: 0 }; // lock is fresh, respect it
        unlinkSync(lockPath); // stale or malformed lock, remove and proceed
      } catch {
        try { unlinkSync(lockPath); } catch { return { archived: 0 }; }
      }
    }
    // Atomic lock acquisition: O_EXCL fails if file already exists (prevents TOCTOU race)
    try {
      const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      writeFileSync(fd, `${Date.now()}`);
      closeSync(fd);
    } catch { return { archived: 0 }; }

    try {
      const lines = readFileSync(tasksPath, 'utf-8').trim().split('\n').filter(Boolean);
      if (lines.length <= maxEntries) return { archived: 0 };

      const entries: Array<{ entry: TaskMemoryEntry; warmth: number; line: string; idx: number }> = [];
      let dropped = 0;
      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]) as TaskMemoryEntry;
          const warmth = this.calculateWarmth(entry.importance, entry.timestamp);
          entries.push({ entry, warmth, line: lines[i], idx: i });
        } catch { dropped++; }
      }

      entries.sort((a, b) => a.warmth - b.warmth);

      const toArchive = entries.slice(0, entries.length - maxEntries);
      const toKeep = entries.slice(entries.length - maxEntries);
      // Restore chronological order so rebuildIndex reads most recent tasks last
      toKeep.sort((a, b) => a.idx - b.idx);

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

      // Truncate archive if too large
      try {
        if (existsSync(archivePath)) {
          const archiveLines = readFileSync(archivePath, 'utf-8').trim().split('\n');
          if (archiveLines.length > MAX_ARCHIVE_LINES) {
            writeFileSync(archivePath, archiveLines.slice(-MAX_ARCHIVE_LINES).join('\n') + '\n');
          }
        }
      } catch (err) {
        process.stderr.write(`[memory-compactor] archive truncation failed for ${agentId}: ${(err as Error).message}\n`);
      }

      writeFileSync(tasksPath, toKeep.map(e => e.line).join('\n') + '\n');

      return { archived: toArchive.length, dropped: dropped || undefined, message: `Compacted ${toArchive.length} memories for ${agentId}${dropped ? ` (${dropped} malformed lines dropped)` : ''}` };
    } finally {
      // Always release lock
      try { unlinkSync(lockPath); } catch { /* already deleted */ }
    }
  }
}
