# TaskGraph Local — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistent task lifecycle tracking via an append-only JSONL event log. Tasks are recorded on dispatch, completed/failed on collect, with parent-child and cross-reference relationships.

**Architecture:** TaskGraph class reads/writes `.gossip/task-graph.jsonl`. MCP server records events alongside the existing in-memory Map (Map owns promises, TaskGraph owns history). CLI `gossipcat tasks` command shows task history.

**Tech Stack:** TypeScript, JSONL, Jest

**Spec:** `docs/superpowers/specs/2026-03-21-taskgraph-supabase-design.md` (Components 1-2, 5-6 — local parts only)

**Scope:** Local TaskGraph only. Supabase sync is a separate plan.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/orchestrator/src/task-graph.ts` | **NEW** — TaskGraph class: append events, reconstruct tasks, query history |
| `packages/orchestrator/src/types.ts` | **EDIT** — Add TaskGraphEvent types, ReconstructedTask, SyncMeta |
| `packages/orchestrator/src/index.ts` | **EDIT** — Export TaskGraph |
| `apps/cli/src/mcp-server-sdk.ts` | **EDIT** — Record events in dispatch/collect handlers |
| `apps/cli/src/tasks-command.ts` | **NEW** — `gossipcat tasks` CLI command |
| `apps/cli/src/index.ts` | **EDIT** — Register tasks command |
| `tests/orchestrator/task-graph.test.ts` | **NEW** — Event recording, reconstruction, query tests |
| `tests/cli/tasks-command.test.ts` | **NEW** — CLI output format tests |

---

### Task 1: Types — TaskGraph Event Types + ReconstructedTask

**Files:**
- Modify: `packages/orchestrator/src/types.ts`

- [ ] **Step 1: Add event types to types.ts**

Append to `packages/orchestrator/src/types.ts`:

```typescript
// ── TaskGraph Event Types ────────────────────────────────────────────────

export interface TaskCreatedEvent {
  type: 'task.created';
  taskId: string;
  agentId: string;
  task: string;
  skills: string[];
  parentId?: string;
  timestamp: string;
}

export interface TaskCompletedEvent {
  type: 'task.completed';
  taskId: string;
  result: string;
  duration: number;
  timestamp: string;
}

export interface TaskFailedEvent {
  type: 'task.failed';
  taskId: string;
  error: string;
  duration: number;
  timestamp: string;
}

export interface TaskCancelledEvent {
  type: 'task.cancelled';
  taskId: string;
  reason: string;
  duration: number;
  timestamp: string;
}

export interface TaskDecomposedEvent {
  type: 'task.decomposed';
  parentId: string;
  strategy: 'single' | 'parallel' | 'sequential';
  subTaskIds: string[];
  timestamp: string;
}

export interface TaskReferenceEvent {
  type: 'task.reference';
  fromTaskId: string;
  toTaskId: string;
  relationship: 'triggered_by' | 'fixes' | 'follows_up' | 'related_to';
  evidence?: string;
  timestamp: string;
}

export type TaskGraphEvent =
  | TaskCreatedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | TaskDecomposedEvent
  | TaskReferenceEvent;

export interface ReconstructedTask {
  taskId: string;
  agentId: string;
  task: string;
  skills: string[];
  parentId?: string;
  status: 'created' | 'completed' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
  duration?: number;
  children?: string[];
  references?: TaskReferenceEvent[];
  createdAt: string;
  completedAt?: string;
}

export interface SyncMeta {
  lastSync: string;
  lastSyncEventCount: number;
}
```

- [ ] **Step 2: Run tests**

Run: `npx jest --no-coverage`
Expected: All 226 tests pass (additive types)

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/types.ts
git commit -m "feat(orchestrator): add TaskGraph event types and ReconstructedTask"
```

---

### Task 2: TaskGraph Class — Write Events

**Files:**
- Create: `packages/orchestrator/src/task-graph.ts`
- Create: `tests/orchestrator/task-graph.test.ts`
- Modify: `packages/orchestrator/src/index.ts`

- [ ] **Step 1: Write failing tests for event recording**

