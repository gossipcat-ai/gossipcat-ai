# DX Overhaul — Tool Consolidation & Native Auto-Relay

**Date:** 2026-03-31
**Status:** Draft
**Consensus:** 3/3 agents recommended Approach C (Hybrid)

## Problem

Gossipcat's MCP tool surface has grown to 27 tools with overlapping functionality, confusing dispatch paths, and silent failure modes. The core DX issues:

1. **27 tools** — new users can't distinguish `gossip_dispatch` vs `gossip_run` vs `gossip_orchestrate`
2. **3-call native dance** — `dispatch → Agent() → relay_result` loses results when any step is missed
3. **Silent failures** — truncated tasks, swallowed errors, undiscoverable tools
4. **No feedback** — 5-15 min consensus waits with no progress indication

## Approach

Four batches, each independently shippable. Approach validated by 3-agent consensus review.

---

## Batch 1: Bug Fixes (hours)

Architecture-independent fixes only. Bugs that are symptoms of the 3-call architecture (swallowed relay errors, crash detection) are deferred to Batch 3 where the root cause is addressed.

### 1.1 Remove task truncation in gossip_run

**File:** `apps/cli/src/mcp-server-sdk.ts` ~line 1816

The native dispatch path truncates the task to 200 chars in the Agent() instruction string:
```ts
`Task: ${task.slice(0, 200)}...`
```

**Fix:** Remove the `.slice(0, 200)`. The full task is already stored in `nativeTaskMap` — the truncation only affects the prompt the native agent receives.

Also fix `persistNativeTaskMap` (line 220) which truncates `info.task.slice(0, 200)` when writing to `native-tasks.json`. After MCP reconnect, restored tasks have permanently truncated task fields.

**Note:** There are also `result.slice(0, 50000)` caps at lines 1703, 1762, 1871, and 1917 (in `gossip_relay_result`, `publishNativeGossip`, and `gossip_run_complete`). These 50k caps are intentional memory protection — do not remove. Document them in code comments as deliberate limits.

### 1.2 Fix prompt injection in gossip_run native path

**File:** `apps/cli/src/mcp-server-sdk.ts` ~line 1816

The task string is embedded raw into a template literal without escaping. A task containing double-quotes produces a malformed Agent() instruction string.

**Fix:** Use `JSON.stringify(task)` for the task portion of the template, matching what `gossip_dispatch_consensus` already does.

### 1.3 Remove silent timeout cap

**File:** `apps/cli/src/mcp-server-sdk.ts` ~line 1023

```ts
const nativeTimeout = Math.min(timeout_ms, 120000); // cap native wait at 2min
```

Users pass `timeout_ms: 300000` (5 min) but native agents are abandoned at 120s with no warning.

**Fix:** Remove the `Math.min` cap. Use the caller's `timeout_ms` directly. If a cap is needed for safety, log a warning when applying it.

**Also fix `gossip_collect`'s default `timeout_ms`** — line 983 has `z.number().default(120000)`. Removing `Math.min` without raising this default is a no-op since callers never pass >120s. Change the default to `300000` to match `gossip_collect_consensus`.

Also check `gossip_collect_consensus` for the same `Math.min` pattern (~line 1254).

Additionally, `gossip_run`'s relay path hardcodes `120000` at line 1825: `mainAgent.collect([taskId], 120000)`. This should use a configurable timeout or at minimum be raised to match.

### 1.4 Add gossip_retract_signal to gossip_tools listing

**File:** `apps/cli/src/mcp-server-sdk.ts` ~line 2512-2539

`gossip_retract_signal` is registered (line 2001) but absent from the hardcoded tools array in `gossip_tools()`. Users can't discover it after `/mcp` reconnect.

**Fix:** Add the entry to the tools array.

### 1.5 Rebuild MCP bundle

After all Batch 1 fixes: `npm run build:mcp` and verify fixes are present in the bundle.

---

## Batch 2: Tool Consolidation 27 → 12 (1-2 sessions)

### Target API Surface

**Core (8 tools — all users need these):**

| New Tool | Replaces | Notes |
|----------|----------|-------|
| `gossip_run` | `gossip_run` + `gossip_orchestrate` | Add `agent_id: "auto"` to trigger decomposer |
| `gossip_dispatch` | `gossip_dispatch` + `gossip_dispatch_parallel` + `gossip_dispatch_consensus` | Add `mode: "single" \| "parallel" \| "consensus"` param |
| `gossip_collect` | `gossip_collect` + `gossip_collect_consensus` | Add `consensus: boolean` param. **Caution:** these have different `task_ids` semantics — `gossip_collect` defaults to `[]` (all tasks), `gossip_collect_consensus` requires explicit IDs. Merged tool should keep the "all tasks" default when `consensus: false` and require explicit IDs when `consensus: true`. |
| `gossip_relay` | `gossip_relay_result` + `gossip_run_complete` | Merge identical implementations into one |
| `gossip_signals` | `gossip_record_signals` + `gossip_retract_signal` | Add `action: "record" \| "retract"` param |
| `gossip_status` | `gossip_agents` + `gossip_status` | Merge into single status view with agent list |
| `gossip_setup` | `gossip_setup` | Keep as-is |
| `gossip_session_save` | `gossip_session_save` | Keep as-is |

