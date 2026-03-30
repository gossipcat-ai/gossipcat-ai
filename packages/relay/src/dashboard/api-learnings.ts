import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

interface Learning {
  agentId: string;
  filename: string;
  description: string;
  type: string;
  mtime: number;
}

export interface LearningsResponse {
  learnings: Learning[];
}

const MAX_LEARNINGS = 10;

export async function learningsHandler(projectRoot: string): Promise<LearningsResponse> {
  const agentsDir = join(projectRoot, '.gossip', 'agents');
  if (!existsSync(agentsDir)) return { learnings: [] };

  const all: Learning[] = [];

  let agentIds: string[];
  try { agentIds = readdirSync(agentsDir).filter(f => !f.startsWith('.')); }
  catch { return { learnings: [] }; }

  for (const agentId of agentIds) {
    const knowledgeDir = join(agentsDir, agentId, 'memory', 'knowledge');
    if (!existsSync(knowledgeDir)) continue;

    let files: string[];
    try { files = readdirSync(knowledgeDir).filter(f => f.endsWith('.md')); }
    catch { continue; }

    for (const filename of files) {
      const filepath = join(knowledgeDir, filename);
      try {
        const stat = statSync(filepath);
        const raw = readFileSync(filepath, 'utf-8');
        const fm = parseFrontmatter(raw);
        all.push({
          agentId,
          filename,
          description: fm.description || fm.name || filename.replace('.md', ''),
          type: fm.type || 'knowledge',
          mtime: stat.mtimeMs,
        });
      } catch { /* skip */ }
    }
  }

  all.sort((a, b) => b.mtime - a.mtime);
  return { learnings: all.slice(0, MAX_LEARNINGS) };
}

function parseFrontmatter(raw: string): Record<string, string> {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('---', 3);
  if (end === -1) return {};
  const fm: Record<string, string> = {};
  for (const line of raw.slice(3, end).trim().split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fm;
}
