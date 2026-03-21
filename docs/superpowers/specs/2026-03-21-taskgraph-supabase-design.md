# Phase 2: TaskGraph with Supabase — Design Spec

> Persistent task lifecycle tracking with an append-only JSONL event log locally and optional Supabase sync for relational queries and team analytics.

**Date:** 2026-03-21
**Status:** Draft
**Dependencies:** Phase 1 (shipped), Skill Discovery System (shipped), Agent Memory (shipped)
**Enables:** Adaptive Team Intelligence Tier 3 (outcome tracking), cross-session task history

---

## Problem Statement

Gossipcat tasks are ephemeral. The MCP server's in-memory `tasks` Map tracks running tasks, but entries are deleted after `gossip_collect`. There is no record of what tasks ran, which agents were assigned, what they produced, or how tasks relate to each other.

This means:
- No audit trail — "what did my agents do last week?" is unanswerable
- ATI Tier 3 can't track outcomes — "did the bug this reviewer found actually get fixed?" requires correlating tasks over time
- Agent performance scoring has no task context — the stubbed 3/3/3 scores in agent memory can't be replaced without knowing task history
- No way to analyze orchestration decisions — "why did `gossip_orchestrate` split this task into 3 sub-tasks?"

## Design Overview

```
┌─────────────────────────────────────────────────────────────┐
│  RUNTIME (in-memory)                                        │
│                                                             │
│  tasks Map — owns running promises, timing, in-flight state │
│  Unchanged from current architecture                        │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  LOCAL PERSISTENCE                                          │
│                                                             │
│  .gossip/task-graph.jsonl — append-only event log            │
│  Events: created, completed, failed, decomposed, reference  │
│  Source of truth — always available, no dependencies         │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  OPTIONAL REMOTE (Supabase)                                 │
│                                                             │
│  4 tables: tasks, task_decompositions, task_references,     │
│            agent_scores                                     │
│  Synced from JSONL every 30 tasks or on gossipcat sync      │
│  Deletable without data loss — JSONL is source of truth     │
└─────────────────────────────────────────────────────────────┘
```

## Component 1: JSONL Event Types

The local TaskGraph is an append-only event log at `.gossip/task-graph.jsonl`.

### Event Types

```typescript
/** Base event with type discriminator and timestamp */
interface TaskGraphEventBase {
  timestamp: string;
}

/** Task created — from gossip_dispatch or gossip_orchestrate */
interface TaskCreatedEvent extends TaskGraphEventBase {
  type: 'task.created';
  taskId: string;
  agentId: string;
  task: string;
  skills: string[];
  parentId?: string;       // if sub-task of orchestrate decomposition
}

/** Task completed successfully */
interface TaskCompletedEvent extends TaskGraphEventBase {
  type: 'task.completed';
  taskId: string;
  result: string;          // truncated to 2000 chars
  duration: number;        // ms
}

/** Task failed */
interface TaskFailedEvent extends TaskGraphEventBase {
  type: 'task.failed';
  taskId: string;
  error: string;
  duration: number;
}

/** Task cancelled (user intervention or timeout) */
interface TaskCancelledEvent extends TaskGraphEventBase {
  type: 'task.cancelled';
  taskId: string;
  reason: string;
  duration: number;
}

/** Orchestrate decomposition — parent split into sub-tasks */
interface TaskDecomposedEvent extends TaskGraphEventBase {
  type: 'task.decomposed';
  parentId: string;
  strategy: 'single' | 'parallel' | 'sequential';
  subTaskIds: string[];
}

/** Cross-reference between tasks — for outcome tracking */
interface TaskReferenceEvent extends TaskGraphEventBase {
  type: 'task.reference';
  fromTaskId: string;
  toTaskId: string;
  relationship: 'triggered_by' | 'fixes' | 'follows_up' | 'related_to';
  evidence?: string;
}

type TaskGraphEvent =
  | TaskCreatedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | TaskDecomposedEvent
  | TaskReferenceEvent;
```

### Example Event Sequence

