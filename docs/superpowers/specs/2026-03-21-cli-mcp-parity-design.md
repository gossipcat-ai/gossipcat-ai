# CLI/MCP Parity — Design Spec

> Refactor MainAgent to own the full dispatch pipeline so standalone CLI chat and MCP both get identical features: memory, TaskGraph, skills, gossip.

**Date:** 2026-03-21
**Status:** Draft
**Dependencies:** Agent Memory (shipped), TaskGraph (shipped), Agent Bootstrap + Gossip (shipped), Prompt Assembler (shipped)
**Found by:** 3-agent architecture analysis (gemini-reviewer, gemini-researcher, sonnet)

---

## Problem Statement

The MCP server (`mcp-server-sdk.ts`) owns all pipeline logic — memory loading, skill injection, TaskGraph recording, gossip publishing, memory writing. CLI chat (`chat.ts`) calls `MainAgent.handleMessage()` which bypasses all of it. Standalone `gossipcat` CLI users get none of these features.

The MCP server is ~600 lines of inline pipeline code. Each new feature (memory, TaskGraph, gossip) added more inline logic to dispatch/collect handlers, creating a growing parity gap.

## Design Overview

**Move the pipeline into MainAgent. Make MCP a thin adapter.**

```
BEFORE:
  MCP handler → [load memory, load skills, check catalog, assemble prompt,
                  dispatch to worker, record TaskGraph, write memory,
                  compact, check gaps, gossip] → return result
  CLI chat → mainAgent.handleMessage() → [decompose, dispatch, synthesize] → return
  (CLI misses everything in [brackets] above)

AFTER:
  MCP handler → mainAgent.dispatch(agentId, task) → return taskId
  MCP handler → mainAgent.collect(taskIds) → return results
  CLI chat → mainAgent.handleMessage() → [full pipeline internally] → return
  (Both get identical pipeline)
```

## Component 1: New MainAgent Interface

### New Methods

```typescript
class MainAgent {
  // EXISTING — unchanged signature
  async handleMessage(userMessage: string | ContentBlock[]): Promise<ChatResponse>;
  async handleChoice(originalMessage: string, choiceValue: string): Promise<ChatResponse>;
  async start(): Promise<void>;
  async stop(): Promise<void>;
  setWorkers(workers: Map<string, WorkerAgent>): void;

  // NEW — direct dispatch (bypasses decomposition)
  dispatch(agentId: string, task: string): { taskId: string; promise: Promise<string> };

  // NEW — collect results
  async collect(taskIds?: string[], timeoutMs?: number): Promise<TaskEntry[]>;

  // NEW — batch dispatch with gossip
  dispatchParallel(tasks: Array<{ agentId: string; task: string }>): { taskIds: string[]; errors: string[] };

  // NEW — hot-reload agents
  async syncWorkers(): Promise<number>;

  // NEW — get worker for instruction updates
  getWorker(agentId: string): WorkerAgent | undefined;
}
```

### TaskEntry Type

```typescript
export interface TaskEntry {
  id: string;
  agentId: string;
  task: string;
  status: 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  skillWarnings?: string[];
}
```

### MainAgentConfig Change

```typescript
export interface MainAgentConfig {
  provider: string;
  model: string;
  apiKey?: string;
  relayUrl: string;
  agents: AgentConfig[];
  apiKeys?: Record<string, string>;
  projectRoot: string;         // NEW — required, replaces process.cwd() everywhere
}
```

## Component 2: Pipeline Instance Fields

MainAgent holds pipeline components as instance fields instead of constructing them inline:

```typescript
class MainAgent {
  // Existing
  private llm: ILLMProvider;
  private registry: AgentRegistry;
  private dispatcher: TaskDispatcher;
  private workers: Map<string, WorkerAgent>;

  // NEW — pipeline instances
  private taskGraph: TaskGraph;
  private memWriter: MemoryWriter;
  private memReader: AgentMemoryReader;
  private memCompactor: MemoryCompactor;
  private gapTracker: SkillGapTracker;
  private catalog: SkillCatalog;
  private gossipPublisher: GossipPublisher | null = null;

  // NEW — task tracking (moved from MCP module-level)
  private tasks: Map<string, TaskEntry & { promise: Promise<string> }> = new Map();
  private batches: Map<string, Set<string>> = new Map();

  constructor(config: MainAgentConfig) {
    // ... existing setup ...
    this.taskGraph = new TaskGraph(config.projectRoot);
    this.memWriter = new MemoryWriter(config.projectRoot);
    this.memReader = new AgentMemoryReader(config.projectRoot);
    this.memCompactor = new MemoryCompactor(config.projectRoot);
    this.gapTracker = new SkillGapTracker(config.projectRoot);
    this.catalog = new SkillCatalog();
  }
}
```

