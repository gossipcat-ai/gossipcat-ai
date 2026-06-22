import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Native memory API — exposes Claude Code's project-scoped auto-memory directory
 * (`~/.claude/projects/-<encoded-cwd>/memory/`). "Native" because Claude Code
 * owns the write side (append-only from gossipcat's view); gossipcat never
 * writes here. Separate from api-memory.ts (per-agent cognitive memory under
 * .gossip/agents/*) and api-gossip-memory.ts (the canonical .gossip/memory/
 * store written by gossipcat's session-save pipeline).
 *
 * Claude Code encodes the absolute cwd by replacing every `/` with `-`. The
 * directory path is derived from `projectRoot` at request time so it follows
 * the user's project, not a hardcoded path.
 *
 * Route: GET /dashboard/api/native-memory (canonical), /dashboard/api/auto-memory (legacy alias).
 * Spec: docs/specs/2026-04-15-session-save-native-vs-gossip-memory.md
 */

const FILENAME_RE = /^[A-Za-z0-9_.-]+\.md$/;

interface KnowledgeFile {
  filename: string;
  frontmatter: Record<string, string>;
  content: string;
  agentId?: string;
}

export interface AutoMemoryResponse {
  knowledge: KnowledgeFile[];
}

/** Canonical alias for AutoMemoryResponse (same shape, clearer name). */
export type NativeMemoryResponse = AutoMemoryResponse;

/** Resolve the Claude Code auto-memory directory for `projectRoot`.
 *  Claude Code replaces every `/` in the absolute cwd with `-`. Because
 *  absolute POSIX paths start with `/`, the result naturally begins with `-`
 *  (e.g. `/Users/goku/Desktop/gossip` → `-Users-goku-Desktop-gossip`). Do NOT
 *  prepend an extra `-` — that would produce `--Users-...` and miss the dir.
 *  `home` is injectable for tests; production callers omit it and we fall back
 *  to `os.homedir()`. */
export function autoMemoryDir(projectRoot: string, home?: string): string {
  const h = home ?? homedir();
  return join(h, '.claude', 'projects', projectRoot.replaceAll('/', '-'), 'memory');
}

export async function autoMemoryHandler(projectRoot: string, home?: string): Promise<AutoMemoryResponse> {
  const dir = autoMemoryDir(projectRoot, home);
  if (!existsSync(dir)) return { knowledge: [] };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { knowledge: [] };
  }

  const knowledge: KnowledgeFile[] = [];
  for (const filename of entries) {
    // Security: strict allowlist — no traversal, no slashes, must end in .md
    if (!FILENAME_RE.test(filename)) continue;
    const full = join(dir, filename);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      const raw = readFileSync(full, 'utf-8');
      const { frontmatter, content } = parseFrontmatter(raw);
      knowledge.push({ filename, frontmatter, content, agentId: '_auto' });
    } catch {
      // Skip unreadable files silently — dashboard should not fail because of
      // one bad entry.
    }
  }

  return { knowledge };
}

export function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; content: string } {
  if (!raw.startsWith('---')) return { frontmatter: {}, content: raw };
  // Frontmatter delimiter is `---` on its own line. Search from position 3 for
  // the next `---` occurrence to locate the closing fence.
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, content: raw };
  const fm: Record<string, string> = {};
  const fmBlock = raw.slice(3, end).trim();
  for (const line of fmBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  // Skip the closing `\n---` (4 chars) plus an optional trailing newline.
  let rest = raw.slice(end + 4);
  if (rest.startsWith('\n')) rest = rest.slice(1);
  return { frontmatter: fm, content: rest.trim() };
}

/** Canonical alias: nativeMemoryHandler === autoMemoryHandler (legacy name). */
export const nativeMemoryHandler = autoMemoryHandler;
/** Canonical alias: nativeMemoryDir === autoMemoryDir (legacy name). */
export const nativeMemoryDir = autoMemoryDir;