```jsonl
{"type":"task.created","taskId":"parent-1","agentId":"orchestrator","task":"Review relay for security","skills":[],"timestamp":"2026-03-21T14:30:00Z"}
{"type":"task.decomposed","parentId":"parent-1","strategy":"parallel","subTaskIds":["sub-1","sub-2"],"timestamp":"2026-03-21T14:30:01Z"}
{"type":"task.created","taskId":"sub-1","agentId":"gemini-reviewer","task":"Review relay/server.ts","skills":["security_audit","code_review"],"parentId":"parent-1","timestamp":"2026-03-21T14:30:01Z"}
{"type":"task.created","taskId":"sub-2","agentId":"gemini-tester","task":"Review relay/router.ts","skills":["testing","debugging"],"parentId":"parent-1","timestamp":"2026-03-21T14:30:01Z"}
{"type":"task.completed","taskId":"sub-1","result":"Found 3 bugs: S1 no maxPayload, S2 no rate limiting, S3 auth spam","duration":15000,"timestamp":"2026-03-21T14:30:16Z"}
{"type":"task.completed","taskId":"sub-2","result":"No issues found in router.ts","duration":12000,"timestamp":"2026-03-21T14:30:13Z"}
{"type":"task.completed","taskId":"parent-1","result":"Combined: 3 bugs found in server.ts","duration":16000,"timestamp":"2026-03-21T14:30:17Z"}
{"type":"task.reference","fromTaskId":"fix-1","toTaskId":"sub-1","relationship":"fixes","evidence":"commit 4faa386 fixed S1 maxPayload","timestamp":"2026-03-21T15:00:00Z"}
```

## Component 2: TaskGraph Class — Local Reader/Writer

**File:** `packages/orchestrator/src/task-graph.ts`

### Interface

```typescript
export class TaskGraph {
  constructor(projectRoot: string);

  // Write events (append to JSONL)
  recordCreated(taskId: string, agentId: string, task: string, skills: string[], parentId?: string): void;
  recordCompleted(taskId: string, result: string, duration: number): void;
  recordFailed(taskId: string, error: string, duration: number): void;
  recordDecomposed(parentId: string, strategy: string, subTaskIds: string[]): void;
  recordReference(fromTaskId: string, toTaskId: string, relationship: string, evidence?: string): void;

  // Read queries (scan JSONL, reconstruct state)
  getTask(taskId: string): ReconstructedTask | null;
  getRecentTasks(limit?: number): ReconstructedTask[];
  getTasksByAgent(agentId: string, limit?: number): ReconstructedTask[];
  getChildren(parentId: string): ReconstructedTask[];
  getReferences(taskId: string): TaskReferenceEvent[];

  // Sync support
  getEventCount(): number;       // count JSONL lines (derived, not stored)
  getUnsynced(lastSyncTimestamp: string): TaskGraphEvent[];
  getSyncMeta(): SyncMeta;
  updateSyncMeta(meta: Partial<SyncMeta>): void;
}
```

### ReconstructedTask

Built by replaying events for a task ID:

```typescript
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
```

### SyncMeta

Stored at `.gossip/task-graph-sync.json`:

```typescript
export interface SyncMeta {
  lastSync: string;            // ISO timestamp
  lastSyncEventCount: number;  // JSONL line count at time of last sync
}
```

### Query Performance

Queries scan the last 1000 lines of the JSONL (same pattern as skill-gaps, agent-performance). For a typical session (~20-50 tasks), this covers the full history. Older events are still in the file but not scanned for recent queries.

The `getTask(id)` query scans for all events matching the task ID and reconstructs state. O(n) where n = scanned lines, but n is bounded at 1000.

## Component 3: Supabase Schema

Created via migration when user runs `gossipcat sync --setup`.

```sql
-- Core task table
CREATE TABLE tasks (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  task text NOT NULL,
  skills text[],
  parent_id text REFERENCES tasks(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('created', 'completed', 'failed', 'cancelled')),
  result text,
  error text,
  duration_ms integer,
  user_id text NOT NULL,
  project_id text NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX idx_tasks_agent ON tasks(agent_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_user ON tasks(user_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created ON tasks(created_at DESC);

-- Decomposition records
CREATE TABLE task_decompositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  strategy text NOT NULL CHECK (strategy IN ('single', 'parallel', 'sequential')),
  sub_task_ids text[] NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_decomp_parent ON task_decompositions(parent_id);

-- Cross-references between tasks
CREATE TABLE task_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relationship text NOT NULL CHECK (relationship IN ('triggered_by', 'fixes', 'follows_up', 'related_to')),
  evidence text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_refs_from ON task_references(from_task_id);
CREATE INDEX idx_refs_to ON task_references(to_task_id);

-- Agent performance scores (from ATI spec — co-located)
CREATE TABLE agent_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  agent_id text NOT NULL,
  task_id text REFERENCES tasks(id) ON DELETE CASCADE,
  task_type text,
  skills text[],
  lens text,
  relevance smallint CHECK (relevance BETWEEN 1 AND 5),
  accuracy smallint CHECK (accuracy BETWEEN 1 AND 5),
  uniqueness smallint CHECK (uniqueness BETWEEN 1 AND 5),
  source text CHECK (source IN ('judgment', 'outcome')),
  event text,
  evidence text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_scores_agent ON agent_scores(agent_id);
CREATE INDEX idx_scores_task ON agent_scores(task_id);
CREATE INDEX idx_scores_user ON agent_scores(user_id);
```

### User Identity

