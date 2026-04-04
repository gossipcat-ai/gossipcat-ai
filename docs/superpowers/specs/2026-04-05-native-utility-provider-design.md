# Native Utility Provider Design

**Date:** 2026-04-05
**Status:** Approved
**Authors:** Orchestrator + haiku-researcher + sonnet-reviewer

## Problem

The utility LLM (used for lens generation, cognitive memory summaries, gossip publishing, session summaries) is hardcoded to use relay providers (Gemini/Anthropic) via direct API calls. When Gemini quota is exhausted, all utility calls fail silently. Users with no Anthropic API key in keychain cannot switch to a Claude provider — native agents use Claude Code's auth, which the MCP server process cannot access.

## Solution

Add `provider: "native"` support to the `utility_model` config. When configured, utility LLM calls are routed through the existing native agent dispatch pipeline: the MCP tool returns EXECUTE NOW, the orchestrator dispatches an `Agent()` call, relays the result via `gossip_relay`, and re-calls the original tool to continue.

## Design Constraints (From Agent Research)

**Promise suspension is infeasible.** Sonnet-reviewer identified two fatal flaws:

1. **MCP timeout** — `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` (protocol.js:12). Native Agent() takes 30-120s. The tool call times out before relay arrives.
2. **Orchestrator deadlock** — Claude Code is a single-threaded LLM. If a tool suspends waiting for `gossip_relay`, the orchestrator is blocked waiting for the tool response and can never call `gossip_relay`.

This is exactly why `gossip_run` and `gossip_collect` already use the return-and-re-call pattern.

**MCP sampling (future):** MCP 1.27.1 supports `sampling/createMessage` server-to-client requests. If Claude Code ever exposes this capability, the MCP server could call the client's LLM directly — no relay, no re-call. This would replace the entire design with ~10 lines. Not available today.

## Config

Extend the existing `utility_model` field to accept `"native"` as a provider:

```json
{
  "main_agent": { "provider": "google", "model": "gemini-2.5-pro" },
  "utility_model": { "provider": "native", "model": "haiku" }
}
```

- `VALID_PROVIDERS` in `config.ts` adds `"native"`
- When `provider: "native"`, `model` must be `opus`, `sonnet`, or `haiku` (matches `CLAUDE_MODEL_MAP`)
- No API key lookup — native uses Claude Code's auth
- Stored on context as `ctx.nativeUtilityConfig = { model: "haiku" }` (not as an `ILLMProvider` — see below)

## Architecture: No ILLMProvider for Native

We are **not** creating a `NativeUtilityProvider` that implements `ILLMProvider`. The `generate()` interface assumes synchronous HTTP and returning a Promise that resolves from an out-of-band relay is a deadlock (see constraints above).

Instead, call sites **branch explicitly**:

```
if (ctx.nativeUtilityConfig) {
  // → create utility task, return EXECUTE NOW
} else {
  // → inline LLM call via utilityLlm.generate() (current path)
}
```

The relay path does not exist. The native path does not pretend to be synchronous.

## Utility Task Lifecycle

### NativeTaskInfo Extension

```typescript
// mcp-context.ts
export interface NativeTaskInfo {
  agentId: string;
  task: string;
  startedAt: number;
  timeoutMs?: number;
  planId?: string;
  step?: number;
  utilityType?: 'lens' | 'gossip' | 'summary' | 'session_summary';  // NEW
}
```

### Creation

When a tool needs a utility LLM call and `ctx.nativeUtilityConfig` is set:

1. Generate task ID via `generateTaskId()`
2. Register in `nativeTaskMap` with `utilityType` set and `agentId: '_utility'`
3. Return EXECUTE NOW with model, prompt, and re-call instructions

### Relay Handling

`handleNativeRelay` in `native-tasks.ts` checks `utilityType`:

- **If set:** Skip memory pipeline, gossip publishing, TaskGraph recording. Just store result in `nativeResultMap`. These are internal plumbing, not agent work product.
- **If not set:** Current behavior unchanged.

