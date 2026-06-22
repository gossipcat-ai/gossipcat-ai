/**
 * prose-bullet-resolver — fuzzy slug-matching for free-form ledger bullets.
 *
 * Spec: docs/specs/2026-05-14-prose-only-bullet-resolver.md
 *
 * Problem: parseNextSessionBullets only attaches a "backingFile" when the
 * bullet text contains an explicit markdown link "[label](path.md)". Free-form
 * prose bullets ("PR #383 5 LOWs deferred — see project_pr383_followup_cleanups.md")
 * fall through to the PROSE-ONLY branch even when a backing memory file
 * obviously exists.
 *
 * This resolver:
 *   1. Indexes each memory file's "name" + "description" frontmatter into
 *      a token set (PR refs, agent IDs, file-path fragments, category keywords).
 *   2. Extracts the same token classes from the prose bullet.
 *   3. Scores each candidate via true Jaccard:
 *        |bullet ∩ memory| / |bullet ∪ memory|
 *   4. Requires Jaccard >= 0.3 AND >= 2 distinct tokens matched.
 *   5. If multiple candidates are within 5% of the top → returns 'ambiguous'.
 *      Single confident match → 'matched'. Otherwise → 'none'.
 *
 * Sidecar (".gossip/prose-resolver-index.json") is invalidated by a hash of
 * the memory directory's filename list (catches add/remove/rename on ext4
 * where directory mtime is unreliable) AND by the directory mtime.
 *
 * NOTE: file paths from agent/user prose are UNTRUSTED. We only read files
 * inside the resolved memoryDir (which the caller derives from os.homedir()
 * + project encoding) — we never read arbitrary attacker-supplied paths.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export const PROSE_RESOLVER_FILENAME = 'prose-resolver-index.json';
export const PROSE_RESOLVER_VERSION = 1;
export const JACCARD_THRESHOLD = 0.3;
export const MIN_TOKEN_MATCHES = 2;
export const AMBIGUITY_WINDOW = 0.05; // within 5% of top score → ambiguous

/** Max bytes for a single memory file's frontmatter read (64 KB). */
export const FRONTMATTER_READ_LIMIT = 64 * 1024;
/** Max bytes for the prose-resolver sidecar JSON (16 MB). */
export const SIDECAR_READ_LIMIT = 16 * 1024 * 1024;
/** Max agent-directory entries scanned before capping. */
export const DISCOVER_AGENT_CAP = 1000;

/** Closed set of skill categories (kept in sync with gossip_skills categories). */
const CATEGORY_KEYWORDS: ReadonlySet<string> = new Set([
  'trust_boundaries',
  'injection_vectors',
  'input_validation',
  'concurrency',
  'resource_exhaustion',
  'type_safety',
  'error_handling',
  'data_integrity',
]);

export interface ProseResolverIndex {
  version: number;
  /** Mtime of the memory directory at index time. */
  memoryDirMtime: number;
  /** Hash of sorted *.md filenames; survives ext4 rename-without-dir-mtime-bump. */
  filenameHash: string;
  /** token → list of memory filenames whose frontmatter contained that token. */
  tokens: Record<string, string[]>;
  /** token-count per memory file (for true Jaccard denominator). */
  memoryTokenCounts: Record<string, number>;
}

export type ProseResolveResult =
  | { kind: 'matched'; backingFile: string; score: number; matchedTokens: string[] }
  | { kind: 'ambiguous'; candidates: Array<{ file: string; score: number }> }
  | { kind: 'none'; reason: 'zero_tokens' | 'below_threshold' };

/**
 * Hand-rolled type guard for ProseResolverIndex.
 * Validates inner record shapes: tokens must be Record<string, string[]>
 * and memoryTokenCounts must be Record<string, number>.
 */
export function isProseResolverIndex(x: unknown): x is ProseResolverIndex {
  if (!x || typeof x !== 'object') return false;
  const obj = x as Record<string, unknown>;
  if (typeof obj['version'] !== 'number') return false;
  if (typeof obj['memoryDirMtime'] !== 'number') return false;
  if (typeof obj['filenameHash'] !== 'string') return false;
  if (!obj['tokens'] || typeof obj['tokens'] !== 'object') return false;
  if (!obj['memoryTokenCounts'] || typeof obj['memoryTokenCounts'] !== 'object') return false;
  for (const val of Object.values(obj['tokens'] as object)) {
    if (!Array.isArray(val)) return false;
    if (!(val as unknown[]).every((v) => typeof v === 'string')) return false;
  }
  for (const val of Object.values(obj['memoryTokenCounts'] as object)) {
    if (typeof val !== 'number') return false;
  }
  return true;
}

