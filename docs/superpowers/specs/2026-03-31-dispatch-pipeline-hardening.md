# Dispatch Pipeline Hardening — Resource Leak & File Growth Fixes

**Date:** 2026-03-31
**Status:** Approved
**Source:** Consensus review of dispatch-pipeline.ts (3 agents, 14 confirmed findings)

## Problem

The dispatch pipeline has resource leaks in cancel/timeout paths and unbounded file growth in two JSONL files. These cause:
- Scopes permanently locked after cancel or server restart
- Worktree directories and git branches leaked on timeout/abandonment
- `consensus-history.jsonl` and `session-gossip.jsonl` growing without bound

## Batch A: Resource Leak Fixes

### A1: `cancelRunningTasks()` must release scopes and clean up worktrees

**File:** `dispatch-pipeline.ts:424-435`

**Current:** Sets `status = 'failed'` but doesn't call `scopeTracker.release()` or `worktreeManager.cleanup()`. After cancel, scoped dispatches to the same path permanently error with "scope overlap."

**Fix:** After marking as failed, release scope and clean up worktree for each cancelled task:
```typescript
cancelRunningTasks(): number {
  let cancelled = 0;
  for (const [, task] of this.tasks.entries()) {
    if (task.status === 'running') {
      task.status = 'failed';
      task.error = 'Cancelled by user';
      task.completedAt = Date.now();
      // Release resources held by cancelled tasks
      if (task.writeMode === 'scoped') {
        this.scopeTracker.release(task.id);
        this.toolServer?.releaseAgent(task.agentId);
      }
      if (task.writeMode === 'worktree' && task.worktreeInfo) {
        this.worktreeManager.cleanup(task.id, task.worktreeInfo.path).catch(() => {});
      }
      cancelled++;
    }
  }
  return cancelled;
}
```

### A2: Worktree timeout must release toolServer agent

**File:** `dispatch-pipeline.ts:622-633`

**Current:** Timeout cleanup at line 629-631 releases scope for scoped tasks but NOT toolServer for worktree tasks. After worktree timeout, toolServer agent slot stays pinned.

**Fix:** Add worktree release in the timeout block:
```typescript
if (t.status === 'running') {
  t.status = 'failed';
  t.error = 'collect timeout';
  t.completedAt = Date.now();
  if (t.writeMode === 'scoped') {
    this.scopeTracker.release(t.id);
    this.toolServer?.releaseAgent(t.agentId);
  }
  if (t.writeMode === 'worktree') {
    this.toolServer?.releaseAgent(t.agentId);
  }
}
```

### A3: Worktree `.catch()` path must clean up worktree on executeTask failure

**File:** `dispatch-pipeline.ts:323-339`

**Current:** If `worktreeManager.create()` succeeds but `executeTask()` fails, the `.catch()` calls `releaseAgent` but not `worktreeManager.cleanup()`. The worktree FS path and git branch are leaked until next `collect()` — but if `collect()` is never called, they leak permanently.

**Fix:** Add cleanup in the `.catch()`:
```typescript
}).catch((err: Error) => {
  entry.status = 'failed'; entry.error = err.message; entry.completedAt = Date.now();
  this.toolServer?.releaseAgent(agentId);
  if (entry.worktreeInfo) {
    this.worktreeManager.cleanup(taskId, entry.worktreeInfo.path).catch(() => {});
  }
  throw err;
});
```

### A4: Constructor must clear stale scopes from orphaned tasks

**File:** `dispatch-pipeline.ts:127` (constructor area) and `446-469` (orphan detection)

**Current:** `pruneOrphans()` cleans up git worktrees but doesn't clear `scopeTracker` entries for orphaned scoped tasks. After server restart during a scoped task, that scope path is permanently locked.

**Fix:** In the orphan handling code, release scope for orphaned tasks:
```typescript
// In orphan detection / constructor init
for (const orphan of orphanedTasks) {
  if (orphan.writeMode === 'scoped') {
    this.scopeTracker.release(orphan.id);
  }
}
```

Since scopeTracker is in-memory and starts empty on restart, this is actually a non-issue — stale scopes only exist within a single process lifetime. The real fix is ensuring A1 and A2 correctly release scopes so they never become stale within a session. Marking this as **won't fix** — the constructor doesn't need to clear scopes because scopeTracker starts fresh.

**Revised assessment:** A4 is not a bug. ScopeTracker is in-memory only, so server restart naturally clears all scopes. The actual scope-locking bugs are A1 (cancel doesn't release) and A2 (timeout doesn't release), which are fixed above.

## Batch B: Unbounded File Growth

### B1: Add rotation to `consensus-history.jsonl`

**File:** `dispatch-pipeline.ts:1029-1034`

**Current:** `appendFileSync` on every consensus run, no eviction.

**Fix:** After appending, check line count. If over a cap (e.g., 200 entries), truncate to the most recent 100:
```typescript
const MAX_HISTORY_ENTRIES = 200;
const KEEP_ENTRIES = 100;

// After append:
try {
  const content = readFileSync(historyPath, 'utf-8');
  const lines = content.trim().split('\n');
  if (lines.length > MAX_HISTORY_ENTRIES) {
    writeFileSync(historyPath, lines.slice(-KEEP_ENTRIES).join('\n') + '\n');
  }
} catch { /* best-effort */ }
```

### B2: Add rotation to `session-gossip.jsonl`

**File:** `dispatch-pipeline.ts:1151-1156`

**Current:** `appendFileSync` on every gossip entry, no eviction. In-memory array is capped at 20, but disk file grows forever.

