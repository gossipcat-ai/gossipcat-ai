/**
 * Backfill pass that propagates keyword-table changes into already-generated
 * skill files (issue #700, item 4).
 *
 * ## Why a migration is needed at all
 *
 * `CATEGORY_KEYWORDS` is pasted verbatim into the `keywords:` frontmatter of
 * every skill the engine generates. Once written, that snapshot is what
 * `getKeywords()` reads — the table is never consulted again for that skill. So
 * a table edit reaches new skills only, and every agent-local copy keeps the old
 * list forever. That is exactly how the #676/#679 citation_grounding fix failed
 * to propagate, and it would have swallowed #700's fix too.
 *
 * ## What it does
 *
 * For each `.gossip/**\/skills/*.md`, one of two things:
 *
 *   - **reseed** — the file's keywords still match the pre-#700 table for its
 *     category, so it is an untouched generated copy. Replaced wholesale with
 *     the current table.
 *   - **strip** — the file's keywords diverge from the legacy table (an
 *     LLM-authored or hand-curated list). Only ambient nouns are removed; the
 *     curation is preserved. Reseeding here would destroy human/model intent,
 *     and unioning in the defaults would re-inflate the hit count that #700
 *     exists to reduce.
 *
 * Distinguishing the two is what `LEGACY_CATEGORY_KEYWORDS` is for. It is a
 * frozen snapshot, never updated again: its only job is recognizing pre-#700
 * files. A future keyword change needs its own snapshot and its own pass.
 *
 * The rewrite is a targeted edit of the `keywords:` entry, leaving the rest of
 * the file byte-identical. It deliberately does NOT bump `version:` — that field
 * drives skill-engine's optimistic-concurrency drift check, and a migration that
 * changes only match vocabulary is not a new skill revision.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { parseSkillFrontmatter } from './skill-parser';
import { stripAmbientStopwords } from './keyword-stopwords';

/**
 * The live keyword table, injected by the caller rather than imported.
 *
 * skill-engine.ts owns `CATEGORY_KEYWORDS` and is also the module that triggers
 * this pass, so importing it here would close a module cycle. Passing the table
 * in keeps the dependency one-directional and lets tests drive the migration
 * with a fixture table instead of the shipped one.
 */
export type KeywordTable = Readonly<Record<string, readonly string[]>>;

/**
 * The keyword table as it stood immediately before #700. Frozen — a file whose
 * `keywords:` still equals one of these lists is an untouched generated copy and
 * is safe to reseed from the live table.
 */
export const LEGACY_CATEGORY_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  trust_boundaries: ['auth', 'authentication', 'authorization', 'session', 'cookie', 'token', 'path', 'traversal', 'injection', 'middleware', 'permission', 'role', 'privilege', 'acl'],
  injection_vectors: ['injection', 'xss', 'sql', 'sanitiz*', 'escape', 'template', 'eval', 'exec', 'html', 'uri', 'command'],
  input_validation: ['validation', 'schema', 'zod', 'parse', 'sanitiz*', 'input', 'form', 'request', 'coerce', 'transform'],
  concurrency: ['race condition', 'concurrent', 'mutex', 'lock', 'atomic', 'parallel', 'deadlock', 'semaphore'],
  resource_exhaustion: ['memory', 'leak', 'unbounded', 'growth', 'limit', 'cap', 'timeout', 'pool', 'cache', 'backpressure', 'buffer', 'queue', 'throttle'],
  type_safety: ['type guard', 'generic', 'cast', 'assertion', 'narrowing', 'discriminated', 'satisfies'],
  error_handling: ['error handling', 'catch', 'throw', 'exception', 'retry*', 'retries', 'retried', 'fallback', 'recovery', 'graceful'],
  data_integrity: ['data integrity', 'migration', 'serializ*', 'deserializ*', 'corrupt*', 'consistency', 'invariant', 'transaction', 'rollback', 'idempotent'],
  severity_calibration: ['severity', 'critical', 'high', 'medium', 'low', 'impact', 'risk', 'priority', 'triage', 'cvss'],
};

export type SkillKeywordMigrationMode = 'reseeded' | 'stripped';

export interface SkillKeywordMigrationEntry {
  /** Absolute path of the rewritten skill file. */
  path: string;
  mode: SkillKeywordMigrationMode;
  before: string[];
  after: string[];
}

export interface SkillKeywordMigrationOptions {
  /** Compute and report the rewrites without touching disk. */
  dryRun?: boolean;
}

/** Case- and order-insensitive list equality. */
function sameKeywords(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (xs: readonly string[]) => [...xs].map(x => x.trim().toLowerCase()).sort();
  const [na, nb] = [norm(a), norm(b)];
  return na.every((x, i) => x === nb[i]);
}

/**
 * Replace the `keywords:` entry in a frontmatter block, preserving whichever of
 * the two supported YAML forms the file already uses (inline `[a, b]` or a `- `
 * block sequence). Returns `null` when the file has no frontmatter or no
 * `keywords:` key, so the caller can skip it rather than inventing one.
 */
