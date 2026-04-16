# Hallucination decay tune + category consistency

**Status:** proposal
**Date:** 2026-04-16
**Consensus:** `cc27bc83-a4254482` (3 agents, 17 confirmed, 2 unique-cross-confirmed, 0 disputed)

## Problem

Gemini-reviewer's dashboard accuracy is **0.28** while recent raw accuracy is **0.915** (7d, post-skill-binding). Simulated accuracy over its 831-signal history matches the dashboard within 0.03:

- `rawAccuracy` (post-task-decay) = 0.895
- `weightedHallucinations` = 8.20
- `hallucinationMultiplier = 1 / (1 + 8.20 * 0.3)` = 0.289
- Composed accuracy = 0.259 ≈ dashboard 0.28

The drag is the **hallucination penalty** with `DECAY_HALF_LIFE = 50 tasks` applied uniformly to all signal types. Old hallucinations age out at the same rate as agreements, so an agent that has demonstrably improved (4 halluc / last 142 signals vs 46 / lifetime) still carries old-mistake weight.

A separate, orthogonal bug was surfaced during consensus review: empty-string `signal.category` is silently ignored in two places (`computeScores`) but accepted in a third (`getCountersSince`).

## Not the problem

- **Diversity-drag fix already shipped** in PR #70 (50fe41e, 2026-04-15). All three `diversityMul` application sites are symmetric at `performance-reader.ts:387-408`.
- **Skill-gated hallucination recovery** (per `project_skill_gated_recovery.md`) was reviewed and **deferred**. It would duplicate the existing `check-effectiveness.ts` verdict system (MIN_EVIDENCE=120 statistical gate vs a new 3-signal gate), and the pending-verdict interaction is unspecified. Revisit only if decay-tune proves insufficient over 30 days.

## Scope of this change

Three small, independently-verifiable changes:

### 1. Separate decay half-life for hallucinations

`packages/orchestrator/src/performance-reader.ts`

- Add `HALLUCINATION_DECAY_HALF_LIFE = 20` next to the existing `DECAY_HALF_LIFE = 50` at `:279-281`.
- In the `hallucination_caught` switch case at `:442-453`, compute a separate `hallucDecay = Math.pow(0.5, tasksSince / HALLUCINATION_DECAY_HALF_LIFE)` and use it for `a.weightedHallucinations += severity * hallucDecay`. The `a.weightedTotal += decay` on line 448 keeps the original decay so the raw accuracy ratio stays calibrated against all signal types equally.

Expected impact (simulated):
- gemini-reviewer: 0.28 → ~0.52
- sonnet-reviewer: marginal (12 lifetime halluc, mostly recent)
- haiku-researcher: marginal (18 lifetime halluc, mixed age)

### 2. Empty-string category consistency

`packages/orchestrator/src/performance-reader.ts:161`

Currently `normalizeSkillName(s.category ?? '')` accepts empty strings as a valid category for comparison. The other two category sites (`:392`, `:450`) use `if (signal.category)` which rejects empty strings. Align to the rejection behavior:

```ts
// :161 — before
if (normalizeSkillName(s.category ?? '') !== normalizedTarget) continue;

// :161 — after
if (!s.category) continue;
if (normalizeSkillName(s.category) !== normalizedTarget) continue;
```

This prevents an empty-string category in `normalizedTarget` from matching empty-string signals (a cross-contamination edge case).

### 3. Category enforcement on `hallucination_caught` emit sites

`packages/orchestrator/src/consensus-engine.ts` and `packages/orchestrator/src/mcp-server-sdk.ts`

Audit every path that writes `signal: 'hallucination_caught'` to `.gossip/agent-performance.jsonl`. If `category` is not derivable from the finding content (via `extractCategories`), log a warning and drop the signal rather than write it with missing category. This closes the 47% category-less-halluc data gap going forward. **Legacy signals are not backfilled** (per consensus f8 — `PerformanceReader` has no access to consensus reports).

## Tests

`tests/orchestrator/performance-reader.test.ts` and `tests/orchestrator/performance-reader-category-accuracy.test.ts`:

- **halluc-decay-20**: agent with hallucination 20 tasks ago has half the `weightedHallucinations` of the same signal at `DECAY_HALF_LIFE=50`. Accuracy recovers proportionally.
- **empty-category-rejected**: signal with `category: ''` is not counted by `getCountersSince` (aligns with `computeScores` behavior).
- **category-undefined-legacy**: signal with `category: undefined` still increments `weightedHallucinations` (legacy-accept per f8).

## Non-goals

- Skill-gated hallucination recovery (deferred — see `cc27bc83-a4254482:f12`, `f16`)
- Backfilling legacy hallucination signals with category (deferred — see `cc27bc83-a4254482:f8`)
- Tuning the `0.3` penalty coefficient (`hallucinationMultiplier`) — the decay tune alone covers the observed case

## Validation plan

After merge, watch gemini-reviewer's dashboard accuracy for 7 days. Expected trajectory:
- T+0: 0.28 (pre-merge baseline)
- T+0 post-merge: ~0.52 (decay tune takes effect immediately — all existing halluc signals reweight)
- T+7d: 0.55-0.65 if no new halluc, or drops if new halluc accumulate

If gemini stays below 0.50 after 7 days, reopen the skill-gated recovery discussion with a fresh spec resolving pending-vs-passed + backfill policy.
