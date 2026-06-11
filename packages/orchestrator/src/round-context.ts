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
 * The known code union for round-level warnings. The PR-A boundary producer
 * uses ONLY `roots_rejected` / `roots_empty_after_validation`; the remaining
 * named codes are the PR-B producer conversions per spec §6.1/§4:
 *   - `anchor_master_fallback` — citation resolved against project root, not the
 *     worktree (alongside the `via="⚠ resolved against project root…"` anchor
 *     note; one warning per resolved-from-project-root anchor instance, no dedup).
 *   - `cross_review_skipped` — a relay agent's Phase-2 cross-review was skipped
 *     (quota / parse / network); dual-written with `report.relayCrossReviewSkipped`.
 *   - `coverage_degraded` — at least one dispatched agent returned a 0-char /
 *     sentinel response; dual-written with `report.coverageDegraded`.
 *   - `partial_review` — at least one finding received fewer than its target K
 *     cross-reviewers; dual-written with `report.partialReview`.
 *   - `zero_tags` — an agent relayed a consensus result carrying zero
 *     `<agent_finding>` tags; dual-written with the relay-lint receipt line.
 *   - `round_restore_malformed` — a persisted round record carried a malformed
 *     field shape that was dropped on restore (relay-cross-review restore path).
 *
 * The trailing `(string & {})` is an INTENTIONAL open extension point: it keeps
 * autocomplete on the named codes while letting a future PR-B producer emit a
 * not-yet-enumerated code without a compile error against this union (and
 * without editing this PR-A file). Unknown codes still render in the drain block
 * (it iterates, not switches), so they reach the operator rather than slipping
 * past silently.
 */
export type RoundWarningCode =
  | 'roots_rejected'
  | 'roots_empty_after_validation'
  | 'anchor_master_fallback'
  | 'cross_review_skipped'
  | 'coverage_degraded'
  | 'partial_review'
  | 'zero_tags'
  | 'round_restore_malformed'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

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
   * The FIELD REFERENCE is readonly (cannot reassign), symmetric with the
   * `warnings` field below and the array element-readonly already on the type.
   */
  readonly resolutionRoots: readonly string[];

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
 * Type guard: is `value` a structurally-valid RoundContext? Used at union
 * boundaries (e.g. `coordinator.runConsensus(results, roundOrRoots)`) where the
 * alternative is a `readonly string[]`. A bare `!Array.isArray` check is NOT
 * sufficient — any non-array object ({}, a Map, a Date) would slip through and
 * be cast to RoundContext, then read `.resolutionRoots` as undefined and
 * silently fall through to empty roots (the exact stale-anchor bug class this
 * carrier exists to prevent). Validates the two required-shape fields:
 * `resolutionRoots` is an array and `warnings` is an array.
 */
export function isRoundContext(value: unknown): value is RoundContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { resolutionRoots?: unknown }).resolutionRoots) &&
    Array.isArray((value as { warnings?: unknown }).warnings)
  );
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