```typescript
// tests/orchestrator/task-graph.test.ts
import { TaskGraph } from '@gossip/orchestrator';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('TaskGraph', () => {
  const testDir = join(tmpdir(), `gossip-taskgraph-test-${Date.now()}`);
  const gossipDir = join(testDir, '.gossip');
  const graphPath = join(gossipDir, 'task-graph.jsonl');

  beforeEach(() => {
    mkdirSync(gossipDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('write events', () => {
    it('creates JSONL file on first event', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'gemini-reviewer', 'review code', ['code_review']);

      expect(existsSync(graphPath)).toBe(true);
      const lines = readFileSync(graphPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);

      const event = JSON.parse(lines[0]);
      expect(event.type).toBe('task.created');
      expect(event.taskId).toBe('t1');
      expect(event.agentId).toBe('gemini-reviewer');
      expect(event.timestamp).toBeDefined();
    });

    it('appends multiple events', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'agent-1', 'task 1', ['skill1']);
      graph.recordCompleted('t1', 'done', 5000);

      const lines = readFileSync(graphPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).type).toBe('task.created');
      expect(JSON.parse(lines[1]).type).toBe('task.completed');
    });

    it('records decomposition event', () => {
      const graph = new TaskGraph(testDir);
      graph.recordDecomposed('parent-1', 'parallel', ['sub-1', 'sub-2']);

      const event = JSON.parse(readFileSync(graphPath, 'utf-8').trim());
      expect(event.type).toBe('task.decomposed');
      expect(event.parentId).toBe('parent-1');
      expect(event.subTaskIds).toEqual(['sub-1', 'sub-2']);
    });

    it('records reference event', () => {
      const graph = new TaskGraph(testDir);
      graph.recordReference('fix-1', 'review-1', 'fixes', 'commit abc');

      const event = JSON.parse(readFileSync(graphPath, 'utf-8').trim());
      expect(event.type).toBe('task.reference');
      expect(event.relationship).toBe('fixes');
      expect(event.evidence).toBe('commit abc');
    });

    it('records cancelled event', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCancelled('t1', 'collect timeout', 120000);

      const event = JSON.parse(readFileSync(graphPath, 'utf-8').trim());
      expect(event.type).toBe('task.cancelled');
      expect(event.reason).toBe('collect timeout');
    });

    it('creates .gossip directory if missing', () => {
      rmSync(gossipDir, { recursive: true, force: true });
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'agent', 'task', []);
      expect(existsSync(graphPath)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/task-graph.test.ts --no-coverage`

- [ ] **Step 3: Implement TaskGraph write methods**

```typescript
// packages/orchestrator/src/task-graph.ts
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  TaskGraphEvent, TaskCreatedEvent, TaskCompletedEvent, TaskFailedEvent,
  TaskCancelledEvent, TaskDecomposedEvent, TaskReferenceEvent,
  ReconstructedTask, SyncMeta,
} from './types';

const MAX_SCAN_LINES = 1000;

export class TaskGraph {
  private readonly graphPath: string;
  private readonly syncMetaPath: string;

  constructor(private projectRoot: string) {
    const gossipDir = join(projectRoot, '.gossip');
    if (!existsSync(gossipDir)) {
      mkdirSync(gossipDir, { recursive: true });
    }
    this.graphPath = join(gossipDir, 'task-graph.jsonl');
    this.syncMetaPath = join(gossipDir, 'task-graph-sync.json');
  }

  private appendEvent(event: TaskGraphEvent): void {
    appendFileSync(this.graphPath, JSON.stringify(event) + '\n');
  }

  recordCreated(taskId: string, agentId: string, task: string, skills: string[], parentId?: string): void {
    const event: TaskCreatedEvent = {
      type: 'task.created', taskId, agentId, task, skills,
      ...(parentId ? { parentId } : {}),
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  recordCompleted(taskId: string, result: string, duration: number): void {
    const event: TaskCompletedEvent = {
      type: 'task.completed', taskId, result: result.slice(0, 4000), duration,
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  recordFailed(taskId: string, error: string, duration: number): void {
    const event: TaskFailedEvent = {
      type: 'task.failed', taskId, error, duration,
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  recordCancelled(taskId: string, reason: string, duration: number): void {
    const event: TaskCancelledEvent = {
      type: 'task.cancelled', taskId, reason, duration,
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  recordDecomposed(parentId: string, strategy: string, subTaskIds: string[]): void {
    const event: TaskDecomposedEvent = {
      type: 'task.decomposed', parentId,
      strategy: strategy as 'single' | 'parallel' | 'sequential',
      subTaskIds,
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  recordReference(fromTaskId: string, toTaskId: string, relationship: string, evidence?: string): void {
    const event: TaskReferenceEvent = {
      type: 'task.reference', fromTaskId, toTaskId,
      relationship: relationship as TaskReferenceEvent['relationship'],
      ...(evidence ? { evidence } : {}),
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  // ... read methods added in Task 3
}
```

