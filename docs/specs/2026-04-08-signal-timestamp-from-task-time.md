# Spec — Signal timestamp must reflect task time, not record time

**Date:** 2026-04-08
**Owner:** orchestrator session
**Status:** v2 — implemented, includes consensus review feedback (haiku + gemini)
**Branch:** `fix/signal-timestamp-from-task-time`

## Problem

The circuit breaker in `packages/orchestrator/src/performance-reader.ts`
(`CIRCUIT_BREAKER_THRESHOLD = 3`, line 36; `circuitOpen` calc at line 510)
trips on **3 consecutive negative signals at the tail of an agent's signal
stream**. Negative signals are `hallucination_caught`, `disagreement`,
`unique_unconfirmed`.

The reader at `performance-reader.ts:434` already sorts each agent's
signals by `signal.timestamp` via `localeCompare` before walking the tail.
**That sort is currently a no-op for bulk-recorded signals.**

### Root cause

`apps/cli/src/mcp-server-sdk.ts:1826` (the `gossip_signals(action:"record")`
handler):

```ts
const timestamp = new Date().toISOString();   // ← ONCE, before the loop
const formatted = signals.map(s => ({
  ...s,
  timestamp,                                   // ← every signal gets the same value
}));
writer.appendSignals(formatted);
```

When the orchestrator bulk-records 5 backlogged consensus rounds in 30
seconds, all signals across all 5 rounds get the **same** ISO timestamp.
`localeCompare` returns 0 for every comparison, so the sort becomes a
no-op and append order determines the tail.

### Concrete incident

Session 2026-04-08, after manually triaging 5 stale consensus rounds:
1. I read the reports newest-first (`38ceed43` → ... → `c8dae78e`).
2. I recorded signals batch-by-batch in that read order.
3. The actual oldest round (`c8dae78e`, where sonnet-reviewer lost 2
   disputes) ended up at the tail of the append stream.
4. sonnet-reviewer's circuit breaker tripped: 5 consecutive negatives.
5. Dispatch weight collapsed from baseline to 0.30
   (`performance-reader.ts:99`).

The agent didn't degrade — the recorder's batched timestamp made the
chronology unrecoverable.

## Goal

Make the recorded `signal.timestamp` reflect the **time the underlying
task/consensus round actually happened**, not the wall-clock time at the
moment of recording, so the circuit breaker reflects real chronology.

## Non-goals

- Backfilling historical signals already in `agent-performance.jsonl`
  (deferred — see "Follow-ups" below).
- Changing `CIRCUIT_BREAKER_THRESHOLD` or the negative-signal set.
- Reworking the dispatch-weight formula.

## Design

### 1. Recorder change (primary fix)

**File:** `apps/cli/src/mcp-server-sdk.ts`
**Tool:** `gossip_signals` (action `record`)

#### Schema additions

Add two **optional** fields to the `gossip_signals` tool input schema:

- `task_start_time?: string` — ISO-8601, batch-level fallback. The
  orchestrator passes the consensus round's `report.timestamp` here when
  bulk-recording from a backlog.
- Per-signal `timestamp?: string` (already accepted on the
  `ConsensusSignal` type at `packages/orchestrator/src/consensus-types.ts:104`,
  but currently overwritten by the handler). Stop overwriting it.

#### Handler change

Replace lines around 1826 / 1862-1888:

```ts
// Before
const timestamp = new Date().toISOString();
const formatted = signals.map(s => ({ ...s, timestamp, /* ... */ }));

// After
const fallback = task_start_time ?? new Date().toISOString();
const formatted = signals.map(s => ({
  ...s,
  timestamp: s.timestamp ?? fallback,
  /* ... */
}));
```

Resolution priority per signal:
1. `s.timestamp` if the caller passed one (per-finding precision).
2. `task_start_time` if the caller passed one (per-batch precision).
3. `new Date().toISOString()` as last resort (live one-off corrections).

### 2. Reader tiebreaker (defensive)

**File:** `packages/orchestrator/src/performance-reader.ts:434`

```ts
// Before
agentSignals.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

// After
agentSignals.sort((a, b) => {
  const t = (a.timestamp || '').localeCompare(b.timestamp || '');
  if (t !== 0) return t;
  return (a.consensusId || '').localeCompare(b.consensusId || '');
});
```

When timestamps tie (e.g. legacy data, or two signals from the same
consensus round), break the tie by `consensusId` lexicographically. This
gives deterministic ordering within a round and is a no-op when
timestamps already differ.

### 3. Other batch-record sites — IN SCOPE (added in v2)

Spec v1 declared 5 paths "safe" because they record at the moment the
underlying event happens. Consensus review (haiku) caught that 3 of the
5 share the same root cause as the recorder bug — they batch-write
multiple signals with one shared `now`, so the reader's chronological
sort becomes a no-op for collisions in the same batch:

- **`apps/cli/src/handlers/collect.ts:150`** — auto-failure loop reused
  one `timestamp` across all failed-results signals. **FIXED:** prefer
  `r.completedAt` per result; fall back to `now + i ms` for strict
  ordering.
- **`packages/orchestrator/src/consensus-coordinator.ts:105`** —
  category-extraction loop reused one `now` for every category emitted
  in a single `synthesize()` call. **FIXED:** lift `baseMs` outside,
  emit each signal at `baseMs + i ms`.
