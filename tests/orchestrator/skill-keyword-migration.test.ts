/**
 * Issue #700 item 4 — backfill already-generated skill files.
 *
 * `CATEGORY_KEYWORDS` is pasted verbatim into the `keywords:` frontmatter of
 * every generated skill; from then on `getKeywords()` reads that snapshot and
 * never the table again. So a table edit reaches new skills only — which is how
 * the #676/#679 citation_grounding fix failed to propagate, and would have
 * swallowed #700's fix too.
 *
 * This suite pins the reseed-vs-strip decision (the part that could destroy
 * curation if it got it backwards), both YAML keyword forms, idempotency, and
 * the non-skill-file guard.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  migrateSkillKeywords,
  rewriteKeywordsFrontmatter,
  LEGACY_CATEGORY_KEYWORDS,
  type KeywordTable,
} from '../../packages/orchestrator/src/skill-keyword-migration';
import { CATEGORY_KEYWORDS } from '../../packages/orchestrator/src/skill-engine';
import { parseSkillFrontmatter } from '../../packages/orchestrator/src/skill-parser';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gossip-kw-migration-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSkill(agentId: string, name: string, frontmatter: string): string {
  const dir = join(root, '.gossip', 'agents', agentId, 'skills');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, `---\n${frontmatter}\n---\n\n## Iron Law\n\nBody text.\n`, 'utf-8');
  return path;
}

const keywordsOf = (path: string): string[] =>
  parseSkillFrontmatter(readFileSync(path, 'utf-8'), path)?.keywords ?? [];

describe('#700 — rewriteKeywordsFrontmatter', () => {
  it('preserves the inline array form', () => {
    const raw = '---\nname: s\nkeywords: [alpha, beta]\nstatus: active\n---\n\nbody\n';
    const out = rewriteKeywordsFrontmatter(raw, ['gamma', 'delta']);
    expect(out).toContain('keywords: [gamma, delta]');
    expect(out).toContain('name: s');
    expect(out).toContain('status: active');
    expect(out).toContain('\n\nbody\n');
  });

  it('preserves the block-sequence form and its indentation', () => {
    const raw = '---\nname: s\nkeywords:\n  - alpha\n  - beta\nstatus: active\n---\n\nbody\n';
    const out = rewriteKeywordsFrontmatter(raw, ['gamma', 'delta']);
    expect(out).toContain('keywords:\n  - gamma\n  - delta\n');
    expect(out).not.toContain('alpha');
    expect(out).toContain('status: active');
  });

  it('returns null when there is no frontmatter or no keywords key', () => {
    expect(rewriteKeywordsFrontmatter('no frontmatter here', ['a'])).toBeNull();
    expect(rewriteKeywordsFrontmatter('---\nname: s\n---\nbody', ['a'])).toBeNull();
  });

  it("does not expand $-substitution sequences from file content (consensus b416f60f:f13)", () => {
    // Frontmatter is model-authored. With a string replacement, `$'` in any
    // field spliced the document body into the frontmatter and dropped every
    // field after the injected `---`; `$&` nested the frontmatter into itself.
    const raw =
      "---\nname: s\ndescription: don't trust the caller's $' expansion or $& or $$ here\nkeywords: [alpha, beta]\nstatus: active\n---\n\nbody\n";
    const out = rewriteKeywordsFrontmatter(raw, ['gamma']);
    expect(out).toContain("description: don't trust the caller's $' expansion or $& or $$ here");
    expect(out).toContain('keywords: [gamma]');
    expect(out).toContain('status: active');
    const fm = parseSkillFrontmatter(out!, 'test');
    expect(fm?.keywords).toEqual(['gamma']);
    expect(fm?.status).toBe('active');
  });

  // #705 — the rewrite's consumed region must equal the parser's. The parser
  // (skill-parser.ts) requires `-` + whitespace for a sequence item and RESETS
  // block context on the first line that fails, so anything at or after that
  // line is NOT a keyword and must survive the rewrite byte-identical.
  it('#705 — stops consuming at the first line the parser would reject', () => {
    const raw = '---\nname: s\nkeywords:\n- path\n-broken\n- b\nstatus: active\n---\n\nbody\n';
    // Ground the premise: `-broken` has no space after the dash, so the parser
    // keeps `path` only — and having reset, it never resumes for `- b`.
    expect(parseSkillFrontmatter(raw, 'test')?.keywords).toEqual(['path']);

    const out = rewriteKeywordsFrontmatter(raw, ['gamma', 'delta']);
    expect(out).toBe(
      '---\nname: s\nkeywords:\n- gamma\n- delta\n-broken\n- b\nstatus: active\n---\n\nbody\n',
    );
  });

  it('#705 — a clean all-valid block is still rewritten in full', () => {
    const raw = '---\nname: s\nkeywords:\n  - alpha\n  - beta\n  - epsilon\nstatus: active\n---\n\nbody\n';
    const out = rewriteKeywordsFrontmatter(raw, ['gamma', 'delta']);
    expect(out).toBe('---\nname: s\nkeywords:\n  - gamma\n  - delta\nstatus: active\n---\n\nbody\n');
  });

  it('#705 — non-list content after the block is left byte-identical', () => {
    const raw = "---\nname: s\nkeywords:\n  - alpha\ndescription: a - dash - laden line\n---\n\nbody\n";
    const out = rewriteKeywordsFrontmatter(raw, ['gamma']);
    expect(out).toBe("---\nname: s\nkeywords:\n  - gamma\ndescription: a - dash - laden line\n---\n\nbody\n");
  });

  it('a $-sequence in a surviving keyword does not corrupt the block form', () => {
    const raw = "---\nname: s\nkeywords:\n  - alpha\n  - beta\nstatus: active\n---\n\nbody\n";
    const out = rewriteKeywordsFrontmatter(raw, ["$'", '$&', 'gamma']);
    expect(out).toContain("  - $'\n  - $&\n  - gamma\n");
    expect(out).toContain('status: active');
    expect(out).toContain('\n\nbody\n');
  });
});

describe('#700 — reseed vs strip', () => {
  it('RESEEDS a file whose keywords still equal the pre-#700 table', () => {
    // An untouched generated copy: safe to replace wholesale.
    const path = writeSkill('gemini-reviewer', 'trust-boundaries',
      `name: trust-boundaries\ncategory: trust_boundaries\nstatus: failed\nkeywords: [${LEGACY_CATEGORY_KEYWORDS.trust_boundaries.join(', ')}]`);

    const migrated = migrateSkillKeywords(root, CATEGORY_KEYWORDS);

    expect(migrated).toHaveLength(1);
    expect(migrated[0].mode).toBe('reseeded');
    expect(keywordsOf(path)).toEqual(CATEGORY_KEYWORDS.trust_boundaries);
  });

  it('STRIPS a curated list instead of clobbering it', () => {
    // Verbatim keywords from the shipped opus-implementer trust-boundaries
    // skill — LLM-authored, diverging from the table. Reseeding would destroy
    // `resolutionRoots` / `projectRoot`, the two most discriminative entries.
    const path = writeSkill('opus-implementer', 'trust-boundaries',
      'name: trust-boundaries\ncategory: trust_boundaries\nstatus: pending\n' +
      'keywords: [auth, session, token, path, traversal, injection, sandbox, mcp, relay, resolutionRoots, projectRoot, gossip, untrusted, validate]');

    const migrated = migrateSkillKeywords(root, CATEGORY_KEYWORDS);

    expect(migrated).toHaveLength(1);
    expect(migrated[0].mode).toBe('stripped');
    expect(keywordsOf(path)).toEqual([
      'auth', 'traversal', 'sandbox', 'resolutionRoots', 'projectRoot', 'untrusted', 'validate',
    ]);
  });

  it('strips ambient nouns even when the category is unknown or absent', () => {
    // No category → no reseed target, but the ambient nouns must still go.
    const path = writeSkill('a1', 'freeform', 'name: freeform\nstatus: active\nkeywords: [path, deadlock, session, mutex]');
    const migrated = migrateSkillKeywords(root, CATEGORY_KEYWORDS);
    expect(migrated[0].mode).toBe('stripped');
    expect(keywordsOf(path)).toEqual(['deadlock', 'mutex']);
  });

  it('leaves an already-clean file untouched and reports nothing', () => {
    const path = writeSkill('a1', 'clean',
      `name: clean\ncategory: concurrency\nstatus: passed\nkeywords: [${CATEGORY_KEYWORDS.concurrency.join(', ')}]`);
    const before = readFileSync(path, 'utf-8');

    expect(migrateSkillKeywords(root, CATEGORY_KEYWORDS)).toEqual([]);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('is idempotent — a second pass reports no further changes', () => {
    writeSkill('gemini-reviewer', 'trust-boundaries',
      `name: trust-boundaries\ncategory: trust_boundaries\nstatus: failed\nkeywords: [${LEGACY_CATEGORY_KEYWORDS.trust_boundaries.join(', ')}]`);

    expect(migrateSkillKeywords(root, CATEGORY_KEYWORDS)).toHaveLength(1);
    expect(migrateSkillKeywords(root, CATEGORY_KEYWORDS)).toEqual([]);
  });

  it('FAIL-SAFE: an all-ambient curated list is left intact, not emptied', () => {
    const path = writeSkill('a1', 'all-ambient', 'name: all-ambient\nstatus: active\nkeywords: [path, session, token]');
    expect(migrateSkillKeywords(root, CATEGORY_KEYWORDS)).toEqual([]);
    expect(keywordsOf(path)).toEqual(['path', 'session', 'token']);
  });
});

describe('#700 — migration safety', () => {
  it('dryRun reports the rewrites without touching disk', () => {
    const path = writeSkill('a1', 's', 'name: s\nstatus: active\nkeywords: [path, deadlock]');
    const before = readFileSync(path, 'utf-8');

    const migrated = migrateSkillKeywords(root, CATEGORY_KEYWORDS, { dryRun: true });

    expect(migrated).toHaveLength(1);
    expect(migrated[0].after).toEqual(['deadlock']);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('skips non-skill markdown that lacks a `name` field', () => {
    const dir = join(root, '.gossip', 'agents', 'a1', 'skills');
    mkdirSync(dir, { recursive: true });
    const notes = join(dir, 'README.md');
    writeFileSync(notes, '---\nkeywords: [path, session]\n---\n\nJust notes.\n', 'utf-8');
    const before = readFileSync(notes, 'utf-8');

    expect(migrateSkillKeywords(root, CATEGORY_KEYWORDS)).toEqual([]);
    expect(readFileSync(notes, 'utf-8')).toBe(before);
  });

  it('does NOT bump `version:` — a vocabulary backfill is not a skill revision', () => {
    // `version` drives skill-engine's optimistic-concurrency drift check. Not
    // bumping is a policy choice, not an OCC requirement: a later writer
    // re-reads and captures whatever version is on disk (contract step 1), so
    // only a cross-process writer already in flight would abort — which is the
    // OCC design intent. This migration simply isn't a skill revision.
    const path = writeSkill('a1', 's', 'name: s\nversion: 3\nstatus: active\nkeywords: [path, deadlock]');
    migrateSkillKeywords(root, CATEGORY_KEYWORDS);
    expect(readFileSync(path, 'utf-8')).toContain('version: 3');
  });

  it('covers the shared `.gossip/skills/` directory too', () => {
    const dir = join(root, '.gossip', 'skills');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'shared.md');
    writeFileSync(path, '---\nname: shared\nstatus: active\nkeywords: [memory, unbounded]\n---\n\nbody\n', 'utf-8');

    expect(migrateSkillKeywords(root, CATEGORY_KEYWORDS)).toHaveLength(1);
    expect(keywordsOf(path)).toEqual(['unbounded']);
  });

  it('a malformed file does not abort the pass', () => {
    writeSkill('a1', 'good', 'name: good\nstatus: active\nkeywords: [path, deadlock]');
    const dir = join(root, '.gossip', 'agents', 'a1', 'skills');
    writeFileSync(join(dir, 'broken.md'), 'not a skill file at all', 'utf-8');

    const migrated = migrateSkillKeywords(root, CATEGORY_KEYWORDS);
    expect(migrated).toHaveLength(1);
    expect(migrated[0].path).toContain('good.md');
  });

  it('returns an empty list when there is no .gossip directory', () => {
    expect(migrateSkillKeywords(root, CATEGORY_KEYWORDS)).toEqual([]);
  });

  it('drives off the injected table, not the shipped one', () => {
    // The dependency-inversion contract: skill-engine owns CATEGORY_KEYWORDS and
    // triggers this pass, so the table is passed in rather than imported.
    const fixture: KeywordTable = { trust_boundaries: ['fixture-only'] };
    const path = writeSkill('a1', 'tb',
      `name: tb\ncategory: trust_boundaries\nstatus: active\nkeywords: [${LEGACY_CATEGORY_KEYWORDS.trust_boundaries.join(', ')}]`);

    migrateSkillKeywords(root, fixture);
    expect(keywordsOf(path)).toEqual(['fixture-only']);
  });
});
