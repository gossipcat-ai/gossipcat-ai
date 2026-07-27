/**
 * Operational (session-scoped) `finding_id` grammar for `gossip_signals`.
 * Issue #668, extended for `design_split` by issue #678.
 *
 * ## Why a second shape exists
 *
 * The original `finding_id` contract is consensus-round-scoped —
 * `<8hex>-<8hex>:<agent>:fN`. That is correct for a verdict about CODE, which is
 * what the format was designed for. It makes an entire class of lesson
 * unrecordable though: PROCESS failures have no consensus round and no cited
 * file:line. Recording one today requires inventing a filler consensus id whose
 * second half is literal padding, which is worse than no id at all — it fakes an
 * audit trail into a round that never existed.
 *
 * ## The grammar
 *
 *     session:<sessionId>:<slug>
 *
 * - literal `session:` prefix — a closed keyword, so the two accepted shapes are
 *   disjoint by their first token and can never be confused for one another.
 *   (`session` is not 8 hex chars, so no consensus id can collide with it.)
 * - `<sessionId>` — the session the mistake happened in. This is the analogue of
 *   the consensus id: the round-of-work the signal belongs to. Any SAFE_NAME
 *   string; session UUIDs and `YYYY-MM-DD-<short>` stamps both fit.
 * - `<slug>` — a stable, human-authored name for the lesson. This is the
 *   analogue of `fN`: it makes the id idempotent, so re-recording the same
 *   lesson overwrites one card instead of accumulating near-duplicates.
 *
 * Exactly two colon-separated components after the prefix — no more, no fewer.
 * A third component is rejected rather than ignored, because silently dropping
 * a component would make two different ids collapse to one lesson card.
 *
 * ## Path safety
 *
 * Both components become part of a filename: the card is written to
 * `.gossip/agents/<id>/memory/knowledge/lesson-session.<sessionId>.<slug>.<8hex>.md`
 * (`memory-writer.ts` `lessonCardSlug` — `.` is the flattening separator
 * because it is the one character `SAFE_NAME` can never emit, and the trailing
 * digest of the full id keeps long ids from colliding at the length cap).
 * They are therefore validated with the project's existing `SAFE_NAME` regex
 * (`packages/orchestrator/src/skill-engine.ts`) — the SAME regex used to gate
 * agent ids and skill categories, not a second copy that could drift. Validation
 * is FAIL-CLOSED: a path-unsafe component is REJECTED with a message, never
 * sanitized-and-accepted. Sanitizing would silently merge `../etc` and `etc`
 * into the same card.
 *
 * ## Required fields
 *
 * `operational_lesson` REQUIRES both a `finding_id` and a non-empty `lesson`.
 * The lesson text is the entire payload — the signal contributes nothing to any
 * score (see performance-reader.ts `case 'operational_lesson'`), so a
 * lesson-less operational signal is a row that can never be read back by
 * `gossip_remember` and never affects anything. That is noise, and the contract
 * rejects it up front rather than persisting it.
 *
 * ## `design_split` — the one signal that accepts BOTH grammars
 *
 * Issue #678. An unresolved design disagreement can arise in two places, and
 * both are legitimate:
 *
 *  - inside a consensus round, where the split has a real consensus id and the
 *    consensus-scoped shape is the accurate anchor; or
 *  - in a PARALLEL (non-consensus) dispatch, which produces no consensus id at
 *    all. Recording that split today required minting a synthetic
 *    `<taskA>-<taskB>` pair purely to satisfy the regex — the same "fake an
 *    audit trail" failure the session-scoped shape was introduced to end.
 *
 * So `design_split` accepts EITHER shape, unlike `operational_lesson` which is
 * session-only. That does not soften either grammar: each is still parsed by
 * its own validator and a value matching NEITHER is still rejected. It only
 * means the disjointness rule is stated per-signal — the shapes themselves stay
 * disjoint (a consensus id can never start with the literal `session:`), so
 * there is never ambiguity about which grammar a given id used.
 */

import { SAFE_NAME } from '@gossip/orchestrator';

