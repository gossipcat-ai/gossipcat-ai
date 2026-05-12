/**
 * memory-index-sidecar.ts
 *
 * Builds and maintains a derived sidecar index of the auto-memory corpus at
 * ~/.claude/projects/<encoded>/memory/*.md. The sidecar lives at
 * <projectRoot>/.gossip/memory-index.json so scoped/worktree agents can write
 * it without tripping the sandbox boundary-escape detector (which blocks writes
 * under ~/). Pattern mirrors skill-index.json and task-graph-index.json.
 *
 * The corpus markdown files remain authoritative — this file is derived data.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  copyFileSync,
  mkdirSync,
  linkSync,
} from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Advisory file locking (linkSync-based, stale TTL 5s)
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 5000;

/**
 * Try to acquire an advisory lock once (non-blocking). Uses a sentinel +
 * linkSync pattern: linkSync is atomic on POSIX filesystems so only one
 * process wins the race.
 *
 * Stale-lock recovery: if linkSync fails AND the existing lock is older than
 * LOCK_STALE_MS, the stale lock is removed and linkSync is retried once.
 *
 * Returns `{acquired: true, lockPath}` on success. The caller MUST call
 * releaseLock(lockPath) in a finally block when acquired is true.
 * Returns `{acquired: false}` immediately if the lock is held by another
 * process (non-stale), or if the sentinel file cannot be written.
 */
export function tryAcquireLockOnce(
  idxPath: string,
): { acquired: true; lockPath: string } | { acquired: false } {
  const lockPath = `${idxPath}.lock`;
  const sentinelPath = `${idxPath}.lock-sentinel`;

  try { writeFileSync(sentinelPath, String(Date.now()), 'utf-8'); }
  catch { return { acquired: false }; }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      linkSync(sentinelPath, lockPath);
      try { unlinkSync(sentinelPath); } catch { /* ignore */ }
      return { acquired: true, lockPath };
    } catch {
      if (attempt === 0) {
        try {
          const s = statSync(lockPath);
          if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
            try { unlinkSync(lockPath); } catch { /* another process may have already cleared it */ }
            continue;
          }
        } catch { /* lock file may have disappeared between stat and now */ }
      }
      try { unlinkSync(sentinelPath); } catch { /* ignore */ }
      return { acquired: false };
    }
  }
  try { unlinkSync(sentinelPath); } catch { /* ignore */ }
  return { acquired: false };
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* already released or never acquired */ }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryFrontmatter {
  name?: string;
  type?: 'user' | 'feedback' | 'project' | 'reference';
  status?: 'open' | 'shipped' | 'closed';
  description?: string;
  originSessionId?: string;
}

export interface MemoryIndexDoc {
  name: string;
  type?: 'user' | 'feedback' | 'project' | 'reference';
  status?: 'open' | 'shipped' | 'closed';
  description?: string;
  mtime: number;
  length: number;       // token count
  terms: { [term: string]: number }; // term → tf
}

export interface MemoryIndex {
  version: 1;
  generatedAt: string;
  totalDocs: number;
  avgDocLength: number;
  docs: { [filename: string]: MemoryIndexDoc };
  postings: {
    [term: string]: {
      df: number;
      docs: string[];
    };
  };
}

// ---------------------------------------------------------------------------
// Tokenisation (shared with BM25 module)
// ---------------------------------------------------------------------------

/**
 * Tokenize text for indexing and querying. Lowercase, split on whitespace and
 * punctuation, drop tokens of length ≤ 3. No stemming.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter(t => t.length > 3);
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set<string>(['user', 'feedback', 'project', 'reference']);
const VALID_STATUSES = new Set<string>(['open', 'shipped', 'closed']);

/**
 * Low-level frontmatter parser shared across this module and memory-searcher.ts.
 *
 * Parses the YAML frontmatter block delimited by `---` lines and returns:
 * - `frontmatter`: raw key→value pairs (quotes stripped from values).
 *
 * Returns null when no valid frontmatter block is found.
 */