- [ ] **Step 4: Export from index**

Add to `packages/orchestrator/src/index.ts`:
```typescript
export { TaskGraph } from './task-graph';
```

- [ ] **Step 5: Run tests**

Run: `npx jest tests/orchestrator/task-graph.test.ts --no-coverage`
Expected: 6 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/task-graph.ts packages/orchestrator/src/index.ts tests/orchestrator/task-graph.test.ts
git commit -m "feat(orchestrator): add TaskGraph event recording (write path)"
```

---

### Task 3: TaskGraph Class — Read + Reconstruct

**Files:**
- Modify: `packages/orchestrator/src/task-graph.ts`
- Modify: `tests/orchestrator/task-graph.test.ts`

- [ ] **Step 1: Write failing tests for queries**

Append to `tests/orchestrator/task-graph.test.ts`:

```typescript
  describe('read and reconstruct', () => {
    it('reconstructs a completed task', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'agent-1', 'review code', ['code_review']);
      graph.recordCompleted('t1', 'found 3 bugs', 15000);

      const task = graph.getTask('t1');
      expect(task).not.toBeNull();
      expect(task!.taskId).toBe('t1');
      expect(task!.agentId).toBe('agent-1');
      expect(task!.status).toBe('completed');
      expect(task!.result).toBe('found 3 bugs');
      expect(task!.duration).toBe(15000);
    });

    it('returns null for unknown task', () => {
      const graph = new TaskGraph(testDir);
      expect(graph.getTask('nonexistent')).toBeNull();
    });

    it('returns recent tasks in reverse order', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'a1', 'first', []);
      graph.recordCreated('t2', 'a2', 'second', []);
      graph.recordCreated('t3', 'a3', 'third', []);
      graph.recordCompleted('t1', 'done', 100);
      graph.recordCompleted('t2', 'done', 200);

      const recent = graph.getRecentTasks(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].taskId).toBe('t3'); // most recent first
    });

    it('filters tasks by agent', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'agent-1', 'task 1', []);
      graph.recordCreated('t2', 'agent-2', 'task 2', []);
      graph.recordCreated('t3', 'agent-1', 'task 3', []);

      const tasks = graph.getTasksByAgent('agent-1');
      expect(tasks).toHaveLength(2);
      expect(tasks.every(t => t.agentId === 'agent-1')).toBe(true);
    });

    it('returns children of a parent task', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('parent', 'orchestrator', 'big task', []);
      graph.recordDecomposed('parent', 'parallel', ['sub-1', 'sub-2']);
      graph.recordCreated('sub-1', 'agent-1', 'sub task 1', [], 'parent');
      graph.recordCreated('sub-2', 'agent-2', 'sub task 2', [], 'parent');

      const children = graph.getChildren('parent');
      expect(children).toHaveLength(2);
      expect(children.map(c => c.taskId).sort()).toEqual(['sub-1', 'sub-2']);
    });

    it('returns references for a task', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('review-1', 'agent', 'review', []);
      graph.recordCreated('fix-1', 'agent', 'fix', []);
      graph.recordReference('fix-1', 'review-1', 'fixes', 'commit abc');

      const refs = graph.getReferences('review-1');
      expect(refs).toHaveLength(1);
      expect(refs[0].fromTaskId).toBe('fix-1');
      expect(refs[0].relationship).toBe('fixes');
    });

    it('counts events via getEventCount', () => {
      const graph = new TaskGraph(testDir);
      expect(graph.getEventCount()).toBe(0);

      graph.recordCreated('t1', 'agent', 'task', []);
      graph.recordCompleted('t1', 'done', 100);
      expect(graph.getEventCount()).toBe(2);
    });

    it('handles empty graph gracefully', () => {
      const graph = new TaskGraph(testDir);
      expect(graph.getRecentTasks()).toEqual([]);
      expect(graph.getTasksByAgent('any')).toEqual([]);
      expect(graph.getEventCount()).toBe(0);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement read methods in TaskGraph**

Add to `packages/orchestrator/src/task-graph.ts` inside the class:

```typescript
  /** Read and parse events from JSONL (last N lines) */
  private readEvents(): TaskGraphEvent[] {
    if (!existsSync(this.graphPath)) return [];
    const content = readFileSync(this.graphPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const tail = lines.slice(-MAX_SCAN_LINES);
    return tail.map(line => {
      try { return JSON.parse(line) as TaskGraphEvent; }
      catch { return null; }
    }).filter(Boolean) as TaskGraphEvent[];
  }

  /** Reconstruct a task by replaying its events */
  getTask(taskId: string): ReconstructedTask | null {
    const events = this.readEvents();
    const created = events.find(
      (e): e is TaskCreatedEvent => e.type === 'task.created' && e.taskId === taskId
    );
    if (!created) return null;

    const task: ReconstructedTask = {
      taskId, agentId: created.agentId, task: created.task,
      skills: created.skills, parentId: created.parentId,
      status: 'created', createdAt: created.timestamp,
    };

    // Apply completion/failure/cancellation
    for (const e of events) {
      if (e.type === 'task.completed' && e.taskId === taskId) {
        task.status = 'completed'; task.result = e.result;
        task.duration = e.duration; task.completedAt = e.timestamp;
      } else if (e.type === 'task.failed' && e.taskId === taskId) {
        task.status = 'failed'; task.error = e.error;
        task.duration = e.duration; task.completedAt = e.timestamp;
      } else if (e.type === 'task.cancelled' && e.taskId === taskId) {
        task.status = 'cancelled'; task.error = e.reason;
        task.duration = e.duration; task.completedAt = e.timestamp;
      }
    }

    // Attach children from decomposition events
    const decomposed = events.find(
      (e): e is TaskDecomposedEvent => e.type === 'task.decomposed' && e.parentId === taskId
    );
    if (decomposed) task.children = decomposed.subTaskIds;

    // Attach references
    const refs = events.filter(
      (e): e is TaskReferenceEvent =>
        e.type === 'task.reference' && (e.fromTaskId === taskId || e.toTaskId === taskId)
    );
    if (refs.length) task.references = refs;

    return task;
  }

  /** Get recent tasks, most recent first */
  getRecentTasks(limit: number = 20): ReconstructedTask[] {
    const events = this.readEvents();
    const created = events
      .filter((e): e is TaskCreatedEvent => e.type === 'task.created')
      .reverse()
      .slice(0, limit);

    return created.map(c => this.getTask(c.taskId)).filter(Boolean) as ReconstructedTask[];
  }

  /** Get tasks by agent ID */
  getTasksByAgent(agentId: string, limit: number = 20): ReconstructedTask[] {
    const events = this.readEvents();
    const created = events
      .filter((e): e is TaskCreatedEvent => e.type === 'task.created' && e.agentId === agentId)
      .reverse()
      .slice(0, limit);

    return created.map(c => this.getTask(c.taskId)).filter(Boolean) as ReconstructedTask[];
  }

  /** Get child tasks of a parent */
  getChildren(parentId: string): ReconstructedTask[] {
    const events = this.readEvents();
    const children = events
      .filter((e): e is TaskCreatedEvent => e.type === 'task.created' && e.parentId === parentId);

    return children.map(c => this.getTask(c.taskId)).filter(Boolean) as ReconstructedTask[];
  }

  /** Get reference events involving a task */
  getReferences(taskId: string): TaskReferenceEvent[] {
    return this.readEvents().filter(
      (e): e is TaskReferenceEvent =>
        e.type === 'task.reference' && (e.fromTaskId === taskId || e.toTaskId === taskId)
    );
  }

  /** Count total events in the JSONL (for sync threshold) */
  getEventCount(): number {
    if (!existsSync(this.graphPath)) return 0;
    const content = readFileSync(this.graphPath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).length;
  }

  /** Read sync metadata */
  getSyncMeta(): SyncMeta {
    if (!existsSync(this.syncMetaPath)) {
      return { lastSync: '', lastSyncEventCount: 0 };
    }
    return JSON.parse(readFileSync(this.syncMetaPath, 'utf-8'));
  }

  /** Update sync metadata */
  updateSyncMeta(meta: Partial<SyncMeta>): void {
    const current = this.getSyncMeta();
    writeFileSync(this.syncMetaPath, JSON.stringify({ ...current, ...meta }, null, 2));
  }

  /** Get events since last sync */
  getUnsynced(lastSyncTimestamp: string): TaskGraphEvent[] {
    if (!lastSyncTimestamp) return this.readEvents();
    return this.readEvents().filter(e => e.timestamp > lastSyncTimestamp);
  }
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/orchestrator/task-graph.test.ts --no-coverage`
Expected: All 14 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/task-graph.ts tests/orchestrator/task-graph.test.ts
git commit -m "feat(orchestrator): add TaskGraph read/reconstruct queries"
```

---

### Task 4: MCP Server — Record Events in Dispatch + Collect

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts`

- [ ] **Step 1: Read current dispatch and collect handlers**

Read `apps/cli/src/mcp-server-sdk.ts` to understand the full structure.

- [ ] **Step 2: Add event recording to gossip_dispatch**

After `tasks.set(taskId, entry)` (around line 183), add:

```typescript
// Record task creation in TaskGraph
try {
  const { TaskGraph } = await import('@gossip/orchestrator');
  const graph = new TaskGraph(process.cwd());
  graph.recordCreated(taskId, agent_id, task, agentSkills);
} catch { /* non-blocking */ }
```

- [ ] **Step 3: Add event recording to gossip_dispatch_parallel**

Same pattern — one `recordCreated` per agent in the loop.

- [ ] **Step 4: Add completion/failure recording to gossip_collect**

In the collect handler, after building result strings and before the existing skill gap tracker block, add:

```typescript
// Record task completion/failure/cancellation in TaskGraph
try {
  const { TaskGraph } = await import('@gossip/orchestrator');
  const graph = new TaskGraph(process.cwd());
  for (const t of targets) {
    const duration = t.completedAt ? t.completedAt - t.startedAt : -1;
    if (t.status === 'completed') {
      graph.recordCompleted(t.id, (t.result || '').slice(0, 4000), duration);
    } else if (t.status === 'failed') {
      graph.recordFailed(t.id, t.error || 'Unknown', duration);
    } else if (t.status === 'running') {
      // Timed out — record as cancelled
      graph.recordCancelled(t.id, 'collect timeout', duration);
    }
  }
} catch { /* non-blocking */ }
```

- [ ] **Step 5: Run full test suite**

Run: `npx jest --no-coverage`

- [ ] **Step 6: Build MCP**

Run: `npm run build:mcp`

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/mcp-server-sdk.ts
git commit -m "feat(mcp): record TaskGraph events in dispatch and collect handlers"
```

---

### Task 5: CLI — `gossipcat tasks` Command

**Files:**
- Create: `apps/cli/src/tasks-command.ts`
- Modify: `apps/cli/src/index.ts`

- [ ] **Step 1: Read current CLI entry point**

Read `apps/cli/src/index.ts` to see how commands are registered.

- [ ] **Step 2: Implement tasks-command.ts**

```typescript
// apps/cli/src/tasks-command.ts
import { TaskGraph } from '@gossip/orchestrator';
import type { ReconstructedTask } from '@gossip/orchestrator';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};

function statusColor(status: string): string {
  if (status === 'completed') return c.green;
  if (status === 'failed') return c.red;
  if (status === 'cancelled') return c.yellow;
  return c.dim;
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '?s';
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function printTask(task: ReconstructedTask, indent: string = '  '): void {
  const color = statusColor(task.status);
  const dur = formatDuration(task.duration);
  const desc = task.task.replace(/\n/g, ' ').slice(0, 80);
  console.log(`${indent}${c.dim}${task.taskId}${c.reset}  ${task.agentId}  ${color}${task.status}${c.reset}  ${c.dim}${dur}${c.reset}  ${desc}`);
}

export function runTasksCommand(args: string[]): void {
  const graph = new TaskGraph(process.cwd());

  // gossipcat tasks <taskId> — detail view
  if (args[0] && !args[0].startsWith('--')) {
    const task = graph.getTask(args[0]);
    if (!task) {
      console.log(`Task "${args[0]}" not found.`);
      return;
    }
    console.log(`\n${c.bold}Task ${task.taskId}${c.reset}`);
    console.log(`  Agent: ${task.agentId}`);
    console.log(`  Status: ${statusColor(task.status)}${task.status}${c.reset}`);
    console.log(`  Duration: ${formatDuration(task.duration)}`);
    console.log(`  Skills: ${task.skills.join(', ') || 'none'}`);
    console.log(`  Created: ${task.createdAt}`);
    if (task.completedAt) console.log(`  Completed: ${task.completedAt}`);
    if (task.result) console.log(`\n  Result:\n    ${task.result.slice(0, 500).replace(/\n/g, '\n    ')}`);
    if (task.error) console.log(`\n  Error: ${task.error}`);

    if (task.children?.length) {
      console.log(`\n  Sub-tasks:`);
      for (const childId of task.children) {
        const child = graph.getTask(childId);
        if (child) printTask(child, '    ');
      }
    }

    if (task.references?.length) {
      console.log(`\n  References:`);
      for (const ref of task.references) {
        console.log(`    ${ref.fromTaskId} → ${ref.toTaskId} (${ref.relationship})${ref.evidence ? ` — ${ref.evidence}` : ''}`);
      }
    }
    console.log('');
    return;
  }

  // gossipcat tasks --agent <id>
  const agentIdx = args.indexOf('--agent');
  const agentFilter = agentIdx >= 0 ? args[agentIdx + 1] : undefined;

  const tasks = agentFilter
    ? graph.getTasksByAgent(agentFilter)
    : graph.getRecentTasks();

  if (tasks.length === 0) {
    console.log('\nNo tasks found.\n');
    return;
  }

  console.log(`\n${c.bold}Recent Tasks${agentFilter ? ` (${agentFilter})` : ''} (${tasks.length}):${c.reset}\n`);

  for (const task of tasks) {
    printTask(task);
    // Show children indented
    if (task.children?.length) {
      for (let i = 0; i < task.children.length; i++) {
        const child = graph.getTask(task.children[i]);
        if (child) {
          const prefix = i === task.children.length - 1 ? '└─' : '├─';
          printTask(child, `    ${prefix} `);
        }
      }
    }
  }
  console.log('');
}
```

- [ ] **Step 3: Register in CLI entry point**

Read `apps/cli/src/index.ts` and add:
```typescript
case 'tasks':
  const { runTasksCommand } = await import('./tasks-command');
  runTasksCommand(process.argv.slice(3));
  break;
```

- [ ] **Step 4: Run full test suite**

Run: `npx jest --no-coverage`

- [ ] **Step 5: Build MCP**

Run: `npm run build:mcp`

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/tasks-command.ts apps/cli/src/index.ts
git commit -m "feat(cli): add gossipcat tasks command for task history"
```

---

### Task 6: Final Integration Test

- [ ] **Step 1: Run full test suite**

Run: `npx jest --no-coverage`
Expected: All tests pass (226 + new task-graph tests)

- [ ] **Step 2: Build MCP**

Run: `npm run build:mcp`

- [ ] **Step 3: Verify TypeScript**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 4: Final commit if needed**

---

## Execution Order

Task 1 first (types). Tasks 2-3 are sequential (read depends on write). Task 4 depends on 2-3. Task 5 depends on 2-3. Task 6 runs last.

```
Task 1 (Types) → Task 2 (Write) → Task 3 (Read) → Task 4 (MCP) → Task 6 (Integration)
                                                  → Task 5 (CLI) → Task 6
```