/** The one signal name that carries an operator-authored process lesson. */
export const OPERATIONAL_LESSON_SIGNAL = 'operational_lesson';

/** Unresolved, defensible design disagreement between two agents (issue #678). */
export const DESIGN_SPLIT_SIGNAL = 'design_split';

/** Literal keyword that opens a session-scoped finding_id. */
export const OPERATIONAL_ID_PREFIX = 'session:';

/**
 * Record-surface signal names that are operational-class: `gossip_signals`
 * stamps `signal_class: 'operational'` on them and `performance-reader.ts`
 * drops them before every scoring pass, so they move no score for anyone.
 *
 * Deliberately a hand-listed set rather than a `classifySignal()` call. That
 * classifier also returns `'operational'` for auto-fired rows (`task_timeout`,
 * `transport_failure`, …) which the record surface does not accept, and
 * returns `'performance'` for the eight scoring names — stamping those would
 * flip previously-unstamped manual rows from the legacy category-absence
 * heuristic onto the explicit-stamp path and change circuit-breaker behaviour.
 * The narrow set keeps this PR's blast radius to the two names it adds.
 */
export const OPERATIONAL_RECORD_SIGNALS: ReadonlySet<string> = new Set([
  OPERATIONAL_LESSON_SIGNAL,
  DESIGN_SPLIT_SIGNAL,
]);

/** Human-readable description of BOTH accepted finding_id shapes. */
export const FINDING_ID_FORMS_HELP =
  'Expected one of: (a) a consensus-id prefix <8hex>-<8hex>:... ' +
  '(e.g. "b81956b2-e0fa4ea4:sonnet-reviewer:f1") for consensus signals, or ' +
  '(b) a session-scoped id session:<sessionId>:<slug> ' +
  '(e.g. "session:2026-07-26-a38286c2:relay-window-expired") for signal ' +
  '"operational_lesson" (session form REQUIRED) or "design_split" (either form ' +
  'accepted — use (b) for splits from a parallel, non-consensus dispatch). ' +
  'Both <sessionId> and <slug> must match ' +
  `${SAFE_NAME.source} (lowercase alphanumerics plus _ and -, max 63 chars).`;

/**
 * Parse outcome for a candidate session-scoped finding_id.
 *
 * `not_operational` is distinct from `invalid` on purpose: the caller must be
 * able to tell "this is a consensus id, go check it against the other regex"
 * apart from "this claims to be a session id and is malformed", so the second
 * case can be rejected with a precise reason instead of a generic message.
 */
export type OperationalIdParse =
  | { kind: 'not_operational' }
  | { kind: 'valid'; sessionId: string; slug: string }
  | { kind: 'invalid'; reason: string };

/** Parse `session:<sessionId>:<slug>`. Never throws; never sanitizes. */
export function parseOperationalFindingId(findingId: string): OperationalIdParse {
  if (typeof findingId !== 'string' || !findingId.startsWith(OPERATIONAL_ID_PREFIX)) {
    return { kind: 'not_operational' };
  }
  const parts = findingId.slice(OPERATIONAL_ID_PREFIX.length).split(':');
  if (parts.length !== 2) {
    return {
      kind: 'invalid',
      reason: `expected exactly 2 components after "${OPERATIONAL_ID_PREFIX}" (<sessionId>:<slug>), got ${parts.length}`,
    };
  }
  const [sessionId, slug] = parts as [string, string];
  if (!SAFE_NAME.test(sessionId)) {
    return { kind: 'invalid', reason: `<sessionId> "${sessionId}" is not a safe path segment` };
  }
  if (!SAFE_NAME.test(slug)) {
    return { kind: 'invalid', reason: `<slug> "${slug}" is not a safe path segment` };
  }
  return { kind: 'valid', sessionId, slug };
}

/** True when this signal name is the operator-authored process lesson. */
export function isOperationalLessonSignal(signal: string): boolean {
  return signal === OPERATIONAL_LESSON_SIGNAL;
}

/** True when this signal name records an unresolved design split. */
export function isDesignSplitSignal(signal: string): boolean {
  return signal === DESIGN_SPLIT_SIGNAL;
}