**Power-user (4 tools):**

| Tool | Notes |
|------|-------|
| `gossip_plan` | Keep — manual decompose + approve before dispatch |
| `gossip_scores` | Keep — performance monitoring |
| `gossip_skills` | Merge `gossip_skill_bind` + `gossip_skill_unbind` + `gossip_skill_index` + `gossip_build_skills` + `gossip_develop_skill`. Action param: `"list" \| "bind" \| "unbind" \| "build" \| "develop"` |
| `gossip_tools` | Keep — discovery |

**Removed (no replacement needed):**

| Tool | Reason |
|------|--------|
| `gossip_bootstrap` | Auto-called on boot + session save. Manual call overwrites itself. |
| `gossip_update_instructions` | Rarely used. Move to `gossip_setup` with `mode: "update_instructions"`. |
| `gossip_log_finding` | Disconnected from signals pipeline. Confusing parallel track. **Remove entirely** — `gossip_signals` is the single channel for performance feedback. |
| `gossip_findings` | Remove with `gossip_log_finding`. |

### Migration Strategy: Dual-Mode Deprecation

Old tool names become thin wrappers that call the new implementations:

```ts
// Legacy wrapper — remove after 2026-06-30
server.tool('gossip_dispatch_consensus', ..., async (params) => {
  return gossip_dispatch_handler({ ...params, mode: 'consensus' });
});
```

- Old tools continue to work for 3 months (sunset: 2026-06-30)
- Old tools emit a one-time stderr deprecation warning per session
- `gossip_tools()` lists new tools first, old tools marked `[deprecated]`
- `bootstrap.md` lists **both** new and deprecated tools during transition — agents need visibility into all available commands. Deprecated tools marked `[deprecated — use X instead]`
- `.claude/rules/gossipcat.md` dispatch rules require a **full narrative rewrite**, not just tool name find-and-replace. The multi-step workflow examples (e.g., "Consensus Workflow — The Complete Flow") must reflect the simplified dispatch patterns
- All `NATIVE_DISPATCH` instruction-generation sites must be audited and updated to reference new tool names (`gossip_relay` instead of `gossip_relay_result`/`gossip_run_complete`)

### Files to Update

- `apps/cli/src/mcp-server-sdk.ts` — tool registrations, handlers
- `packages/orchestrator/src/bootstrap.ts` — tool table in rendered prompt
- `.claude/rules/gossipcat.md` — dispatch rules and tier tables
- `.gossip/bootstrap.md` — regenerated automatically

### Review Requirement

Tool consolidation changes MCP tool registration — Tier 2 review per dispatch rules. If any tool rename breaks dispatch pipeline semantics, escalate to Tier 1.

---

## Batch 3: Native Auto-Relay (1-2 sessions)

The hardest batch. Eliminates the 3-call dance and fixes Bugs 3 (swallowed relay errors) and 5 (native crash detection) at the root cause.

### Problem

Native agents require the orchestrator to manually:
1. Call `gossip_dispatch` → get NATIVE_DISPATCH instructions
2. Execute `Agent()` with the generated prompt
3. Call `gossip_relay_result` with the Agent() output

If step 3 is missed (crashed agent, forgotten call, context overflow), the result is lost. No error, no signal, no recovery.

### Design Direction

The MCP server cannot invoke Agent() on behalf of the caller — that's a Claude Code architecture constraint. The relay must remain cooperative. Two options:

**Option A: Automatic relay injection in collect**

When `gossip_collect` is called and native tasks are still pending:
- Check `nativeResultMap` for any results that arrived via `gossip_relay_result`
- For tasks still in `nativeTaskMap` with no result after timeout, emit `status: "lost"` with actionable guidance ("Agent may have crashed. Re-dispatch with gossip_run.")
- Auto-record `hallucination_caught` signal for lost tasks

This doesn't eliminate the 3-call dance but makes failure visible and actionable.

**Option B: gossip_run as blocking call for native agents**

Redesign `gossip_run` for native agents:
1. `gossip_run` returns NATIVE_DISPATCH instructions (same as today)
2. BUT also starts a background timeout watcher
3. If `gossip_run_complete` is not called within `timeout_ms`, the task is marked failed with an actionable error
4. The watcher emits a signal and updates the task status

This reduces the dance from 3 calls to 2 (run → run_complete) with automatic failure detection.

**Option C: Combine both**

Use Option B for `gossip_run` (2-call with auto-timeout), and Option A for `gossip_collect` (surface lost tasks). This provides defense-in-depth.

**Recommended: Option C.** Needs Tier 1 consensus review before implementation — touches shared mutable state (`nativeTaskMap`, `nativeResultMap`), file persistence (`native-tasks.json`), and relay lifecycle.