### Timeout

Utility tasks get a 60s TTL (vs 2hr for agent tasks). On timeout, calling tool falls back gracefully (empty lenses, no summary — same as current behavior when Gemini errors).

### No Persistence

Utility tasks don't survive MCP reconnects. They're ephemeral. Skip writing them to `native-tasks.json`.

## Call Site Changes

There are 4 call sites. Each uses one of two patterns:

### Pattern A: Blocking (EXECUTE NOW + re-call)

Tool returns early, orchestrator dispatches Agent(), relays result, re-calls the same tool with a `_utility_task_id` parameter. On re-entry, tool finds result in `nativeResultMap` and continues.

### Pattern B: Fire-and-forget (deferred)

Utility task is queued alongside the main relay response. Orchestrator dispatches it, relays result. No re-call — the parent operation already completed.

### Call Sites

| # | Call site | File | Pattern | Re-entry tool |
|---|-----------|------|---------|---------------|
| 1 | Lens generation | dispatch-pipeline.ts | A (blocking) | gossip_dispatch |
| 2 | Cognitive summary | memory-writer.ts via native-tasks.ts | B (fire-and-forget) | N/A |
| 3 | Gossip publishing | gossip-publisher.ts via native-tasks.ts | B (fire-and-forget) | N/A |
| 4 | Session summary | mcp-server-sdk.ts | A (blocking) | gossip_session_save |

### 1. Lens Generation (blocking)

**Current:** `LensGenerator.generateLenses()` called inline during `gossip_dispatch`.

**Native path:** Dispatch handler detects `ctx.nativeUtilityConfig`, creates utility task, returns EXECUTE NOW with lens prompt. Orchestrator dispatches Agent(), relays result, re-calls `gossip_dispatch` with same arguments + `_utility_task_id`. On re-entry, handler finds lens result in `nativeResultMap` and continues with dispatch.

**Fallback:** Agents dispatch without lenses (overlapping focus). Already handled — this is what happens when lens generation fails today.

### 2. Cognitive Memory Summary (fire-and-forget)

**Current:** After relay, `writeKnowledgeFromResult()` calls utility LLM to extract learnings.

**Native path:** Skip cognitive summary during relay. Include utility task in relay response: "also dispatch these utility tasks." Non-blocking — relay completes immediately, summary arrives later.

**Fallback:** Memory entries get regex-extracted facts instead of LLM summaries. Already the fallback path.

### 3. Gossip Publishing (fire-and-forget)

**Current:** After relay, `publishGossip()` summarizes result for siblings.

**Native path:** Same as #2. Queue as deferred utility task in relay response.

**Fallback:** Other agents don't get gossip about this result. Minor quality degradation.

### 4. Session Summary (blocking)

**Current:** `MemoryWriter.writeSessionSummary()` called inline during `gossip_session_save`.

**Native path:** `gossip_session_save` returns EXECUTE NOW with session summary prompt. Orchestrator dispatches Agent(), relays result, re-calls `gossip_session_save` with `_utility_task_id`. On re-entry, picks up summary from `nativeResultMap` and writes session file.

**Fallback:** Raw data written ("LLM summary failed — raw data below").

## EXECUTE NOW Format

### Blocking (with re-call)

```
⚠️ EXECUTE NOW — native utility task (lens generation)

1. Agent(model: "haiku", prompt: "<utility prompt>", run_in_background: true)
2. When agent completes → gossip_relay(task_id: "abc123", result: "<full output>")
3. Then re-call: gossip_dispatch(mode: "consensus", tasks: [...], _utility_task_id: "abc123")
```

### Fire-and-forget (from relay response)

