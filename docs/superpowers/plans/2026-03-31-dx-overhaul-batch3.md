# DX Overhaul — Batch 3: Native Auto-Relay

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add timeout watchers to native agent tasks so crashed/forgotten agents are detected automatically, and fix error propagation so failures are never silently swallowed.

**Architecture:** Timeout watcher spawned at every `nativeTaskMap.set()` site. On timeout, writes `timed_out` status to `nativeResultMap` without deleting from `nativeTaskMap` (load-bearing invariant). Late relay always wins — overwrites timed_out entries. Watchers re-armed on MCP reconnect.

**Tech Stack:** TypeScript, Node.js setTimeout, Map snapshots for iteration safety

**Spec:** `docs/superpowers/specs/2026-03-31-dx-overhaul-design.md` (Batch 3)

---

## File Map

| File | Lines | Changes |
|------|-------|---------|
| `apps/cli/src/mcp-context.ts` | 73 | Add `timeoutMs` to NativeTaskInfo, add `timed_out` to NativeResultInfo status |
| `apps/cli/src/handlers/native-tasks.ts` | 152 | Add `spawnTimeoutWatcher()`, `recordTimeoutSignal()`, fix iteration safety, persist error field, update `restoreNativeTaskMap`, update `handleNativeRelay` for late-relay-wins |
| `apps/cli/src/handlers/dispatch.ts` | 234 | Call `spawnTimeoutWatcher()` at all 3 native task creation sites |
| `apps/cli/src/handlers/collect.ts` | 183 | Add `timed_out` format case, fix auto-signal filter, fix error propagation, fix timeout counter |
| `apps/cli/src/mcp-server-sdk.ts` | 1640 | Call `spawnTimeoutWatcher()` in gossip_run native path |

---

### Task 1: Update types and fix iteration safety

**Files:**
- Modify: `apps/cli/src/mcp-context.ts:7-24`
- Modify: `apps/cli/src/handlers/native-tasks.ts:8-18`

- [ ] **Step 1: Add timeoutMs to NativeTaskInfo**

In `apps/cli/src/mcp-context.ts`, find the `NativeTaskInfo` interface (line 7):

```ts
export interface NativeTaskInfo {
  agentId: string;
  task: string;
  startedAt: number;
  planId?: string;
  step?: number;
}
```

Add `timeoutMs`:

```ts
export interface NativeTaskInfo {
  agentId: string;
  task: string;
  startedAt: number;
  timeoutMs?: number;
  planId?: string;
  step?: number;
}
```

- [ ] **Step 2: Add timed_out to NativeResultInfo status**

In `apps/cli/src/mcp-context.ts`, find the `NativeResultInfo` interface (line 15):

```ts
  status: 'completed' | 'failed';
```

Change to:

```ts
  status: 'completed' | 'failed' | 'timed_out';
```

- [ ] **Step 3: Fix iteration safety in evictStaleNativeTasks**

In `apps/cli/src/handlers/native-tasks.ts`, find `evictStaleNativeTasks` (line 8):

```ts
export function evictStaleNativeTasks(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, info] of ctx.nativeTaskMap) {
    if (now - info.startedAt > NATIVE_TASK_TTL_MS) { ctx.nativeTaskMap.delete(id); changed = true; }
  }
  for (const [id, info] of ctx.nativeResultMap) {
    if (now - info.startedAt > NATIVE_TASK_TTL_MS) { ctx.nativeResultMap.delete(id); changed = true; }
  }
  if (changed) persistNativeTaskMap();
}
```

Replace with snapshot-based iteration:

```ts
export function evictStaleNativeTasks(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, info] of [...ctx.nativeTaskMap]) {
    if (now - info.startedAt > NATIVE_TASK_TTL_MS) { ctx.nativeTaskMap.delete(id); changed = true; }
  }
  for (const [id, info] of [...ctx.nativeResultMap]) {
    if (now - info.startedAt > NATIVE_TASK_TTL_MS) { ctx.nativeResultMap.delete(id); changed = true; }
  }
  if (changed) persistNativeTaskMap();
}
```

