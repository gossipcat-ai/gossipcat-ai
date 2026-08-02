/**
 * Ambient-repo-noun stopwording for skill keyword lists (issue #700).
 *
 * ## The bug this fixes
 *
 * Contextual skill activation counts keyword hits against the dispatch brief.
 * That measures *vocabulary overlap with this repo*, not task relevance — so the
 * hit rate went ANTI-correlated with measured effectiveness:
 *
 *   trust_boundaries  fires on 59.4% of briefs  →  effectiveness -0.19 (failed)
 *   concurrency       fires on 15.7% of briefs  →  effectiveness +0.58 (passed)
 *
 * The cause is that `trust_boundaries` listed `path`, `session`, `token` and
 * `injection`, which in a gossipcat brief mean "file path", "orchestrator
 * session", "context token" and "skill injection" — never the security concepts
 * the category is about.
 *
 * ## How the list was derived
 *
 * Document frequency (DF) measured over a 471-document corpus of this repo's
 * real dispatch-brief vocabulary — every GitHub issue body plus the last 400
 * commit messages. Reproduce with:
 *
 *   gh issue list --state all --limit 400 --json number,title,body
 *   git log --format='%s%n%b%n===DOC===' -400
 *
 * then count, per term, the documents matching `getPattern(term)`.
 *
 * A term is an ambient stopword when BOTH hold:
 *
 *   (a) DF >= 10% of brief documents, AND
 *   (b) its dominant sense in this repo is gossipcat's own machinery or the
 *       scaffolding shared by every brief (files, paths, tests, agents,
 *       sessions, tokens, logs, the dashboard) — NOT a failure mode.
 *
 * (a) is necessary but not sufficient. `cli` (22.9%) and `verif*` (34.8%) clear
 * the DF bar but are the literal subject of `cli_ergonomics` and
 * `citation_grounding`, so they fail (b) and are kept.
 *
 * Two entries are admitted on (b) alone.
 *
 * `injection`, at DF 7.4%: of its 62 corpus occurrences, 60 are skill/lesson/
 * context injection ("injection point", "injection time", "lesson injection
 * poisons the cache") and 2 are the security sense. The multi-word forms
 * `prompt injection` / `shell injection` / `command injection` survive
 * stopwording and carry that sense precisely.
 *
 * `scoped`, at DF 6.5% (26 of 400 documents, 45 occurrences, re-measured
 * 2026-08-03) — and here the sense split is total rather than lopsided: all 45
 * occurrences name gossipcat's own machinery (`write_mode: "scoped"`, scoped
 * signal retraction, session-/consensus-/file-scoped identifiers, CSS-scoped
 * tokens) and none carry a permissions sense. It was itself introduced by #700
 * as replacement vocabulary for the removed `path` / `session` / `token`, which
 * makes it this rule's own blind spot: a term can be the repo's trust-boundary
 * jargon and an ambient repo noun at once. The phrase `scoped write*` (DF 0.2%)
 * replaces it in `trust_boundaries` and survives stopwording.
 *
 * ## Scope of the filter
 *
 * Applied in two places:
 *   - the shared keyword tables (`DEFAULT_KEYWORDS` / `CATEGORY_KEYWORDS`), which
 *     are curated to already satisfy it and pinned by test; and
 *   - `getKeywords()` at match time, which defuses the stale `keywords:`
 *     frontmatter baked into already-generated skill files. Runtime stripping is
 *     what makes the fix effective before the backfill migration runs — and for
 *     LLM-generated keyword lists, which are not drawn from the tables at all.
 */

/**
 * Single-token ambient nouns. Every entry is lowercase and unspaced; the
 * phrase carve-out in `isAmbientStopword` depends on that.
 *
 * Trailing DF figures are the measured document frequency described above.
 */
