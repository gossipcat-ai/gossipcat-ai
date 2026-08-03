import { readFileSync, existsSync, readdirSync, realpathSync } from 'fs';
import { resolve, sep } from 'path';
import type { SkillIndex } from './skill-index';
import { parseSkillFrontmatter } from './skill-parser';
import { normalizeSkillName } from './skill-name';
import { gossipLog, log as _log } from './log';
import { loadMemoryConfig } from './memory-config';
import { emitPipelineSignals } from './signal-helpers';
import { sanitizePromptMarkers } from './prompt-markers';
import { stripAmbientStopwords } from './keyword-stopwords';

const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const MAX_CONTEXTUAL_SKILLS = 3;
/**
 * Fractional boost added to a contextual skill's raw hit count when its
 * `category` frontmatter is in the task's extracted categories. Chosen as 0.5
 * to preserve integer-tie semantics against raw hits:
 *   - non-category 2-hit (2.0) still beats category 1-hit (1.5)
 *   - category 1-hit (1.5) beats non-category 1-hit (1.0)
 *   - 0 raw hits + boost (0.5) does NOT pass MIN_KEYWORD_HITS=1 threshold
 * See consensus f2ff0fac-fb384daa for the pinned design.
 */
const CATEGORY_BOOST = 0.5;
// Lowered from 2 → 1 (consensus c8977bda-37564212): cross-cutting skills
// (citation_grounding, error_handling) starved on well-framed tasks where
// only a single keyword matched. MAX_CONTEXTUAL_SKILLS=3 remains the budget
// safety net — hit count still orders candidates, so low-signal matches lose
// to stronger ones and only fill the remaining slots when nothing else wins.
const MIN_KEYWORD_HITS = 1;

/**
 * Default keyword sets by category — used when skill frontmatter has no explicit keywords.
 *
 * KEYWORD CONVENTION (issue #681, option 2, operator-approved). A trailing `*`
 * opts that single keyword into stem matching: `verif*` compiles to the
 * case-insensitive `\bverif[a-z]` star, reaching verifies / verified /
 * verifying / verification.
 * A bare keyword keeps exact `\b…\b` word matching, byte-identical to pre-#681.
 * See `getPattern()` for the compiler and why the anchor is NOT relaxed globally.
 *
 * Adding a `*` is a deliberate act: audit the stem for off-domain over-match
 * first. Stems rejected here for that reason, with the colliding words:
 *   `cit*`   → city, citizen            (use `cite*` + `citing` + `citation*`)
 *   `retr*`  → retreat, retrieve        (use `retry*` + explicit retries/retried)
 *   `retrie*`→ retrieve, retrieval      (same)
 *   `cast*`  → castle, caster, castigate (left bare below)
 *   `auth*`  → author, authored          (left bare; the #676 case)
 *   `log*`   → login, logic, logistics   (left bare)
 *   `exec*`  → execution is in-domain, but `executive`/`executor` are not (left bare)
 *
 * AMBIENT-NOUN RULE (issue #700). No entry below may be a single ambient repo
 * noun — a word that names gossipcat's own machinery or the scaffolding every
 * dispatch brief shares (`path`, `session`, `token`, `memory`, `log`, `test`,
 * `dashboard`, `prompt`, `high`/`medium`/`low`, `injection`, `scoped`). Those terms
 * measure vocabulary overlap with this repo, not task relevance, which is how
 * `trust_boundaries` reached a 59.4% brief fire rate at -0.19 effectiveness
 * while `concurrency` sat at 15.7% and +0.58. The list, its measured document
 * frequencies, and the two-part admission test live in `keyword-stopwords.ts`;
 * `tests/orchestrator/keyword-stopwords.test.ts` pins that neither table
 * contains one. Multi-word phrases are exempt — `file path*`, `unit test` and
 * `prompt injection` are discriminative precisely because the qualifier pins
 * the sense the bare noun loses.
 */