### Required Hardening (from agent review)

The timeout watcher has three confirmed failure modes that must be addressed:

**1. Race condition: late relay_result after timeout (CRITICAL)**

If timeout fires first → deletes from `nativeTaskMap` → writes failed entry to `nativeResultMap`. Then late `gossip_relay_result` arrives → checks `nativeTaskMap.get(task_id)` → returns null → "Unknown task ID". Actual result is silently lost.

**Fix:** Real result always wins. `gossip_relay_result` must check `nativeResultMap` for a timeout-failed entry and overwrite it. Add a generation counter to `nativeTaskMap` entries to prevent ABA races. The relay handler should accept results even if the task was already timed out.

**2. Timeout watchers lost on MCP restart (CRITICAL)**

Timeout is a JavaScript `setTimeout()` in process memory. When MCP reconnects, `restoreNativeTaskMap()` (line 456) restores task metadata but NOT the running timers. Task stays "pending" indefinitely.

**Fix:** Store `timeoutMs` in `nativeTaskMap` entries. During `restoreNativeTaskMap()`, check `Date.now() - startedAt > timeoutMs` — if exceeded, mark failed immediately. Otherwise, re-spawn timer with remaining time.

**3. Timeout watcher vs gossip_collect polling loop (HIGH)**

The `await`-based polling loop in `gossip_collect_consensus` (lines 1260-1263) yields between iterations. A timeout callback can fire between iterations, deleting a `nativeTaskMap` entry the collect loop was waiting for.

**Fix:** The timeout watcher should NOT delete from `nativeTaskMap`. Instead, it should write a `status: "timed_out"` entry to `nativeResultMap`, leaving `nativeTaskMap` intact. The collect loop checks `nativeResultMap` for results — including timed-out ones.

### Error Propagation

With auto-relay in place, fix the swallowed errors:
- `gossip_collect` catch block: instead of silently returning empty results, return `{ status: "error", error: message }` so the caller knows the relay is down
- Native crash detection: timeout watcher marks task as failed, emits signal

### Review Requirement

**Tier 1 mandatory.** Triggers: shared mutable state across async boundaries, file persistence of state, core dispatch pipeline.

---

## Batch 4: Feedback Quality (1 session)

### 4.1 Progress indication during consensus

Replace the single stderr message with periodic heartbeat:
```
[gossipcat] Consensus: 1/3 agents complete (gemini-reviewer: done, sonnet-reviewer: running 45s, haiku-researcher: running 30s)
```

Update every 10 seconds during the polling loop. Include per-agent timing.

### 4.2 Actionable error messages

Replace generic errors with structured messages:
```
Task failed: <full error message>
  Agent: sonnet-reviewer
  Duration: 45s
  Suggestion: Re-dispatch with gossip_run, or check agent logs in .gossip/agents/sonnet-reviewer/
```

Fix `error.slice(0, 100)` at line 1077 — this truncates the `evidence` field written to `agent-performance.jsonl`, not the user-visible error (which already shows full text). Show full evidence in signal records for better debugging.

### 4.3 Consensus timing data

Add timing to consensus reports:
```
CONSENSUS REPORT (3 agents, 3 rounds, 4m 32s)
  gemini-reviewer: 31s | sonnet-reviewer: 3m 45s | haiku-researcher: 1m 50s
  Cross-review: 12s
```

### 4.4 UNVERIFIED findings guidance

Add next-step guidance to UNVERIFIED findings:
```
◇ [reviewer, unverified by peers] "Finding text..."
  → To verify: re-dispatch to a second agent, or read the code at file:line
```

### Review Requirement

Batch 4 is Tier 3 (self-review + tests). No shared state, no dispatch pipeline changes.

---

## Success Criteria

**Quantitative:**

| Metric | Before | After |
|--------|--------|-------|
| MCP tool count | 27 | 12 (+ deprecated wrappers) |
| Calls for single native task | 3 | 2 (with auto-timeout) |
| Silent data loss on native crash | Yes | No (timeout + signal) |
| Task truncation | 200 chars | Full task |
| Progress during consensus | None | 10s heartbeat |
| Discoverable tools | 26/27 | 12/12 |

**Qualitative:**

| Metric | Target |
|--------|--------|
| Native agent data loss incidents (tracked via timeout signals) | Decrease >75% |
| New user can complete 3-agent consensus review | <5 min with no wrong tool calls |
| Dispatch rule confusion (wrong tool selected) | Eliminated by single `gossip_dispatch` with mode param |

## Risks

- **Batch 2 migration:** Old tool references in memory files, skills, user prompts. Mitigated by dual-mode deprecation.
- **Batch 3 complexity:** Timeout watcher adds async complexity to nativeTaskMap lifecycle. Mitigated by Tier 1 review.
- **Batch 3 architecture constraint:** MCP server can't call Agent() directly. Design works within this constraint.