- [ ] **Step 4: Add error field to persistNativeTaskMap slimResults**

In `apps/cli/src/handlers/native-tasks.ts`, find the slimResults builder (line 31-33):

```ts
      slimResults[id] = {
        id: info.id, agentId: info.agentId, task: info.task.slice(0, 5000), // cap on-disk only — full task stays in memory
        status: info.status, startedAt: info.startedAt, completedAt: info.completedAt,
      };
```

Add `error`:

```ts
      slimResults[id] = {
        id: info.id, agentId: info.agentId, task: info.task.slice(0, 5000), // cap on-disk only — full task stays in memory
        status: info.status, error: info.error, startedAt: info.startedAt, completedAt: info.completedAt,
      };
```

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/mcp-context.ts apps/cli/src/handlers/native-tasks.ts
git commit -m "feat: add timed_out status, timeoutMs field, fix iteration safety"
```

---

### Task 2: Implement timeout watcher and signal recording

**Files:**
- Modify: `apps/cli/src/handlers/native-tasks.ts`

- [ ] **Step 1: Add the timeout watcher map and spawn function**

At the top of `native-tasks.ts`, after the imports, add:

```ts
/** Active timeout watchers — keyed by task ID, value is the timer handle */
const timeoutWatchers: Map<string, ReturnType<typeof setTimeout>> = new Map();

/**
 * Spawn a timeout watcher for a native task.
 * On timeout: writes timed_out to nativeResultMap, does NOT delete from nativeTaskMap.
 * This is a load-bearing invariant — the collect polling loop depends on nativeTaskMap
 * entries persisting until the real relay arrives or TTL eviction.
 */
export function spawnTimeoutWatcher(taskId: string, info: { agentId: string; task: string; startedAt: number; timeoutMs?: number }): void {
  const timeoutMs = info.timeoutMs ?? NATIVE_TASK_TTL_MS;
  const elapsed = Date.now() - info.startedAt;
  const remaining = Math.max(timeoutMs - elapsed, 0);

  // Clear any existing watcher for this task
  const existing = timeoutWatchers.get(taskId);
  if (existing) clearTimeout(existing);

  if (remaining <= 0) {
    // Already expired — mark immediately
    markTimedOut(taskId, info, timeoutMs);
    return;
  }

  const timer = setTimeout(() => {
    timeoutWatchers.delete(taskId);
    // Only fire if task hasn't already been relayed
    if (ctx.nativeTaskMap.has(taskId) && !ctx.nativeResultMap.has(taskId)) {
      markTimedOut(taskId, info, timeoutMs);
    }
  }, remaining);

  // Don't let the timer prevent process exit
  if (timer.unref) timer.unref();
  timeoutWatchers.set(taskId, timer);
}

function markTimedOut(taskId: string, info: { agentId: string; task: string; startedAt: number }, timeoutMs: number): void {
  ctx.nativeResultMap.set(taskId, {
    id: taskId,
    agentId: info.agentId,
    task: info.task,
    status: 'timed_out',
    error: `Timed out after ${timeoutMs}ms — agent may have crashed or forgotten gossip_relay. Re-dispatch with gossip_run to retry.`,
    startedAt: info.startedAt,
    completedAt: Date.now(),
  });
  // Do NOT delete from nativeTaskMap — collect loop invariant
  persistNativeTaskMap();
  recordTimeoutSignal(taskId, info.agentId);
}