export const DEFAULT_KEYWORDS: Record<string, string[]> = {
  // #700: `session` / `token` / `path` / `injection` removed — in a gossipcat
  // brief they mean the orchestrator session, a context token, a file path and
  // skill injection, never the security concepts. `path` alone matched 42.7% of
  // briefs. Replaced with this repo's real trust-boundary vocabulary: the
  // worktree `sandbox`, the `scoped write*` mode phrase, `allowlist` checks, and
  // the `path traversal` / `boundary escape` phrases (exempt from stopwording).
  // #675 P3: that replacement first shipped as bare `scoped`, which was itself an
  // ambient repo noun — 45/45 corpus occurrences are gossipcat machinery (scoped
  // write mode, scoped retraction, session-/consensus-/file-scoped ids), none a
  // permissions sense. It is now stopworded, and the `scoped write*` phrase (DF
  // 0.2%) carries the sense: firing rarely and correctly is the goal.
  trust_boundaries: ['auth', 'authentication', 'authorization', 'cookie', 'traversal', 'path traversal', 'middleware', 'permission', 'role', 'privilege', 'acl', 'trust boundary', 'boundary escape', 'sandbox', 'scoped write*', 'untrusted', 'allowlist', 'bypass*', 'escalat*', 'tamper*'],
  // `sanitiz*` → sanitize/sanitized/sanitizes/sanitizing/sanitization/sanitizer.
  // No English word outside that family begins `sanitiz`. (The British `sanitis*`
  // spelling is still uncovered — same gap as the pre-#681 bare `sanitize`.)
  // `exec` stays bare: `exec*` would reach executive/executor, which are not
  // injection vocabulary.
  // #700: bare `injection` removed. 60 of its 62 corpus occurrences are skill /
  // lesson / context injection, so it fired this category on briefs about the
  // skill engine. The qualified phrases below keep the security sense and are
  // deliberately low-frequency — firing rarely and correctly is the goal.
  injection_vectors: ['xss', 'sql', 'sanitiz*', 'escape', 'template', 'eval', 'exec', 'html', 'uri', 'command', 'prompt injection', 'shell injection', 'command injection', 'argument injection'],
  input_validation: ['validation', 'schema', 'zod', 'parse', 'sanitiz*', 'input', 'form', 'request', 'coerce', 'transform'],
  // #700: this category was the anti-correlation's other half — the best-scoring
  // skill (+0.58) firing on almost nothing, because every entry was textbook
  // jargon absent from real briefs. `race condition` matched 0.8% of briefs
  // while bare `race` matched 5.7%, so the phrase is dropped for the bare form
  // (which subsumes it). `concurren*` folds in concurrent/concurrently/
  // concurrency; no English word outside that family begins `concurren`.
  // `toctou`, `interleav*` and `in-flight` are the terms this repo actually uses
  // for the failure. `read-modify-write` / `check-then-act` were considered and
  // rejected: both measured 0 corpus hits, which is the same dead-jargon problem.
  concurrency: ['race', 'concurren*', 'mutex', 'lock', 'atomic', 'parallel', 'deadlock', 'semaphore', 'toctou', 'interleav*', 'in-flight'],
  // #700: `memory` removed — in this repo it is the memory system (gossip_remember,
  // memory files) at 17.0% of briefs, not RAM. `leak` and `unbounded` carry the
  // exhaustion sense precisely.
  resource_exhaustion: ['leak', 'unbounded', 'growth', 'limit', 'cap', 'timeout', 'pool', 'cache', 'backpressure', 'buffer', 'queue', 'throttle'],
  // `cast` deliberately stays bare — `cast*` reaches castle/caster/castigate, and
  // the trailing \b is what keeps it out of `broadcast` (#676). `casting` is
  // therefore still unreachable; that is the accepted trade.
  type_safety: ['type guard', 'generic', 'cast', 'assertion', 'narrowing', 'discriminated', 'satisfies'],
  // `retry*` → retry/retrying. retries/retried need a different stem (`retri*`
  // collides with retrieve/retrieval, `retr*` also with retreat), so they are
  // enumerated instead.
  error_handling: ['error handling', 'catch', 'throw', 'exception', 'retry*', 'retries', 'retried', 'fallback', 'recovery', 'graceful'],
  // `serializ*` / `deserializ*` → the -s/-d/-ing/-ation/-er forms. Both are needed:
  // the leading \b means `serializ*` does NOT match inside `deserialization`.
  // `corrupt*` → corrupts/corrupted/corruption/corruptible; no off-domain collisions.
  data_integrity: ['data integrity', 'migration', 'serializ*', 'deserializ*', 'corrupt*', 'consistency', 'invariant', 'transaction', 'rollback', 'idempotent'],
  // Fabrication-class failures: agent cites code that does not match repo state.
  // Kept in sync with CATEGORY_KEYWORDS in skill-engine.ts — both tables drive contextual activation
  // and auto-inference in gossip_signals, so they must agree.
  // Issue #676: `fabricat` / `hallucin` were stems, but getPattern() compiles
  // every keyword as /\b<escaped>\b/i — the escape step makes a regex literal
  // impossible here, and a bare stem never occurs in English, so both entries
  // were permanently dead on the fabrication-detection category. Listed as
  // explicit inflections instead; that touches only this category, whereas
  // relaxing the shared \b anchor in getPattern() would change matching for
  // every keyword of every skill.
  // Issue #679: `fabricating` / `hallucinating` were missing — the present
  // participle is the most natural phrasing in a task brief ("the agent is
  // fabricating citations"), and \b-anchored matching means no other inflection
  // covers it.
  // Issue #681: 12 of 16 realistic phrasings fired NO keyword here, because
  // every entry was a base form under \b…\b. The base forms below now carry the
  // stem marker. Per-stem over-match audit:
  //   `cite*`      cite/cites/cited. Not city/citizen (no `y`/`i` after `cite`),
  //                not excite (leading \b). `citing` needs its own entry — the
  //                `e` drops, so it is not reachable from the `cite` stem, and
  //                `cit*` was rejected above.
  //   `citation*`  citation/citations.
  //   `line number*` / `file path*`  plural only; wildcarding mid-phrase is
  //                awkward, and the trailing noun is the one that inflects.
  //   `anchor*`    anchor/anchors/anchored/anchoring.
  //   `referenc*`  reference(s|d)/referencing. Deliberately NOT `refer*`, which
  //                reaches referral/referee/deference-adjacent prose.
  //   `verif*`     verify/verifies/verified/verifying/verification/verifiable.
  //                No word outside the verify family begins `verif`.
  // The fabricate/hallucinate enumerations from #676/#679 are left as-is: they
  // already cover their full inflection set, so restating them as `fabricat*` /
  // `hallucinat*` would churn a working, test-pinned list for zero coverage gain.
  // `doesn't exist` is a contraction, not an inflection — no stem reaches it.
  citation_grounding: ['cite*', 'citing', 'citation*', 'line number*', 'anchor*', 'file path*', 'referenc*', 'fabricate', 'fabricates', 'fabricated', 'fabricating', 'fabrication', 'hallucinate', 'hallucinates', 'hallucinated', 'hallucinating', 'hallucination', 'verif*', 'does not exist', "doesn't exist", 'no such'],
  // Phase 1 dev-quality extensions (consensus 09693c51-184246e5).
  // #700: `log` (16.6%) and `dashboard` (35.9%) removed — this repo ships a
  // dashboard and logs constantly, so both fired on briefs with no observability
  // concern. `logging` stays: at 1.5% it is not ambient and names the activity.
  observability: ['logging', 'metric', 'tracing', 'telemetry', 'monitor', 'stderr', 'observability'],
  // #700: `prompt` removed (12.7%) — every brief here is about prompts. `cli`
  // (22.9%) is deliberately KEPT: it clears the ambient DF bar but is the literal
  // subject of this category, so it fails the second admission test.
  cli_ergonomics: ['cli', 'flag', 'help text', 'error message', 'usage', 'banner', 'spinner'],
  performance: ['latency', 'slow', 'performance', 'n+1', 'uncached', 'readfilesync', 'synchronous', 'hot path'],
  // #700: bare `test` / `tests` removed (42.9% / 45.9%) — "add tests", "tests
  // pass" is boilerplate in every brief and names the scaffolding, not a testing
  // failure. The phrases and `testing` itself survive and are discriminative.
  testing: ['testing', 'coverage', 'mock', 'fixture', 'unit test', 'integration test', 'e2e', 'test suite'],
};