/** True when `gossip_signals` should stamp `signal_class: 'operational'`. */
export function isOperationalRecordSignal(signal: string): boolean {
  return OPERATIONAL_RECORD_SIGNALS.has(signal);
}

/**
 * True when this signal name may carry a session-scoped `finding_id`.
 *
 * Coincides with `OPERATIONAL_RECORD_SIGNALS` today, but is a SEPARATE
 * predicate on purpose: "is unscored" and "may use the session grammar" are
 * independent contracts that happen to hold for the same two names right now.
 * A future unscored signal that is always consensus-anchored would change one
 * and not the other.
 */
export function acceptsSessionScopedFindingId(signal: string): boolean {
  return isOperationalLessonSignal(signal) || isDesignSplitSignal(signal);
}

/** Minimal shape `validateOperationalLessonSignal` needs from a signal input. */
export interface OperationalLessonInput {
  signal: string;
  agent_id: string;
  finding_id?: string;
  lesson?: string;
}

/**
 * Gate the operational half of the finding_id contract.
 *
 * Returns an error string to return verbatim to the caller, or `null` when the
 * signal is fine to continue validating on the consensus path. Fail-closed in
 * every direction:
 *  - an `operational_lesson` MUST carry a valid session-scoped id and a lesson;
 *  - a `design_split` MAY carry either shape, but a MALFORMED session-scoped id
 *    is still rejected — "accepts either" never means "accepts anything";
 *  - any other signal must NOT carry a session-scoped id, so the two shapes
 *    cannot be used interchangeably to dodge either gate.
 *
 * The consensus-scoped shape is deliberately untouched by this function — it is
 * still validated by `FINDING_ID_PREFIX` in the handler, exactly as before.
 */
export function validateOperationalLessonSignal(s: OperationalLessonInput): string | null {
  const parsed = s.finding_id === undefined
    ? ({ kind: 'not_operational' } as const)
    : parseOperationalFindingId(s.finding_id);

  if (!isOperationalLessonSignal(s.signal)) {
    if (parsed.kind === 'invalid' && acceptsSessionScopedFindingId(s.signal)) {
      // Opted into the session grammar and got it wrong. Report the parse
      // reason rather than falling through to the consensus-prefix check,
      // whose message ("expected <8hex>-<8hex>") would misdiagnose it.
      return `Error: malformed finding_id "${s.finding_id}" (agent: ${s.agent_id}) — ${parsed.reason}. ${FINDING_ID_FORMS_HELP}`;
    }
    if (parsed.kind !== 'not_operational' && !acceptsSessionScopedFindingId(s.signal)) {
      return `Error: finding_id "${s.finding_id}" uses the session-scoped form, which is only valid for signals "${OPERATIONAL_LESSON_SIGNAL}" and "${DESIGN_SPLIT_SIGNAL}" (received "${s.signal}", agent: ${s.agent_id}). ${FINDING_ID_FORMS_HELP}`;
    }
    return null;
  }

  if (s.finding_id === undefined || s.finding_id.trim().length === 0) {
    return `Error: signal "${OPERATIONAL_LESSON_SIGNAL}" requires a finding_id (agent: ${s.agent_id}). ${FINDING_ID_FORMS_HELP}`;
  }
  if (parsed.kind === 'invalid') {
    return `Error: malformed finding_id "${s.finding_id}" (agent: ${s.agent_id}) — ${parsed.reason}. ${FINDING_ID_FORMS_HELP}`;
  }
  if (parsed.kind === 'not_operational') {
    return `Error: signal "${OPERATIONAL_LESSON_SIGNAL}" requires a session-scoped finding_id, got "${s.finding_id}" (agent: ${s.agent_id}). ${FINDING_ID_FORMS_HELP}`;
  }
  if (!s.lesson || s.lesson.trim().length === 0) {
    return `Error: signal "${OPERATIONAL_LESSON_SIGNAL}" requires a non-empty lesson (agent: ${s.agent_id}). The lesson text is the entire payload — the signal contributes nothing to any score, so a lesson-less operational signal is unreadable noise.`;
  }
  return null;
}
