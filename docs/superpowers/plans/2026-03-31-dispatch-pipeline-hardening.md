# Dispatch Pipeline Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix resource leaks in cancel/timeout paths, add file rotation for unbounded JSONL files, and auto-record provisional signals at collect time.

**Architecture:** Three independent batches — (A) resource leaks in dispatch-pipeline.ts, (B) file rotation in dispatch-pipeline.ts, (C) provisional signals + dead branch fix in handlers/collect.ts. Each batch can be committed independently.

**Tech Stack:** TypeScript, Jest, Node.js `fs`

**Spec:** `docs/superpowers/specs/2026-03-31-dispatch-pipeline-hardening.md`

---

### Task 1: Fix `cancelRunningTasks()` to release scopes and worktrees

**Files:**
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts:424-435`
- Test: `tests/orchestrator/dispatch-pipeline.test.ts`

- [ ] **Step 1: Write failing tests**

Add a new describe block in `tests/orchestrator/dispatch-pipeline.test.ts` after the existing `write modes` block:

```typescript
describe('cancelRunningTasks()', () => {
  it('releases scoped task resources on cancel', async () => {
    const releaseAgent = jest.fn();
    const hangingWorker = {
      executeTask: jest.fn().mockReturnValue(new Promise(() => {})), // never resolves
      subscribeToBatch: jest.fn().mockResolvedValue(undefined),
      unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
    };
    const ws = new Map([['hang-agent', hangingWorker]]);
    const p = new DispatchPipeline({
      projectRoot: '/tmp/gossip-cancel-test-' + Date.now(),
      workers: ws,
      registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      toolServer: { assignScope: jest.fn(), assignRoot: jest.fn(), releaseAgent },
    });

    p.dispatch('hang-agent', 'scoped task', { writeMode: 'scoped', scope: 'packages/relay/' });
    const cancelled = p.cancelRunningTasks();
    expect(cancelled).toBe(1);
    expect(releaseAgent).toHaveBeenCalledWith('hang-agent');

    // Scope should be released — dispatching to same scope should not throw
    const freshWorker = {
      executeTask: jest.fn().mockResolvedValue({ result: 'ok', inputTokens: 0, outputTokens: 0 }),
      subscribeToBatch: jest.fn().mockResolvedValue(undefined),
      unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
    };
    ws.set('fresh-agent', freshWorker);
    expect(() =>
      p.dispatch('fresh-agent', 'new scoped task', { writeMode: 'scoped', scope: 'packages/relay/' })
    ).not.toThrow();
  });

  it('cleans up worktree task resources on cancel', async () => {
    const cleanupMock = jest.fn().mockResolvedValue(undefined);
    const releaseAgent = jest.fn();
    const hangingWorker = {
      executeTask: jest.fn().mockReturnValue(new Promise(() => {})),
      subscribeToBatch: jest.fn().mockResolvedValue(undefined),
      unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
    };
    const ws = new Map([['hang-agent', hangingWorker]]);
    const p = new DispatchPipeline({
      projectRoot: '/tmp/gossip-cancel-wt-test-' + Date.now(),
      workers: ws,
      registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      toolServer: { assignScope: jest.fn(), assignRoot: jest.fn(), releaseAgent },
    });

    // Manually set up a task with worktreeInfo to simulate a running worktree task
    const { taskId } = p.dispatch('hang-agent', 'worktree task');
    const task = p.getTask(taskId)!;
    (task as any).writeMode = 'worktree';
    (task as any).worktreeInfo = { path: '/tmp/wt-test', branch: 'gossip-test' };
    // Inject mock worktreeManager
    (p as any).worktreeManager = { cleanup: cleanupMock, create: jest.fn(), merge: jest.fn(), pruneOrphans: jest.fn() };

    p.cancelRunningTasks();
    expect(cleanupMock).toHaveBeenCalledWith(taskId, '/tmp/wt-test');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/orchestrator/dispatch-pipeline.test.ts -t "cancelRunningTasks" --no-coverage`
Expected: FAIL — `releaseAgent` not called, scope not released

- [ ] **Step 3: Implement the fix**

In `packages/orchestrator/src/dispatch-pipeline.ts`, replace the `cancelRunningTasks` method (lines 424-435):

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
        this.toolServer?.releaseAgent(task.agentId);
      }
      cancelled++;
    }
  }
  return cancelled;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/orchestrator/dispatch-pipeline.test.ts -t "cancelRunningTasks" --no-coverage`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/dispatch-pipeline.ts tests/orchestrator/dispatch-pipeline.test.ts
git commit -m "fix(dispatch): cancelRunningTasks releases scopes and worktrees

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Fix worktree timeout to release toolServer agent

**Files:**
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts:622-633`
- Test: `tests/orchestrator/dispatch-pipeline.test.ts`

- [ ] **Step 1: Write failing test**

Add to the `cancelRunningTasks()` describe block (or create a new `collect() timeout cleanup` block):

```typescript
describe('collect() timeout cleanup', () => {
  it('releases toolServer agent for timed-out worktree tasks', async () => {
    const releaseAgent = jest.fn();
    const hangingWorker = {
      executeTask: jest.fn().mockReturnValue(new Promise(() => {})),
      subscribeToBatch: jest.fn().mockResolvedValue(undefined),
      unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
    };
    const ws = new Map([['hang-agent', hangingWorker]]);
    const p = new DispatchPipeline({
      projectRoot: '/tmp/gossip-timeout-test-' + Date.now(),
      workers: ws,
      registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      toolServer: { assignScope: jest.fn(), assignRoot: jest.fn(), releaseAgent },
    });

    const { taskId } = p.dispatch('hang-agent', 'slow worktree task');
    const task = p.getTask(taskId)!;
    (task as any).writeMode = 'worktree';
    (task as any).worktreeInfo = { path: '/tmp/wt-timeout', branch: 'gossip-timeout' };
    (p as any).worktreeManager = { cleanup: jest.fn().mockResolvedValue(undefined), create: jest.fn(), merge: jest.fn(), pruneOrphans: jest.fn() };

    // Collect with very short timeout — task will still be running
    await p.collect([taskId], 50);
    expect(releaseAgent).toHaveBeenCalledWith('hang-agent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/dispatch-pipeline.test.ts -t "timed-out worktree" --no-coverage`
Expected: FAIL — `releaseAgent` not called for worktree timeout

- [ ] **Step 3: Implement the fix**

In `packages/orchestrator/src/dispatch-pipeline.ts`, find the timeout cleanup block (line ~622-633). After the existing `if (t.writeMode === 'scoped')` block, add worktree release:

```typescript
if (t.status === 'running') {
  t.status = 'failed';
  t.error = 'collect timeout';
  t.completedAt = Date.now();
  // Fix 5: release scope for timed-out scoped tasks (prevents permanent scope leak)
  if (t.writeMode === 'scoped') {
    this.scopeTracker.release(t.id);
    this.toolServer?.releaseAgent(t.agentId);
  }
  // Fix: release toolServer for timed-out worktree tasks
  if (t.writeMode === 'worktree') {
    this.toolServer?.releaseAgent(t.agentId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/orchestrator/dispatch-pipeline.test.ts -t "timed-out worktree" --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/dispatch-pipeline.ts tests/orchestrator/dispatch-pipeline.test.ts
git commit -m "fix(dispatch): release toolServer agent on worktree task timeout

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Fix worktree `.catch()` to clean up on executeTask failure

**Files:**
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts:323-339`
- Test: `tests/orchestrator/dispatch-pipeline.test.ts`

- [ ] **Step 1: Read the current worktree dispatch code**

Read `packages/orchestrator/src/dispatch-pipeline.ts` lines 320-345 to see the exact `.catch()` block.

- [ ] **Step 2: Write failing test**

```typescript
describe('worktree error cleanup', () => {
  it('cleans up worktree when executeTask fails', async () => {
    const cleanupMock = jest.fn().mockResolvedValue(undefined);
    const createMock = jest.fn().mockResolvedValue({ path: '/tmp/wt-fail', branch: 'gossip-fail' });
    const failWorker = {
      executeTask: jest.fn().mockRejectedValue(new Error('exec failed')),
      subscribeToBatch: jest.fn().mockResolvedValue(undefined),
      unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
    };
    const ws = new Map([['fail-agent', failWorker]]);
    const p = new DispatchPipeline({
      projectRoot: '/tmp/gossip-wt-fail-test-' + Date.now(),
      workers: ws,
      registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
    });
    // Inject mock worktreeManager
    (p as any).worktreeManager = { cleanup: cleanupMock, create: createMock, merge: jest.fn(), pruneOrphans: jest.fn() };

    const { taskId, promise } = p.dispatch('fail-agent', 'doomed task', { writeMode: 'worktree' });
    await promise.catch(() => {}); // swallow rejection

    const task = p.getTask(taskId);
    expect(task?.status).toBe('failed');
    expect(cleanupMock).toHaveBeenCalledWith(taskId, '/tmp/wt-fail');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/orchestrator/dispatch-pipeline.test.ts -t "cleans up worktree when executeTask fails" --no-coverage`
Expected: FAIL — `cleanup` not called

- [ ] **Step 4: Implement the fix**

In `packages/orchestrator/src/dispatch-pipeline.ts`, find the worktree `.catch()` block (around line 335). Add worktree cleanup:

```typescript
}).catch((err: Error) => {
  entry.status = 'failed'; entry.error = err.message; entry.completedAt = Date.now();
  this.toolServer?.releaseAgent(agentId);
  // Clean up worktree on failure to prevent leaked FS paths and git branches
  if (entry.worktreeInfo) {
    this.worktreeManager.cleanup(taskId, entry.worktreeInfo.path).catch(() => {});
  }
  throw err;
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/orchestrator/dispatch-pipeline.test.ts --no-coverage`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/dispatch-pipeline.ts tests/orchestrator/dispatch-pipeline.test.ts
git commit -m "fix(dispatch): clean up worktree on executeTask failure

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Add JSONL file rotation for consensus-history and session-gossip

**Files:**
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts:1029-1034` and `1151-1156`
- Test: `tests/orchestrator/dispatch-pipeline.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('JSONL file rotation', () => {
  const fs = require('fs');
  const path = require('path');

  it('rotates consensus-history.jsonl when over 200 entries', async () => {
    const tmpDir = '/tmp/gossip-rotation-test-' + Date.now();
    fs.mkdirSync(path.join(tmpDir, '.gossip'), { recursive: true });
    const historyPath = path.join(tmpDir, '.gossip', 'consensus-history.jsonl');

    // Write 210 entries
    const lines = Array.from({ length: 210 }, (_, i) => JSON.stringify({ id: i, summary: `entry ${i}` }));
    fs.writeFileSync(historyPath, lines.join('\n') + '\n');

    const p = new DispatchPipeline({
      projectRoot: tmpDir,
      workers: new Map([['test-agent', mockWorker()]]),
      registryGet: () => mockRegistryGet(),
    });

    // Trigger rotation by calling the private method or running consensus
    // Access private rotateJsonl helper
    (p as any).rotateJsonlFile(historyPath, 200, 100);

    const content = fs.readFileSync(historyPath, 'utf-8').trim();
    const remaining = content.split('\n');
    expect(remaining.length).toBe(100);
    // Should keep the LAST 100 entries (110-209)
    expect(JSON.parse(remaining[0]).id).toBe(110);
    expect(JSON.parse(remaining[99]).id).toBe(209);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not rotate when under the cap', async () => {
    const tmpDir = '/tmp/gossip-rotation-norot-' + Date.now();
    fs.mkdirSync(path.join(tmpDir, '.gossip'), { recursive: true });
    const historyPath = path.join(tmpDir, '.gossip', 'consensus-history.jsonl');

    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: i }));
    fs.writeFileSync(historyPath, lines.join('\n') + '\n');

    const p = new DispatchPipeline({
      projectRoot: tmpDir,
      workers: new Map([['test-agent', mockWorker()]]),
      registryGet: () => mockRegistryGet(),
    });

    (p as any).rotateJsonlFile(historyPath, 200, 100);

    const content = fs.readFileSync(historyPath, 'utf-8').trim();
    expect(content.split('\n').length).toBe(50);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/orchestrator/dispatch-pipeline.test.ts -t "JSONL file rotation" --no-coverage`
Expected: FAIL — `rotateJsonlFile is not a function`

- [ ] **Step 3: Implement `rotateJsonlFile` helper and wire it up**

Add a private helper method to `DispatchPipeline`:

```typescript
/** Rotate a JSONL file: if over maxEntries lines, keep only the last keepEntries. */
private rotateJsonlFile(filePath: string, maxEntries: number, keepEntries: number): void {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    if (lines.length > maxEntries) {
      writeFileSync(filePath, lines.slice(-keepEntries).join('\n') + '\n');
    }
  } catch { /* file may not exist yet */ }
}
```

Note: Add `writeFileSync` to the existing `import { readFileSync, appendFileSync, mkdirSync } from 'fs'` at the top of the file.

Then call it after the two append sites:

At line ~1033 (after `appendFileSync(historyPath, ...)`):
```typescript
this.rotateJsonlFile(historyPath, 200, 100);
```

At line ~1155 (after `appendFileSync(gossipPath, ...)`):
```typescript
this.rotateJsonlFile(gossipPath, 100, 50);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/orchestrator/dispatch-pipeline.test.ts -t "JSONL file rotation" --no-coverage`
Expected: All PASS

- [ ] **Step 5: Run full dispatch test suite**

Run: `npx jest tests/orchestrator/dispatch-pipeline --no-coverage`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/dispatch-pipeline.ts tests/orchestrator/dispatch-pipeline.test.ts
git commit -m "fix(dispatch): add JSONL file rotation for consensus-history and session-gossip

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Auto-record provisional signals at collect time

**Files:**
- Modify: `apps/cli/src/handlers/collect.ts:152-184`
- Test: `tests/orchestrator/dispatch-pipeline.test.ts` (or a new `tests/cli/collect.test.ts` if test infra exists)

Since `collect.ts` is a handler that depends on the full MCP context, testing the provisional signal logic in isolation is better. We'll add a unit test that verifies the signal-building logic directly in the dispatch-pipeline tests.

- [ ] **Step 1: Write the provisional signal recording code**

In `apps/cli/src/handlers/collect.ts`, after the auto-persist block (line 184), add:

```typescript
// Auto-record provisional signals for all consensus findings
// This makes signal recording the default — orchestrator retracts incorrect ones
let provisionalSignalCount = 0;
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
    evidence: `[provisional] ${(f.finding || '').slice(0, 200)}`,
    timestamp,
  }));

  if (provisionalSignals.length > 0) {
    writer.appendSignals(provisionalSignals);
    provisionalSignalCount = provisionalSignals.length;
    process.stderr.write(`[gossipcat] Auto-recorded ${provisionalSignalCount} provisional signal(s). Retract incorrect ones with gossip_signals(action: "retract").\n`);
  }
} catch { /* best-effort */ }
```

Then in the output formatting section (around line 208), after the consensus summary, add:

```typescript
if (provisionalSignalCount > 0) {
  output += `\n\n📊 ${provisionalSignalCount} provisional signals auto-recorded. Retract incorrect ones with gossip_signals(action: "retract", agent_id, reason).`;
}
```

Note: Move the `provisionalSignalCount` variable declaration above the `if (consensusReport)` block so it's in scope for the output section.

- [ ] **Step 2: Fix the dead branch bug**

In `apps/cli/src/handlers/collect.ts:134`, replace:
```typescript
signal: (r.status === 'failed' ? 'disagreement' : 'disagreement') as const,
```
With:
```typescript
signal: (r.status === 'failed' ? 'disagreement' : 'unique_unconfirmed') as const,
```

- [ ] **Step 3: Build and verify**

Run: `npm run build -w packages/orchestrator && npm run build -w apps/cli 2>&1 | tail -5`

If CLI build fails with pre-existing errors (unrelated to our changes), verify the handler file compiles by checking for TypeScript errors in our specific file:
```bash
npx tsc --noEmit --pretty apps/cli/src/handlers/collect.ts 2>&1 | head -20
```

- [ ] **Step 4: Run existing tests**

Run: `npx jest tests/orchestrator/dispatch-pipeline --no-coverage`
Expected: All PASS (our handler change doesn't break dispatch tests)

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/handlers/collect.ts
git commit -m "feat(collect): auto-record provisional signals for all consensus findings

Flips signal recording default from opt-in to opt-out. All consensus
findings get a provisional signal at collect time. Orchestrator retracts
incorrect ones instead of proactively recording correct ones.

Also fixes dead branch bug at line 134 where both ternary branches
evaluated to 'disagreement'.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Rebuild MCP and verify end-to-end

**Files:** No code changes — verification only.

- [ ] **Step 1: Rebuild orchestrator + relay**

```bash
npm run build -w packages/orchestrator && npm run build -w packages/relay
```

- [ ] **Step 2: Run full test suite**

```bash
npx jest tests/orchestrator/dispatch-pipeline tests/orchestrator/consensus --no-coverage
```
Expected: All PASS

- [ ] **Step 3: Verify provisional signals in a real consensus run**

After MCP reconnect, run a small consensus dispatch and check:
- Collect output includes "N provisional signals auto-recorded"
- `.gossip/agents/*/performance/signals.jsonl` contains `[provisional]` entries
- Retract flow works: `gossip_signals(action: "retract", agent_id: "...", reason: "...")`

---

## Summary

| Task | Batch | What | Files |
|------|-------|------|-------|
| 1 | A | cancelRunningTasks releases resources | dispatch-pipeline.ts, test |
| 2 | A | Worktree timeout releases toolServer | dispatch-pipeline.ts, test |
| 3 | A | Worktree .catch() cleans up on failure | dispatch-pipeline.ts, test |
| 4 | B | JSONL file rotation | dispatch-pipeline.ts, test |
| 5 | C | Provisional signals + dead branch fix | collect.ts |
| 6 | — | Rebuild and verify | — |