export interface DroppedSkill {
  skill: string;
  reason:
    | 'status-failed'
    | 'status-silent'
    /**
     * Skill was previously `passed` and was demoted to `inconclusive` by the
     * drift detector (carries `regressed_from_passed_at` frontmatter). Held out
     * of injection until it re-passes effectiveness checks; see
     * docs/specs/2026-05-13-passed-skill-drift-detection.md §Quarantine.
     */
    | 'status-drift-demoted'
    | 'below-keyword-threshold'
    | 'no-task-provided'
    | 'budget-exceeded'
    /**
     * Skill declared `task_type` that does not match the dispatch's inferred
     * type (e.g. a review-only skill on an implement dispatch). Evaluated
     * BEFORE keyword-hit threshold and category boost so mismatched skills
     * never consume the contextual budget.
     */
    | 'task-type-mismatch'
    /**
     * Skill declared a `scope` array (cross-cutting always-load on matching
     * task types) but the current dispatch's task_type is not in the scope
     * list. Distinct from `task-type-mismatch` so callers can tell the two
     * filter axes apart in observability logs.
     */
    | 'scope-type-mismatch'
    /**
     * Skill is flagged `propagated: true` and the project's memory-config.json
     * has `bundledMemories.enabled: false`. All propagated skills are suppressed.
     */
    | 'kill-switch'
    /**
     * Skill is flagged `propagated: true` and its name appears in
     * `bundledMemories.exclude`. Only this skill is suppressed.
     */
    | 'excluded';
  hits: number;
}

export interface LoadSkillsResult {
  content: string;
  loaded: string[];
  /**
   * Structured drop records. Every skill that was considered but not injected
   * appears here with the reason. Closes the silent-drop observability gap
   * where contextual skills with `task` undefined were previously skipped
   * without appearing in `loaded` OR `dropped`.
   */
  dropped: DroppedSkill[];
  activatedContextual: string[];
  /**
   * Skills activated via the scope axis (task-type-aware always-load).
   * These are distinct from `activatedContextual` (keyword-gated) and do not
   * count against the MAX_CONTEXTUAL_SKILLS budget. Populated only when
   * `dispatchTaskType` is provided and a skill's `scope` array matches it.
   */
  loadedScoped: string[];
  /**
   * Resolved absolute paths of every skill file successfully loaded into `content`.
   * Index-aligned with `loaded` (paths[i] is the resolved path of loaded[i]).
   * Realpath-normalized so symlinked skills dedupe correctly. Empty array when
   * no skills loaded. Consumers (e.g. dispatch-prompt warm cache) use these paths
   * + their mtimeMs to build a skill-set fingerprint without re-walking the FS.
   */
  paths: string[];
}

/**
 * Drop reasons whose skills are advertised as fetchable on demand (issue #715).
 *
 * ONLY these two. A skill dropped for `status-failed`, `status-silent`, or
 * `status-drift-demoted` is QUARANTINED by design — advertising it would let an
 * agent pull back exactly the content the effectiveness pipeline just withheld.
 * `kill-switch` / `excluded` are operator decisions, and the `*-mismatch` /
 * `no-task-provided` reasons mean the skill does not apply to this dispatch at
 * all. Those all stay silent.
 */
export const ON_DEMAND_DROP_REASONS: ReadonlySet<DroppedSkill['reason']> = new Set([
  'below-keyword-threshold',
  'budget-exceeded',
] as const);

/**
 * Build the one-line on-demand skill advertisement appended after the SKILLS
 * block (issue #715 / #698 part 2). Returns `''` when nothing is eligible, so
 * callers can pass the result straight through and the line is simply omitted.
 *
 * Deliberately ONE line: this rides on every dispatch, so it is a fixed ~15
 * token cost plus one comma-separated name per withheld skill.
 */
export function buildSkillsOnDemandLine(
  dropped: DroppedSkill[],
  runtime: 'native' | 'relay',
): string {
  const names = Array.from(new Set(
    dropped.filter(d => ON_DEMAND_DROP_REASONS.has(d.reason)).map(d => d.skill),
  )).sort();
  if (names.length === 0) return '';
  const tool = runtime === 'native'
    ? 'mcp__gossipcat__gossip_skill_query(agent_id, skill)'
    : 'skill_query(skill)';
  return `Skills available on demand (not loaded): ${names.join(', ')} — fetch with ${tool}`;
}

/**
 * The effective skill set for an agent — the SINGLE source of truth shared by
 * the prompt builder (`loadSkills`) and the coverage-gap detector
 * (`SkillCatalog.checkCoverage`). When the skill index has slots for the agent,
 * the index-enabled set wins (it reflects bind/disable lifecycle decisions);
 * otherwise the raw config.json `skills` list is used.
 *
 * Before this helper, `loadSkills` resolved the index-enabled set while
 * `checkCoverage` was handed the raw config list, so an index-bound skill that
 * WAS injected still produced a false "skill may be relevant but is not
 * assigned" warning (project_coverage_gap_detector_config_vs_index, CONFIRMED
 * 2026-06-11). Both consumers now call this function.
 */