## Component 3: dispatch() — The Core Pipeline

Single-agent dispatch with the full pipeline:

```typescript
dispatch(agentId: string, task: string): { taskId: string; promise: Promise<string> } {
  const worker = this.workers.get(agentId);
  if (!worker) throw new Error(`Agent "${agentId}" not found`);

  const taskId = randomUUID().slice(0, 8);

  // 1. Load skills
  const skills = loadSkills(agentId, this.projectRoot);

  // 2. Load memory
  const memory = this.memReader.loadMemory(agentId, task);

  // 3. Check skill coverage
  const skillWarnings = this.catalog.checkCoverage(
    this.registry.get(agentId)?.skills || [], task
  );

  // 4. Assemble prompt
  const promptContent = assemblePrompt({
    memory: memory || undefined,
    skills,
  });

  // 5. Record TaskGraph created
  const agentSkills = this.registry.get(agentId)?.skills || [];
  this.taskGraph.recordCreated(taskId, agentId, task, agentSkills);

  // 6. Create task entry
  const entry: TaskEntry & { promise: Promise<string> } = {
    id: taskId, agentId, task, status: 'running',
    startedAt: Date.now(), skillWarnings,
    promise: null as any,
  };

  // 7. Execute
  entry.promise = worker.executeTask(task, undefined, promptContent)
    .then((result: string) => {
      entry.status = 'completed'; entry.result = result;
      entry.completedAt = Date.now();
      return result;
    })
    .catch((err: Error) => {
      entry.status = 'failed'; entry.error = err.message;
      entry.completedAt = Date.now();
      throw err;
    });

  this.tasks.set(taskId, entry);
  return { taskId, promise: entry.promise };
}
```

## Component 4: collect() — Post-Task Pipeline

```typescript
async collect(taskIds?: string[], timeoutMs: number = 120000): Promise<TaskEntry[]> {
  // Find targets
  const targets = taskIds
    ? taskIds.map(id => this.tasks.get(id)).filter(Boolean)
    : Array.from(this.tasks.values()).filter(t => t.status === 'running');

  if (targets.length === 0) return [];

  // Wait for completion (with timeout)
  await Promise.race([
    Promise.all(targets.map(t => t.promise.catch(() => {}))),
    new Promise(r => setTimeout(r, timeoutMs)),
  ]);

  // Post-collect pipeline
  for (const t of targets) {
    const duration = t.completedAt ? t.completedAt - t.startedAt : -1;

    // 1. Record TaskGraph
    if (t.status === 'completed') {
      this.taskGraph.recordCompleted(t.id, (t.result || '').slice(0, 4000), duration);
    } else if (t.status === 'failed') {
      this.taskGraph.recordFailed(t.id, t.error || 'Unknown', duration);
    } else if (t.status === 'running') {
      this.taskGraph.recordCancelled(t.id, 'collect timeout', duration);
    }

    // 2. Skill gap suggestions
    const suggestions = this.gapTracker.getSuggestionsSince(t.agentId, t.startedAt);
    // (format and attach to result)

    // 3. Write agent memory
    if (t.status === 'completed') {
      await this.memWriter.writeTaskEntry(t.agentId, {
        taskId: t.id, task: t.task,
        skills: this.registry.get(t.agentId)?.skills || [],
        scores: { relevance: 3, accuracy: 3, uniqueness: 3 }, // stubbed
      });
      this.memWriter.rebuildIndex(t.agentId);
    }

    // 4. Compact memory
    const compactResult = this.memCompactor.compactIfNeeded(t.agentId);
    if (compactResult.message) {
      process.stderr.write(`[gossipcat] ${compactResult.message}\n`);
    }
  }

  // 5. Check skeleton generation
  this.gapTracker.checkAndGenerate();

  // Build result entries (without promise — clean for return)
  const results = targets.map(t => ({
    id: t.id, agentId: t.agentId, task: t.task,
    status: t.status, result: t.result, error: t.error,
    startedAt: t.startedAt, completedAt: t.completedAt,
    skillWarnings: t.skillWarnings,
  }));

  // Cleanup
  for (const t of targets) {
    if (t.status !== 'running') this.tasks.delete(t.id);
  }

  return results;
}
```

## Component 5: dispatchParallel() — Batch + Gossip