- **`packages/tools/src/tool-server.ts:531`** — impl test signal +
  peer-review signal pair shared one `now`. **FIXED:** test signal at
  `baseMs`, peer-review signal at `baseMs + 1 ms` (test happens before
  review).

**Genuinely safe (unchanged):**

- `apps/cli/src/handlers/native-tasks.ts:77` — single signal per timeout
  event; no batch loop.
- `apps/cli/src/handlers/relay-cross-review.ts:40` — single signal per
  consensus-timeout event; no batch loop.

### 4. Timestamp validation — spoof rejection (added in v2)

Consensus review (gemini) caught that exposing `task_start_time` and
per-signal `timestamp` to callers without validation creates a
score-manipulation surface:

- **Park the tail:** record a positive signal with a far-future
  timestamp → permanent "good" tail → circuit breaker effectively
  disabled.
- **Bury negatives:** record negatives with very old timestamps → push
  them outside `SIGNAL_EXPIRY_DAYS` (30d) window or shift them away
  from the tail.

**Mitigation:** in the recorder, validate every caller-provided
timestamp against a sanity window of `[now - 30d, now + 1h]`. Reject
out-of-range or unparseable values with a clear error citing the field
and the bound that was violated. Implemented as a single
`validateTimestamp(ts, label)` helper applied to `task_start_time` and
each `signals[i].timestamp`.

## Test plan

### New tests

`tests/cli/mcp-signals-validation.test.ts` (additions):

1. **Per-signal timestamp respected:** record 3 signals with explicit
   `timestamp` fields → assert each row in JSONL has its own timestamp.
2. **`task_start_time` fallback applied:** record 3 signals without
   per-signal timestamp, with `task_start_time` set → all 3 get
   `task_start_time` (same value, but distinguishable from wall-clock).
3. **Wall-clock fallback last resort:** record 1 signal with no timestamp
   and no `task_start_time` → row gets a recent ISO timestamp.

`tests/orchestrator/performance-reader.test.ts` (additions):

4. **Bulk-record chronology bug regression:** seed 5 signals for one
   agent — 3 positive with old timestamps, 2 negative with newer
   timestamps → assert circuit is OPEN.
5. **Inverse:** seed 5 signals — 2 negative old, 3 positive new →
   assert circuit is CLOSED. (Today this fails because identical
   timestamps fall back to file order.)
6. **Tiebreaker:** seed signals with identical timestamps but different
   `consensusId` → sort is deterministic.

### Manual regression

After landing, retract this session's misordered sonnet-reviewer
hallucination/disagreement signals via `gossip_signals(action:retract)`
and re-record them with explicit `task_start_time` pulled from each
round's `consensus-reports/<id>.json` `timestamp` field. Verify
sonnet-reviewer's circuit re-closes via `gossip_scores`.

## Edge cases (already considered)

- **`signal_retracted`** at `mcp-server-sdk.ts:1810` continues to use
  wall-clock. It's not in `NEGATIVE_SIGNALS`, so it acts as a streak
  breaker — wall-clock is correct here.
- **Cross-round signals with same `taskId`** sort by their own
  timestamp; minor non-intuitive interleaving is acceptable.
- **Live one-off corrections** with no `task_start_time` and no
  `s.timestamp` continue to use wall-clock — correct.
- **Historical signals already in `agent-performance.jsonl`** still have
  collided timestamps from past bulk-records. Not fixed by this change;
  see Follow-ups.

## Follow-ups (out of scope)

- **F1.** Reader-side backfill: join `signal.consensusId` →
  `consensus-reports/<id>.json::timestamp` to retroactively fix
  historical collisions. Adds FS read per signal in the scoring hot
  path; only worth it if historical chronology matters.
- **F2.** Audit the 11 other signal-recording paths to confirm none are
  also vulnerable to bulk-import chronology drift.
- **F3.** Add a `gossip_signals(action:rewrite_timestamps)` admin tool
  to repair existing JSONL data once F1 is implemented.
- **F4.** Memory entry: structural lesson — bulk-recording skews
  chronology; live recording is preferable.

## Acceptance criteria

- [ ] `gossip_signals` tool schema accepts `task_start_time` and
      per-signal `timestamp`.
- [ ] Recorder no longer overwrites caller-provided per-signal
      timestamps.
- [ ] Reader sort has deterministic tiebreaker on `consensusId`.
- [ ] All 6 new tests pass; existing tests still pass.
- [ ] Sonnet-reviewer's circuit can be re-closed by retract +
      re-record with proper timestamps.
- [ ] PR opened against `master` from `fix/signal-timestamp-from-task-time`.

## Estimated diff size (v2 actual)

~95 LOC across 5 source files + ~180 LOC of tests:

- `apps/cli/src/mcp-server-sdk.ts` — schema additions, validation helper,
  resolver, per-signal timestamp wiring (~50 LOC)
- `packages/orchestrator/src/performance-reader.ts` — secondary sort key
  (~5 LOC)
- `apps/cli/src/handlers/collect.ts` — per-result timestamp (~6 LOC)
- `packages/orchestrator/src/consensus-coordinator.ts` — per-category
  offset (~5 LOC)
- `packages/tools/src/tool-server.ts` — distinct test/peer-review
  timestamps (~5 LOC)

No schema changes to `agent-performance.jsonl` (the `timestamp` field
already exists as a free-form `string`).