export function resolveEffectiveSkills(
  agentId: string,
  configSkills: string[],
  index?: SkillIndex,
): string[] {
  return index && index.getAgentSlots(agentId).length > 0
    ? index.getEnabledSkills(agentId)
    : configSkills;
}

/**
 * Compute the category match boost for a contextual skill.
 * Returns CATEGORY_BOOST (0.5) if the skill's category is in the task's
 * extracted categories, otherwise 0. Zero-category tasks always return 0.
 */
function categoryBoost(skillCategory: string | undefined, categories: string[]): number {
  if (!skillCategory || categories.length === 0) return 0;
  return categories.includes(skillCategory) ? CATEGORY_BOOST : 0;
}

/**
 * Load skill files for an agent and return structured result.
 *
 * Resolution order per skill:
 * 1. Agent's local skills: .gossip/agents/<id>/skills/
 * 2. Project skills: .gossip/skills/
 * 3. Default skills: packages/orchestrator/src/default-skills/
 *
 * Permanent skills are always loaded. Contextual skills require MIN_KEYWORD_HITS
 * (word-boundary match) against the task string, capped at MAX_CONTEXTUAL_SKILLS.
 *
 * When `taskCategories` is provided, skills whose frontmatter `category` is in
 * that array receive a fractional boost (CATEGORY_BOOST) applied to raw hits
 * BEFORE the threshold gate. A 0-hit skill with boost 0.5 still fails the
 * MIN_KEYWORD_HITS=1 gate (effective 0.5 < 1). A 1-hit skill with boost gets
 * 1.5 effective hits — enough to outrank a non-category 1-hit but not a
 * non-category 2-hit. See consensus f2ff0fac-fb384daa.
 *
 * Candidates that tie on effective hits are ranked by their frontmatter
 * `effectiveness` (descending; absent = 0), with the skill name as the final
 * deterministic tiebreaker. See issue #675 precondition 2.
 */