export function parseFrontmatterRaw(
  content: string,
): { frontmatter: Record<string, string> } | null {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return null;
  const rest = normalized.slice(3);
  const endIdx = rest.indexOf('\n---');
  if (endIdx === -1) return null;
  const block = rest.slice(0, endIdx);

  const obj: Record<string, string> = {};
  for (const raw of block.split('\n')) {
    const colonIdx = raw.indexOf(':');
    if (colonIdx === -1) continue;
    const key = raw.slice(0, colonIdx).trim();
    const rawVal = raw.slice(colonIdx + 1).trim();
    // Strip optional surrounding quotes (single or double)
    const value = rawVal.replace(/^["']|["']$/g, '');
    obj[key] = value;
  }

  return { frontmatter: obj };
}

/**
 * Parse YAML frontmatter from a memory file into typed MemoryFrontmatter fields.
 * Handles optional YAML quotes around values (e.g. status: "open").
 */
export function parseMemoryFrontmatter(content: string): MemoryFrontmatter | null {
  const parsed = parseFrontmatterRaw(content);
  if (!parsed) return null;
  const obj = parsed.frontmatter;

  const result: MemoryFrontmatter = {};
  if (obj.name) result.name = obj.name;
  if (obj.description) result.description = obj.description;
  if (obj.originSessionId) result.originSessionId = obj.originSessionId;

  const rawType = obj.type?.toLowerCase();
  if (rawType && VALID_TYPES.has(rawType)) {
    result.type = rawType as MemoryFrontmatter['type'];
  }

  const rawStatus = obj.status?.toLowerCase();
  if (rawStatus && VALID_STATUSES.has(rawStatus)) {
    result.status = rawStatus as MemoryFrontmatter['status'];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sidecar path resolution
// ---------------------------------------------------------------------------

/**
 * Returns the path to the sidecar index file.
 * Stored under <projectRoot>/.gossip/ for sandbox compatibility.
 */
export function sidecarPath(projectRoot: string): string {
  return join(projectRoot, '.gossip', 'memory-index.json');
}

/**
 * Returns the memory corpus directory for a given projectRoot.
 * The corpus lives under ~/.claude/projects/<encoded-cwd>/memory/.
 *
 * Encoding mirrors Claude Code's convention: every '/' in the absolute
 * path becomes '-'. The leading '/' becomes a leading '-', which is
 * preserved (e.g. /Users/goku/foo → -Users-goku-foo).
 */
export function corpusDir(projectRoot: string): string {
  // Claude Code encodes the project root as the directory name under
  // ~/.claude/projects/. Every '/' (including the leading one) becomes '-'.
  const encoded = projectRoot.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', encoded, 'memory');
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

function atomicWriteJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  let fd: number | undefined;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
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

// ---------------------------------------------------------------------------
// Index build helpers
// ---------------------------------------------------------------------------

function buildDocEntry(filename: string, content: string, mtime: number): MemoryIndexDoc {
  const frontmatter = parseMemoryFrontmatter(content);
  const body = content.replace(/^---[\s\S]*?\n---\n*/m, '');

  const nameFromFrontmatter = frontmatter?.name;
  const name = nameFromFrontmatter || basename(filename, '.md');

  const description = frontmatter?.description || '';

  // Build token set with field weights for term frequency tracking.
  // Weight reflects query-time BM25 field weight: name=3, description=2, body=1.
  const nameTokens = tokenize(name);
  const descTokens = tokenize(description);
  const bodyTokens = tokenize(body);
  const allTokens: string[] = [
    ...nameTokens, ...nameTokens, ...nameTokens,
    ...descTokens, ...descTokens,
    ...bodyTokens,
  ];

  const terms: { [term: string]: number } = {};
  for (const t of allTokens) {
    terms[t] = (terms[t] || 0) + 1;
  }

  // Length for BM25 normalization: unweighted token count across all fields
  const length = nameTokens.length + descTokens.length + bodyTokens.length;

  const entry: MemoryIndexDoc = {
    name,
    mtime,
    length,
    terms,
  };

  if (frontmatter?.type) entry.type = frontmatter.type;
  if (frontmatter?.status) entry.status = frontmatter.status;
  if (description) entry.description = description;

  return entry;
}

function buildPostings(docs: MemoryIndex['docs']): MemoryIndex['postings'] {
  const postings: MemoryIndex['postings'] = {};
  for (const [filename, doc] of Object.entries(docs)) {
    for (const term of Object.keys(doc.terms)) {
      if (!postings[term]) {
        postings[term] = { df: 0, docs: [] };
      }
      postings[term].df++;
      postings[term].docs.push(filename);
    }
  }
  return postings;
}

function computeAvgDocLength(docs: MemoryIndex['docs']): number {
  const entries = Object.values(docs);
  if (entries.length === 0) return 0;
  const total = entries.reduce((s, d) => s + d.length, 0);
  return total / entries.length;
}

// ---------------------------------------------------------------------------
// Load / full rebuild / incremental rebuild
// ---------------------------------------------------------------------------

function tryLoadIndex(indexPath: string): MemoryIndex | null {
  if (!existsSync(indexPath)) return null;
  try {
    const raw = readFileSync(indexPath, 'utf-8');
    const parsed = JSON.parse(raw) as MemoryIndex;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build a complete fresh index from the corpus directory.
 */
export function buildFullIndex(corpusDirectory: string): MemoryIndex {
  const docs: MemoryIndex['docs'] = {};

  if (existsSync(corpusDirectory)) {
    let files: string[];
    try {
      files = readdirSync(corpusDirectory).filter(
        f => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'MEMORY.md.bak',
      );
    } catch {
      files = [];
    }

    for (const filename of files) {
      const filePath = join(corpusDirectory, filename);
      try {
        const stat = statSync(filePath);
        const content = readFileSync(filePath, 'utf-8');
        docs[filename] = buildDocEntry(filename, content, stat.mtimeMs);
      } catch {
        // skip inaccessible files
      }
    }
  }

  const postings = buildPostings(docs);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    totalDocs: Object.keys(docs).length,
    avgDocLength: computeAvgDocLength(docs),
    docs,
    postings,
  };
}

/**
 * Incremental rebuild: walk corpus, update only files whose mtime differs from
 * the stored entry. Returns the updated index (or null if nothing changed).
 *
 * Callers should persist the returned index only when it differs from the
 * loaded one. This function always returns a fully-consistent index.
 */
function incrementalRebuild(
  existing: MemoryIndex,
  corpusDirectory: string,
): { index: MemoryIndex; changed: boolean } {
  if (!existsSync(corpusDirectory)) {
    return { index: existing, changed: false };
  }

  let files: string[];
  try {
    files = readdirSync(corpusDirectory).filter(
      f => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'MEMORY.md.bak',
    );
  } catch {
    return { index: existing, changed: false };
  }

  const newDocs: MemoryIndex['docs'] = { ...existing.docs };
  let changed = false;

  const diskFilenames = new Set(files);

  // Remove deleted files
  for (const filename of Object.keys(newDocs)) {
    if (!diskFilenames.has(filename)) {
      delete newDocs[filename];
      changed = true;
    }
  }

  // Update new or changed files
  for (const filename of files) {
    const filePath = join(corpusDirectory, filename);
    try {
      const stat = statSync(filePath);
      const existingEntry = existing.docs[filename];
      if (!existingEntry || existingEntry.mtime !== stat.mtimeMs) {
        const content = readFileSync(filePath, 'utf-8');
        newDocs[filename] = buildDocEntry(filename, content, stat.mtimeMs);
        changed = true;
      }
    } catch {
      // skip inaccessible files
    }
  }

  if (!changed) return { index: existing, changed: false };

  const postings = buildPostings(newDocs);
  const index: MemoryIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    totalDocs: Object.keys(newDocs).length,
    avgDocLength: computeAvgDocLength(newDocs),
    docs: newDocs,
    postings,
  };
  return { index, changed: true };
}

// ---------------------------------------------------------------------------
// Public API: load (with lazy incremental rebuild)
// ---------------------------------------------------------------------------

/**
 * Load the sidecar index, performing an incremental rebuild if any corpus file
 * has a newer mtime. Persists the updated index atomically.
 *
 * On missing or corrupt index, performs a full rebuild.
 */
export function loadIndex(projectRoot: string): MemoryIndex {
  const idxPath = sidecarPath(projectRoot);
  const corpus = corpusDir(projectRoot);

  const existing = tryLoadIndex(idxPath);
  if (!existing) {
    // Full rebuild outside the lock (rebuild is safe to run concurrently).
    const index = buildFullIndex(corpus);
    // Only the write step needs serialization.
    const lock = tryAcquireLockOnce(idxPath);
    if (lock.acquired) {
      try {
        mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
        atomicWriteJson(idxPath, index);
      } catch { /* best-effort — callers can still use the in-memory index */ }
      finally {
        releaseLock(lock.lockPath);
      }
    }
    // best-effort: another writer is active — return in-memory index without persisting
    return index;
  }

  const { index, changed } = incrementalRebuild(existing, corpus);
  if (changed) {
    // Incremental rebuild — only lock before persisting.
    const lock = tryAcquireLockOnce(idxPath);
    if (lock.acquired) {
      try {
        atomicWriteJson(idxPath, index);
      } catch { /* best-effort */ }
      finally {
        releaseLock(lock.lockPath);
      }
    }
    // best-effort: another writer is active — return in-memory index without persisting
  }
  // No rebuild needed — skip locking (read-only path).
  return index;
}

/**
 * Explicit full rebuild. Writes the new index atomically to disk.
 */
export function rebuildIndex(projectRoot: string): MemoryIndex {
  const corpus = corpusDir(projectRoot);
  const index = buildFullIndex(corpus);
  const idxPath = sidecarPath(projectRoot);
  mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  atomicWriteJson(idxPath, index);
  return index;
}

// ---------------------------------------------------------------------------
// Atomic write for plain text
// ---------------------------------------------------------------------------

function atomicWriteText(path: string, content: string): void {
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

// ---------------------------------------------------------------------------
// MEMORY.md regeneration
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<string, number> = {
  open: 0,
  undefined: 0,   // absent treated same as open
  shipped: 1,
  closed: 2,
};

function statusRank(status: string | undefined): number {
  return STATUS_ORDER[status ?? 'undefined'] ?? 0;
}

/**
 * Regenerate MEMORY.md from the index.
 *
 * Grouping: by type (user, feedback, project, reference). Files with no type
 * go into a final "Ungrouped" section — never silently dropped.
 *
 * Sort within each group: status asc (open/absent first, shipped, closed),
 * then mtime desc.
 *
 * Caps output at 200 lines: truncates most-stale shipped/closed entries first;
 * Ungrouped entries are never truncated.
 *
 * Backs up existing MEMORY.md to MEMORY.md.bak before writing.
 */
export function regenerateMemoryMd(projectRoot: string, index: MemoryIndex): void {
  const corpus = corpusDir(projectRoot);
  const memoryMdPath = join(corpus, 'MEMORY.md');
  const backupPath = join(corpus, 'MEMORY.md.bak');

  // Backup before writing
  if (existsSync(memoryMdPath)) {
    try {
      copyFileSync(memoryMdPath, backupPath);
    } catch { /* best-effort backup */ }
  }

  // Group entries
  type DocEntry = { filename: string; doc: MemoryIndexDoc };
  const groups: Record<string, DocEntry[]> = {
    user: [],
    feedback: [],
    project: [],
    reference: [],
    ungrouped: [],
  };

  for (const [filename, doc] of Object.entries(index.docs)) {
    const group = doc.type ?? 'ungrouped';
    groups[group].push({ filename, doc });
  }

  function sortGroup(entries: DocEntry[]): DocEntry[] {
    return entries.slice().sort((a, b) => {
      const sA = statusRank(a.doc.status);
      const sB = statusRank(b.doc.status);
      if (sA !== sB) return sA - sB;
      return b.doc.mtime - a.doc.mtime;
    });
  }

  function renderLine(filename: string, doc: MemoryIndexDoc): string {
    const statusTag = doc.status ? `[${doc.status.toUpperCase()}] ` : '';
    const desc = doc.description || '';
    const truncatedDesc = desc.length > 100 ? desc.slice(0, 100) : desc;
    const separator = truncatedDesc ? ' — ' : '';
    return `- ${statusTag}[${doc.name}](${filename})${separator}${truncatedDesc}`;
  }

  const TYPE_ORDER = ['user', 'feedback', 'project', 'reference'];
  const TYPE_HEADERS: Record<string, string> = {
    user: 'User',
    feedback: 'Feedback',
    project: 'Project',
    reference: 'Reference',
  };

  const sections: string[] = [];
  sections.push('# Gossip Mesh — Memory Index\n');

  // Lines budget: 200 total, ungrouped is protected
  const ungroupedLines = sortGroup(groups.ungrouped);
  const ungroupedLineCount = ungroupedLines.length + (ungroupedLines.length > 0 ? 2 : 0); // header + blank
  const budget = 200 - ungroupedLineCount;

  // For shipped/closed truncation: collect them sorted by mtime asc (most stale first)
  type SortableEntry = DocEntry & { group: string };
  const trimmable: SortableEntry[] = [];
  for (const g of TYPE_ORDER) {
    for (const entry of groups[g]) {
      if (entry.doc.status === 'shipped' || entry.doc.status === 'closed') {
        trimmable.push({ ...entry, group: g });
      }
    }
  }
  trimmable.sort((a, b) => a.doc.mtime - b.doc.mtime);

  // Count total lines across typed groups
  let totalTypedLines = 0;
  for (const g of TYPE_ORDER) {
    const sorted = sortGroup(groups[g]);
    if (sorted.length > 0) totalTypedLines += sorted.length + 2; // header + blank
  }

  // Trim most-stale shipped/closed entries until we fit in budget
  const trimmedFilenames = new Set<string>();
  let idx = 0;
  while (totalTypedLines > budget && idx < trimmable.length) {
    const entry = trimmable[idx++];
    if (!trimmedFilenames.has(entry.filename)) {
      trimmedFilenames.add(entry.filename);
      totalTypedLines--;
    }
  }

  for (const g of TYPE_ORDER) {
    const sorted = sortGroup(groups[g]);
    const visible = sorted.filter(e => !trimmedFilenames.has(e.filename));
    if (visible.length === 0) continue;
    sections.push(`## ${TYPE_HEADERS[g]}\n`);
    for (const { filename, doc } of visible) {
      sections.push(renderLine(filename, doc));
    }
    sections.push('');
  }

  // Ungrouped section — never truncated
  if (ungroupedLines.length > 0) {
    sections.push('## Ungrouped\n');
    for (const { filename, doc } of ungroupedLines) {
      sections.push(renderLine(filename, doc));
    }
    sections.push('');
  }

  const output = sections.join('\n');
  mkdirSync(corpus, { recursive: true });
  atomicWriteText(memoryMdPath, output);
}

/**
 * Regenerate MEMORY.md: load (or rebuild) the index first, then render.
 */
export function rebuildMemoryMd(projectRoot: string): void {
  const index = loadIndex(projectRoot);
  regenerateMemoryMd(projectRoot, index);
}
