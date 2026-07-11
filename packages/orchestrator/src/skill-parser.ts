import { normalizeSkillName } from './skill-name';

/** Status values written by the skill lifecycle: both the authoring-time values
 * ('active', 'draft', 'disabled') and the effectiveness verdict values written
 * by checkEffectiveness() ('passed', 'failed', 'pending', 'flagged_for_manual_review',
 * 'silent_skill', 'insufficient_evidence'). Loader filters on these at dispatch time.
 */
export type SkillStatus =
  | 'active'
  | 'draft'
  | 'disabled'
  | 'passed'
  | 'failed'
  | 'pending'
  | 'inconclusive'
  | 'flagged_for_manual_review'
  | 'silent_skill'
  | 'insufficient_evidence';

/**
 * Task-type scope for a skill. Controls which dispatch types the skill
 * activates for (see skill-loader filter at :119).
 *
 * Vocabulary asymmetry (intentional): skills may declare `task_type: 'any'`
 * to mean "match every dispatch". A dispatch itself always resolves to one
 * of 'review' | 'implement' | 'research' — never 'any'. See
 * `task-type-inference.ts` for the dispatch-side inference.
 */
export type SkillTaskType = 'review' | 'implement' | 'research' | 'any';

/**
 * Cross-cutting scope declaration for a skill. Unlike `mode: permanent`
 * (which always loads regardless of task type) and `mode: contextual`
 * (which requires keyword hits), a skill with `scope` set loads on EVERY
 * task whose task_type is in the array — no keyword matching required.
 *
 * This is the correct model for cross-cutting concerns like citation integrity
 * that apply to all code-review tasks regardless of topic, but should NOT
 * fire on implement or research dispatches.
 *
 * Scoped skills do NOT count against the MAX_CONTEXTUAL_SKILLS budget. They
 * are a separate loading axis: task-type-aware always-loads.
 *
 * Example frontmatter: `scope: [review]` or `scope: [review, research]`
 */
export type SkillScope = ReadonlyArray<'review' | 'implement' | 'research'>;

export interface SkillFrontmatter {
  name: string;
  description: string;
  keywords: string[];
  category?: string;
  mode?: 'permanent' | 'contextual';
  generated_by?: string;
  sources?: string;
  status: SkillStatus;
  /**
   * ISO-8601 timestamp set when a `passed` skill is demoted to `inconclusive`
   * by the drift detector; absent for organically-inconclusive skills. Read by
   * the skill-loader quarantine filter to suppress regressed skills from
   * dispatch injection until they re-pass effectiveness checks.
   */
  regressed_from_passed_at?: string;
  /**
   * Dispatch scope. Default 'any' preserves backwards-compatibility with skills
   * authored before this axis was introduced — they activate for all dispatches.
   * Explicit values ('review'|'implement'|'research') hard-reject on mismatch in
   * the skill-loader BEFORE the keyword-hit / category-boost gates run.
   */
  task_type?: SkillTaskType;
  /**
   * Cross-cutting scope array. When present, the skill loads on EVERY dispatch
   * whose task_type is in this list — no keyword matching, no contextual budget.
   * Use for concerns that are always relevant to a task type (e.g. citation
   * integrity on review tasks) but should not fire on other task types.
   *
   * Takes priority over mode/contextual machinery: if scope matches the dispatch
   * task_type, the skill is injected unconditionally. If scope is present but
   * the dispatch type is not in the list, the skill is dropped as task-type-mismatch.
   *
   * Parsed from frontmatter: `scope: [review]` or `scope: [review, research]`
   * Missing or empty → treated as absent (no scope constraint, falls through to
   * mode/contextual machinery).
   */
  scope?: SkillScope;
}

/**
 * Fields that support the YAML block-sequence form:
 *   keywords:
 *     - injection
 *     - sanitize
 * in addition to the inline `keywords: [injection, sanitize]` form. Kept to
 * these two list-valued axes deliberately — other fields stay scalar.
 */
const BLOCK_SEQUENCE_KEYS = new Set(['keywords', 'scope']);

/** Writes a loud, prefixed diagnostic to stderr for parse failures. Warnings
 * fire when a `---` frontmatter block IS present but either (a) is missing the
 * hard-required `name` field — a genuine authoring error that drops the skill —
 * or (b) had `description`/`status` backfilled with safe defaults (one warning,
 * skill preserved). The silent-coercion philosophy for OPTIONAL axes (task_type,
 * scope unknown-token dropping, mode) is unchanged below.
 *
 * Deliberately silent when no frontmatter block is found at all: plain
 * `# Title` markdown with no `---` block is a supported, common skill
 * format — most of the bundled default skills under
 * `packages/orchestrator/src/default-skills/` are authored this way.
 * Warning on every such file would spam stderr/mcp.log on every dispatch
 * that loads default skills for no actionable reason. */
function warnParseFailure(message: string, sourceLabel?: string): void {
  const suffix = sourceLabel ? ` (source: ${sourceLabel})` : '';
  process.stderr.write(`[skill-parser] ${message}${suffix}\n`);
}