export function loadSkills(
  agentId: string,
  skills: string[],
  projectRoot: string,
  index?: SkillIndex,
  task?: string,
  taskCategories?: string[],
  /**
   * Dispatch task type. When provided, skills whose frontmatter `task_type`
   * is set to a CONCRETE type ('review'|'implement'|'research') that does
   * not match are hard-rejected with `task-type-mismatch` BEFORE the
   * keyword-hit gate. Skills with `task_type: 'any'` (the default for
   * unlabelled skills) are unaffected, preserving backwards-compat.
   *
   * When undefined, the filter is skipped entirely (same as pre-migration
   * behaviour) — call sites that don't yet know the dispatch type retain
   * today's semantics.
   */
  dispatchTaskType?: 'review' | 'implement' | 'research',
): LoadSkillsResult {
  const effectiveSkills = resolveEffectiveSkills(agentId, skills, index);

  const categories = taskCategories ?? [];

  // Load kill-switch config once per invocation (not inside the loop).
  const memConfig = loadMemoryConfig(projectRoot);

  const permanent: Array<{ name: string; content: string; path: string }> = [];
  const scoped: Array<{ name: string; content: string; path: string }> = [];
  const contextualCandidates: Array<{ name: string; content: string; path: string; hits: number; rawHits: number; boost: number; effectiveness: number }> = [];
  const loaded: string[] = [];
  const paths: string[] = [];
  const dropped: DroppedSkill[] = [];
  const activatedContextual: string[] = [];
  const loadedScoped: string[] = [];

  for (const skill of effectiveSkills) {
    const resolved = resolveSkill(agentId, skill, projectRoot);
    if (!resolved) continue;
    const { content, path: resolvedPath } = resolved;

    // Quarantine gate — SHARED with resolveServableSkill so the on-demand
    // skill_query tools cannot serve what injection suppresses (consensus
    // c64bedcd-a44a45e8). Reason semantics and per-reason logging are unchanged;
    // only the predicate moved.
    const quarantineReason = checkSkillQuarantine(content, resolvedPath, [skill], memConfig);
    if (quarantineReason === 'status-failed' || quarantineReason === 'status-silent' || quarantineReason === 'status-drift-demoted') {
      gossipLog(
        `Skipping ${quarantineReason === 'status-drift-demoted' ? 'drift-demoted inconclusive' : quarantineReason === 'status-failed' ? 'failed' : 'silent_skill'} skill ${agentId}/${skill} from injection`,
      );
      dropped.push({ skill, reason: quarantineReason, hits: 0 });
      continue;
    }
    if (quarantineReason === 'kill-switch' || quarantineReason === 'excluded') {
      const detail = quarantineReason === 'kill-switch'
        ? 'bundledMemories.enabled=false'
        : 'listed in bundledMemories.exclude';
      _log('skill-loader', `Skipping propagated skill ${agentId}/${skill}: ${detail}`);
      emitPipelineSignals(projectRoot, [{
        type: 'pipeline',
        signal: 'skill_injection_skipped',
        agentId,
        taskId: `skill-loader:${agentId}:${skill}`,
        metadata: { skillName: skill, reason: quarantineReason },
        timestamp: new Date().toISOString(),
      }]);
      dropped.push({ skill, reason: quarantineReason, hits: 0 });
      continue;
    }

    const parsedFrontmatter = parseSkillFrontmatter(content, resolvedPath);
    if (parsedFrontmatter?.status === 'flagged_for_manual_review') {
      gossipLog(`Injecting flagged_for_manual_review skill ${agentId}/${skill} — manual review recommended`);
    }

    // ── Scope axis (Option A from finding c8977bda-37564212:f3) ──────────────
    // Skills with `scope: [review, ...]` frontmatter are cross-cutting
    // always-loads for matching task types. They bypass keyword matching and
    // the contextual budget entirely. If scope is present and the dispatch
    // type matches → inject unconditionally. If scope is present but the
    // dispatch type does NOT match → drop as scope-type-mismatch. Skills
    // without a scope declaration fall through to the existing task-type /
    // mode / contextual machinery unchanged.
    //
    // When dispatchTaskType is undefined (call sites that don't know the type),
    // scope-declared skills are treated as permanent (injected unconditionally)
    // so the backwards-compat guarantee is preserved — the same as the
    // task_type filter, which is also skipped when dispatchTaskType is absent.
    const frontmatterForScope = parseSkillFrontmatter(content, resolvedPath);
    const skillScope = frontmatterForScope?.scope;
    if (skillScope && skillScope.length > 0) {
      if (!dispatchTaskType || skillScope.includes(dispatchTaskType)) {
        // Scope matches (or no dispatch type known) — inject unconditionally.
        scoped.push({ name: skill, content, path: resolvedPath });
      } else {
        // Scope declared but dispatch type not in the list.
        dropped.push({ skill, reason: 'scope-type-mismatch', hits: 0 });
      }
      // Either way, the scope axis has handled this skill — skip the
      // task_type / mode / contextual machinery below.
      continue;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Task-type axis filter. Evaluated BEFORE keyword-hit counting and the
    // contextual budget, so a mismatched skill never starves a valid one
    // out of the MAX_CONTEXTUAL_SKILLS slots. Skills without an explicit
    // task_type parse to 'any' (see skill-parser coercion), which passes
    // the gate for every dispatch — backwards-compat by default.
    if (dispatchTaskType) {
      const skillTaskType = frontmatterForScope?.task_type ?? 'any';
      if (skillTaskType !== 'any' && skillTaskType !== dispatchTaskType) {
        dropped.push({ skill, reason: 'task-type-mismatch', hits: 0 });
        continue;
      }
    }

    const mode = index?.getSkillMode(agentId, skill) ?? 'permanent';

    if (mode === 'permanent') {
      permanent.push({ name: skill, content, path: resolvedPath });
    } else if (task) {
      const rawHits = countKeywordHits(content, skill, task, resolvedPath);
      const frontmatter = parseSkillFrontmatter(content, resolvedPath);
      const boost = categoryBoost(frontmatter?.category, categories);
      const effectiveHits = rawHits + boost;
      // Threshold applied to effective hits. With CATEGORY_BOOST=0.5 and
      // MIN_KEYWORD_HITS=1, a 0-hit skill with boost still fails (0.5 < 1)
      // but a 1-hit skill with boost passes (1.5 >= 1) and outranks plain
      // 1-hit candidates during the descending sort below.
      if (effectiveHits >= MIN_KEYWORD_HITS) {
        // Unmeasured skills rank as 0.0 — neutral, so they lose a tie to a
        // positive-effectiveness peer and win one against a negative-
        // effectiveness peer that survived the status filter.
        contextualCandidates.push({
          name: skill,
          content,
          path: resolvedPath,
          hits: effectiveHits,
          rawHits,
          boost,
          effectiveness: frontmatter?.effectiveness ?? 0,
        });
      } else {
        // Report raw hits so operators see the real keyword-match count; boost
        // already failed to rescue, so recording effective hits would hide the
        // fact that the skill had 0 keyword matches.
        dropped.push({ skill, reason: 'below-keyword-threshold', hits: rawHits });
      }
    } else {
      // No task provided — record the silent drop so it shows up in observability
      // instead of vanishing between loaded and dropped.
      dropped.push({ skill, reason: 'no-task-provided', hits: 0 });
    }
  }

  // Sort contextual by effective hit count (descending), then by measured
  // effectiveness (descending), then alphabetically by name.
  //
  // The effectiveness tier is issue #675 precondition 2: hit counts are coarse
  // integers (plus the 0.5 category boost), so a 1-1-1 tie for the last budget
  // slot was previously decided alphabetically — which evicted
  // `input-validation` (+0.416) in favour of `concurrency` on measured briefs.
  // Ranking by hits alone turns that tie into a coin flip on a skill the RL
  // loop has shown to work. Hit count stays the PRIMARY key: this only
  // reorders candidates that the existing ranking already considered equal.
  //
  // Alphabetical name remains the final tiebreaker. Node's Array.sort has been
  // stable since v12, but relying on input order here would leak skill-index
  // iteration order into activation decisions — the name tiebreaker makes ties
  // deterministic regardless of discovery order.
  contextualCandidates.sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    if (b.effectiveness !== a.effectiveness) return b.effectiveness - a.effectiveness;
    return a.name.localeCompare(b.name);
  });
  const accepted = contextualCandidates.slice(0, MAX_CONTEXTUAL_SKILLS);
  const rejected = contextualCandidates.slice(MAX_CONTEXTUAL_SKILLS);

  // Iteration order here defines the index-alignment of `paths` with `loaded`:
  // permanent → scoped → accepted (contextual). Both arrays must push in the
  // same order so consumers can rely on paths[i] being the resolved path of
  // loaded[i] (see LoadSkillsResult.paths docstring).
  for (const s of permanent) {
    loaded.push(s.name);
    paths.push(s.path);
  }
  for (const s of scoped) {
    loaded.push(s.name);
    paths.push(s.path);
    loadedScoped.push(s.name);
  }
  for (const s of accepted) {
    loaded.push(s.name);
    paths.push(s.path);
    activatedContextual.push(s.name);
  }
  for (const s of rejected) dropped.push({ skill: s.name, reason: 'budget-exceeded', hits: s.hits });

  // Strip delimiter strings from skill content to prevent prompt injection.
  //
  // Issue #679 fixed a deterministic bypass here (shared middle dashes between
  // two adjacent markers, plus a replacement that itself ended in `---`).
  // Issue #680 moved the surviving pattern into prompt-markers.ts, so this path
  // and the agent-memory / lesson-card / LENS paths all consume ONE marker list
  // and one set of bounds instead of four hand-maintained regexes. The full
  // rationale for each bound, and the no-dash-in-replacement invariant, live at
  // the definition site. Covered by
  // tests/orchestrator/skills-delimiter-and-keywords.test.ts and
  // tests/orchestrator/memory-delimiter-sanitization.test.ts.
  const sanitizeContent = (c: string) => sanitizePromptMarkers(c);
  const sections = [
    ...permanent.map(s => sanitizeContent(s.content)),
    ...scoped.map(s => sanitizeContent(s.content)),
    ...accepted.map(s => sanitizeContent(s.content)),
  ];

  // Issue #677: return BARE skill content — no `--- SKILLS ---` framing.
  // The prompt builders own the delimiter (`wrapSkillsBlock` in
  // prompt-assembler.ts); emitting it here too produced a nested block whose
  // inner terminator closed the section early for the model. The
  // `sanitizeContent` pass above is unaffected and still required: it is the
  // trust boundary that stops untrusted skill FILE content from injecting its
  // own terminator into whichever block the consumer builds.
  // Sanitize AGAIN after the join. Per-section sanitization structurally cannot
  // see a marker composed ACROSS the boundary: a section beginning `SKILLS ---`
  // carries no marker on its own, but the `\n\n---\n\n` separator supplies the
  // leading dashes, yielding a live forged open marker in the joined string.
  // The second pass is safe for benign content — a bare separator has no
  // `SKILLS` token after it, so it never matches — and the sanitizer is
  // idempotent, so already-clean sections are untouched.
  const contentStr = sections.length > 0
    ? sanitizeContent(sections.join('\n\n---\n\n'))
    : '';

  return { content: contentStr, loaded, paths, dropped, activatedContextual, loadedScoped };
}