/** Cancel a timeout watcher (called when relay arrives before timeout) */
export function cancelTimeoutWatcher(taskId: string): void {
  const timer = timeoutWatchers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    timeoutWatchers.delete(taskId);
  }
}
```

- [ ] **Step 2: Add signal recording for timeouts**

Below the watcher functions, add:

```ts
function recordTimeoutSignal(taskId: string, agentId: string): void {
  try {
    const { PerformanceWriter } = require('@gossip/orchestrator');
    const writer = new PerformanceWriter(process.cwd());
    writer.appendSignals([{
      type: 'consensus' as const,
      taskId,
      signal: 'disagreement' as const, // timeout = reliability failure, not hallucination
      agentId,
      evidence: `Native agent timed out — no gossip_relay call received`,
      timestamp: new Date().toISOString(),
    }]);
    process.stderr.write(`[gossipcat] Auto-recorded timeout signal for ${agentId} [${taskId}]\n`);
  } catch { /* best-effort */ }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/handlers/native-tasks.ts
git commit -m "feat: implement timeout watcher with signal recording for native tasks"
```

---

### Task 3: Update handleNativeRelay for late-relay-wins

**Files:**
- Modify: `apps/cli/src/handlers/native-tasks.ts:72-90`

- [ ] **Step 1: Cancel watcher and handle late relay**

Find `handleNativeRelay` (line 72). Replace the taskInfo lookup (lines 75-78):

```ts
  const taskInfo = ctx.nativeTaskMap.get(task_id);
  if (!taskInfo) {
    return { content: [{ type: 'text' as const, text: `Unknown task ID: ${task_id}. Was it dispatched via gossip_dispatch or gossip_run?` }] };
  }
```

With late-relay-wins logic:

```ts
  // Cancel timeout watcher if still running
  cancelTimeoutWatcher(task_id);

  // Late relay wins: check nativeTaskMap first, then fall back to timed_out result
  let taskInfo = ctx.nativeTaskMap.get(task_id);
  let lateRelay = false;
  if (!taskInfo) {
    // Task may have timed out — check nativeResultMap for timed_out entry
    const timedOutResult = ctx.nativeResultMap.get(task_id);
    if (timedOutResult && timedOutResult.status === 'timed_out') {
      taskInfo = { agentId: timedOutResult.agentId, task: timedOutResult.task, startedAt: timedOutResult.startedAt };
      lateRelay = true;
      process.stderr.write(`[gossipcat] Late relay for ${task_id} — overwriting timed_out result with real data\n`);
    } else {
      return { content: [{ type: 'text' as const, text: `Unknown task ID: ${task_id}. Was it dispatched via gossip_dispatch or gossip_run?` }] };
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/handlers/native-tasks.ts
git commit -m "feat: late relay wins — overwrite timed_out results with real data"
```

---

### Task 4: Wire timeout watchers into all dispatch sites

**Files:**
- Modify: `apps/cli/src/handlers/dispatch.ts:42-43, 143-145, 213-215`
- Modify: `apps/cli/src/mcp-server-sdk.ts:1116-1117`

- [ ] **Step 1: Add import to dispatch.ts**

At the top of `apps/cli/src/handlers/dispatch.ts`, add:

```ts
import { spawnTimeoutWatcher } from './native-tasks';
```

(If `evictStaleNativeTasks` and `persistNativeTaskMap` are already imported, just add `spawnTimeoutWatcher` to the import list.)

- [ ] **Step 2: Wire into handleDispatchSingle**

Find `apps/cli/src/handlers/dispatch.ts:42-43`:

```ts
    ctx.nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now(), planId: plan_id, step });
    persistNativeTaskMap();
```

Add `timeoutMs` and watcher spawn between set and persist:

```ts
    const timeoutMs = timeout_ms ?? NATIVE_TASK_TTL_MS;
    ctx.nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now(), timeoutMs, planId: plan_id, step });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    persistNativeTaskMap();
```

Add `NATIVE_TASK_TTL_MS` to the import from `../mcp-context` if not already imported.

- [ ] **Step 3: Wire into handleDispatchParallel**

Find `apps/cli/src/handlers/dispatch.ts:143`:

```ts
    ctx.nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now() });
```

Replace with:

```ts
    ctx.nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
```

- [ ] **Step 4: Wire into handleDispatchConsensus**

Find `apps/cli/src/handlers/dispatch.ts:213` (same pattern):

```ts
    ctx.nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now() });
```

Replace with:

```ts
    ctx.nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
```

- [ ] **Step 5: Wire into gossip_run native path**

Find `apps/cli/src/mcp-server-sdk.ts:1116`:

```ts
      ctx.nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now() });
      persistNativeTaskMap();
```

Replace with:

```ts
      ctx.nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS });
      spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
      persistNativeTaskMap();
