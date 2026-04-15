/**
 * Pure helper to classify a dispatch into one of three task types:
 *   - 'implement' — the agent is expected to write/modify code (scoped or worktree)
 *   - 'research'  — the agent is expected to explore and report (summarize/analyze/…)
 *   - 'review'    — the agent is expected to verify/audit existing code (default)
 *
 * NOTE on vocabulary asymmetry: skills may declare `task_type: 'any'` to mean
 * "activate for every dispatch". `any` is a SKILL-side sentinel only; a dispatch
 * always resolves to exactly one of the three concrete types. See
 * SkillFrontmatter.task_type and skill-loader filter for the filter semantics.
 */
export type DispatchTaskType = 'review' | 'implement' | 'research';

const RESEARCH_VERB = /^(summarize|analyze|investigate|trace|research)\b/i;
const REVIEW_VERB = /^(verify|check|review|audit|explain|document|list)\b/i;

/**
 * Infer the dispatch task type from the task string and (optional) write mode.
 *
 * Precedence (highest first):
 *   1. write_mode === 'scoped' | 'worktree' → 'implement'
 *      (Authoring modes that produce file writes are always implementations,
 *      regardless of the opening verb.)
 *   2. Research verb in the first token → 'research'
 *   3. Review verb in the first token → 'review'
 *   4. Fallback → 'review' (safe default — matches the pre-existing behaviour
 *      of the verifier/cross-review pipeline; skills declared as `review` or
 *      `any` still activate, so no surprises.)
 */
export function inferTaskType(task: string, writeMode?: string): DispatchTaskType {
  if (writeMode === 'scoped' || writeMode === 'worktree') return 'implement';
  const trimmed = (task ?? '').trimStart();
  if (RESEARCH_VERB.test(trimmed)) return 'research';
  if (REVIEW_VERB.test(trimmed)) return 'review';
  return 'review';
}