/** Cache compiled regex patterns to avoid per-dispatch recompilation */
const patternCache = new Map<string, RegExp>();
const MAX_PATTERN_CACHE = 500;
const MAX_KEYWORD_LENGTH = 100;

/**
 * Strip the opt-in trailing `*` stem marker from a keyword, yielding the text a
 * literal-substring consumer should match on.
 *
 * `getPattern()` is not the only consumer of the keyword tables: the signal
 * category-inference paths in `mcp-server-sdk.ts` match with `text.includes(kw)`.
 * A raw `cite*` is never a substring of real prose, so those consumers must strip
 * the marker or the keyword goes dead for them — the exact failure mode #676
 * fixed for `fabricat`/`hallucin`.
 *
 * A keyword of nothing but asterisks has no stem; returning the original (rather
 * than `''`) keeps `includes()` from matching every string.
 */
export function keywordStem(keyword: string): string {
  const stem = keyword.replace(/\*+$/, '');
  return stem.length > 0 ? stem : keyword;
}

/**
 * Compile one keyword into its matcher.
 *
 * **Bare keyword** — `/\b<escaped>\b/i`, exact word match. Unchanged, byte for
 * byte, from the pre-#681 compiler.
 *
 * **Trailing `*` (issue #681, option 2, operator-approved)** — opts that ONE
 * keyword into stem matching: case-insensitive `\b<escaped-stem>[a-z]` star.
 * The leading `\b` is kept; only the trailing `\b` is dropped, so `verif*`
 * reaches verifies / verified / verifying / verification while `\bverif` still
 * cannot start mid-word.
 *
 * Opt-in is the whole point. Relaxing the trailing `\b` for EVERY keyword was
 * considered and rejected in #676: `auth` would match `author`, `log` `login`,
 * `cast` `broadcast`, `exec` `execution`. Those keywords stay bare and keep
 * their anchor; only keywords whose author has audited the stem for over-match
 * carry the marker.
 *
 * Only a TRAILING `*` is a wildcard. Anywhere else it stays a literal asterisk
 * via the escape step, so `a*b` still means the three characters `a*b`. A
 * keyword that is nothing but asterisks has no stem and falls back to the
 * exact-match compile — `\b[a-z]*` would match every task string, so this fails
 * closed rather than open.
 */
function getPattern(keyword: string): RegExp {
  const capped = keyword.slice(0, MAX_KEYWORD_LENGTH);
  const cached = patternCache.get(capped);
  if (cached !== undefined) {
    // LRU: delete-then-set promotes this key to most-recently-used position.
    // Without this, Map insertion order made eviction FIFO despite the LRU name,
    // so hot keywords could be evicted while cold ones survived.
    patternCache.delete(capped);
    patternCache.set(capped, cached);
    return cached;
  }
  if (patternCache.size >= MAX_PATTERN_CACHE) {
    // Evict least-recently-used entry (first in iteration order after LRU promotion)
    const first = patternCache.keys().next().value;
    if (first !== undefined) patternCache.delete(first);
  }
  const stem = keywordStem(capped);
  const isWildcard = stem !== capped;
  const escaped = (isWildcard ? stem : capped).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(isWildcard ? `\\b${escaped}[a-z]*` : `\\b${escaped}\\b`, 'i');
  patternCache.set(capped, pattern);
  return pattern;
}

/**
 * Count keyword hits for a contextual skill against a task string.
 * Uses word-boundary matching to prevent false positives (e.g., "auth" won't match "author").
 *
 * `sourceLabel` is the resolved skill file path when the caller has one
 * (threaded down to getKeywords -> parseSkillFrontmatter for diagnosability);
 * falls back to `skillName` when no resolved path is available.
 */
