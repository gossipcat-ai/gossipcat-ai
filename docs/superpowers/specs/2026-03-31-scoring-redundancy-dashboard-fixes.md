# Scoring, Redundancy & Dashboard Fixes

**Date:** 2026-03-31
**Status:** Approved
**Source:** Consensus review (3 agents, 13 confirmed, 1 partial, 1 refuted)

## Batch A: Critical Scoring Bugs (F1, F3, F11)

### F1: retractSignal doesn't exist on PerformanceWriter
**File:** `apps/cli/src/handlers/native-tasks.ts:181`
**Bug:** Calls `writer.retractSignal()` which throws TypeError, silently caught. Agents permanently penalized for late relay.
**Fix:** Replace with `writer.appendSignals([{ type: 'consensus', signal: 'signal_retracted', agentId, taskId, ... }])` pattern used in `mcp-server-sdk.ts:1211-1218`.

### F3: Double signal writes for consensus findings
**File:** `apps/cli/src/handlers/collect.ts:186-222`
**Bug:** `runConsensus()` (dispatch-pipeline.ts:975) writes consensus engine signals. Then collect.ts writes provisional signals from the same report. Double-counted.
**Fix:** Provisional signals should only cover findings that DON'T have a corresponding signal from the engine. The consensus engine writes agreement/disagreement/unverified signals per cross-review entry. Provisional signals should only cover the TAG-level summary (confirmed/disputed/unique/unverified) for the ORIGINAL author — not re-signal what cross-reviewers already generated. Filter: skip findings whose `originalAgentId` already has a signal in `consensusReport.signals`.

### F11: totalSignals double-count on disagreement winner
**File:** `packages/orchestrator/src/performance-reader.ts:217`
**Bug:** Winner gets `totalSignals++` at line 217 as counterpart AND at line 188 when processing their own signal row.
**Fix:** Remove `winner.totalSignals++` at line 217. The winner's own signal row at line 188 already counts it.

## Batch B: Scoring Design Improvements (F9, F10)

### F9: Time decay permanent penalty for bad agents
**File:** `packages/orchestrator/src/performance-reader.ts:302`
**Current:** `if (reliability >= 0.5)` gates time decay. Bad agents never recover.
**Fix:** Apply slow decay for all agents, but at different rates. Good agents decay toward 0.5 (lose edge). Bad agents decay toward 0.5 (slow rehabilitation). Use a longer half-life for bad agents (e.g., 21 days vs 7 days for good).

### F10: Dispatch weight ignores signal volume confidence
**File:** `packages/orchestrator/src/performance-reader.ts:73-79`
**Current:** Once above 3 signals, volume is irrelevant.
**Fix:** Add a confidence factor: `confidence = 1 - Math.exp(-totalSignals / 10)`. Blend reliability toward 0.5 based on confidence: `adjusted = 0.5 + (reliability - 0.5) * confidence`. This means 3 signals → confidence ~0.26 (mostly neutral), 10 → ~0.63, 30 → ~0.95.

## Batch C: Pipeline Dedup (F2, F4, F5, F6)

### F2: Two diverging scoring pipelines
**Files:** `performance-reader.ts:297` and `competency-profiler.ts:204`
**Bug:** Different blend ratios (0.8/0.2 vs 0.7/0.3) and CompetencyProfiler doesn't filter expired/retracted signals.
**Fix:** CompetencyProfiler should delegate signal reading to PerformanceReader instead of re-implementing it. Extract shared constants for DECAY_HALF_LIFE and clamp(). Align blend ratio to 0.8/0.2 (PerformanceReader's value — the canonical one).

### F4: task-graph-sync reads wrong fields
**File:** `packages/orchestrator/src/task-graph-sync.ts:157`
**Bug:** Posts `entry.scores?.relevance` which doesn't exist in agent-performance.jsonl.
**Fix:** Read the actual signal fields (`entry.signal`, `entry.agentId`, `entry.taskId`) and post those. Or delegate to PerformanceReader to get computed scores per agent.

### F5: Consensus >=2 gate duplicated
**Files:** `dispatch-pipeline.ts:658` and `collect.ts:148`
**Fix:** Extract `MIN_AGENTS_FOR_CONSENSUS = 2` constant to types.ts. Both files import it.

### F6: writeMemoryForTask duplicates collect() memory write
**File:** `dispatch-pipeline.ts:826-856`
**Fix:** Extract a private `_postTaskComplete(task)` helper that both `collect()` and `writeMemoryForTask()` call.

## Batch D: Dashboard UI (F12, F13, F14, F15)

### F12: Ring viz hides reliability/uniqueness
**File:** `packages/dashboard/src/hub/team.js:33`
**Fix:** Add small stat bars below each agent ring showing all 4 scores (accuracy, reliability, uniqueness, dispatch weight) as labeled horizontal bars.

### F13: Signal history is flat list
**File:** `packages/dashboard/src/detail/signals.js:68`
**Fix:** Add a simple sparkline above the signal list: group signals by day, count positive vs negative per day, render as colored dots or mini bar chart.

### F14: Consensus pills show absolute counts
**File:** `packages/dashboard/src/hub/activity.js:29`
**Fix:** Add a stacked bar next to the pills showing proportional breakdown (confirmed/disputed/unverified/unique as colored segments).

### F15: innerHTML concatenation
**File:** `packages/dashboard/src/app.js` and others
**Fix:** Add `escapeHtml()` calls where missing. Full framework migration is out of scope — the dashboard is a lightweight internal tool. Focus on ensuring all dynamic data passes through escapeHtml.

## Not fixing
- F7 (uniqueness saturation): PARTIAL — the formula is sound, diminishing returns are intentional.
- F8 (hallucination penalty binary): REFUTED — the penalty IS graduated exponential.

## Test Plan
- F1: Verify late relay correctly appends signal_retracted entry
- F3: Count signals in agent-performance.jsonl after consensus — should not double-count
- F11: After disagreement, winner.totalSignals should not exceed their actual signal count
- F9: Bad agent (reliability 0.3) should slowly recover toward 0.5 over weeks
- F10: Agent with 3 signals should have lower weight than agent with 30 signals at same accuracy
- F2: CompetencyProfiler scores should match PerformanceReader for same agent
- Existing test suite passes