Same as ATI spec:
```typescript
const userId = sha256(gitEmail + projectRoot + localSalt);
```
Salt generated once, stored in keychain via `gossipcat setup`.

### Project Identity

```typescript
const projectId = sha256(projectRoot);
```
Simple hash of project path. Allows filtering queries by project in multi-project setups.

## Component 4: Sync Layer

**File:** `packages/orchestrator/src/task-graph-sync.ts`

### Interface

```typescript
export class TaskGraphSync {
  constructor(
    graph: TaskGraph,
    supabaseUrl: string,
    supabaseKey: string,
    userId: string,
    projectId: string,
  );

  /** Sync unsynced JSONL events + agent-performance entries to Supabase */
  async sync(): Promise<{ events: number; scores: number }>;

  /** Check if Supabase is configured */
  isConfigured(): boolean;
}
```

### Sync Flow

```
1. Read sync meta from .gossip/task-graph-sync.json
2. Get unsynced events from task-graph.jsonl (after lastSyncTimestamp)
3. Translate each event to Supabase operation:
   - task.created   → INSERT into tasks (status='created')
   - task.completed → UPDATE tasks SET status='completed', result, duration, completed_at
   - task.failed    → UPDATE tasks SET status='failed', error, duration, completed_at
   - task.decomposed → INSERT into task_decompositions
   - task.reference  → INSERT into task_references
4. Sync unsynced agent-performance.jsonl entries → INSERT into agent_scores
5. Update sync meta
```

### Supabase Connection

Uses direct `fetch` calls to Supabase REST API (PostgREST). No SDK dependency — same pattern as LLM providers.

```typescript
// POST https://<project>.supabase.co/rest/v1/tasks
// Headers: apikey: <anon_key>, Authorization: Bearer <anon_key>
```

### Connection Config

```json
// .gossip/supabase.json (gitignored)
{
  "url": "https://xxx.supabase.co",
  "projectRef": "xxx"
}
```

API key stored in keychain (same as LLM provider keys):
```typescript
await keychain.setKey('supabase', anonKey);
```

### Sync Triggers

1. **Auto:** Every 30 completed tasks (counter in sync meta)
2. **Manual:** `gossipcat sync` command
3. **On setup:** `gossipcat sync --setup` runs initial sync after migration

Auto-sync is async non-blocking in the `gossip_collect` post-processing pipeline.

## Component 5: MCP Server Integration

### Dispatch Handlers

After creating the in-memory Map entry, record the TaskGraph event:

```typescript
// In gossip_dispatch, after tasks.set(taskId, entry):
try {
  const { TaskGraph } = await import('@gossip/orchestrator');
  const graph = new TaskGraph(process.cwd());
  graph.recordCreated(taskId, agent_id, task, agentSkills);
} catch { /* non-blocking */ }
```

Same for `gossip_dispatch_parallel` — one `recordCreated` per agent.

### Collect Handler

After building results, in the post-collect pipeline:

```typescript
// Step 3 (NEW): Record task completion in TaskGraph
try {
  const { TaskGraph } = await import('@gossip/orchestrator');
  const graph = new TaskGraph(process.cwd());
  for (const t of targets) {
    if (t.status === 'completed') {
      graph.recordCompleted(t.id, (t.result || '').slice(0, 2000), t.completedAt - t.startedAt);
    } else if (t.status === 'failed') {
      graph.recordFailed(t.id, t.error || 'Unknown', t.completedAt - t.startedAt);
    }
  }

  // Check sync threshold (every 30 events)
  // totalEvents derived by counting JSONL lines — not a stored counter
  const totalEvents = graph.getEventCount();
  const syncMeta = graph.getSyncMeta();
  if (totalEvents - syncMeta.lastSyncEventCount >= 30) {
    const supaConfig = loadSupabaseConfig();
    if (supaConfig) {
      const { TaskGraphSync } = await import('@gossip/orchestrator');
      const keychain = new (await import('./keychain')).Keychain();
      const supaKey = await keychain.getKey('supabase');
      if (supaKey) {
        const sync = new TaskGraphSync(graph, supaConfig.url, supaKey, userId, projectId);
        sync.sync().catch(err => process.stderr.write(`[gossipcat] Sync: ${err.message}\n`));
      }
    }
  }
} catch { /* non-blocking */ }
```

### Post-Collect Pipeline Order (Updated)

```
1. Build result strings + skill coverage warnings (existing)
2. Surface skill suggestions from gap log (existing)
3. Record task completion in TaskGraph (NEW)
4. Write agent memories (existing)
5. Compact memories if needed (existing)
6. Check sync threshold → trigger Supabase sync if needed (NEW)
```

**Pipeline execution model:** Steps 2-6 run inline (awaited) within the collect handler before it returns. They are wrapped in try/catch so failures are logged, never blocking the response. This is "non-failing" rather than "non-blocking" — the collect response waits for all steps. True background execution (fire-and-forget after response) would require restructuring the MCP handler, which is deferred.