function countKeywordHits(skillContent: string, skillName: string, task: string, sourceLabel?: string): number {
  const keywords = getKeywords(skillContent, skillName, sourceLabel);
  if (keywords.length === 0) return 0;

  let hits = 0;
  for (const keyword of keywords) {
    if (getPattern(keyword).test(task)) hits++;
  }
  return hits;
}

/**
 * Extract keywords from skill frontmatter or fall back to category defaults.
 */
function getKeywords(content: string, skillName: string, sourceLabel?: string): string[] {
  const frontmatter = parseSkillFrontmatter(content, sourceLabel ?? skillName);
  if (frontmatter?.keywords && frontmatter.keywords.length > 0) {
    // Ambient repo nouns are stripped at match time, not just curated out of the
    // tables above (issue #700). Frontmatter keywords are the dominant source
    // here and the tables never reach them: generated skills bake a snapshot of
    // CATEGORY_KEYWORDS into their own file, and LLM-authored keyword lists are
    // not drawn from the tables at all — the shipped `opus-implementer`
    // trust-boundaries skill lists `mcp, relay, gossip, path, session, token,
    // injection`, seven ambient nouns that alone made it fire on every brief.
    // stripAmbientStopwords is fail-safe: an all-ambient list is returned intact
    // rather than emptied into the filename fallback below.
    return stripAmbientStopwords(frontmatter.keywords.map(k => k.toLowerCase()));
  }
  if (frontmatter?.category && DEFAULT_KEYWORDS[frontmatter.category]) {
    return DEFAULT_KEYWORDS[frontmatter.category];
  }
  // Fallback: skill name as single keyword. With MIN_KEYWORD_HITS=1, this
  // fallback IS reachable — a skill with broken frontmatter will fire
  // whenever its filename word appears in the task. Warn loudly so missing
  // keywords/category surface quickly instead of silently activating on
  // tenuous filename matches. Per bench review 12827629-fa9a4660:f2 and
  // cross-review 5ad115dd-fbc14d01:f6.
  _log('skill-loader', `WARNING: skill '${skillName}' has no keywords/category frontmatter — contextual activation will fail (using filename fallback)`);
  return [skillName.replace(/-/g, ' ')];
}

/**
 * Resolve a skill name to its file content and resolved absolute path.
 * Returns `null` if no resolution path produced a readable file.
 *
 * The `path` field is realpath-normalized (so symlinked skills dedupe with
 * their target) when realpathSync succeeds; on realpathSync failure we fall
 * back to the non-realpath'd absolute path so a transient FS error never
 * fails the load.
 */
export function resolveSkill(
  agentId: string,
  skill: string,
  projectRoot: string,
): { content: string; path: string } | null {
  // Sanitize agentId to prevent path traversal
  if (!SAFE_AGENT_ID.test(agentId)) return null;

  const bases = [
    resolve(projectRoot, '.gossip', 'agents', agentId, 'skills'),
    resolve(projectRoot, '.gossip', 'skills'),
    resolve(__dirname, 'default-skills'),
  ];

  return resolveSkillFromBases(bases, skill);
}

/**
 * Resolve a skill name against the agent-agnostic bases only (project-wide
 * `.gossip/skills`, then bundled `default-skills`) — never an agent-local
 * `.gossip/agents/<id>/skills` directory. For callers that have no specific
 * agentId in hand (e.g. an ad-hoc `gossip_skills(action: "get")` lookup)
 * and must not risk resolving into an unrelated agent's local skill dir.
 * Shares the same path-traversal guard and safe-read behavior as {@link resolveSkill}.
 */
export function resolveSharedSkill(
  skill: string,
  projectRoot: string,
): { content: string; path: string } | null {
  const bases = [
    resolve(projectRoot, '.gossip', 'skills'),
    resolve(__dirname, 'default-skills'),
  ];

  return resolveSkillFromBases(bases, skill);
}

/** Shared resolution walk used by {@link resolveSkill} and {@link resolveSharedSkill}. */
function resolveSkillFromBases(
  bases: string[],
  skill: string,
): { content: string; path: string } | null {
  // Use canonical normalization for skill name (consistent with SkillIndex)
  const normalized = normalizeSkillName(skill);
  if (!normalized) return null;
  const filename = `${normalized}.md`;

  for (const base of bases) {
    const candidate = resolve(base, filename);
    // Validate resolved path stays within base directory
    if (!candidate.startsWith(base + sep)) continue;
    if (existsSync(candidate)) {
      // Guard against permission errors, I/O failures, corrupted files.
      // Per bench review 12827629-fa9a4660:f1, an unguarded readFileSync here
      // propagated uncaught through dispatch handlers and could crash the
      // entire gossip_dispatch call. Now we log and fall through to the next
      // base (or return null) instead.
      try {
        const content = readFileSync(candidate, 'utf-8');
        // Realpath-normalize so symlinked skills collapse to a single fingerprint
        // entry. If realpathSync throws (broken symlink, permissions), fall back
        // to the non-realpath'd candidate — a fingerprint glitch is better than
        // failing the load entirely.
        let path: string;
        try {
          path = realpathSync(candidate);
        } catch {
          path = candidate;
        }
        return { content, path };
      } catch (err: any) {
        _log('skill-loader', `Failed to read skill file ${candidate}: ${err?.message ?? err}`);
        continue;
      }
    }
  }
  return null;
}

/** Check if a skill file exists in any resolution path (without reading content). */
export function resolveSkillExists(agentId: string, skill: string, projectRoot: string): boolean {
  return resolveSkill(agentId, skill, projectRoot) !== null;
}

/**
 * Reasons a resolved skill file is withheld from an agent regardless of the
 * dispatch. These are QUARANTINE conditions — distinct from the relevance
 * filters (keyword threshold, budget, task-type) which are per-dispatch.
 */