**Fix:** Same pattern as B1 — after append, truncate if over cap:
```typescript
const MAX_GOSSIP_ENTRIES = 100;
const KEEP_GOSSIP = 50;

// After append:
try {
  const content = readFileSync(gossipPath, 'utf-8');
  const lines = content.trim().split('\n');
  if (lines.length > MAX_GOSSIP_ENTRIES) {
    writeFileSync(gossipPath, lines.slice(-KEEP_GOSSIP).join('\n') + '\n');
  }
} catch { /* best-effort */ }
```

## Batch C: Auto-Record Provisional Signals

**Source:** Consensus review (3 agents, 8 confirmed findings) on signal enforcement architecture.

### Problem

After `gossip_collect` returns consensus findings, the orchestrator must call `gossip_signals` for each finding it verifies or invalidates. In practice, it gets absorbed in downstream work (writing specs, planning) and forgets. Text instructions don't change behavior — the rule exists in CLAUDE.md but gets overridden by task focus.

### Why the obvious options don't work

- **Hooks** (scan Write/Edit for "not a bug" patterns) — high false positive rate, fires after the fact, no link to preceding collect
- **Structured checklist** from collect — still advisory text the orchestrator can ignore
- **gossip_verify tool** — MCP can't gate tool calls, orchestrator ignores new tools same as old

### Fix: Auto-record provisional signals at collect time

Follow the auto-persistence pattern that already works for failures (`collect.ts:118-144`). After consensus, auto-record a provisional signal for every finding:

| Finding tag | Auto-signal | Meaning |
|------------|-------------|---------|
| confirmed | `unique_confirmed` | Peers agreed — provisionally credited (conservative: not `agreement` until orchestrator verifies) |
| disputed | `disagreement` | Peers disagreed — provisionally penalized |
| unverified | `unique_unconfirmed` | Can't verify — conservative default |
| unique | `unique_unconfirmed` | One agent only — conservative default |

The orchestrator then only needs to **retract** wrong signals via `gossip_signals(action: "retract")` — lower friction than proactively recording. Forgetting to verify = provisional scores stand (closer to ground truth than silence).

**File:** `apps/cli/src/handlers/collect.ts:152-184`

After the auto-persist block, add provisional signal recording:
```typescript
// Auto-record provisional signals for all consensus findings
try {
  const { PerformanceWriter } = await import('@gossip/orchestrator');
  const writer = new PerformanceWriter(process.cwd());
  const timestamp = new Date().toISOString();

  const tagToSignal: Record<string, string> = {
    confirmed: 'unique_confirmed',
    disputed: 'disagreement',
    unverified: 'unique_unconfirmed',
    unique: 'unique_unconfirmed',
  };

  const allFindings = [
    ...(consensusReport.confirmed || []),
    ...(consensusReport.disputed || []),
    ...(consensusReport.unverified || []),
    ...(consensusReport.unique || []),
  ];

  const provisionalSignals = allFindings.map((f: any) => ({
    type: 'consensus' as const,
    taskId: f.id || '',
    signal: tagToSignal[f.tag] || 'unique_unconfirmed',
    agentId: f.originalAgentId,
    evidence: `[provisional] ${f.finding?.slice(0, 200) || 'no description'}`,
    timestamp,
  }));

  if (provisionalSignals.length > 0) {
    writer.appendSignals(provisionalSignals);
    process.stderr.write(`[gossipcat] Auto-recorded ${provisionalSignals.length} provisional signal(s). Retract incorrect ones with gossip_signals(action: "retract").\n`);
  }
} catch { /* best-effort */ }
```

Add a note in the collect output:
```typescript
if (provisionalSignalCount > 0) {
  output += `\n\n📊 ${provisionalSignalCount} provisional signals auto-recorded. Retract incorrect ones with gossip_signals(action: "retract", agent_id, reason).`;
}
```

### C2: Fix dead branch bug in auto-failure signals

**File:** `apps/cli/src/handlers/collect.ts:134`

**Current:**
```typescript
signal: (r.status === 'failed' ? 'disagreement' : 'disagreement') as const,
```
Both branches identical — dead code.

**Fix:** Use appropriate signal types:
```typescript
signal: (r.status === 'failed' ? 'disagreement' : 'unique_unconfirmed') as const,
```
- `failed` → `disagreement` (agent produced an error — reliability failure)
- `timed_out` / empty → `unique_unconfirmed` (agent didn't respond — less severe than active failure)

## What This Does NOT Change

- Race conditions on entry.status (deferred — needs broader refactoring)
- Task removal timing vs memory writes (deferred)
- The `collect()` method structure (confirmed as complex but functional)
- Path traversal guard (already patched in commit 15c2b40)

## Test Plan

### Batch A
- `cancelRunningTasks()` with scoped task → verify `scopeTracker.release()` called
- `cancelRunningTasks()` with worktree task → verify `worktreeManager.cleanup()` called
- Timeout in `collect()` with worktree task → verify `releaseAgent()` called
- Worktree task where executeTask fails → verify worktree cleaned up

### Batch B
- `consensus-history.jsonl` with >200 entries → verify truncated to 100
- `session-gossip.jsonl` with >100 entries → verify truncated to 50

### Batch C
- `handleCollect` with consensus report → verify provisional signals written for all finding tags
- Provisional signal for confirmed finding uses `unique_confirmed`, not `agreement`
- Provisional signal for unverified finding uses `unique_unconfirmed`
- Auto-failure signal for timeout uses `unique_unconfirmed`, not `disagreement`
- Collect output includes provisional signal count and retract instructions
- Existing consensus and dispatch tests still pass