export const AMBIENT_STOPWORDS: ReadonlySet<string> = new Set([
  // ── gossipcat's own machinery ────────────────────────────────────────────
  'agent', 'agents',            // 42.7%
  'orchestrator',               // 40.6%
  'consensus',                  // 58.0%
  'dispatch', 'dispatches',     // 26.1%
  'relay', 'relays',            // 25.9%
  'signal', 'signals',          // 27.2%
  'skill', 'skills',            // 20.2%
  'gossip', 'gossipcat',        // 23.4% / 18.9%
  'mcp',                        // 26.1%
  'worktree', 'worktrees',      // 15.1%
  'finding', 'findings',        // 27.2%
  'task', 'tasks',              // 18.3%
  'session', 'sessions',        // 15.5% — the orchestrator session, never an auth session
  'dashboard',                  // 35.9%
  'memory',                     // 17.0% — the memory system, never RAM
  'context',                    // 59.9%
  'round', 'rounds',            // 21.0%
  'reviewer', 'reviewers',      // 28.2%
  'subagent', 'subagents',
  'prompt', 'prompts',          // 12.7% — every brief is about prompts

  // ── scaffolding shared by every brief ────────────────────────────────────
  'path', 'paths',              // 42.7% — the single largest false-positive driver
  'file', 'files',              // 27.4%
  'line', 'lines',              // 24.6%
  'code',                       // 29.7%
  'docs', 'doc',                // 22.3%
  'spec', 'specs',              // 17.6%
  'build', 'builds',            // 22.1%
  'src', 'packages',            // 25.1% / 21.7%
  'json', 'config',             // 22.5%
  'token', 'tokens',            // 11.7% — context tokens, never an auth token
  'log', 'logs',                // 16.6% — `logging` is kept; it is not ambient (1.5%)
  'test', 'tests',              // 42.9% / 45.9% — `unit test` / `test suite` survive

  // ── non-discriminative severity adjectives ───────────────────────────────
  'high', 'medium', 'low',      // 19.1% / 20.4% / 19.3%

  // ── admitted on sense, not DF ────────────────────────────────────────────
  'injection',                  // 7.4%, but 60/62 occurrences are skill injection
  'scoped',                     // 6.5%, but 45/45 occurrences are gossipcat's own
                                // machinery: `write_mode: "scoped"`, scoped signal
                                // retraction, session-/consensus-/file-scoped ids,
                                // CSS-scoped tokens. Zero carry a permissions sense.
                                // Ironically added by #700 itself as replacement
                                // vocabulary; `scoped write*` carries the sense.
]);

/**
 * Normalize a keyword for stopword lookup: lowercase, trimmed, with the #681
 * trailing `*` stem marker removed so `token*` is judged as `token`.
 *
 * Exported for the table-hygiene test, which must normalize exactly as the
 * runtime filter does or it would pass vacuously on a `*`-suffixed ambient noun.
 */
export function normalizeKeywordForStopwordLookup(keyword: string): string {
  // /\*+$/ (all trailing stars, not one) matches `keywordStem` in
  // skill-loader.ts — a doubled marker like `token**` still compiles to the
  // same wildcard pattern as `token*`, so it must be judged the same way here.
  return keyword.trim().toLowerCase().replace(/\*+$/, '');
}

/**
 * True when `keyword` is a single ambient repo noun.
 *
 * MULTI-WORD PHRASES ARE NEVER STOPWORDS. `file path*`, `line number*`,
 * `hot path`, `unit test`, `test suite`, `prompt injection` and `race condition`
 * all survive even though `path`, `line`, `test`, `prompt` and `injection` are
 * ambient on their own. A phrase is discriminative precisely because the
 * qualifier pins the sense the bare noun loses — and #681 deliberately added
 * `file path*` / `line number*` to `citation_grounding`, so blanket-stripping on
 * a contained token would regress it.
 */
export function isAmbientStopword(keyword: string): boolean {
  const normalized = normalizeKeywordForStopwordLookup(keyword);
  if (normalized === '' || normalized.includes(' ')) return false;
  return AMBIENT_STOPWORDS.has(normalized);
}

/**
 * Drop ambient repo nouns from a keyword list, preserving order and the
 * original spelling (including any `*` stem marker) of survivors.
 *
 * FAIL-SAFE: returns the input unchanged when every keyword is ambient. An
 * empty keyword list makes `getKeywords()` fall back to filename matching,
 * which fires on a single tenuous word — strictly worse than the ambient list
 * it replaced. Callers therefore never receive an empty array from a non-empty
 * input.
 */
export function stripAmbientStopwords(keywords: readonly string[]): string[] {
  const kept = keywords.filter(k => !isAmbientStopword(k));
  return kept.length > 0 ? kept : [...keywords];
}