export type SkillQuarantineReason =
  | 'status-failed'
  | 'status-silent'
  | 'status-drift-demoted'
  | 'kill-switch'
  | 'excluded';

/**
 * The SINGLE quarantine predicate, shared by `loadSkills` (injection path) and
 * `resolveServableSkill` (on-demand fetch path).
 *
 * Before this existed, `skill_query` / `gossip_skill_query` called the bare
 * `resolveSkill`, which does containment + read only. That let an agent fetch
 * by name exactly the content the effectiveness pipeline had just withheld —
 * a content-access escalation for relay workers, which have no file_read
 * fallback (consensus c64bedcd-a44a45e8). Both paths must run this check or
 * the quarantine is advisory rather than enforced.
 *
 * Returns the reason, or `null` when the skill is servable. Skills with NO
 * frontmatter status (utility skills like memory-retrieval) are servable —
 * only explicit quarantine conditions filter.
 *
 * `excludeCandidates` are the names tested against `bundledMemories.exclude`.
 * Callers pass every alias they know (raw + canonical) so an exclude entry
 * written in either spelling still bites — fail-closed on ambiguity.
 */
export function checkSkillQuarantine(
  content: string,
  resolvedPath: string,
  excludeCandidates: string[],
  memConfig: ReturnType<typeof loadMemoryConfig>,
): SkillQuarantineReason | null {
  // Effectiveness status written by checkEffectiveness(). 'failed' and
  // 'silent_skill' are suppressed — serving a skill the RL loop marked as
  // harmful or silent would re-pollute the forward pass.
  //
  // Drift-demoted skills (`status: inconclusive` AND `regressed_from_passed_at`
  // set) are quarantined too — see docs/specs/2026-05-13-passed-skill-drift-
  // detection.md §"Quarantine drift-demoted skills". Organic inconclusive (no
  // regressed_from_passed_at) stays servable.
  const parsed = parseSkillFrontmatter(content, resolvedPath);
  const status = parsed?.status;
  if (status === 'failed') return 'status-failed';
  if (status === 'silent_skill') return 'status-silent';
  if (status === 'inconclusive' && parsed?.regressed_from_passed_at != null) {
    return 'status-drift-demoted';
  }

  // Kill-switch filter: propagated skills (ikp §4). Read `propagated` from raw
  // frontmatter — the SkillFrontmatter interface does not expose it (that field
  // is for bundled skills only).
  const isPropagated = /^propagated:\s*true\s*$/m.test(content.split('\n---')[0]);
  if (isPropagated) {
    if (!memConfig.bundledMemories.enabled) return 'kill-switch';
    if (excludeCandidates.some(n => memConfig.bundledMemories.exclude.includes(n))) {
      return 'excluded';
    }
  }

  return null;
}

/** A skill that resolved AND cleared the quarantine gate. */
export interface ServableSkill {
  content: string;
  path: string;
}

/**
 * Result of an on-demand skill lookup. `canonicalName` is always safe to echo
 * back to the agent; the raw argument never is (it is attacker-controlled and
 * would land in a markdown header / JSONL field verbatim).
 *
 * `skill: null` covers BOTH "no such file" and "quarantined" deliberately —
 * callers must render one indistinguishable not-found message so an agent
 * cannot probe which of its skills the effectiveness pipeline suppressed.
 */
export interface SkillQueryResult {
  canonicalName: string;
  skill: ServableSkill | null;
}

/**
 * Resolve a skill for on-demand fetch: normal resolution PLUS the quarantine
 * gate. This is the ONLY resolver the skill_query tools may use.
 */
export function resolveServableSkill(
  agentId: string,
  skill: string,
  projectRoot: string,
): SkillQueryResult {
  const canonicalName = normalizeSkillName(skill);
  const resolved = resolveSkill(agentId, skill, projectRoot);
  if (!resolved) return { canonicalName, skill: null };

  const excludeCandidates = Array.from(new Set([skill, canonicalName].filter(Boolean)));
  const reason = checkSkillQuarantine(
    resolved.content,
    resolved.path,
    excludeCandidates,
    loadMemoryConfig(projectRoot),
  );
  if (reason) {
    _log('skill-loader', `skill_query withheld ${agentId}/${canonicalName}: ${reason}`);
    return { canonicalName, skill: null };
  }
  return { canonicalName, skill: resolved };
}

/**
 * Test-only handle for LRU cache behavior verification. Not part of the public
 * API — consumers should not rely on this shape. Exposed so tests can assert
 * eviction order without duplicating the module-scoped cache.
 */
export const __lruInternals = {
  patternCache,
  getPattern,
  MAX_PATTERN_CACHE,
};

/**
 * List available skills for an agent (from all sources, deduplicated).
 */
export function listAvailableSkills(agentId: string, projectRoot: string): string[] {
  const skills = new Set<string>();

  const defaultDir = resolve(__dirname, 'default-skills');
  if (existsSync(defaultDir)) {
    for (const f of readdirSync(defaultDir)) {
      if (f.endsWith('.md')) skills.add(f.replace('.md', ''));
    }
  }

  const projectDir = resolve(projectRoot, '.gossip', 'skills');
  if (existsSync(projectDir)) {
    for (const f of readdirSync(projectDir)) {
      if (f.endsWith('.md')) skills.add(f.replace('.md', ''));
    }
  }

  if (!SAFE_AGENT_ID.test(agentId)) return Array.from(skills).sort();
  const agentDir = resolve(projectRoot, '.gossip', 'agents', agentId, 'skills');
  if (existsSync(agentDir)) {
    for (const f of readdirSync(agentDir)) {
      if (f.endsWith('.md')) skills.add(f.replace('.md', ''));
    }
  }

  return Array.from(skills).sort();
}
