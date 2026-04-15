#!/usr/bin/env ts-node
/**
 * Idempotent migration: normalize `.gossip/memory/*.md` frontmatter to the
 * canonical schema defined in docs/specs/2026-04-15-session-save-native-vs-gossip-memory.md.
 *
 * Canonical fields:
 *   name, description, status, type, importance, lastAccessed, updated, accessCount
 *
 * Transformation rules (spec §143-151):
 *   1. name           → "Session <date> — <SUMMARY first 40 chars>"
 *   2. description    → existing SUMMARY: line body
 *   3. status         → `open` if "Open for next session" section is non-empty, else `shipped`
 *   4. type           → always `session` for `session_*.md`
 *   5. importance     → always 0.4 (canonical gossip default — never inherit cognitive-store values)
 *   6. lastAccessed   → file mtime, formatted YYYY-MM-DD
 *   7. updated        → mirror of lastAccessed
 *   8. accessCount    → 0 (reset; the cognitive recall pipeline maintains its own counter)
 *   9. Preserve any pre-existing fields not in the canonical set (harmless; mapper ignores them)
 *
 * Usage:
 *   npx ts-node scripts/migrate-gossip-memory.ts [projectRoot]
 *
 * Idempotency: a second run on an already-canonical file is a no-op (skips
 * when all canonical fields are present).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const CANONICAL_FIELDS = ['name', 'description', 'status', 'type', 'importance', 'lastAccessed', 'accessCount'] as const;

export interface MigrationResult {
  migrated: string[];
  skipped: string[];
  errors: Array<{ file: string; error: string }>;
}

/**
 * Parse frontmatter leniently. Returns the raw frontmatter body (between the
 * --- fences), an ordered list of keys, a kv map, and the post-frontmatter
 * body. Files without frontmatter get empty fm / full raw body.
 */
export function parseFrontmatter(raw: string): {
  fmRaw: string;
  fm: Record<string, string>;
  body: string;
} {
  if (!raw.startsWith('---')) return { fmRaw: '', fm: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { fmRaw: '', fm: {}, body: raw };
  const fmBlock = raw.slice(3, end).trim();
  const fm: Record<string, string> = {};
  for (const line of fmBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  let rest = raw.slice(end + 4);
  if (rest.startsWith('\n')) rest = rest.slice(1);
  return { fmRaw: fmBlock, fm, body: rest };
}

/** True when all canonical fields are present — migration is a no-op. */
export function hasCanonicalSchema(fm: Record<string, string>): boolean {
  return CANONICAL_FIELDS.every((k) => fm[k] !== undefined && fm[k] !== '');
}

/** Extract the SUMMARY: line from the body or a legacy "SUMMARY: ..." line anywhere. */
function extractSummary(body: string): string {
  const m = body.match(/^SUMMARY:\s*(.+)$/m);
  return m ? m[1].trim() : '';
}

/** True when the body has an "## Open for next session" section with non-empty content. */
function hasOpenSection(body: string): boolean {
  const m = body.match(/##\s+Open[^\n]*\n([\s\S]*?)(?=\n##|\s*$)/i);
  if (!m) return false;
  const section = m[1].trim();
  // Strip bullet markers and whitespace; non-empty means at least one meaningful bullet.
  return section.replace(/[-*\s]/g, '').length > 0;
}

/** File mtime formatted as YYYY-MM-DD for lastAccessed / updated. */
function formatMtime(filePath: string): string {
  try {
    const mt = statSync(filePath).mtime;
    return mt.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Build the canonical frontmatter block + body for one file. Pure function —
 * takes raw file content, returns the rewritten content. Returns `null` when
 * the file already has the canonical schema (idempotency guard).
 */
export function migrateOne(raw: string, filename: string, mtimeYmd: string): string | null {
  const { fm: existing, body } = parseFrontmatter(raw);
  if (hasCanonicalSchema(existing)) return null;

  const summary = extractSummary(body);
  const date = existing.date || existing.lastAccessed || mtimeYmd;

  const nameBase = summary ? summary.slice(0, 40) : filename.replace(/\.md$/, '').replace(/_/g, ' ');
  const name = existing.name || `Session ${date} — ${nameBase}`;
  const description = existing.description || summary || nameBase;
  const status = existing.status || (hasOpenSection(body) ? 'open' : 'shipped');
  const type = existing.type || 'session';
  const lastAccessed = existing.lastAccessed || mtimeYmd;
  const updated = existing.updated || lastAccessed;

  // Build canonical frontmatter. Canonical fields come first in a stable order;
  // any pre-existing non-canonical fields are preserved at the end (harmless
  // metadata survives — spec rule 8).
  const canonicalKeys = new Set<string>([...CANONICAL_FIELDS, 'updated', 'pinned']);
  const canonical: Array<[string, string]> = [
    ['name', name],
    ['description', description],
    ['status', status],
    ['type', type],
    ['importance', '0.4'],
    ['lastAccessed', lastAccessed],
    ['updated', updated],
    ['accessCount', existing.accessCount || '0'],
  ];

  const preserved: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(existing)) {
    if (canonicalKeys.has(k)) continue;
    preserved.push([k, v]);
  }

  const fmLines = [...canonical, ...preserved].map(([k, v]) => `${k}: ${v}`);
  return `---\n${fmLines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/** Migrate every `session_*.md` file under `<projectRoot>/.gossip/memory/`. */
export function migrateGossipMemory(projectRoot: string): MigrationResult {
  const result: MigrationResult = { migrated: [], skipped: [], errors: [] };
  const dir = join(projectRoot, '.gossip', 'memory');
  if (!existsSync(dir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    result.errors.push({ file: dir, error: (err as Error).message });
    return result;
  }

  for (const filename of entries) {
    if (!filename.endsWith('.md')) continue;
    const full = join(dir, filename);
    try {
      const raw = readFileSync(full, 'utf-8');
      const mtimeYmd = formatMtime(full);
      const rewritten = migrateOne(raw, filename, mtimeYmd);
      if (rewritten === null) {
        result.skipped.push(filename);
        continue;
      }
      writeFileSync(full, rewritten);
      result.migrated.push(filename);
    } catch (err) {
      result.errors.push({ file: filename, error: (err as Error).message });
    }
  }

  return result;
}

// CLI entry point: run the migration when invoked directly.
if (require.main === module) {
  const projectRoot = process.argv[2] || process.cwd();
  const result = migrateGossipMemory(projectRoot);
  process.stdout.write(`Migration complete — migrated: ${result.migrated.length}, skipped: ${result.skipped.length}, errors: ${result.errors.length}\n`);
  if (result.migrated.length > 0) process.stdout.write(`  migrated: ${result.migrated.join(', ')}\n`);
  if (result.skipped.length > 0) process.stdout.write(`  skipped:  ${result.skipped.join(', ')}\n`);
  for (const e of result.errors) process.stderr.write(`  ERROR ${e.file}: ${e.error}\n`);
  process.exit(result.errors.length > 0 ? 1 : 0);
}
