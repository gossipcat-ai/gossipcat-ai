# Gossipcat Write Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable gossipcat workers (Gemini, GPT) to safely handle implementation tasks with three layered write modes: sequential, scoped, and worktree.

**Architecture:** Add `DispatchOptions` with `writeMode` to `dispatch()`. Three new modules: `ScopeTracker` (directory overlap detection), `WorktreeManager` (git worktree lifecycle), and write queue logic in `DispatchPipeline`. Tool Server gains scope/root enforcement with fail-closed semantics.

**Tech Stack:** TypeScript, Jest, @gossip/orchestrator, @gossip/tools, git worktrees

**Spec:** `docs/superpowers/specs/2026-03-22-gossipcat-write-tasks-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/orchestrator/src/types.ts` | **Edit** | Add `DispatchOptions`, extend `TaskEntry` with writeMode/scope/worktreeInfo |
| `packages/orchestrator/src/scope-tracker.ts` | **Create** | ScopeTracker: normalize, overlap detection, register/release (~70 lines) |
| `packages/orchestrator/src/worktree-manager.ts` | **Create** | WorktreeManager: create/merge/cleanup/pruneOrphans (~100 lines) |
| `packages/orchestrator/src/dispatch-pipeline.ts` | **Edit** | Add writeMode handling: sequential queue, scoped delegation, worktree delegation, drainWriteQueue, write timeout |
| `packages/orchestrator/src/index.ts` | **Edit** | Export new modules |
| `packages/tools/src/tool-server.ts` | **Edit** | Add agentScopes/agentRoots/writeAgents maps, scope_assign/root_assign RPCs, fail-closed enforcement, shell pattern blocking |
| `apps/cli/src/mcp-server-sdk.ts` | **Edit** | Add write_mode/scope/timeout_ms params to gossip_dispatch and gossip_dispatch_parallel |
| `tests/orchestrator/scope-tracker.test.ts` | **Create** | Overlap detection, register/release, path traversal rejection |
| `tests/orchestrator/worktree-manager.test.ts` | **Create** | Create/merge/cleanup, conflict detection |
| `tests/orchestrator/dispatch-pipeline.test.ts` | **Edit** | Sequential queue, scoped dispatch, worktree dispatch, timeout tests |

---

### Task 1: Add DispatchOptions and TaskEntry fields to types.ts

**Files:**
- Modify: `packages/orchestrator/src/types.ts`

- [ ] **Step 1: Add DispatchOptions interface and TaskEntry fields**

In `packages/orchestrator/src/types.ts`, after the `TaskEntry` interface, add:

```typescript
/** Options for write-mode dispatch */
export interface DispatchOptions {
  writeMode?: 'sequential' | 'scoped' | 'worktree';
  scope?: string;
  timeoutMs?: number;
}
```

And extend `TaskEntry` with:

```typescript
export interface TaskEntry {
  // ... existing fields ...
  writeMode?: 'sequential' | 'scoped' | 'worktree';
  scope?: string;
  worktreeInfo?: {
    path: string;
    branch: string;
  };
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/goku/Desktop/gossip && npx jest --config jest.config.base.js tests/orchestrator/dispatch-pipeline.test.ts --verbose`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/types.ts
git commit -m "feat(types): add DispatchOptions and write-mode TaskEntry fields"
```

---

### Task 2: Create ScopeTracker

**Files:**
- Create: `packages/orchestrator/src/scope-tracker.ts`
- Create: `tests/orchestrator/scope-tracker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/orchestrator/scope-tracker.test.ts`:

```typescript
import { ScopeTracker } from '../../packages/orchestrator/src/scope-tracker';

