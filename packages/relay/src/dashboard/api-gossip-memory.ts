import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from './api-native-memory';

/**
 * Gossip-memory API — exposes gossipcat's canonical, dashboard-visible memory
 * store at `.gossip/memory/` (inside the project). Gossipcat owns the write
 * side (see memory-writer.ts `prepareSessionArtifacts*`); Claude Code never
 * writes here. Separate from api-native-memory.ts (Claude Code's auto-memory)
 * and api-memory.ts (per-agent cognitive memory under .gossip/agents/*).
 *
 * Contrast:
 *   - Native memory  → `~/.claude/projects/-<cwd>/memory/` (CC-owned, flat list)
 *   - Gossip memory  → `<projectRoot>/.gossip/memory/`    (gossipcat-owned, 4-folder taxonomy)
 *
 * The dashboard consumes this endpoint via `useDashboardData.gossipMemories`
 * and renders it with the 4-folder taxonomy (backlog / record / session / rule)
 * mapped by `memory-taxonomy.ts`. Dashboard must NEVER merge native + gossip
 * arrays — separation is an invariant (see spec risk matrix).
 *
 * Route: GET /dashboard/api/gossip-memory
 * Spec: docs/specs/2026-04-15-session-save-native-vs-gossip-memory.md
 */

const FILENAME_RE = /^[A-Za-z0-9_.-]+\.md$/;

interface KnowledgeFile {
  filename: string;
  frontmatter: Record<string, string>;
  content: string;
  agentId?: string;
}

export interface GossipMemoryResponse {
  knowledge: KnowledgeFile[];
}

/** Resolve the `.gossip/memory/` directory for `projectRoot`. */
export function gossipMemoryDir(projectRoot: string): string {
  return join(projectRoot, '.gossip', 'memory');
}

/**
 * Read every `.md` file under `.gossip/memory/` and return the parsed
 * frontmatter + body. Unreadable or malformed files are skipped silently —
 * one bad file must not take down the dashboard. Filename allowlist enforced
 * to block traversal and non-markdown artifacts.
 */
export async function gossipMemoryHandler(projectRoot: string): Promise<GossipMemoryResponse> {
  const dir = gossipMemoryDir(projectRoot);
  if (!existsSync(dir)) return { knowledge: [] };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { knowledge: [] };
  }

  const knowledge: KnowledgeFile[] = [];
  for (const filename of entries) {
    if (!FILENAME_RE.test(filename)) continue;
    const full = join(dir, filename);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      const raw = readFileSync(full, 'utf-8');
      const { frontmatter, content } = parseFrontmatter(raw);
      knowledge.push({ filename, frontmatter, content, agentId: '_gossip' });
    } catch {
      // Skip unreadable files silently — dashboard should not fail because of one bad entry.
    }
  }

  return { knowledge };
}
