---
status: proposal
---

# Cross-round finding dedupe — content-anchored key

## Problem

`finding_id` is `<consensusId>:<agentId>:fN`. `consensusId` is fresh per round (`consensus-engine.ts:627`), so the same bug rediscovered in a new consensus round gets a new finding_id. Current dedup at `apps/cli/src/mcp-server-sdk.ts:2430-2452` is exact string match on `finding_id` — it doesn't catch cross-round semantic duplicates. Estimated 50-100 duplicate signals already in `.gossip/agent-performance.jsonl` with ~15-25% cross-round re-discovery rate.

## Design discussion

Three options (C1 strict line+category, C2 10-line bucket, C3 line+snippet-fallback) evaluated in parallel by three agents (dispatches `2ccd021c`, `ea9ee175`, `9065d90f`, 2026-04-17):

- **C1 REJECTED** — line-ranges truncate to start line in `ANCHOR_PATTERN` (`parse-findings.ts:31`); false-negative rate high under active dev.
- **C2 REJECTED** — gemini found real historical collision: `cross-reviewer-selection.ts:107-113` (starvation bug) and `:105,110` (Math.min crash) both hash to bucket 10 — distinct bugs collapsing.
- **C3 RECOMMEND with reservations** — snippet fallback catches line-drift but boilerplate risk is high ("missing bounds check" across unrelated findings). Mitigation: gate snippet path by agentId+category.
- **Blocker for all** — `category` is not persisted in `.gossip/implementation-findings.jsonl`. Keys present: `[timestamp, taskId, originalAgentId, confirmedBy, finding, tag, confidence, status, resolvedAt]`.

Converging signal: content must anchor the key; location is too noisy; category alone is too coarse.

## Proposed design — D: content-anchored

### Key formula

```
dedupeKey = sha256(agentId + "\x00" + normalizedFilePath + "\x00" + firstNormalized32Chars(findingContent) + "\x00" + category)
```

- **agentId** — required. No cross-agent dedup.
- **normalizedFilePath** — file from first `<cite tag="file">` citation via `ANCHOR_PATTERN` (`parse-findings.ts:31`). Absent citation → dedup disabled for that signal.
- **firstNormalized32Chars(content)** — lowercased, collapsed whitespace, trimmed first 32 chars of finding body. Content anchors the identity; drops lineNumber entirely (absorbs refactor drift).
- **category** — requires the prerequisite fix below. Distinguishes `missing bounds check` in file A (concurrency) vs file B (input_validation).

### Short-content fallback

If normalized content < 32 chars, **dedup disabled for that finding** (safer than false-collision). Logged one line to stderr.

### Prerequisite — persist category

The current writer drops `ParsedFinding.category` before serialization (`parse-findings.ts:186` types it but no persistence site writes it). Fix: emit `category` into the jsonl record next to existing fields. ~5 LOC at the writer + regen logic tolerant of legacy rows without the field.

### Insertion point

`apps/cli/src/mcp-server-sdk.ts:2430-2452`. Before the existing exact-`findingId` filter, compute `dedupeKey` for each incoming signal and check against a `Set` built from prior signals. Reject matches; return receipt showing dropped keys and the matching prior `finding_id`.

### What stays unchanged

- `finding_id` format and generation — unchanged. Dedup operates alongside, not in place of.
- Within-round semantic dedupe (`consensus-engine.ts:1743-1835`) — unchanged.
- Cross-reviewer selection — unchanged.
- Legacy signals without `category` — tolerated; dedup uses empty-string category for those. May produce rare false-matches bootstrapping until new signals dominate.

## Non-goals

- Don't rewrite finding_id. Round-scoped IDs are still useful for audit + cross-review back-pointers.
- Don't backfill legacy signals. New dedup applies forward only.
- Don't dedup across agents. Two agents reporting the same bug in the same round is the normal cross-confirm path, not a duplicate.

## Test plan

- Unit: `computeDedupeKey()` — stable hash for identical inputs, different hash for distinct content, disabled when content < 32 chars.
- Unit: file-path normalization — `/abs/pkg/foo.ts` and `pkg/foo.ts` match (relative).
- Unit: category present vs absent — both work, absent degrades gracefully.
- Integration: signal-record handler rejects the second of two signals with same dedupe key, returns receipt with prior `finding_id`.
- Integration: category is persisted to `implementation-findings.jsonl` on new findings.
- Regression: existing exact-`findingId` dedup still fires when finding_id repeats (don't break the current path).

## Implementation estimate

- Prod: ~25 LOC across `mcp-server-sdk.ts` (dedup gate + key helper import) + `<writer>.ts` (category persist) + new `packages/orchestrator/src/dedupe-key.ts` (key builder, ~40 LOC).
- Tests: ~80 LOC.

## References

- Research dispatch `199a4a6f` (haiku) — problem surface + empirical duplicate rate.
- Design reviews `2ccd021c` (sonnet C1), `ea9ee175` (gemini C2), `9065d90f` (haiku C3).
- Ground truth: `.gossip/implementation-findings.jsonl` schema verified missing `category`.
- `apps/cli/src/mcp-server-sdk.ts:2430-2452` — insertion point.
- `packages/orchestrator/src/parse-findings.ts:31,186` — ANCHOR_PATTERN + `ParsedFinding.category`.
- `packages/orchestrator/src/consensus-engine.ts:1743-1835` — existing within-round Jaccard dedup.
