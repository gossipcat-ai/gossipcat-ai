/**
 * Memory-index auto-tagging (Stage 2 of memory-index status surfacing).
 *
 * Reads the hand-curated MEMORY.md file in a memory directory and rewrites
 * its bullet lines so each entry that references a `project_*.md` or
 * `feedback_*.md` file gets a `[SHIPPED]`, `[OPEN]`, or `[CLOSED]` tag
 * derived from that file's YAML frontmatter `status:` field.
 *
 * Stage 1 (PR #214) landed the upstream warning in docs. Stage 2 injects the
 * status into the index itself so the orchestrator sees the state in the
 * same visual scan as the title — impossible to overlook.
 *
 * Behavior:
 *   - `user_*.md` and `reference_*.md` are explicitly excluded (no tag).
 *   - Files without frontmatter or without a `status:` field get no tag.
 *   - Lines in MEMORY.md that don't match the bullet shape pass through verbatim
 *     (section headers, sub-bullets, blank lines, etc).
 *   - Existing tags are replaced when the file's status changes, or stripped
 *     when the file no longer exposes a status.
 *   - Output is written via a temp-file + rename so readers never observe
 *     a torn file. When the output is identical to the input, no write occurs.
 *
 * This file is read-only with respect to the underlying memory files — we
 * never mutate `project_*.md` or `feedback_*.md`, only rewrite MEMORY.md.
 */

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync, unlinkSync } from 'fs';
import { join } from 'path';

export type MemoryStatus = 'open' | 'shipped' | 'closed';

export interface RefreshResult {
  updated: number;
  skipped: number;
  error?: string;
}

// Matches bullet lines like:
//   - [TAG] [Title text](project_foo.md) — description
//   - [Title text](feedback_bar.md)
// Captures: (1) existing tag (with brackets and trailing space) OR empty,
//           (2) title, (3) filename.
const BULLET_RE = /^(- )(\[[A-Z]+\] )?\[([^\]]+)\]\(([^)]+\.md)\)/;

// Matches frontmatter `status:` lines. Leading/trailing whitespace and
// optional quotes are tolerated.
const STATUS_RE = /^status:\s*["']?(open|shipped|closed)["']?\s*$/i;

/**
 * Parse the first YAML frontmatter block (between leading `---` fences) and
 * extract a `status:` value if present and valid. Returns `undefined` when
 * the file has no frontmatter, no status, or an invalid status value.
 */
function extractStatus(content: string): MemoryStatus | undefined {
  // Frontmatter must be the first non-empty thing in the file.
  if (!content.startsWith('---')) return undefined;
  const rest = content.slice(3);
  // Find the next `---` fence on its own line.
  const endIdx = rest.indexOf('\n---');
  if (endIdx === -1) return undefined;
  const block = rest.slice(0, endIdx);
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    const m = line.match(STATUS_RE);
    if (m) {
      return m[1].toLowerCase() as MemoryStatus;
    }
  }
  return undefined;
}

/**
 * Build a map from memory filename (e.g. `project_foo.md`) → status, by
 * scanning the directory for `project_*.md` / `feedback_*.md` files and
 * parsing their frontmatter. `user_*.md` and `reference_*.md` are skipped
 * per contract. Files missing status are omitted from the map (→ caller
 * strips any existing tag).
 */
function buildStatusMap(memoryDir: string): Map<string, MemoryStatus> {
  const map = new Map<string, MemoryStatus>();
  let entries: string[];
  try {
    entries = readdirSync(memoryDir);
  } catch {
    return map;
  }
  for (const fname of entries) {
    if (!fname.endsWith('.md')) continue;
    if (fname === 'MEMORY.md') continue;
    if (!(fname.startsWith('project_') || fname.startsWith('feedback_'))) continue;
    let content: string;
    try {
      content = readFileSync(join(memoryDir, fname), 'utf-8');
    } catch {
      continue;
    }
    const status = extractStatus(content);
    if (status) map.set(fname, status);
  }
  return map;
}

/**
 * Rewrite MEMORY.md index lines to reflect the current `status:` of each
 * linked memory file. Pure string transform — testable in isolation.
 *
 * Rules:
 *   - Lines matching BULLET_RE whose filename is in the status map get the
 *     tag set (added or replaced) to `[STATUS]` in caps.
 *   - Lines matching BULLET_RE whose filename is NOT in the map have any
 *     existing tag stripped (file has no status OR is an excluded user/reference
 *     memory OR is missing on disk).
 *   - All other lines pass through unchanged.
 *
 * Returns the rewritten text plus count of lines actually changed.
 */
export function applyStatusTags(
  input: string,
  statusMap: Map<string, MemoryStatus>,
): { output: string; changed: number } {
  const lines = input.split('\n');
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(BULLET_RE);
    if (!m) continue;
    const [, bullet, existingTag, title, filename] = m;
    const status = statusMap.get(filename);
    const desiredTag = status ? `[${status.toUpperCase()}] ` : '';
    if ((existingTag ?? '') === desiredTag) continue;
    // Rebuild the prefix up through the `)` of the filename, preserve trailing content verbatim.
    const rebuilt = `${bullet}${desiredTag}[${title}](${filename})`;
    const tail = line.slice(m[0].length);
    lines[i] = rebuilt + tail;
    changed++;
  }
  return { output: lines.join('\n'), changed };
}

/**
 * Atomic write: write to `<path>.tmp`, fsync, rename. The rename is atomic on
 * POSIX, so readers see either the old file or the new one — never a partial
 * write. If any step throws, attempt to clean up the tmp file.
 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  let fd: number | undefined;
  try {
    writeFileSync(tmp, content, 'utf-8');
    fd = openSync(tmp, 'r');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Refresh MEMORY.md in `memoryDir` with `[STATUS]` tags derived from each
 * linked memory file's frontmatter. Non-fatal: returns an `error` field
 * rather than throwing.
 */
export async function refreshMemoryIndex(memoryDir: string): Promise<RefreshResult> {
  const indexPath = join(memoryDir, 'MEMORY.md');
  if (!existsSync(indexPath)) {
    return { updated: 0, skipped: 0 };
  }
  try {
    const input = readFileSync(indexPath, 'utf-8');
    const statusMap = buildStatusMap(memoryDir);
    const { output, changed } = applyStatusTags(input, statusMap);
    const totalLines = input.split('\n').length;
    const skipped = totalLines - changed;
    if (output !== input) {
      atomicWrite(indexPath, output);
    }
    return { updated: changed, skipped };
  } catch (err) {
    return { updated: 0, skipped: 0, error: (err as Error).message };
  }
}