**Cancellation:** When `gossip_collect` hits its timeout (line 262-265 in mcp-server-sdk.ts), tasks with `status: 'running'` should be recorded as cancelled:
```typescript
for (const t of targets) {
  if (t.status === 'running') {
    graph.recordCancelled(t.id, 'collect timeout', timeout_ms || 120000);
  }
}
```

### In-Memory Map — Unchanged

The `tasks` Map continues to:
- Track running promises (TaskGraph can't store Promises)
- Provide immediate task lookup for `gossip_collect`
- Delete entries after collection

TaskGraph is a parallel persistent record, not a replacement.

## Component 6: CLI Commands

### `gossipcat tasks`

```
gossipcat tasks                          # show recent tasks (last 20)
gossipcat tasks --agent gemini-reviewer  # filter by agent
gossipcat tasks <taskId>                 # task detail with children + references
```

**Output format:**
```
Recent Tasks (20):

  2f2a5373  gemini-reviewer  completed  16s   Review agent-memory.ts for code quality
  9b3dfaff  gemini-reviewer  completed  14s   Review memory-writer.ts for code quality
  parent-1  orchestrator     completed  42s   Security review of relay (3 sub-tasks)
    ├─ sub-1  gemini-reviewer  completed  25s   Review relay/server.ts
    ├─ sub-2  gemini-tester    completed  18s   Review relay/router.ts
    └─ sub-3  sonnet           completed  30s   Review relay/presence.ts
```

### `gossipcat sync`

```
gossipcat sync              # sync to Supabase now
gossipcat sync --setup      # configure Supabase connection + run migrations
gossipcat sync --status     # show sync status (events synced, last sync time)
```

**`gossipcat sync --setup` flow:**
1. Check if Supabase MCP is available
2. If yes: use `mcp__supabase__list_projects` to let user select/create a project
3. Run SQL migration via `mcp__supabase__apply_migration`
4. Store URL + project ref in `.gossip/supabase.json`
5. Store anon key in keychain
6. Run initial sync

If Supabase MCP is not available: prompt for URL + key manually.

## Files Changed/Created

| File | Action | Component |
|------|--------|-----------|
| `packages/orchestrator/src/task-graph.ts` | Create | Event log reader/writer, query reconstruction |
| `packages/orchestrator/src/task-graph-sync.ts` | Create | JSONL → Supabase translator |
| `packages/orchestrator/src/types.ts` | Edit | Add TaskGraphEvent types, ReconstructedTask, SyncMeta |
| `packages/orchestrator/src/index.ts` | Edit | Export TaskGraph, TaskGraphSync |
| `apps/cli/src/mcp-server-sdk.ts` | Edit | Record events in dispatch/collect, sync check |
| `apps/cli/src/tasks-command.ts` | Create | `gossipcat tasks` CLI |
| `apps/cli/src/sync-command.ts` | Create | `gossipcat sync` CLI |
| `apps/cli/src/index.ts` | Edit | Register new CLI commands |
| `.gossip/task-graph.jsonl` | Runtime | Local event log (gitignored) |
| `.gossip/task-graph-sync.json` | Runtime | Sync metadata (gitignored) |
| `.gossip/supabase.json` | Runtime | Supabase connection config (gitignored) |
| `tests/orchestrator/task-graph.test.ts` | Create | Event recording, query, reconstruction tests |
| `tests/orchestrator/task-graph-sync.test.ts` | Create | Sync translation tests (mocked Supabase) |

## Security Constraints

- **No PII in Supabase** — user identity is sha256 hash, salt stays local
- **API keys in keychain** — Supabase anon key stored via Keychain, not in config files
- **Task results truncated** — 2000 char limit prevents storing large LLM outputs in JSONL/Supabase
- **Sync is non-blocking** — failures logged, never block dispatch/collect
- **JSONL is source of truth** — Supabase can be deleted/recreated without data loss
- **`.gossip/supabase.json` is gitignored** — connection config never committed

## Testing Strategy

- **TaskGraph write:** Unit test — record events, verify JSONL format
- **TaskGraph read:** Unit test — write events, reconstruct task, verify state
- **Parent-child:** Unit test — record decomposition, verify getChildren returns sub-tasks
- **References:** Unit test — record references, verify getReferences returns links
- **ReconstructedTask:** Unit test — replay created + completed events, verify final state
- **Sync translation:** Unit test — given events, verify correct Supabase REST calls (mocked fetch)
- **Sync meta:** Unit test — verify counter increments, threshold triggers sync
- **Cold start:** Unit test — verify graceful handling when JSONL doesn't exist
- **Integration:** Record events via dispatch → collect → verify JSONL written → verify `gossipcat tasks` output
