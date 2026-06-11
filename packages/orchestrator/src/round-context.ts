/**
 * RoundContext — single carrier for per-consensus-round state that today is
 * threaded as a loose `resolutionRoots?: readonly string[]` through five
 * separate door boundaries (collect handler, dispatch handler, coordinator,
 * pipeline, engine). This is the alias-mode introduction (PR-A): every call
 * site that accepts `resolutionRoots` gains an OPTIONAL `round?: RoundContext`
 * alongside it. When `round` is present it WINS; when absent, the legacy
 * `resolutionRoots` path behaves byte-identically. PR-C removes the aliases.
 *
 * Spec: 2026-06-11-round-context-fail-loud.md §3.1, consensus 5e9804d3-91fe440d.
 */

/**
 * The closed code union for round-level warnings. New codes are added here, not
 * invented at producer sites — an unknown code string would silently slip past
 * the drain renderer's switch and never reach the operator. Only the boundary
 * producer (roots_rejected / roots_empty_after_validation) is wired in PR-A;
 * the remaining codes are reserved for PR-B producer conversions
 * (relayCrossReviewSkipped → coverage_degraded, partialReview → partial_review).
 */
export type RoundWarningCode =
  | 'roots_rejected'
  | 'roots_empty_after_validation'
  | 'coverage_degraded'
  | 'partial_review'
  | 'relay_cross_review_skipped';

/**
 * A single fail-loud warning produced during a consensus round. `agentId` is
 * present only when the warning is attributable to a specific agent (e.g. a
 * skipped relay cross-review); root-level warnings (rejected resolutionRoots)
 * omit it.
 */
export interface RoundWarning {
  code: RoundWarningCode;
  message: string;
  agentId?: string;
}

/**
 * Per-round consensus context. Construct one at each trust boundary
 * (MCP collect/dispatch handlers, ToolRouter) immediately AFTER input
 * validation, and thread it through the consensus call chain.
 */
export interface RoundContext {
  /**
   * The consensus round id, when known at construction time. OPTIONAL — the
   * id is sometimes minted downstream (the engine derives it from
   * `report.signals[0]?.consensusId` or a fresh `randomUUID().slice(0,12)`),
   * so boundaries that build a RoundContext before synthesis legitimately omit
   * it. Never throw on absence; a RoundContext without a consensusId is valid.
   */
  consensusId?: string;

  /**
   * Post-validation, post-realpath citation resolution roots. INVARIANT: every
   * entry is an absolute, realpath'd path — validation lives at the MCP
   * boundary (`validateResolutionRoot`). An empty array means "resolve against
   * project root only" and is the correct shape for boundaries that have no
   * roots (e.g. ToolRouter's in-process consensus). NEVER undefined: use `[]`.
   */
  resolutionRoots: readonly string[];

  /**
   * Optional per-agent (or per-key) descriptive lenses. PLAIN OBJECT, never a
   * Map — this record is persisted to disk inside the pending-consensus JSON
   * and read back across /mcp reconnects, so it must survive a
   * `JSON.stringify`/`JSON.parse` round-trip intact. A Map serializes to `{}`
   * and would silently drop every lens.
   */
  lenses?: Readonly<Record<string, string>>;

  /**
   * Fail-loud warnings accumulated during the round. The FIELD REFERENCE is
   * readonly (you cannot reassign `round.warnings = [...]`), but the array
   * CONTENTS are mutable: producers append in place via `warnings.push(...)`.
   * By convention this array is APPEND-ONLY — never spliced, reordered, or
   * deduped. The drain copies it into `ConsensusReport.warnings` at synthesis
   * and renders it in the gossip_collect tool response. Storing duplicates is
   * intentional: each push records a distinct rejection event.
   */
  readonly warnings: RoundWarning[];
}

/**
 * Construct a RoundContext from a partial. Fills the two required-shape fields
 * (`resolutionRoots` defaults to `[]`, `warnings` defaults to a fresh array) so
 * callers can pass only what they have. The returned object's `warnings` array
 * is always a NEW array unless the caller supplied one — never a shared
 * singleton — so two rounds never alias each other's warnings.
 */
export function makeRoundContext(
  partial: {
    consensusId?: string;
    resolutionRoots?: readonly string[];
    lenses?: Readonly<Record<string, string>>;
    warnings?: RoundWarning[];
  } = {},
): RoundContext {
  return {
    ...(partial.consensusId !== undefined ? { consensusId: partial.consensusId } : {}),
    resolutionRoots: partial.resolutionRoots ?? [],
    ...(partial.lenses !== undefined ? { lenses: partial.lenses } : {}),
    warnings: partial.warnings ?? [],
  };
}

/**
 * Test fixture helper — a RoundContext with sensible defaults, overridable per
 * field. Exported for tests; production code uses `makeRoundContext`.
 */
export function testRound(overrides: Partial<RoundContext> = {}): RoundContext {
  return {
    consensusId: overrides.consensusId,
    resolutionRoots: overrides.resolutionRoots ?? [],
    lenses: overrides.lenses,
    warnings: overrides.warnings ?? [],
  };
}