```typescript
dispatchParallel(taskDefs: Array<{ agentId: string; task: string }>): {
  taskIds: string[];
  errors: string[];
} {
  const taskIds: string[] = [];
  const errors: string[] = [];
  const batchId = randomUUID().slice(0, 8);
  const batchTaskIds = new Set<string>();

  // Subscribe workers to batch channel
  for (const def of taskDefs) {
    const worker = this.workers.get(def.agentId);
    if (worker?.subscribeToBatch) {
      worker.subscribeToBatch(batchId).catch(() => {});
    }
  }

  for (const def of taskDefs) {
    try {
      const { taskId, promise } = this.dispatch(def.agentId, def.task);
      taskIds.push(taskId);
      batchTaskIds.add(taskId);

      // Gossip trigger on completion
      if (this.gossipPublisher) {
        promise.then(async (result) => {
          const remaining = Array.from(batchTaskIds)
            .map(tid => this.tasks.get(tid))
            .filter(t => t && t.status === 'running' && t.agentId !== def.agentId)
            .map(t => this.registry.get(t!.agentId))
            .filter((ac): ac is AgentConfig => ac !== undefined);

          if (remaining.length > 0) {
            this.gossipPublisher!.publishGossip({
              batchId, completedAgentId: def.agentId,
              completedResult: result,
              remainingSiblings: remaining.map(ac => ({
                agentId: ac.id, preset: ac.preset || 'custom', skills: ac.skills,
              })),
            }).catch(err => process.stderr.write(`[gossipcat] Gossip: ${err.message}\n`));
          }
        }).catch(() => {});
      }
    } catch (err) {
      errors.push(`Agent "${def.agentId}" not found`);
    }
  }

  this.batches.set(batchId, batchTaskIds);
  return { taskIds, errors };
}
```

## Component 6: handleMessage Integration

`handleMessage` already calls `executeSubTask` internally. Update `executeSubTask` to use the new `dispatch()` pipeline:

```typescript
private async executeSubTask(subTask: SubTask): Promise<TaskResult> {
  const { taskId, promise } = this.dispatch(subTask.assignedAgent!, subTask.description);
  const start = Date.now();
  try {
    const result = await promise;
    // Post-task pipeline runs when collect() is called
    // For handleMessage (synchronous flow), run inline:
    await this.writeMemoryForTask(taskId);
    return { agentId: subTask.assignedAgent!, task: subTask.description, result, duration: Date.now() - start };
  } catch (err) {
    return {
      agentId: subTask.assignedAgent!, task: subTask.description,
      result: '', error: (err as Error).message, duration: Date.now() - start,
    };
  }
}

private async writeMemoryForTask(taskId: string): Promise<void> {
  const t = this.tasks.get(taskId);
  if (!t || t.status !== 'completed') return;

  const duration = t.completedAt ? t.completedAt - t.startedAt : -1;
  this.taskGraph.recordCompleted(t.id, (t.result || '').slice(0, 4000), duration);

  await this.memWriter.writeTaskEntry(t.agentId, {
    taskId: t.id, task: t.task,
    skills: this.registry.get(t.agentId)?.skills || [],
    scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
  });
  this.memWriter.rebuildIndex(t.agentId);
  this.memCompactor.compactIfNeeded(t.agentId);
  this.tasks.delete(t.id);
}
```

Now both paths use the same pipeline:
- **CLI chat** → `handleMessage()` → `executeSubTask()` → `dispatch()` + inline memory write
- **MCP gossip_dispatch** → `mainAgent.dispatch()` → later `mainAgent.collect()` runs memory write

## Component 7: Slim MCP Server

After refactoring, MCP handlers become thin adapters:

```typescript
// gossip_dispatch → ~10 lines instead of ~40
server.tool('gossip_dispatch', ..., async ({ agent_id, task }) => {
  await boot();
  await mainAgent.syncWorkers();
  try {
    const { taskId } = mainAgent.dispatch(agent_id, task);
    return text(`Dispatched to ${agent_id}. Task ID: ${taskId}`);
  } catch (err) {
    return text((err as Error).message);
  }
});

// gossip_dispatch_parallel → ~10 lines instead of ~80
server.tool('gossip_dispatch_parallel', ..., async ({ tasks: taskDefs }) => {
  await boot();
  await mainAgent.syncWorkers();
  const { taskIds, errors } = mainAgent.dispatchParallel(taskDefs);
  let msg = `Dispatched ${taskIds.length} tasks:\n${taskIds.map(tid => {
    const t = mainAgent.getTask(tid);
    return `  ${tid} → ${t?.agentId || 'unknown'}`;
  }).join('\n')}`;
  if (errors.length) msg += `\nErrors: ${errors.join(', ')}`;
  return text(msg);
});

// gossip_collect → ~15 lines instead of ~120
server.tool('gossip_collect', ..., async ({ task_ids, timeout_ms }) => {
  const entries = await mainAgent.collect(task_ids, timeout_ms || 120000);
  const results = entries.map(t => {
    const dur = t.completedAt ? `${t.completedAt - t.startedAt}ms` : 'running';
    if (t.status === 'completed') return `[${t.id}] ${t.agentId} (${dur}):\n${t.result}`;
    if (t.status === 'failed') return `[${t.id}] ${t.agentId} (${dur}): ERROR: ${t.error}`;
    return `[${t.id}] ${t.agentId}: still running...`;
  });
  return text(results.join('\n\n---\n\n'));
});
```