export function parseSkillFrontmatter(content: string, sourceLabel?: string): SkillFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    // No `---` frontmatter block — a supported format for skills without
    // metadata (see warnParseFailure doc comment). Silent by design.
    return null;
  }

  const lines = match[1].split('\n');
  const fields: Record<string, string> = {};
  const blockSequences: Record<string, string[]> = {};
  let activeBlockKey: string | null = null;

  for (const line of lines) {
    // Block-sequence continuation: a `- item` line following a key whose
    // inline value was empty (e.g. `keywords:` with no trailing value).
    // Leading indentation is OPTIONAL (`\s*`, not `\s+`) — valid YAML
    // allows sequence items at column 0 under their key, which is common
    // LLM-authoring style:
    //   keywords:
    //   - injection
    //   - sanitize
    // A single space after `-` is REQUIRED (`\s`, not `\s?`): per YAML,
    // `- item` is a sequence item but `-item` (no space) is not — pin that
    // distinction here rather than silently accepting it. Only
    // keywords/scope collect these; any other line (including a bare
    // `-item` that fails this match) ends the block-sequence context so
    // scalar fields aren't misread as list items — this reset path is
    // unchanged from before.
    if (activeBlockKey) {
      const itemMatch = line.match(/^\s*-\s(.*)$/);
      if (itemMatch) {
        (blockSequences[activeBlockKey] ??= []).push(itemMatch[1].trim());
        continue;
      }
      activeBlockKey = null;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding "..." or '...' so `status: "pending"` matches the
    // enum the same way `status: pending` does. Mirrors the quote handling
    // in skill-engine.ts:parseSkillFile — this parser is the loader's path
    // and drifted. Inline arrays (keywords) keep their form via the [] check
    // below, so stripping here is safe.
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      // `.trim()` AFTER the strip too: a quoted-whitespace value like
      // `name: "   "` is otherwise 3 truthy spaces that slip the `!name`
      // guard below and normalize to '' downstream (consensus 41d9d4d9).
      value = value.slice(1, -1).trim();
    }
    fields[key] = value;

    if (value === '' && BLOCK_SEQUENCE_KEYS.has(key)) {
      activeBlockKey = key;
    }
  }

  // `name` is the only HARD requirement: a skill with no identity is unusable,
  // so keep PR #647's loud-drop path for it (warn + return null). `description`
  // and `status` are recall/lifecycle metadata — dropping a functional
  // contextual skill for a missing one-liner is too harsh (it stranded
  // generated agent-local skills that omit `description`). Backfill safe
  // defaults instead and emit ONE observability warning noting what was
  // filled in.
  if (!fields.name) {
    warnParseFailure('missing required field(s): name', sourceLabel);
    return null;
  }
  const backfilled: string[] = [];
  if (!fields.description) {
    // Humanize the identity into a stand-in one-liner: `resource-exhaustion`
    // → `resource exhaustion`. Pure recall metadata, so a derived value is
    // strictly better than dropping the whole skill.
    // `|| fields.name` guards an all-separator name (e.g. `---`) humanizing to ''.
    fields.description = fields.name.replace(/[-_]/g, ' ').trim() || fields.name;
    backfilled.push('description');
  }
  if (!fields.status) {
    fields.status = 'active';
    backfilled.push('status');
  }
  if (backfilled.length > 0) {
    warnParseFailure(`backfilled missing field(s): ${backfilled.join(', ')}`, sourceLabel);
  }

  let keywords: string[] = [];
  if (blockSequences.keywords && blockSequences.keywords.length > 0) {
    keywords = blockSequences.keywords
      .map(k => k.trim().replace(/^['"]|['"]$/g, '').slice(0, 100))
      .filter(Boolean);
  } else if (fields.keywords) {
    const raw = fields.keywords;
    if (raw.startsWith('[') && raw.endsWith(']')) {
      keywords = raw.slice(1, -1).split(',').map(k => k.trim().replace(/^['"]|['"]$/g, '').slice(0, 100)).filter(Boolean);
    } else {
      keywords = raw.split(',').map(k => k.trim().slice(0, 100)).filter(Boolean);
    }
  }

  // Silent coercion mirrors the `mode` field's ternary treatment: an unknown
  // or malformed value collapses to the safe default ('any') instead of
  // rejecting the whole skill. Rationale: skill authors shouldn't lose a
  // whole contextual skill to a typo in an optional axis. The dispatch-side
  // filter still gates activation on the coerced value.
  const rawTaskType = fields.task_type;
  const task_type: SkillTaskType = (
    rawTaskType === 'review' || rawTaskType === 'implement' ||
    rawTaskType === 'research' || rawTaskType === 'any'
  ) ? rawTaskType : 'any';

  // Parse `scope` field: inline list e.g. `scope: [review, research]`
  // or bare single value `scope: review`. Unknown tokens are silently
  // dropped (same coercion philosophy as task_type). An empty parsed
  // array is treated as absent — callers check `scope && scope.length > 0`.
  let scope: SkillScope | undefined;
  if (blockSequences.scope && blockSequences.scope.length > 0) {
    const tokens = blockSequences.scope.map(t => t.trim().replace(/^['"]|['"]$/g, ''));
    const valid = tokens.filter(
      (t): t is 'review' | 'implement' | 'research' =>
        t === 'review' || t === 'implement' || t === 'research',
    );
    if (valid.length > 0) scope = valid;
  } else if (fields.scope) {
    const raw = fields.scope.trim();
    let tokens: string[];
    if (raw.startsWith('[') && raw.endsWith(']')) {
      tokens = raw.slice(1, -1).split(',').map(t => t.trim().replace(/^['"]|['"]$/g, ''));
    } else {
      tokens = [raw.replace(/^['"]|['"]$/g, '')];
    }
    const valid = tokens.filter(
      (t): t is 'review' | 'implement' | 'research' =>
        t === 'review' || t === 'implement' || t === 'research',
    );
    if (valid.length > 0) scope = valid;
  }

  return {
    name: normalizeSkillName(fields.name),
    description: fields.description,
    keywords,
    category: fields.category || undefined,
    mode: (fields.mode === 'contextual' ? 'contextual' : fields.mode === 'permanent' ? 'permanent' : undefined),
    generated_by: fields.generated_by,
    sources: fields.sources,
    status: fields.status as SkillStatus,
    regressed_from_passed_at: fields.regressed_from_passed_at || undefined,
    task_type,
    scope,
  };
}
