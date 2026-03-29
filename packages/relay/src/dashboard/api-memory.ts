import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const DANGEROUS_IDS = new Set(['__proto__', 'constructor', 'prototype']);

interface KnowledgeFile { filename: string; frontmatter: Record<string, string>; content: string; }
export interface MemoryResponse { index: string; knowledge: KnowledgeFile[]; tasks: Record<string, unknown>[]; }

export async function memoryHandler(projectRoot: string, agentId: string): Promise<MemoryResponse> {
  if (!agentId || !AGENT_ID_RE.test(agentId) || DANGEROUS_IDS.has(agentId)) throw new Error('Invalid agent ID');
  const memDir = join(projectRoot, '.gossip', 'agents', agentId, 'memory');

  let index = '';
  const indexPath = join(memDir, 'MEMORY.md');
  if (existsSync(indexPath)) { try { index = readFileSync(indexPath, 'utf-8'); } catch {} }

  const knowledge: KnowledgeFile[] = [];
  // Knowledge files live in memory/knowledge/ subdirectory
  const knowledgeDir = join(memDir, 'knowledge');
  const knowledgeDirs = [knowledgeDir, memDir]; // check subdirectory first, fallback to root
  for (const dir of knowledgeDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
      for (const filename of files) {
        try {
          const raw = readFileSync(join(dir, filename), 'utf-8');
          const { frontmatter, content } = parseFrontmatter(raw);
          knowledge.push({ filename, frontmatter, content });
        } catch {}
      }
    } catch {}
  }

  const tasks: Record<string, unknown>[] = [];
  const tasksPath = join(memDir, 'tasks.jsonl');
  if (existsSync(tasksPath)) {
    try {
      const lines = readFileSync(tasksPath, 'utf-8').trim().split('\n').filter(Boolean).slice(-200);
      for (const line of lines) { try { tasks.push(JSON.parse(line)); } catch {} }
    } catch {}
  }

  return { index, knowledge, tasks };
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; content: string } {
  if (!raw.startsWith('---')) return { frontmatter: {}, content: raw };
  const end = raw.indexOf('---', 3);
  if (end === -1) return { frontmatter: {}, content: raw };
  const fm: Record<string, string> = {};
  const fmBlock = raw.slice(3, end).trim();
  for (const line of fmBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { frontmatter: fm, content: raw.slice(end + 3).trim() };
}