```
Result relayed for sonnet-reviewer [def456]: completed (3200ms)

⚠️ EXECUTE NOW — 2 utility tasks queued:

1. Agent(model: "haiku", prompt: "<cognitive summary prompt>", run_in_background: true)
   → gossip_relay(task_id: "u1", result: "<output>")

2. Agent(model: "haiku", prompt: "<gossip summary prompt>", run_in_background: true)
   → gossip_relay(task_id: "u2", result: "<output>")
```

## Re-entry Detection

Tools that support blocking utility calls accept an optional `_utility_task_id` parameter:

- **Present:** Check `nativeResultMap` for that ID. If found → use result, continue. If not found (timed out) → fall back gracefully.
- **Absent:** Normal execution. If native utility is configured and needed, create utility task and return EXECUTE NOW.

This is explicit — no hidden state, no guessing.

## Multiple Utility Calls in One Tool

`gossip_session_save` makes two LLM calls (cognitive + session summary). Batch them into a single EXECUTE NOW with two Agent() dispatches. Re-call happens after both are relayed. Tool checks for both task IDs on re-entry.

## Edge Cases

### No utility calls during collect

`gossip_collect` with `consensus: true` already has a complex flow. Lens generation happens at dispatch time, not collect time. Cognitive summary and gossip happen in relay (fire-and-forget). Collect stays untouched.

### Mixed mode (config switch mid-session)

Handled by `gossip_setup(mode: "merge")` which re-reads config. Pending utility tasks in `nativeTaskMap` still resolve normally via relay.

### Native utility + no .claude/agents/ files

Doesn't matter. Utility tasks are dispatched directly with `Agent(model: "haiku")` and a self-contained prompt. No agent config needed.

## Log Visibility

Two new log lines for utility tasks:

```
[gossipcat] utility → haiku: "Generate lenses for 3 agents..." (task: abc123)
[gossipcat] utility ← haiku [abc123]: completed (18200ms, 340 chars)
```

Plus general native dispatch/relay logs (separate from this design):

```
[gossipcat] dispatch → sonnet-reviewer: "task preview..." (native, sonnet)
[gossipcat] relay ← sonnet-reviewer [def456]: completed (42000ms, 12340 chars)
```

## CLAUDE.md Addition

One paragraph added to the utility section:

> **Utility tasks:** When a tool returns `EXECUTE NOW` for a utility task (lens generation, summary, gossip), follow the same dispatch pattern as native agents. If the response includes a "re-call" instruction, call that tool with the specified arguments after relaying the result. Fire-and-forget utility tasks have no re-call — just dispatch and relay.

## Out of Scope

1. **Automatic fallback** — No auto-detecting Gemini 429s. Manual config switch only. Quota watcher is a separate feature that layers on top.
2. **ILLMProvider implementation** — No `NativeUtilityProvider` class. Deadlock trap confirmed by sonnet-reviewer.
3. **MCP sampling** — Future clean path when Claude Code exposes the capability.
4. **New MCP tools** — Zero new tools. Reuses `gossip_relay` and existing tool parameters.
5. **Persistence for utility tasks** — Ephemeral, 60s TTL, graceful degradation.

## Files Changed

| File | Change |
|------|--------|
| `apps/cli/src/config.ts` | Add `"native"` to `VALID_PROVIDERS`, validate model against `CLAUDE_MODEL_MAP` |
| `apps/cli/src/mcp-context.ts` | Add `utilityType` to `NativeTaskInfo`, add `nativeUtilityConfig` to `McpContext` |
| `apps/cli/src/mcp-server-sdk.ts` | Boot: set `ctx.nativeUtilityConfig`. `gossip_dispatch`: lens utility branch + re-entry. `gossip_session_save`: session summary utility branch + re-entry |
| `apps/cli/src/handlers/native-tasks.ts` | Skip memory pipeline for `utilityType` tasks, shorter TTL, log lines |
| `apps/cli/src/handlers/dispatch.ts` | Pass `_utility_task_id` through, check for lens result on re-entry |
| `packages/orchestrator/src/dispatch-pipeline.ts` | Expose lens generation call point for native branch |