export function rewriteKeywordsFrontmatter(raw: string, keywords: readonly string[]): string | null {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;

  const block = fm[1];
  // Replacements are passed as functions throughout: the replacement text is
  // file-derived (model-authored frontmatter and keywords), and a string
  // replacement would expand `$'` / `` $` `` / `$&` / `$$` sequences in it,
  // splicing document content into the frontmatter.
  const inline = block.match(/^(\s*keywords:[ \t]*)\[[^\]]*\][ \t]*$/m);
  if (inline) {
    const replaced = block.replace(inline[0], () => `${inline[1]}[${keywords.join(', ')}]`);
    return raw.replace(block, () => replaced);
  }

  // Block sequence: `keywords:` on its own line followed by `- item` lines.
  const seq = block.match(/^(\s*)keywords:[ \t]*\n((?:[ \t]*-[ \t]*.*\n?)+)/m);
  if (seq) {
    const indent = seq[1];
    const itemIndent = seq[2].match(/^([ \t]*)-/)?.[1] ?? `${indent}  `;
    const rendered = keywords.map(k => `${itemIndent}- ${k}`).join('\n');
    const replaced = block.replace(seq[0], () => `${indent}keywords:\n${rendered}\n`);
    return raw.replace(block, () => replaced);
  }

  return null;
}

/** Every `skills/` directory under `.gossip/` that a skill file can live in. */
function skillDirectories(projectRoot: string): string[] {
  const dirs: string[] = [];
  const shared = join(projectRoot, '.gossip', 'skills');
  if (existsSync(shared)) dirs.push(shared);

  const agentsDir = join(projectRoot, '.gossip', 'agents');
  if (!existsSync(agentsDir)) return dirs;

  let agentIds: string[];
  try {
    agentIds = readdirSync(agentsDir);
  } catch {
    return dirs;
  }

  for (const agentId of agentIds) {
    const skillsDir = join(agentsDir, agentId, 'skills');
    try {
      if (statSync(skillsDir).isDirectory()) dirs.push(skillsDir);
    } catch {
      // Not a directory, or unreadable — skip.
    }
  }
  return dirs;
}

/** Decide the new keyword list for one skill file, or `null` to leave it alone. */
function nextKeywords(
  keywords: readonly string[],
  category: string | undefined,
  keywordTable: KeywordTable,
): { mode: SkillKeywordMigrationMode; after: string[] } | null {
  const legacy = category ? LEGACY_CATEGORY_KEYWORDS[category] : undefined;
  const current = category ? keywordTable[category] : undefined;

  if (legacy && current && sameKeywords(keywords, legacy)) {
    return sameKeywords(keywords, current) ? null : { mode: 'reseeded', after: [...current] };
  }

  const stripped = stripAmbientStopwords(keywords);
  return sameKeywords(keywords, stripped) ? null : { mode: 'stripped', after: stripped };
}

/**
 * Walk every skill file under `.gossip/` and bring its `keywords:` frontmatter
 * in line with the post-#700 tables.
 *
 * Idempotent: a second run reports no entries, because both branches converge on
 * a list that already equals its own target. Individually fault-tolerant — an
 * unreadable or malformed file is skipped, never fatal, so one corrupt skill
 * cannot block the pass or the engine constructing around it.
 */
export function migrateSkillKeywords(
  projectRoot: string,
  keywordTable: KeywordTable,
  options: SkillKeywordMigrationOptions = {},
): SkillKeywordMigrationEntry[] {
  const migrated: SkillKeywordMigrationEntry[] = [];

  for (const dir of skillDirectories(projectRoot)) {
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const skillPath = join(dir, file);
      try {
        const raw = readFileSync(skillPath, 'utf-8');
        const frontmatter = parseSkillFrontmatter(raw, skillPath);

        // Same guard as the status migration: skill files always carry `name`.
        // Rewriting a README or notes file that happens to sit here would
        // corrupt non-skill content.
        if (!frontmatter || typeof frontmatter.name !== 'string' || frontmatter.name.trim() === '') continue;
        if (!frontmatter.keywords || frontmatter.keywords.length === 0) continue;

        const next = nextKeywords(frontmatter.keywords, frontmatter.category, keywordTable);
        if (!next) continue;

        const rewritten = rewriteKeywordsFrontmatter(raw, next.after);
        if (rewritten === null) continue;

        if (!options.dryRun) {
          // Same-directory tmp + rename, matching writeSkillFileFromParts: a
          // crash mid-write must not leave a torn skill file.
          const tmpPath = `${skillPath}.tmp.${process.pid}`;
          writeFileSync(tmpPath, rewritten, 'utf-8');
          renameSync(tmpPath, skillPath);
        }
        migrated.push({
          path: skillPath,
          mode: next.mode,
          before: [...frontmatter.keywords],
          after: next.after,
        });
      } catch {
        // Unreadable / unwritable / malformed — skip this file only.
      }
    }
  }

  return migrated;
}