```

Add imports at top of mcp-server-sdk.ts:

```ts
import { spawnTimeoutWatcher } from './handlers/native-tasks';
```

(Add to existing import line from `./handlers/native-tasks` if one exists.)

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/handlers/dispatch.ts apps/cli/src/mcp-server-sdk.ts
git commit -m "feat: wire timeout watchers into all 4 native task dispatch sites"
```

---

### Task 5: Update restoreNativeTaskMap to re-arm timers

**Files:**
- Modify: `apps/cli/src/handlers/native-tasks.ts:46-69`

- [ ] **Step 1: Replace restoreNativeTaskMap**

Find the current `restoreNativeTaskMap` function (line 46). Replace the tasks restoration block (lines 54-59):

```ts
    if (raw.tasks) {
      for (const [id, info] of Object.entries(raw.tasks) as [string, any][]) {
        if (now - info.startedAt < NATIVE_TASK_TTL_MS && !ctx.nativeTaskMap.has(id)) {
          ctx.nativeTaskMap.set(id, info);
        }
      }
    }
```

With timer-aware restoration:

```ts
    if (raw.tasks) {
      for (const [id, info] of Object.entries(raw.tasks) as [string, any][]) {
        if (now - info.startedAt >= NATIVE_TASK_TTL_MS) continue; // expired
        if (ctx.nativeTaskMap.has(id)) continue; // already loaded
        if (ctx.nativeResultMap.has(id)) continue; // already completed before reconnect

        ctx.nativeTaskMap.set(id, info);

        const timeoutMs = info.timeoutMs ?? NATIVE_TASK_TTL_MS;
        const elapsed = now - info.startedAt;

        if (elapsed >= timeoutMs) {
          // Past deadline — mark timed_out immediately
          ctx.nativeResultMap.set(id, {
            id, agentId: info.agentId, task: info.task,
            status: 'timed_out' as const,
            error: `Timed out after MCP reconnect — ${elapsed}ms elapsed, limit was ${timeoutMs}ms`,
            startedAt: info.startedAt, completedAt: now,
          });
          process.stderr.write(`[gossipcat] Restored task ${id} already expired — marked timed_out\n`);
        } else {
          // Re-arm timer for remaining time
          spawnTimeoutWatcher(id, { agentId: info.agentId, task: info.task, startedAt: info.startedAt, timeoutMs });
          process.stderr.write(`[gossipcat] Restored task ${id} — re-armed timeout (${Math.round((timeoutMs - elapsed) / 1000)}s remaining)\n`);
        }
      }
    }
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/handlers/native-tasks.ts
git commit -m "feat: re-arm timeout watchers on MCP reconnect for restored tasks"
```

---

### Task 6: Fix collect handler for timed_out status and error propagation

**Files:**
- Modify: `apps/cli/src/handlers/collect.ts`

- [ ] **Step 1: Fix iteration safety at line 40**

Find the loop at line 40:

```ts
    for (const [id] of ctx.nativeTaskMap) {
```

Replace with snapshot:

```ts
    for (const id of [...ctx.nativeTaskMap.keys()]) {
```

- [ ] **Step 2: Fix error propagation in catch block**

Find the catch block at lines 32-34:

```ts
  } catch (err) {
    process.stderr.write(`[gossipcat] collect failed: ${(err as Error).message}\n`);
  }
```

Replace with:

```ts
  } catch (err) {
    const message = (err as Error).message;
    process.stderr.write(`[gossipcat] collect failed: ${message}\n`);
    // If no native tasks either, return error immediately
    const hasNativeTasks = (nativeIds && nativeIds.length > 0) || (!requestedIds && ctx.nativeTaskMap.size > 0);
    if (!hasNativeTasks) {
      return { content: [{ type: 'text' as const, text: `[ERROR] Failed to collect results: ${message}\n\nRelay may be down. Check gossip_status() for connection state.` }] };
    }
    // Otherwise continue — native results may still be available
  }
```

- [ ] **Step 3: Add timed_out to format switch**

Find the format block (around line 129-131):