describe('ScopeTracker', () => {
  let tracker: ScopeTracker;
  const projectRoot = '/test/project';

  beforeEach(() => { tracker = new ScopeTracker(projectRoot); });

  describe('overlap detection', () => {
    it('detects parent/child overlap', () => {
      tracker.register('packages/relay/', 'task-1');
      const result = tracker.hasOverlap('packages/relay/src/');
      expect(result.overlaps).toBe(true);
      expect(result.conflictTaskId).toBe('task-1');
    });

    it('detects child/parent overlap', () => {
      tracker.register('packages/relay/src/', 'task-1');
      expect(tracker.hasOverlap('packages/relay/').overlaps).toBe(true);
    });

    it('allows sibling scopes', () => {
      tracker.register('packages/relay/', 'task-1');
      expect(tracker.hasOverlap('packages/tools/').overlaps).toBe(false);
    });

    it('rejects path traversal', () => {
      expect(() => tracker.register('../../etc/', 'task-1')).toThrow('resolves outside project root');
    });
  });

  describe('lifecycle', () => {
    it('releases scope by taskId', () => {
      tracker.register('packages/relay/', 'task-1');
      tracker.release('task-1');
      expect(tracker.hasOverlap('packages/relay/').overlaps).toBe(false);
    });

    it('clears all scopes', () => {
      tracker.register('packages/relay/', 'task-1');
      tracker.register('packages/tools/', 'task-2');
      tracker.clear();
      expect(tracker.hasOverlap('packages/relay/').overlaps).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config jest.config.base.js tests/orchestrator/scope-tracker.test.ts --verbose`
Expected: FAIL — ScopeTracker doesn't exist

- [ ] **Step 3: Implement ScopeTracker**

Create `packages/orchestrator/src/scope-tracker.ts`:

```typescript
import { resolve, relative } from 'path';

export class ScopeTracker {
  private activeScopes: Map<string, string> = new Map(); // normalized scope → taskId
  private taskToScope: Map<string, string> = new Map();  // taskId → scope (for release)

  constructor(private projectRoot: string) {}

  private normalize(scope: string): string {
    const abs = resolve(this.projectRoot, scope);
    const rel = relative(this.projectRoot, abs);
    if (rel.startsWith('..')) throw new Error(`Scope "${scope}" resolves outside project root`);
    return rel.endsWith('/') ? rel : rel + '/';
  }

  hasOverlap(scope: string): { overlaps: boolean; conflictTaskId?: string; conflictScope?: string } {
    const normalized = this.normalize(scope);
    for (const [activeScope, taskId] of this.activeScopes) {
      if (normalized.startsWith(activeScope) || activeScope.startsWith(normalized)) {
        return { overlaps: true, conflictTaskId: taskId, conflictScope: activeScope };
      }
    }
    return { overlaps: false };
  }

  register(scope: string, taskId: string): void {
    const normalized = this.normalize(scope);
    this.activeScopes.set(normalized, taskId);
    this.taskToScope.set(taskId, normalized);
  }

  release(taskId: string): void {
    const scope = this.taskToScope.get(taskId);
    if (scope) {
      this.activeScopes.delete(scope);
      this.taskToScope.delete(taskId);
    }
  }

  clear(): void {
    this.activeScopes.clear();
    this.taskToScope.clear();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx jest --config jest.config.base.js tests/orchestrator/scope-tracker.test.ts --verbose`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/scope-tracker.ts tests/orchestrator/scope-tracker.test.ts
git commit -m "feat(orchestrator): add ScopeTracker with overlap detection and path traversal prevention"
```

---

### Task 3: Create WorktreeManager

**Files:**
- Create: `packages/orchestrator/src/worktree-manager.ts`
- Create: `tests/orchestrator/worktree-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/orchestrator/worktree-manager.test.ts`:

```typescript
import { WorktreeManager } from '../../packages/orchestrator/src/worktree-manager';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('WorktreeManager', () => {
  const testDir = join(tmpdir(), `gossip-wt-test-${Date.now()}`);
  let manager: WorktreeManager;

  beforeAll(() => {
    // Create a test git repo
    mkdirSync(testDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: testDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: testDir });
  });

  afterAll(() => { rmSync(testDir, { recursive: true, force: true }); });

  beforeEach(() => { manager = new WorktreeManager(testDir); });

  it('creates a worktree with a branch', async () => {
    const { path, branch } = await manager.create('test-1');
    expect(existsSync(path)).toBe(true);
    expect(branch).toBe('gossip-test-1');
    await manager.cleanup('test-1', path);
  });

  it('merges a worktree with changes', async () => {
    const { path, branch } = await manager.create('test-2');
    writeFileSync(join(path, 'new-file.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: path });
    execFileSync('git', ['commit', '-m', 'add file'], { cwd: path });

    const result = await manager.merge('test-2');
    expect(result.merged).toBe(true);
    expect(existsSync(join(testDir, 'new-file.txt'))).toBe(true);
    await manager.cleanup('test-2', path);
  });

  it('detects merge conflicts', async () => {
    // Create conflicting changes on main and worktree
    const { path, branch } = await manager.create('test-3');

    // Change on main
    writeFileSync(join(testDir, 'conflict.txt'), 'main version');
    execFileSync('git', ['add', '.'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'main change'], { cwd: testDir });

    // Change on worktree
    writeFileSync(join(path, 'conflict.txt'), 'worktree version');
    execFileSync('git', ['add', '.'], { cwd: path });
    execFileSync('git', ['commit', '-m', 'wt change'], { cwd: path });

    const result = await manager.merge('test-3');
    expect(result.merged).toBe(false);
    expect(result.conflicts).toBeDefined();
    await manager.cleanup('test-3', path);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config jest.config.base.js tests/orchestrator/worktree-manager.test.ts --verbose`
Expected: FAIL

- [ ] **Step 3: Implement WorktreeManager**

Create `packages/orchestrator/src/worktree-manager.ts`:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

export class WorktreeManager {
  constructor(private projectRoot: string) {}

  async create(taskId: string): Promise<{ path: string; branch: string }> {
    const branch = `gossip-${taskId}`;
    const wtPath = await mkdtemp(join(tmpdir(), 'gossip-wt-'));

    await execFileAsync('git', ['branch', branch, 'HEAD'], { cwd: this.projectRoot });
    await execFileAsync('git', ['worktree', 'add', wtPath, branch], { cwd: this.projectRoot });

    return { path: wtPath, branch };
  }

  async merge(taskId: string): Promise<{ merged: boolean; conflicts?: string[] }> {
    const branch = `gossip-${taskId}`;

    const log = await execFileAsync('git', ['log', `HEAD..${branch}`, '--oneline'], { cwd: this.projectRoot });
    if (!log.stdout.trim()) return { merged: true };

    try {
      await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', 'merge', branch, '--no-edit'], { cwd: this.projectRoot });
      return { merged: true };
    } catch {
      await execFileAsync('git', ['merge', '--abort'], { cwd: this.projectRoot });
      const diff = await execFileAsync('git', ['diff', '--name-only', `HEAD...${branch}`], { cwd: this.projectRoot });
      return { merged: false, conflicts: diff.stdout.trim().split('\n') };
    }
  }

  async cleanup(taskId: string, wtPath: string): Promise<void> {
    const branch = `gossip-${taskId}`;
    try { await execFileAsync('git', ['worktree', 'remove', wtPath, '--force'], { cwd: this.projectRoot }); } catch { /* already removed */ }
    try { await execFileAsync('git', ['branch', '-d', branch], { cwd: this.projectRoot }); } catch { /* branch in use */ }
  }

  async pruneOrphans(): Promise<void> {
    try {
      const result = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: this.projectRoot });
      const orphans = result.stdout.split('\n\n')
        .filter(block => block.includes('gossip-wt-'))
        .map(block => block.match(/worktree (.+)/)?.[1])
        .filter(Boolean);
      for (const wtPath of orphans) {
        try { await execFileAsync('git', ['worktree', 'remove', wtPath!, '--force'], { cwd: this.projectRoot }); } catch {}
      }
      await execFileAsync('git', ['worktree', 'prune'], { cwd: this.projectRoot });
    } catch { /* git not available or no worktrees */ }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx jest --config jest.config.base.js tests/orchestrator/worktree-manager.test.ts --verbose`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/worktree-manager.ts tests/orchestrator/worktree-manager.test.ts
git commit -m "feat(orchestrator): add WorktreeManager with create/merge/cleanup/pruneOrphans"
```

---

### Task 4: Export new modules from orchestrator

**Files:**
- Modify: `packages/orchestrator/src/index.ts`

- [ ] **Step 1: Add exports**

```typescript
export { ScopeTracker } from './scope-tracker';
export { WorktreeManager } from './worktree-manager';
export type { DispatchOptions } from './types';
```

- [ ] **Step 2: Verify build**

Run: `npx jest --config jest.config.base.js tests/orchestrator/ --verbose`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/index.ts
git commit -m "feat(orchestrator): export ScopeTracker, WorktreeManager, DispatchOptions"
```

---

### Task 5: Add write modes to DispatchPipeline

**Files:**
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts`
- Modify: `tests/orchestrator/dispatch-pipeline.test.ts`

This is the largest task — it wires ScopeTracker and WorktreeManager into the dispatch/collect flow.

- [ ] **Step 1: Write failing tests for sequential queue**

Add to `tests/orchestrator/dispatch-pipeline.test.ts`:

```typescript
describe('sequential write mode', () => {
  it('queues sequential tasks behind active write', async () => {
    let resolveFirst: (v: string) => void;
    const slowWorker = { executeTask: jest.fn(() => new Promise<string>(r => { resolveFirst = r; })) };
    workers.set('slow', slowWorker as any);
    pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-test-' + Date.now(),
      workers,
      registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
    });

    const task1 = pipeline.dispatch('slow', 'first', { writeMode: 'sequential' });
    const task2 = pipeline.dispatch('test-agent', 'second', { writeMode: 'sequential' });

    // task2 should not have started yet
    expect(workers.get('test-agent')!.executeTask).not.toHaveBeenCalled();

    // Complete task1
    resolveFirst!('done');
    await task1.promise;

    // Now task2 should run
    const results = await pipeline.collect([task2.taskId]);
    expect(results[0].status).toBe('completed');
  });

  it('does not block read-only tasks', async () => {
    let resolveWrite: (v: string) => void;
    const slowWorker = { executeTask: jest.fn(() => new Promise<string>(r => { resolveWrite = r; })) };
    workers.set('slow', slowWorker as any);
    pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-test-' + Date.now(),
      workers,
      registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
    });

    pipeline.dispatch('slow', 'write task', { writeMode: 'sequential' });
    const read = pipeline.dispatch('test-agent', 'read task'); // no writeMode = read-only

    // Read task should complete immediately
    const result = await read.promise;
    expect(result).toBe('done');

    resolveWrite!('ok');
  });

  it('rejects when queue is full', () => {
    const neverWorker = { executeTask: jest.fn(() => new Promise<string>(() => {})) };
    workers.set('never', neverWorker as any);
    pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-test-' + Date.now(),
      workers,
      registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
    });

    pipeline.dispatch('never', 'active', { writeMode: 'sequential' });
    for (let i = 0; i < 20; i++) {
      pipeline.dispatch('never', `queued-${i}`, { writeMode: 'sequential' });
    }
    expect(() => pipeline.dispatch('never', 'overflow', { writeMode: 'sequential' }))
      .toThrow('Sequential write queue full');
  });

  it('drains queue on task failure', async () => {
    const failWorker = { executeTask: jest.fn().mockRejectedValue(new Error('fail')) };
    workers.set('fail', failWorker as any);
    pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-test-' + Date.now(),
      workers,
      registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
    });

    const task1 = pipeline.dispatch('fail', 'will-fail', { writeMode: 'sequential' });
    const task2 = pipeline.dispatch('test-agent', 'should-run-after', { writeMode: 'sequential' });

    await task1.promise.catch(() => {});
    // Collect task1 to trigger queue drain
    await pipeline.collect([task1.taskId]);
    // task2 should now run and complete
    const results = await pipeline.collect([task2.taskId]);
    expect(results[0].status).toBe('completed');
  });
});

describe('scoped write mode', () => {
  it('rejects overlapping scopes', () => {
    pipeline.dispatch('test-agent', 'task1', { writeMode: 'scoped', scope: 'packages/relay/' });
    expect(() => pipeline.dispatch('test-agent', 'task2', { writeMode: 'scoped', scope: 'packages/relay/src/' }))
      .toThrow(/conflict|overlap/i);
  });

  it('allows non-overlapping scopes', async () => {
    workers.set('agent-b', mockWorker('done'));
    pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-test-' + Date.now(),
      workers,
      registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
    });
    const t1 = pipeline.dispatch('test-agent', 'task1', { writeMode: 'scoped', scope: 'packages/relay/' });
    const t2 = pipeline.dispatch('agent-b', 'task2', { writeMode: 'scoped', scope: 'packages/tools/' });
    await Promise.all([t1.promise, t2.promise]);
    expect(pipeline.getTask(t1.taskId)?.status).toBe('completed');
    expect(pipeline.getTask(t2.taskId)?.status).toBe('completed');
  });

  it('requires scope for scoped mode', () => {
    expect(() => pipeline.dispatch('test-agent', 'task', { writeMode: 'scoped' }))
      .toThrow('scope is required');
  });

  it('releases scope on collect', async () => {
    const { taskId } = pipeline.dispatch('test-agent', 'task', { writeMode: 'scoped', scope: 'packages/relay/' });
    await pipeline.collect([taskId]);
    // Same scope should now be available
    const t2 = pipeline.dispatch('test-agent', 'task2', { writeMode: 'scoped', scope: 'packages/relay/' });
    expect(t2.taskId).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config jest.config.base.js tests/orchestrator/dispatch-pipeline.test.ts --verbose`
Expected: FAIL — dispatch doesn't accept options

- [ ] **Step 3: Implement write modes in DispatchPipeline**

Modify `packages/orchestrator/src/dispatch-pipeline.ts`:

1. Import ScopeTracker and WorktreeManager
2. Add to constructor: `this.scopeTracker = new ScopeTracker(projectRoot)`, `this.worktreeManager = new WorktreeManager(projectRoot)`
3. Add state: `writeQueue`, `activeWriteTaskId`, `MAX_WRITE_QUEUE = 20`, `DEFAULT_WRITE_TIMEOUT = 300_000`
4. Modify `dispatch()` signature to accept `options?: DispatchOptions`
5. Add write mode validation and routing before worker execution
6. Add `drainWriteQueue()` method
7. Modify `collect()` to handle scope release, worktree merge, and queue draining
8. Modify `writeMemoryForTask()` to drain queue on completion/failure of sequential tasks
9. Add write timeout via `setTimeout` that auto-fails the task

Key: Store `writeMode`, `scope`, `worktreeInfo` on the `TrackedTask` entry so `collect()` knows how to handle each task.

- [ ] **Step 4: Run tests**

Run: `npx jest --config jest.config.base.js tests/orchestrator/dispatch-pipeline.test.ts --verbose`
Expected: All pass (existing + new)

- [ ] **Step 5: Run full orchestrator suite**

Run: `npx jest --config jest.config.base.js tests/orchestrator/ --verbose`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/dispatch-pipeline.ts tests/orchestrator/dispatch-pipeline.test.ts
git commit -m "feat(dispatch-pipeline): add sequential/scoped/worktree write modes"
```

---

### Task 6: Add dispatchParallel write mode validation

**Files:**
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts`
- Modify: `tests/orchestrator/dispatch-pipeline.test.ts`

- [ ] **Step 1: Write failing tests for batch validation**

Add to `tests/orchestrator/dispatch-pipeline.test.ts`:

```typescript
describe('dispatchParallel write mode validation', () => {
  it('rejects multiple sequential in one batch', () => {
    const { errors } = pipeline.dispatchParallel([
      { agentId: 'test-agent', task: 't1', writeMode: 'sequential' },
      { agentId: 'test-agent', task: 't2', writeMode: 'sequential' },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('sequential');
  });

  it('rejects overlapping scopes in batch', () => {
    const { errors } = pipeline.dispatchParallel([
      { agentId: 'test-agent', task: 't1', writeMode: 'scoped', scope: 'packages/relay/' },
      { agentId: 'test-agent', task: 't2', writeMode: 'scoped', scope: 'packages/relay/src/' },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('overlap');
  });

  it('allows non-overlapping scopes in batch', () => {
    workers.set('agent-b', mockWorker('done'));
    pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-test-' + Date.now(),
      workers,
      registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
    });
    const { taskIds, errors } = pipeline.dispatchParallel([
      { agentId: 'test-agent', task: 't1', writeMode: 'scoped', scope: 'packages/relay/' },
      { agentId: 'agent-b', task: 't2', writeMode: 'scoped', scope: 'packages/tools/' },
    ]);
    expect(taskIds).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  it('pre-validates agents before dispatching any', () => {
    const { taskIds, errors } = pipeline.dispatchParallel([
      { agentId: 'test-agent', task: 't1', writeMode: 'scoped', scope: 'packages/relay/' },
      { agentId: 'nonexistent', task: 't2', writeMode: 'scoped', scope: 'packages/tools/' },
    ]);
    expect(taskIds).toHaveLength(0); // ALL rejected, not partial
    expect(errors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement batch pre-validation in dispatchParallel**

In `dispatchParallel()`, BEFORE the dispatch loop, add:

1. Pre-validate ALL agents exist
2. Check write mode combination rules (no multiple sequential, no sequential + other write modes)
3. Check inter-batch scope overlap
4. Check worktree agent collision (same agent can't have two worktree tasks)
5. Only if ALL checks pass, proceed to dispatch loop

- [ ] **Step 3: Run tests**

Run: `npx jest --config jest.config.base.js tests/orchestrator/dispatch-pipeline.test.ts --verbose`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/dispatch-pipeline.ts tests/orchestrator/dispatch-pipeline.test.ts
git commit -m "feat(dispatch-pipeline): add dispatchParallel write mode batch validation"
```

---

### Task 7: Add Tool Server scope/root enforcement

**Files:**
- Modify: `packages/tools/src/tool-server.ts`

- [ ] **Step 1: Add scope and root state + RPC handlers**

In `packages/tools/src/tool-server.ts`:

1. Add to `ToolServerConfig`: `orchestratorId?: string`
2. Add instance fields:
   - `agentScopes: Map<string, string>` — agentId → scope path
   - `agentRoots: Map<string, string>` — agentId → worktree path
   - `writeAgents: Set<string>` — agents with active write tasks (for fail-closed)
3. Add RPC handlers in `handleToolRequest` for `scope_assign`, `scope_release`, `root_assign`, `root_release`:
   - ALL require `this.orchestratorId && envelope.sid === this.orchestratorId`
   - `scope_assign` adds to both `agentScopes` and `writeAgents`
   - `root_assign` adds to both `agentRoots` and `writeAgents`
4. **Fail-closed scope enforcement** on `file_write`:
   ```typescript
   if (this.writeAgents.has(callerId) && !this.agentScopes.has(callerId) && !this.agentRoots.has(callerId)) {
     throw new Error(`Agent ${callerId} has active write task but no scope registered — rejecting (fail-closed)`);
   }
   if (this.agentScopes.has(callerId)) {
     // ... scope prefix check on args.path
   }
   ```
5. Per-agent root override for file/git/shell tools:
   ```typescript
   const root = this.agentRoots.get(callerId) || this.sandbox.projectRoot;
   ```
   - `file_read`/`file_write`: use `new Sandbox(root)` for path validation
   - `shell_exec`: set `args.cwd = root`
   - `git_*`: use `new GitTools(root)`
6. Blocked shell patterns for write-mode agents: `../`, `.git/hooks`, absolute paths, `core.hookspath`
7. **Global error handler**: wrap ALL `handleToolRequest` dispatch in try/catch — NEVER crash on malformed input

- [ ] **Step 2: Verify build and tests**

Run: `npx jest --config jest.config.base.js --verbose`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add packages/tools/src/tool-server.ts
git commit -m "feat(tool-server): add scope/root enforcement with fail-closed semantics"
```

---

### Task 8: Add ToolServer state recovery to DispatchPipeline

**Files:**
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts`

- [ ] **Step 1: Add reRegisterWriteTaskState method**

```typescript
async reRegisterWriteTaskState(): Promise<void> {
  for (const [taskId, entry] of this.tasks) {
    try {
      if (entry.writeMode === 'scoped' && entry.scope) {
        // Re-send scope_assign RPC to tool-server
        // (implementation depends on how DispatchPipeline communicates with ToolServer)
      }
      if (entry.writeMode === 'worktree' && entry.worktreeInfo) {
        // Re-send root_assign RPC
      }
    } catch (err) {
      log(`Failed to re-register write state for task ${taskId}: ${(err as Error).message}`);
      // Continue — don't let one failure block others
    }
  }
}
```

- [ ] **Step 2: Wire pruneOrphans into startup**

In DispatchPipeline constructor or an `init()` method:
```typescript
this.worktreeManager.pruneOrphans().catch(err => log(`Orphan cleanup failed: ${err.message}`));
```

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/dispatch-pipeline.ts
git commit -m "feat(dispatch-pipeline): add ToolServer state recovery and orphan cleanup"
```

---

### Task 9: Update MCP tools for write mode

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts`

- [ ] **Step 1: Add write_mode and scope params to gossip_dispatch**

Update the `gossip_dispatch` tool schema:

```typescript
write_mode: z.enum(['sequential', 'scoped', 'worktree']).optional(),
scope: z.string().optional().describe('Directory scope for scoped write mode'),
timeout_ms: z.number().optional().describe('Write task timeout in ms (default 300000)'),
```

Map to DispatchOptions:
```typescript
const options = write_mode
  ? { writeMode: write_mode, scope, timeoutMs: timeout_ms } as DispatchOptions
  : undefined;
const { taskId } = mainAgent.dispatch(agent_id, task, options);
```

- [ ] **Step 2: Add to gossip_dispatch_parallel**

Add `write_mode`, `scope`, `timeout_ms` to each task in the array schema. Map to DispatchOptions for each task.

- [ ] **Step 3: Update gossip_collect output for worktree results**

When a collected task has worktreeInfo, append merge result info:
```typescript
if (t.worktreeInfo) {
  if (t.worktreeInfo.merged) text += '\n\nWorktree merge: SUCCESS';
  else text += `\n\nWorktree merge: CONFLICT\n  Branch preserved: ${t.worktreeInfo.branch}`;
}
```

- [ ] **Step 4: Build and test**

Run: `npm run build:mcp && npx jest --config jest.config.base.js --verbose`
Expected: Clean build, all tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/mcp-server-sdk.ts
git commit -m "feat(mcp): add write_mode and scope params to dispatch tools"
```

---

### Task 10: Add CLI write mode support

**Files:**
- Modify: `apps/cli/src/index.ts` (one-shot mode)
- Modify: `apps/cli/src/chat.ts` (interactive chat)

- [ ] **Step 1: Add --write-mode flag to one-shot CLI**

In `apps/cli/src/index.ts`, the one-shot mode (`if (args.length > 0)`) currently just runs `mainAgent.handleMessage(task)`. Add CLI flag parsing:

```typescript
// Parse --write-mode and --scope from args
let writeMode: string | undefined;
let scope: string | undefined;
const filteredArgs: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--write-mode' && args[i + 1]) {
    writeMode = args[++i];
  } else if (args[i] === '--scope' && args[i + 1]) {
    scope = args[++i];
  } else {
    filteredArgs.push(args[i]);
  }
}
const task = filteredArgs.join(' ');
```

If `writeMode` is set, use `mainAgent.dispatch()` + `mainAgent.collect()` instead of `handleMessage()`:

```typescript
if (writeMode) {
  const { taskId } = mainAgent.dispatch(
    configToAgentConfigs(config)[0]?.id || 'default',
    task,
    { writeMode: writeMode as any, scope }
  );
  const results = await mainAgent.collect([taskId]);
  console.log(results[0]?.result || results[0]?.error || 'No result');
} else {
  const response = await mainAgent.handleMessage(task);
  console.log(response.text);
}
```

Usage: `gossipcat "fix the relay bug" --write-mode sequential`

- [ ] **Step 2: Add /write command to interactive chat**

In `apps/cli/src/chat.ts`, add a `/write` command handler alongside the existing `/image` handler:

```typescript
if (input.startsWith('/write ')) {
  const writeTask = input.slice(7).trim();
  if (!writeTask) { console.log('Usage: /write <task>'); rl.prompt(); return; }

  process.stdout.write(`${c.dim}  dispatching write task...${c.reset}`);

  // Use first available agent for sequential write
  const agents = configToAgentConfigs(config);
  if (agents.length === 0) { console.log('No agents configured.'); rl.prompt(); return; }

  try {
    const { taskId } = mainAgent.dispatch(agents[0].id, writeTask, { writeMode: 'sequential' });
    const results = await mainAgent.collect([taskId]);
    process.stdout.write('\r\x1b[K');
    const r = results[0];
    if (r?.status === 'completed') console.log(`\n${r.result}\n`);
    else console.log(`\n${c.yellow}  Error: ${r?.error || 'Unknown'}${c.reset}\n`);
  } catch (err) {
    process.stdout.write('\r\x1b[K');
    console.log(`\n${c.yellow}  Error: ${(err as Error).message}${c.reset}\n`);
  }
  rl.prompt();
  return;
}
```

Usage in chat: `/write fix the timer leak in worker-agent.ts`

- [ ] **Step 3: Verify build**

Run: `npx jest --config jest.config.base.js --verbose`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/index.ts apps/cli/src/chat.ts
git commit -m "feat(cli): add --write-mode flag for one-shot and /write command for chat"
```

---

### Task 11: Full regression + smoke test

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx jest --config jest.config.base.js --verbose`
Expected: All tests pass

- [ ] **Step 2: Build MCP**

Run: `npm run build:mcp`
Expected: Clean build

- [ ] **Step 3: Smoke test sequential mode**

After `/mcp` reconnect:
```
gossip_dispatch(agent_id: "gemini-tester", task: "Read packages/orchestrator/src/dispatch-pipeline.ts and report the line count", write_mode: "sequential")
gossip_collect()
```
Verify task completes normally.

- [ ] **Step 4: Verify no write mode = unchanged behavior**

```
gossip_dispatch(agent_id: "gemini-tester", task: "List files in packages/tools/src/")
gossip_collect()
```
Verify read-only tasks work exactly as before.

- [ ] **Step 5: Verify line counts**

Run: `wc -l packages/orchestrator/src/scope-tracker.ts packages/orchestrator/src/worktree-manager.ts packages/orchestrator/src/dispatch-pipeline.ts packages/tools/src/tool-server.ts`
Expected:
- `scope-tracker.ts` ≤ 80 lines
- `worktree-manager.ts` ≤ 120 lines
- `dispatch-pipeline.ts` — may exceed 300 temporarily; if so, note for follow-up split
- `tool-server.ts` — may exceed 150; acceptable with new enforcement logic
