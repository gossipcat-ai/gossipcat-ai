# Signal Validation at Ingestion

**Date:** 2026-03-30
**Status:** Design approved
**Consensus:** 3/3 agents agreed on Option C (sonnet-reviewer, haiku-researcher, gemini-reviewer)

## Problem

`agent-performance.jsonl` has 304 signals. 46 (15%) have empty `taskId`, 221 (73%) are missing `consensusId`, 23 have empty `evidence`. `PerformanceWriter.appendSignal()` does zero validation — raw `appendFileSync`. The reader compensates with `taskId || timestamp` fallback, which breaks retraction matching and consensus grouping.

Consequences:
- **Retraction is broken** for empty-taskId signals — retraction key uses retraction's timestamp, original uses original's timestamp, keys never match
- **Decay is incoherent** for manual signals — synthetic `manual-*` taskIds create isolated decay buckets disconnected from real tasks
- **Scoring is skewed** by signals that can't be retracted or grouped

## Approach: Option C — Two-Layer Validation

### Layer 1: PerformanceWriter (hard schema)

The writer rejects any signal missing required structural fields. This is the last line of defense — no bad data reaches disk.

**Required fields (all signal types):**

| Field | Rule | Why |
|-------|------|-----|
| `type` | Must be `'consensus'`, `'impl'`, or `'meta'` | Reader filters on type |
| `agentId` | Non-empty string | Scoring keys on this |
| `taskId` | Non-empty string | Retraction matching, decay bucketing |
| `signal` | Known enum value per type | Unknown values silently dropped by reader |
| `timestamp` | Valid ISO-8601 string | Signal expiry, circuit breaker |

**Validation function:** A `validateSignal(signal: PerformanceSignal)` function that throws on violation. Called in both `appendSignal()` and `appendSignals()` before writing.

**On validation failure:** Throw with a descriptive message. Callers must fix their signal construction. Do NOT silently drop — silent drops are how we got here.

### Layer 2: Ingestion Points (business rules)

Each caller validates context-specific rules before calling the writer.

#### ConsensusEngine (consensus-engine.ts)

- Assert `agentTaskIds.get(agentId)` is defined and non-empty before constructing signal. If undefined, log a warning and use `unknown-${consensusId}-${agentId}` as a recoverable fallback (better than empty string).
- Always attach `consensusId` — the engine generates it, so there's no excuse for omission.
- Cap `evidence` length at 2000 chars to prevent unbounded file growth from LLM output.

#### gossip_record_signals (mcp-server-sdk.ts)

- Accept optional `task_id` parameter from the caller. When provided, use it as the real `taskId` to link manual signals to the task that triggered the review.
- When no `task_id` provided, generate `manual-${timestamp}-${i}` as today (backward compatible).
- Require non-empty `evidence` for `hallucination_caught` and `disagreement` signals — these are punitive and must be auditable.

#### gossip_retract_signal (mcp-server-sdk.ts)

- Remove the `as any` cast on `signal_retracted` — it's already in the union type.
- Validate that `task_id` is non-empty before writing retraction.

### Conditional field requirements (enforced at ingestion)

| Field | Required when | Why |
|-------|--------------|-----|
| `evidence` | `signal` in `{hallucination_caught, disagreement}` | Punitive signals need audit trail |
| `counterpartId` | `signal` in `{agreement, disagreement}` | Winner-gets-credit logic no-ops without it |

### Optional fields (no enforcement)

| Field | Reason |
|-------|--------|
| `consensusId` | Manual signals legitimately lack it |
| `skill` | Not used in scoring |
| `outcome` | Only meaningful for `hallucination_caught`; default severity is fine |
| `category` | Not used in scoring |

## Migration Strategy

**Principle:** Append-only. Do not rewrite the file — it's an audit log.

1. **46 empty-taskId signals:** Write `signal_retracted` entries for each, keyed by `agentId + timestamp` (the only matching key available). This removes them from scoring. They age out in 30 days.
2. **221 missing-consensusId signals:** No action. The reader doesn't group by `consensusId` today. These age out naturally.
3. **23 empty-evidence signals:** No action. Evidence isn't used in scoring math.
4. **After migration:** Remove the `taskId || timestamp` fallback from `PerformanceReader`. With validation enforcing non-empty `taskId`, the fallback is dead code.

## Bonus Bug Fixes (in scope)

These were discovered during the consensus review and directly relate to signal quality:

1. **`verifyCitations` false positives** (consensus-engine.ts:517-519) — catch block returns `true` (fabricated) on any I/O error. Fix: return `false` on I/O errors (benefit of doubt), only return `true` on confirmed non-existence.
2. **`as any` cast on `signal_retracted`** (mcp-server-sdk.ts:1987) — remove it, the value is already in the union type.

## Out of Scope

- File size eviction/rotation — important but separate concern (unbounded growth)
- `consensusId` grouping in the reader — no reader changes until legacy signals age out
- O(n^2) dedup in ConsensusEngine — no observed impact at current scale
- mtime cache staleness — filesystem-dependent, low priority

## Files to Change

| File | Change |
|------|--------|
| `packages/orchestrator/src/performance-writer.ts` | Add `validateSignal()`, call before every write |
| `packages/orchestrator/src/consensus-types.ts` | No change — types already cover the schema |
| `packages/orchestrator/src/consensus-engine.ts` | Assert taskId non-empty, cap evidence length, fix verifyCitations catch |
| `apps/cli/src/mcp-server-sdk.ts` | Add optional `task_id` param to record_signals, require evidence for punitive signals, remove `as any` cast |
| `packages/orchestrator/src/performance-reader.ts` | Remove `taskId \|\| timestamp` fallback after migration |
| `tests/orchestrator/performance-writer.test.ts` | New — validation tests |
| `tests/orchestrator/signal-types.test.ts` | Extend with conditional field tests |

## Test Plan

- Writer rejects signal with empty `taskId` (throws)
- Writer rejects signal with invalid `timestamp`
- Writer rejects signal with unknown `signal` enum
- Writer accepts valid signal for each type (consensus, impl, meta)
- ConsensusEngine never produces empty `taskId` — mock agent not in map, verify fallback
- `gossip_record_signals` requires evidence for `hallucination_caught`
- `gossip_record_signals` accepts optional `task_id` and uses it
- `verifyCitations` returns `false` on I/O error (not `true`)
- Retraction works for signals with real `taskId`
- Migration script produces valid retraction entries for empty-taskId signals