```ts
    if (t.status === 'completed') text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag} (${dur}):\n${t.result}`;
    else if (t.status === 'failed') text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag} (${dur}): ERROR: ${t.error}`;
    else text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag}: still running...`;
```

Replace with:

```ts
    if (t.status === 'completed') text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag} (${dur}):\n${t.result}`;
    else if (t.status === 'failed') text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag} (${dur}): ERROR: ${t.error}`;
    else if (t.status === 'timed_out') text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag} (timed out): ${t.error}\n  → Re-dispatch with gossip_run to retry.`;
    else text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag}: still running...`;
```

- [ ] **Step 4: Fix auto-signal filter for timed_out**

Find the failedResults filter (around line 92-95):

```ts
    const failedResults = allResults.filter((r: any) =>
      r.status === 'failed' ||
      r.status === 'timeout' ||
```

Replace `'timeout'` with `'timed_out'`:

```ts
    const failedResults = allResults.filter((r: any) =>
      r.status === 'failed' ||
      r.status === 'timed_out' ||
```

- [ ] **Step 5: Fix timeout counter in polling log**

Find around line 63-66:

```ts
    const arrived = pendingNativeIds.filter(id => ctx.nativeResultMap.has(id)).length;
    const timedOut = pendingNativeIds.length - arrived;
```

Replace with explicit status check:

```ts
    const arrived = pendingNativeIds.filter(id => ctx.nativeResultMap.has(id)).length;
    const timedOutCount = pendingNativeIds.filter(id => {
      const r = ctx.nativeResultMap.get(id);
      return r?.status === 'timed_out';
    }).length;
    const stillPending = pendingNativeIds.length - arrived;
```

Update the log messages below to use `timedOutCount` and `stillPending`:

```ts
    if (stillPending > 0) {
      process.stderr.write(`[gossipcat] ${stillPending} native agent(s) didn't respond, ${timedOutCount} timed out, ${arrived - timedOutCount} arrived\n`);
    } else {
      process.stderr.write(`[gossipcat] All ${arrived} native agent(s) arrived${timedOutCount > 0 ? ` (${timedOutCount} via timeout)` : ''}\n`);
    }
```

- [ ] **Step 6: Clean up nativeTaskMap after collect consumes result**

After line 79 where nativeResultMap entry is consumed:

```ts
      ctx.nativeResultMap.delete(id); // consumed
```

Add cleanup of the corresponding nativeTaskMap entry:

```ts
      ctx.nativeResultMap.delete(id); // consumed
      ctx.nativeTaskMap.delete(id); // clean up — result has been delivered
```

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/handlers/collect.ts
git commit -m "feat: handle timed_out status in collect, fix error propagation and iteration safety"
```

---

### Task 7: Rebuild MCP bundle and verify

**Files:**
- Build: `dist-mcp/mcp-server.js`

- [ ] **Step 1: Build**

```bash
npm run build --workspaces 2>&1 | grep -v 'error TS2307' | grep -E '(error|built|Dashboard)' | head -10
npm run build:mcp
```

- [ ] **Step 2: Verify timeout watcher in bundle**

```bash
grep -c 'spawnTimeoutWatcher' dist-mcp/mcp-server.js
# Should be >= 5 (4 dispatch sites + 1 restore + function def)

grep -c 'timed_out' dist-mcp/mcp-server.js
# Should be >= 5 (status checks, format, signal filter, markTimedOut)

grep -c 'cancelTimeoutWatcher' dist-mcp/mcp-server.js
# Should be >= 2 (function def + call in handleNativeRelay)
```

- [ ] **Step 3: Commit**

```bash
git add dist-mcp/mcp-server.js
git commit -m "build: rebuild MCP bundle with Batch 3 native auto-relay"
```

---

## Review Requirement

**Tier 1 mandatory.** This batch touches:
- Shared mutable state across async boundaries (`nativeTaskMap`, `nativeResultMap`)
- File persistence (`native-tasks.json`)
- Core dispatch pipeline (all dispatch handlers + collect)

Dispatch consensus review with 3 agents after implementation, before merging.