MCP server drops from ~600 lines to ~200.

## Component 8: syncWorkers in MainAgent

Move hot-reload logic from MCP's `syncWorkers()` into MainAgent:

```typescript
async syncWorkers(): Promise<number> {
  // Read current config
  const configPath = findConfigPath();
  if (!configPath) return 0;
  const config = loadConfig(configPath);
  const agentConfigs = configToAgentConfigs(config);

  let added = 0;
  for (const ac of agentConfigs) {
    if (this.workers.has(ac.id)) continue;
    const key = await this.keychain.getKey(ac.provider);
    const llm = createProvider(ac.provider, ac.model, key ?? undefined);

    // Load instructions
    const instructionsPath = join(this.projectRoot, '.gossip', 'agents', ac.id, 'instructions.md');
    const instructions = existsSync(instructionsPath)
      ? readFileSync(instructionsPath, 'utf-8') : undefined;

    const worker = new WorkerAgent(ac.id, llm, this.relayUrl, ALL_TOOLS, instructions);
    await worker.start();
    this.workers.set(ac.id, worker);
    this.registry.register(ac);
    added++;
  }
  return added;
}
```

## Files Changed

| File | Action | Change |
|------|--------|--------|
| `packages/orchestrator/src/main-agent.ts` | **Major edit** | Add dispatch/collect/dispatchParallel/syncWorkers, pipeline instances, tasks Map |
| `packages/orchestrator/src/types.ts` | **Edit** | Add TaskEntry, update MainAgentConfig with projectRoot |
| `packages/orchestrator/src/index.ts` | **Edit** | Export TaskEntry |
| `apps/cli/src/mcp-server-sdk.ts` | **Major edit** | Slim to ~200 lines, delegate to MainAgent |
| `apps/cli/src/chat.ts` | **Minor edit** | Add projectRoot to MainAgentConfig |
| `apps/cli/src/skill-loader-bridge.ts` | **Delete** | Logic moves into MainAgent |
| `tests/orchestrator/main-agent.test.ts` | **Major edit** | Test dispatch/collect/pipeline |
| `tests/cli/mcp-integration.test.ts` | **New** | Test MCP adapter layer |

## What CLI Chat Gets For Free

After this refactor, `gossipcat` standalone chat automatically gets:

| Feature | Before | After |
|---------|--------|-------|
| Memory loading at dispatch | No | Yes — via `dispatch()` |
| Memory writing after tasks | No | Yes — via `writeMemoryForTask()` |
| TaskGraph recording | No | Yes — via `dispatch()` + `writeMemoryForTask()` |
| Skill injection | Partial | Full — via `dispatch()` |
| Skill gap tracking | No | Yes — via `collect()` |
| Prompt assembly | Partial | Full — memory + skills + lens |
| Instructions loading | Yes (boot) | Yes (boot) |

## Security Constraints

- Pipeline logic is identical for MCP and CLI — no bypasses
- `dispatch()` validates agentId against workers Map (same as before)
- Memory write locking stays per-agent (same `withMemoryLock` pattern)
- TaskGraph recording is non-blocking (try/catch)
- `gossip_update_instructions` MCP tool stays as MCP-only — CLI chat doesn't need it

## Testing Strategy

- **dispatch():** Unit test — dispatch to mock worker, verify memory loaded, TaskGraph recorded, skills injected
- **collect():** Unit test — collect completed task, verify memory written, TaskGraph updated, task cleaned up
- **dispatchParallel():** Unit test — dispatch 3 tasks, verify batch created, gossip triggered when first completes
- **handleMessage parity:** Integration test — same task via handleMessage and dispatch should produce same pipeline effects
- **MCP adapter:** Test that MCP tools correctly delegate to MainAgent methods
- **Regression:** All existing 257 tests must still pass
