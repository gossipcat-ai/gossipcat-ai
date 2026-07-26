/**
 * Operational (session-scoped) `finding_id` grammar for `gossip_signals`.
 * Issue #668.
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
 * `.gossip/agents/<id>/memory/knowledge/lesson-session_<sessionId>_<slug>.md`.
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
 */

import { SAFE_NAME } from '@gossip/orchestrator';

/** The one signal name that carries an operator-authored process lesson. */
export const OPERATIONAL_LESSON_SIGNAL = 'operational_lesson';

/** Literal keyword that opens a session-scoped finding_id. */
export const OPERATIONAL_ID_PREFIX = 'session:';

/** Human-readable description of BOTH accepted finding_id shapes. */
export const FINDING_ID_FORMS_HELP =
  'Expected one of: (a) a consensus-id prefix <8hex>-<8hex>:... ' +
  '(e.g. "b81956b2-e0fa4ea4:sonnet-reviewer:f1") for consensus signals, or ' +
  '(b) a session-scoped id session:<sessionId>:<slug> ' +
  '(e.g. "session:2026-07-26-a38286c2:relay-window-expired") for signal ' +
  '"operational_lesson". Both <sessionId> and <slug> must match ' +
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
 * both directions:
 *  - an `operational_lesson` MUST carry a valid session-scoped id and a lesson;
 *  - a NON-operational signal must NOT carry a session-scoped id, so the two
 *    shapes cannot be used interchangeably to dodge either gate.
 *
 * The consensus-scoped shape is deliberately untouched by this function — it is
 * still validated by `FINDING_ID_PREFIX` in the handler, exactly as before.
 */
export function validateOperationalLessonSignal(s: OperationalLessonInput): string | null {
  const parsed = s.finding_id === undefined
    ? ({ kind: 'not_operational' } as const)
    : parseOperationalFindingId(s.finding_id);

  if (!isOperationalLessonSignal(s.signal)) {
    if (parsed.kind !== 'not_operational') {
      return `Error: finding_id "${s.finding_id}" uses the session-scoped form, which is only valid for signal "${OPERATIONAL_LESSON_SIGNAL}" (received "${s.signal}", agent: ${s.agent_id}). ${FINDING_ID_FORMS_HELP}`;
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
