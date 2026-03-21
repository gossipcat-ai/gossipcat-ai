import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { TaskMemoryEntry } from './types';

const memoryLocks = new Map<string, Promise<void>>();

async function withMemoryLock(agentId: string, fn: () => Promise<void>): Promise<void> {
  const prev = memoryLocks.get(agentId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  memoryLocks.set(agentId, next);
  await next;
}

export class MemoryWriter {
  constructor(private projectRoot: string) {}

  private getMemDir(agentId: string): string {
    return join(this.projectRoot, '.gossip', 'agents', agentId, 'memory');
  }

  private ensureDirs(agentId: string): string {
    const memDir = this.getMemDir(agentId);
    mkdirSync(join(memDir, 'knowledge'), { recursive: true });
    mkdirSync(join(memDir, 'calibration'), { recursive: true });
    return memDir;
  }

  async writeTaskEntry(agentId: string, data: {
    taskId: string;
    task: string;
    skills: string[];
    scores: { relevance: number; accuracy: number; uniqueness: number };
    lens?: string;
    findings?: number;
  }): Promise<void> {
    const memDir = this.ensureDirs(agentId);
    const entry: TaskMemoryEntry = {
      version: 1,
      taskId: data.taskId,
      task: data.task.slice(0, 200),
      skills: data.skills,
      lens: data.lens,
      findings: data.findings ?? 0,
      hallucinated: 0,
      scores: data.scores,
      warmth: 1.0,
      importance: this.deriveImportance(data.scores),
      timestamp: new Date().toISOString(),
    };
    appendFileSync(join(memDir, 'tasks.jsonl'), JSON.stringify(entry) + '\n');
  }

  deriveImportance(scores: { relevance: number; accuracy: number; uniqueness: number }): number {
    return (scores.relevance + scores.accuracy + scores.uniqueness) / 15;
  }

  rebuildIndex(agentId: string): void {
    const memDir = this.getMemDir(agentId);
    const parts: string[] = [`# Agent Memory — ${agentId}\n`];

    const knowledgeDir = join(memDir, 'knowledge');
    if (existsSync(knowledgeDir)) {
      const files = readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
      if (files.length > 0) {
        parts.push('## Knowledge');
        for (const file of files) {
          const content = readFileSync(join(knowledgeDir, file), 'utf-8');
          const descMatch = content.match(/description:\s*(.+)/);
          const desc = descMatch ? descMatch[1].trim() : file.replace('.md', '');
          parts.push(`- [${file.replace('.md', '')}](knowledge/${file}) — ${desc}`);
        }
        parts.push('');
      }
    }

    const calPath = join(memDir, 'calibration', 'accuracy.md');
    if (existsSync(calPath)) {
      const content = readFileSync(calPath, 'utf-8');
      const descMatch = content.match(/description:\s*(.+)/);
      parts.push('## Calibration');
      parts.push(`- [accuracy](calibration/accuracy.md) — ${descMatch ? descMatch[1].trim() : 'accuracy data'}`);
      parts.push('');
    }

    const tasksPath = join(memDir, 'tasks.jsonl');
    if (existsSync(tasksPath)) {
      const lines = readFileSync(tasksPath, 'utf-8').trim().split('\n').filter(Boolean);
      const recent = lines.slice(-5).reverse();
      if (recent.length > 0) {
        parts.push('## Recent Tasks');
        for (const line of recent) {
          try {
            const entry = JSON.parse(line) as TaskMemoryEntry;
            const date = entry.timestamp.split('T')[0];
            parts.push(`- ${date}: ${entry.task}`);
          } catch { /* skip malformed */ }
        }
        parts.push('');
      }
    }

    writeFileSync(join(memDir, 'MEMORY.md'), parts.join('\n'));
  }

  async writeKnowledge(agentId: string, filename: string, content: string): Promise<void> {
    await withMemoryLock(agentId, async () => {
      const memDir = this.ensureDirs(agentId);
      writeFileSync(join(memDir, 'knowledge', filename), content);
      this.rebuildIndex(agentId);
    });
  }
}