/** Stable hash of the sorted *.md filename list. */
function hashFilenames(names: string[]): string {
  const sorted = [...names].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
}

/** List *.md files in memoryDir. Empty array on any fs error. */
function listMemoryFiles(memoryDir: string): string[] {
  try {
    return readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch {
    return [];
  }
}

/** Resolve the sidecar path. */
export function proseResolverPath(projectRoot: string): string {
  return join(projectRoot, '.gossip', PROSE_RESOLVER_FILENAME);
}

/** Read the known agent-ID list by scanning .gossip/agents subdirs. */
export function discoverAgentIds(projectRoot: string): string[] {
  const dir = join(projectRoot, '.gossip', 'agents');
  try {
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    if (dirs.length > DISCOVER_AGENT_CAP) {
      console.warn(`[prose-resolver] discoverAgentIds: ${dirs.length} entries exceed cap of ${DISCOVER_AGENT_CAP}; truncating`);
      return dirs.slice(0, DISCOVER_AGENT_CAP);
    }
    return dirs;
  } catch {
    return [];
  }
}

/**
 * Extract candidate tokens from arbitrary text. Pure — no fs access.
 * agentIds is the per-project agent list (passed in so callers can mock).
 */
export function extractTokens(text: string, agentIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const lower = text.toLowerCase();

  // 1. PR refs: PR #383, PR 383, pr#383
  const prRe = /\bpr\s*#?(\d+)\b/g;
  let prMatch: RegExpExecArray | null;
  while ((prMatch = prRe.exec(lower)) !== null) {
    out.add(`pr${prMatch[1]}`);
  }

  // 2. Agent IDs — match against the known list (case-insensitive).
  for (const id of agentIds) {
    if (id && lower.includes(id.toLowerCase())) out.add(id.toLowerCase());
  }

  // 3. File-path fragments: name.ts / name.md / name.json (underscore allowed).
  //    Lower-case already, so use [a-z0-9_-].
  const fileRe = /[a-z0-9_-]+\.(?:ts|md|json)/g;
  let fileMatch: RegExpExecArray | null;
  while ((fileMatch = fileRe.exec(lower)) !== null) {
    out.add(fileMatch[0]);
  }

  // 4. Category keywords (closed set).
  for (const kw of CATEGORY_KEYWORDS) {
    if (lower.includes(kw)) out.add(kw);
  }

  return out;
}

/**
 * Parse the "name" + "description" lines out of a memory file's frontmatter.
 * Hand-rolled (no yaml dep). Returns concatenated text for token extraction.
 */
function readFrontmatterNameDesc(file: string): string {
  let raw: string;
  try {
    if (statSync(file).size > FRONTMATTER_READ_LIMIT) return '';
    raw = readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
  if (!raw.startsWith('---')) return '';
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return '';
  const fm = raw.slice(3, end);
  const parts: string[] = [];
  for (const line of fm.split('\n')) {
    const m = /^(name|description)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) parts.push(m[2].replace(/^["']|["']$/g, ''));
  }
  return parts.join(' ');
}

/**
 * Build (or rebuild) the prose-resolver index from the memory directory.
 * No sidecar IO here; persistence handled by "buildProseResolverIndex".
 */
function buildIndexFromDisk(
  memoryDir: string,
  agentIds: readonly string[],
): ProseResolverIndex {
  const files = listMemoryFiles(memoryDir);
  const filenameHash = hashFilenames(files);
  let memoryDirMtime = 0;
  try { memoryDirMtime = statSync(memoryDir).mtimeMs; } catch { /* leave 0 */ }

  const tokens: Record<string, string[]> = {};
  const memoryTokenCounts: Record<string, number> = {};

  for (const fname of files) {
    const text = readFrontmatterNameDesc(join(memoryDir, fname));
    if (!text) {
      memoryTokenCounts[fname] = 0;
      continue;
    }
    const toks = extractTokens(text, agentIds);
    memoryTokenCounts[fname] = toks.size;
    for (const t of toks) {
      const list = tokens[t] ?? (tokens[t] = []);
      if (!list.includes(fname)) list.push(fname);
    }
  }

  return {
    version: PROSE_RESOLVER_VERSION,
    memoryDirMtime,
    filenameHash,
    tokens,
    memoryTokenCounts,
  };
}

/**
 * Load a valid sidecar from disk, or null if missing / stale / malformed.
 * Validates filenameHash + memoryDirMtime against live state.
 */
function readValidSidecar(
  projectRoot: string,
  memoryDir: string,
): ProseResolverIndex | null {
  const path = proseResolverPath(projectRoot);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    if (statSync(path).size > SIDECAR_READ_LIMIT) return null;
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  if (!isProseResolverIndex(parsed)) return null;
  const idx = parsed;
  if (idx.version !== PROSE_RESOLVER_VERSION) return null;

  // Validate against current memory dir state.
  const files = listMemoryFiles(memoryDir);
  const liveHash = hashFilenames(files);
  if (idx.filenameHash !== liveHash) return null;
  let liveMtime = 0;
  try { liveMtime = statSync(memoryDir).mtimeMs; } catch { return null; }
  if (idx.memoryDirMtime !== liveMtime) return null;
  return idx;
}

/** Write sidecar; best-effort, swallows errors. */
function writeSidecar(projectRoot: string, idx: ProseResolverIndex): void {
  const path = proseResolverPath(projectRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(idx));
  } catch {
    /* best-effort */
  }
}

/**
 * Public entry point. Returns a fresh, validated index — rebuilt from disk
 * when the cached sidecar is missing or stale.
 */
export function buildProseResolverIndex(
  projectRoot: string,
  memoryDir: string,
): ProseResolverIndex {
  const agentIds = discoverAgentIds(projectRoot);
  const cached = readValidSidecar(projectRoot, memoryDir);
  if (cached) return cached;
  const fresh = buildIndexFromDisk(memoryDir, agentIds);
  writeSidecar(projectRoot, fresh);
  return fresh;
}

/**
 * Resolve a single prose bullet against the index.
 * Pure aside from the agent-list scan, which uses the index implicitly.
 */
export function resolveProseBullet(
  bullet: string,
  index: ProseResolverIndex,
  agentIds: readonly string[] = [],
): ProseResolveResult {
  const bulletTokens = extractTokens(bullet, agentIds);
  if (bulletTokens.size === 0) return { kind: 'none', reason: 'zero_tokens' };

  // Tally per-candidate matched-token counts.
  const matched = new Map<string, Set<string>>(); // file → set of matched tokens
  for (const tok of bulletTokens) {
    const files = index.tokens[tok];
    if (!files) continue;
    for (const f of files) {
      const s = matched.get(f) ?? new Set<string>();
      s.add(tok);
      matched.set(f, s);
    }
  }
  if (matched.size === 0) return { kind: 'none', reason: 'below_threshold' };

  // Score each candidate with true Jaccard.
  const scored: Array<{ file: string; score: number; matched: string[] }> = [];
  for (const [file, toks] of matched) {
    const memTokens = index.memoryTokenCounts[file] ?? 0;
    const inter = toks.size;
    const union = bulletTokens.size + memTokens - inter;
    if (union <= 0) continue;
    const score = inter / union;
    if (score >= JACCARD_THRESHOLD && inter >= MIN_TOKEN_MATCHES) {
      scored.push({ file, score, matched: [...toks] });
    }
  }
  if (scored.length === 0) return { kind: 'none', reason: 'below_threshold' };

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const winThreshold = top.score * (1 - AMBIGUITY_WINDOW);
  const contenders = scored.filter((s) => s.score >= winThreshold);
  if (contenders.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: contenders.map((c) => ({ file: c.file, score: c.score })),
    };
  }
  return {
    kind: 'matched',
    backingFile: top.file,
    score: top.score,
    matchedTokens: top.matched,
  };
}

/** Convenience: agent-ID list for callers that already have an index. */
export function discoverAgentIdsForRoot(projectRoot: string): string[] {
  return discoverAgentIds(projectRoot);
}
