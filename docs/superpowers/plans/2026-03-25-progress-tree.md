# Progress Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live pipeline progress bar UI to gossipcat's CLI showing per-agent execution status, tool call counts, and token usage during plan execution.

**Architecture:** Worker agents emit progress callbacks during execution. DispatchPipeline relays these through TrackedTask entries. ToolExecutor bridges to a CLI-facing `TaskProgressEvent` stream. A new `ProgressTree` renderer owns a block of ANSI-rewritable terminal lines.

**Tech Stack:** TypeScript, ANSI escape sequences, Node.js readline

**Spec:** `docs/superpowers/specs/2026-03-25-progress-tree-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/orchestrator/src/types.ts` | Modify | Add `TaskProgressEvent`, `toolCalls` to `TaskEntry` |
| `packages/orchestrator/src/worker-agent.ts` | Modify | Add `WorkerProgressCallback`, tool call counter, progress firing |
| `packages/orchestrator/src/llm-client.ts` | Modify | Fix Gemini token extraction |
| `packages/orchestrator/src/dispatch-pipeline.ts` | Modify | Update `WorkerLike`, add `taskProgressCallback`, wire 4 call sites |
| `packages/orchestrator/src/tool-router.ts` | Modify | Emit init/progress/finish events from `executePlan` |
| `packages/orchestrator/src/main-agent.ts` | Modify | Replace inline type with `TaskProgressEvent` |
| `apps/cli/src/progress-tree.ts` | Create | ANSI progress bar renderer |
| `apps/cli/src/chat-session.ts` | Modify | Wire ProgressTree, fix SIGINT handler |

---

### Task 1: Types — `TaskProgressEvent` and `TaskEntry.toolCalls`

**Files:**
- Modify: `packages/orchestrator/src/types.ts:23-28` (TaskExecutionResult), `:181-201` (TaskEntry)
- Test: `tests/orchestrator/progress-types.test.ts`

- [ ] **Step 1: Write the type test**

```typescript
// tests/orchestrator/progress-types.test.ts
import { TaskProgressEvent, TaskEntry, TaskExecutionResult } from '@gossip/orchestrator';

describe('TaskProgressEvent type', () => {
  it('accepts all valid status values', () => {
    const statuses: TaskProgressEvent['status'][] = [
      'init', 'start', 'progress', 'done', 'error', 'finish',
    ];
    for (const status of statuses) {
      const event: TaskProgressEvent = {
        taskIndex: 0, totalTasks: 1,
        agentId: 'test', taskDescription: 'test',
        status,
      };
      expect(event.status).toBe(status);
    }
  });

  it('init event carries agents list', () => {
    const event: TaskProgressEvent = {
      taskIndex: 0, totalTasks: 2,
      agentId: '', taskDescription: '',
      status: 'init',
      agents: [
        { agentId: 'impl', task: 'build it' },
        { agentId: 'review', task: 'review it' },
      ],
    };
    expect(event.agents).toHaveLength(2);
  });

  it('progress event carries telemetry', () => {
    const event: TaskProgressEvent = {
      taskIndex: 0, totalTasks: 1,
      agentId: 'impl', taskDescription: 'build',
      status: 'progress',
      toolCalls: 3, inputTokens: 1200, outputTokens: 400,
      currentTool: 'write_file', turn: 2,
    };
    expect(event.toolCalls).toBe(3);
    expect(event.currentTool).toBe('write_file');
  });
});

describe('TaskEntry.toolCalls', () => {
  it('has optional toolCalls field', () => {
    const entry: TaskEntry = {
      id: '1', agentId: 'a', task: 't',
      status: 'running', startedAt: Date.now(),
      toolCalls: 5,
    };
    expect(entry.toolCalls).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/progress-types.test.ts -v`
Expected: FAIL — `TaskProgressEvent` not found in exports

- [ ] **Step 3: Add types to types.ts**

Add `TaskProgressEvent` after `TaskExecutionResult` (after line 28):

```typescript
/** Emitted during plan execution for UI progress tracking */
export interface TaskProgressEvent {
  taskIndex: number;
  totalTasks: number;
  agentId: string;
  taskDescription: string;
  status: 'init' | 'start' | 'progress' | 'done' | 'error' | 'finish';
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  currentTool?: string;
  turn?: number;
  result?: string;
  error?: string;
  agents?: Array<{ agentId: string; task: string }>;
}
```

Add `toolCalls?: number;` to `TaskEntry` (after line 200, before the closing `}`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/orchestrator/progress-types.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/types.ts tests/orchestrator/progress-types.test.ts
git commit -m "feat(types): add TaskProgressEvent and TaskEntry.toolCalls"
```

---

### Task 2: Worker telemetry — `WorkerProgressCallback` and tool call counting

**Files:**
- Modify: `packages/orchestrator/src/worker-agent.ts:79-173`
- Test: `tests/orchestrator/worker-agent.test.ts` (extend existing)

- [ ] **Step 1: Write the progress callback test**

Add to the end of `tests/orchestrator/worker-agent.test.ts`:

```typescript
describe('WorkerAgent progress callback', () => {
  it('fires onProgress after each tool call with cumulative counts', async () => {
    const events: Array<{ toolCalls: number; currentTool: string; turn: number }> = [];
    let callCount = 0;

    const mockLLM: ILLMProvider = {
      async generate(messages, options) {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            toolCalls: [
              { id: '1', name: 'read_file', arguments: { path: 'a.ts' } },
              { id: '2', name: 'write_file', arguments: { path: 'b.ts', content: 'x' } },
            ],
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }
        return { text: 'Done', usage: { inputTokens: 80, outputTokens: 30 } };
      },
    };

    const result = await simulateToolLoopWithProgress(
      mockLLM, tools, 'test task',
      async () => 'ok',
      (evt) => events.push({ toolCalls: evt.toolCalls, currentTool: evt.currentTool, turn: evt.turn }),
    );

    expect(result).toBe('Done');
    expect(events).toHaveLength(2); // one per tool call
    expect(events[0]).toEqual({ toolCalls: 1, currentTool: 'read_file', turn: 0 });
    expect(events[1]).toEqual({ toolCalls: 2, currentTool: 'write_file', turn: 0 });
  });

  it('accumulates tokens across turns', async () => {
    const events: Array<{ inputTokens: number; outputTokens: number }> = [];
    let callCount = 0;

    const mockLLM: ILLMProvider = {
      async generate() {
        callCount++;
        if (callCount <= 2) {
          return {
            text: '',
            toolCalls: [{ id: String(callCount), name: 'read_file', arguments: { path: 'a.ts' } }],
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }
        return { text: 'Done', usage: { inputTokens: 80, outputTokens: 30 } };
      },
    };

    await simulateToolLoopWithProgress(
      mockLLM, tools, 'test task',
      async () => 'ok',
      (evt) => events.push({ inputTokens: evt.inputTokens, outputTokens: evt.outputTokens }),
    );

    // Turn 0: 100/50 after LLM, then tool call fires
    expect(events[0]).toEqual({ inputTokens: 100, outputTokens: 50 });
    // Turn 1: 200/100 after second LLM, then tool call fires
    expect(events[1]).toEqual({ inputTokens: 200, outputTokens: 100 });
  });
});
```

You will also need to add a `simulateToolLoopWithProgress` helper that mirrors the existing `simulateToolLoop` but accepts an `onProgress` callback. Copy `simulateToolLoop` (lines 10-47) and add `onProgress` parameter — add `toolCallCount` counter before the outer for-loop, increment after each `callTool`, fire `onProgress` with cumulative state after each tool call.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/worker-agent.test.ts -t "progress callback" -v`
Expected: FAIL — `simulateToolLoopWithProgress` not defined

- [ ] **Step 3: Add `simulateToolLoopWithProgress` helper and modify WorkerAgent**

In `tests/orchestrator/worker-agent.test.ts`, add the helper after the existing `simulateToolLoop`:

```typescript
type ProgressCb = (event: {
  toolCalls: number; inputTokens: number; outputTokens: number;
  currentTool: string; turn: number;
}) => void;

async function simulateToolLoopWithProgress(
  llm: ILLMProvider, tools: ToolDefinition[], task: string,
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  onProgress?: ProgressCb, maxTurns = 15,
): Promise<string> {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'You are a developer agent.' },
    { role: 'user', content: task },
  ];
  let totalInput = 0, totalOutput = 0, toolCallCount = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await llm.generate(messages, { tools });
    if (response.usage) {
      totalInput += response.usage.inputTokens;
      totalOutput += response.usage.outputTokens;
    }
    if (!response.toolCalls?.length) return response.text;

    messages.push({ role: 'assistant', content: response.text || '', toolCalls: response.toolCalls });
    for (const tc of response.toolCalls) {
      const result = await callTool(tc.name, tc.arguments);
      toolCallCount++;
      onProgress?.({
        toolCalls: toolCallCount, inputTokens: totalInput, outputTokens: totalOutput,
        currentTool: tc.name, turn,
      });
      messages.push({ role: 'tool', content: result, toolCallId: tc.id, name: tc.name });
    }
  }
  return 'Max tool turns reached';
}
```

In `packages/orchestrator/src/worker-agent.ts`:

1. Add export type before the class (after line 14):
```typescript
export type WorkerProgressCallback = (event: {
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  currentTool: string;
  turn: number;
}) => void;
```

2. Add `onProgress` as 4th param to `executeTask` signature (line 79):
```typescript
async executeTask(task: string, context?: string, skillsContent?: string, onProgress?: WorkerProgressCallback): Promise<TaskExecutionResult> {
```

3. Add `let toolCallCount = 0;` after `let totalOutputTokens = 0;` (after line 82).

4. After each tool call completes (after line 157, inside the `for (const toolCall of response.toolCalls)` loop), add:
```typescript
toolCallCount++;
onProgress?.({
  toolCalls: toolCallCount,
  inputTokens: totalInputTokens,
  outputTokens: totalOutputTokens,
  currentTool: toolCall.name,
  turn,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/orchestrator/worker-agent.test.ts -v`
Expected: ALL PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/worker-agent.ts tests/orchestrator/worker-agent.test.ts
git commit -m "feat(worker): add WorkerProgressCallback with tool call counting"
```

---

### Task 3: Gemini token extraction fix

**Files:**
- Modify: `packages/orchestrator/src/llm-client.ts:269-311`
- Test: `tests/orchestrator/llm-client.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test**

Add to `tests/orchestrator/llm-client.test.ts`, in the existing Gemini describe block:

```typescript
it('extracts token usage from Gemini usageMetadata', () => {
  const provider = new GeminiProvider('gemini-2.5-pro', 'fake-key');
  // Access the private method via any cast for testing
  const result = (provider as any).parseGeminiResponse({
    candidates: [{
      content: { parts: [{ text: 'Hello' }] },
      finishReason: 'STOP',
    }],
    usageMetadata: {
      promptTokenCount: 150,
      candidatesTokenCount: 42,
    },
  });
  expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 42 });
});

it('returns undefined usage when Gemini has no usageMetadata', () => {
  const provider = new GeminiProvider('gemini-2.5-pro', 'fake-key');
  const result = (provider as any).parseGeminiResponse({
    candidates: [{ content: { parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }],
  });
  expect(result.usage).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/llm-client.test.ts -t "usageMetadata" -v`
Expected: FAIL — `result.usage` is undefined

- [ ] **Step 3: Fix parseGeminiResponse**

In `packages/orchestrator/src/llm-client.ts`, replace lines 307-311:

```typescript
    return {
      text: textParts.join(''),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
```

With:

```typescript
    const usage = data.usageMetadata as {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    } | undefined;

    return {
      text: textParts.join(''),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage?.promptTokenCount != null ? {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
      } : undefined,
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/orchestrator/llm-client.test.ts -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/llm-client.ts tests/orchestrator/llm-client.test.ts
git commit -m "fix(gemini): extract token usage from usageMetadata"
```

---

### Task 4: DispatchPipeline — wire progress callback through TrackedTask

**Files:**
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts:27-31` (WorkerLike), `:49` (TrackedTask), `:198-269` (4 call sites)
- Test: `tests/orchestrator/dispatch-pipeline.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test**

Add to the end of `tests/orchestrator/dispatch-pipeline.test.ts`:

```typescript
describe('task progress callback', () => {
  it('fires progress events during task execution', async () => {
    const events: Array<{ taskId: string; toolCalls: number }> = [];

    // Create a mock worker that calls onProgress
    const mockWorker = {
      async executeTask(
        task: string, _lens?: string, _prompt?: string,
        onProgress?: (evt: any) => void,
      ) {
        onProgress?.({ toolCalls: 1, inputTokens: 100, outputTokens: 50, currentTool: 'read_file', turn: 0 });
        onProgress?.({ toolCalls: 2, inputTokens: 200, outputTokens: 100, currentTool: 'write_file', turn: 0 });
        return { result: 'done', inputTokens: 200, outputTokens: 100 };
      },
    };

    // Inject mock worker
    (pipeline as any).config.workers.set('test-agent', mockWorker);

    pipeline.setTaskProgressCallback((taskId, evt) => {
      events.push({ taskId, toolCalls: evt.toolCalls });
    });

    const { taskId } = pipeline.dispatch('test-agent', 'test task');
    await pipeline.collect([taskId], 5000);

    expect(events).toHaveLength(2);
    expect(events[0].toolCalls).toBe(1);
    expect(events[1].toolCalls).toBe(2);

    // Cleanup
    pipeline.setTaskProgressCallback(null);
  });
});
```

Note: You may need to adapt this to the existing test setup in the file (check how `pipeline` is constructed in the existing tests — use the same pattern).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/dispatch-pipeline.test.ts -t "task progress callback" -v`
Expected: FAIL — `setTaskProgressCallback` is not a function

- [ ] **Step 3: Implement pipeline changes**

In `packages/orchestrator/src/dispatch-pipeline.ts`:

1. Import `WorkerProgressCallback` from `./worker-agent` (add to imports at top):
```typescript
import { WorkerProgressCallback } from './worker-agent';
```

2. Update `WorkerLike` interface (line 27-28) — add 4th param:
```typescript
interface WorkerLike {
  executeTask(task: string, lens?: string, promptContent?: string, onProgress?: WorkerProgressCallback): Promise<TaskExecutionResult>;
  subscribeToBatch?(batchId: string): Promise<void>;
  unsubscribeFromBatch?(batchId: string): Promise<void>;
}
```

3. Add callback field and setter to `DispatchPipeline` class (after existing class fields):
```typescript
private taskProgressCallback: ((taskId: string, event: { toolCalls: number; inputTokens: number; outputTokens: number; currentTool: string; turn: number }) => void) | null = null;

setTaskProgressCallback(cb: typeof this.taskProgressCallback): void {
  this.taskProgressCallback = cb;
}
```

4. At each of the 4 `worker.executeTask` call sites, create a progress closure before the call and pass it as the 4th argument. Pattern for each:

Before the `worker.executeTask(task, undefined, promptContent)` call, add:
```typescript
const progressCb: WorkerProgressCallback = (evt) => {
  entry.toolCalls = evt.toolCalls;
  entry.inputTokens = evt.inputTokens;
  entry.outputTokens = evt.outputTokens;
  this.taskProgressCallback?.(taskId, evt);
};
```
Then change `worker.executeTask(task, undefined, promptContent)` → `worker.executeTask(task, undefined, promptContent, progressCb)`.

Apply this to all 4 sites:
- Line ~201 (sequential): create `progressCb` before `this.enqueueSequential`, capture in closure
- Line ~221 (scoped): create `progressCb` before `worker.executeTask`
- Line ~241 (worktree): create `progressCb` before the `.then()` chain, pass inside the `.then`
- Line ~257 (default): create `progressCb` before `worker.executeTask`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/orchestrator/dispatch-pipeline.test.ts -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/dispatch-pipeline.ts packages/orchestrator/src/worker-agent.ts tests/orchestrator/dispatch-pipeline.test.ts
git commit -m "feat(pipeline): wire WorkerProgressCallback through TrackedTask"
```

---

### Task 5: ToolExecutor — emit init/progress/finish events

**Files:**
- Modify: `packages/orchestrator/src/tool-router.ts:267-275` (onTaskProgress type), `:277-339` (executePlan)
- Modify: `packages/orchestrator/src/main-agent.ts:282-292` (onTaskProgress type)
- Test: `tests/orchestrator/tool-router.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test**

Add to `tests/orchestrator/tool-router.test.ts`:

```typescript
describe('ToolExecutor plan progress events', () => {
  it('emits init, start, done, and finish events during executePlan', async () => {
    const events: Array<{ status: string; agentId?: string }> = [];
    const mockPipeline = {
      dispatch: jest.fn().mockReturnValue({
        taskId: 'task-1',
        promise: Promise.resolve('result'),
      }),
      collect: jest.fn().mockResolvedValue({
        results: [{ agentId: 'impl', status: 'completed', result: 'done' }],
      }),
      setTaskProgressCallback: jest.fn(),
    };
    const mockRegistry = { get: jest.fn().mockReturnValue({ id: 'impl' }) };
    const executor = new ToolExecutor({
      pipeline: mockPipeline,
      registry: mockRegistry,
      projectRoot: '/tmp/test',
    });

    executor.onTaskProgress = (event: any) => {
      events.push({ status: event.status, agentId: event.agentId || undefined });
    };

    await executor.executePlan({
      plan: { originalTask: 'test', strategy: 'sequential', subTasks: [] },
      tasks: [{ agentId: 'impl', task: 'build it', access: 'write' as const }],
    });

    const statuses = events.map(e => e.status);
    expect(statuses[0]).toBe('init');
    expect(statuses).toContain('start');
    expect(statuses).toContain('done');
    expect(statuses[statuses.length - 1]).toBe('finish');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/tool-router.test.ts -t "plan progress events" -v`
Expected: FAIL — no 'init' event emitted

- [ ] **Step 3: Implement executePlan changes**

In `packages/orchestrator/src/tool-router.ts`:

1. Import `TaskProgressEvent` (add to imports from `./types`):
```typescript
import type { ToolCall, ToolResult, DispatchPlan, PlannedTask, TaskProgressEvent } from './types';
```

2. Replace the inline type on `onTaskProgress` (line 267-275) with:
```typescript
onTaskProgress: ((event: TaskProgressEvent) => void) | null = null;
```

3. In `executePlan` (line 277), add at the start of the `try` block (before line 282):
```typescript
// Emit init event with full agent list
this.onTaskProgress?.({
  taskIndex: 0, totalTasks: tasks.length,
  agentId: '', taskDescription: '',
  status: 'init',
  agents: tasks.map(t => ({ agentId: t.agentId, task: t.task })),
});

// Wire pipeline progress callback
this.pipeline.setTaskProgressCallback?.((taskId: string, evt: any) => {
  const idx = tasks.findIndex((t, i) => i === taskIdMap.get(taskId));
  if (idx >= 0) {
    this.onTaskProgress?.({
      taskIndex: idx, totalTasks: tasks.length,
      agentId: tasks[idx].agentId, taskDescription: tasks[idx].task,
      status: 'progress',
      toolCalls: evt.toolCalls, inputTokens: evt.inputTokens,
      outputTokens: evt.outputTokens, currentTool: evt.currentTool, turn: evt.turn,
    });
  }
});
const taskIdMap = new Map<string, number>();
```

4. In both parallel and sequential paths, store taskId → index mapping after each dispatch:
```typescript
taskIdMap.set(taskId, i);  // where i is the task index
```

5. Add `'finish'` event at the end of the `try` block, before `return`:
```typescript
this.onTaskProgress?.({
  taskIndex: tasks.length, totalTasks: tasks.length,
  agentId: '', taskDescription: '', status: 'finish',
});
```

6. Add `finally` block to clear the pipeline callback:
```typescript
} catch (err) {
  // existing error handling
} finally {
  this.pipeline.setTaskProgressCallback?.(null);
}
```

7. Update existing `this.onTaskProgress?.()` calls in the parallel/sequential paths to use the `TaskProgressEvent` shape (add missing fields like `taskIndex`, `totalTasks`).

- [ ] **Step 4: Update MainAgent type**

In `packages/orchestrator/src/main-agent.ts`:

1. Add `TaskProgressEvent` to imports from `./types`.
2. Replace the inline type at line 282 with:
```typescript
onTaskProgress(cb: (event: TaskProgressEvent) => void): void {
  this.toolExecutor.onTaskProgress = cb;
}
```

- [ ] **Step 5: Run tests**

Run: `npx jest tests/orchestrator/tool-router.test.ts -v`
Expected: ALL PASS

Run: `npx jest tests/orchestrator/main-agent.test.ts -v`
Expected: ALL PASS (existing tests still work with widened type)

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/tool-router.ts packages/orchestrator/src/main-agent.ts tests/orchestrator/tool-router.test.ts
git commit -m "feat(executor): emit init/progress/finish events during plan execution"
```

---

### Task 6: ProgressTree renderer

**Files:**
- Create: `apps/cli/src/progress-tree.ts`
- Test: `tests/cli/progress-tree.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/cli/progress-tree.test.ts
import { ProgressTree } from '../../apps/cli/src/progress-tree';

// Mock readline
const mockRl = {
  pause: jest.fn(),
  resume: jest.fn(),
};

// Capture stdout writes
let output: string[] = [];
const origWrite = process.stdout.write;

beforeEach(() => {
  output = [];
  process.stdout.write = jest.fn((chunk: any) => {
    output.push(String(chunk));
    return true;
  }) as any;
  jest.spyOn(process.stdout, 'isTTY', 'get').mockReturnValue(true as any);
  jest.spyOn(process.stdout, 'columns', 'get').mockReturnValue(120);
  mockRl.pause.mockClear();
  mockRl.resume.mockClear();
});
afterEach(() => { process.stdout.write = origWrite; });

describe('ProgressTree', () => {
  it('start() prints initial lines and pauses readline', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([
      { agentId: 'impl', task: 'build form' },
      { agentId: 'review', task: 'review code' },
    ]);
    expect(mockRl.pause).toHaveBeenCalled();
    // Should have written agent lines + summary footer
    const joined = output.join('');
    expect(joined).toContain('impl');
    expect(joined).toContain('review');
    expect(joined).toContain('pending');
    tree.finish();
  });

  it('update() changes agent status to running', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([{ agentId: 'impl', task: 'build' }]);
    output = [];
    tree.update('impl', {
      taskIndex: 0, totalTasks: 1, agentId: 'impl',
      taskDescription: 'build', status: 'start',
    } as any);
    // After redraw, should no longer show 'pending'
    const joined = output.join('');
    // Running state shows spinner frame
    expect(joined).not.toContain('pending');
    tree.finish();
  });

  it('update() with progress shows tool calls in bar', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([{ agentId: 'impl', task: 'build' }]);
    output = [];
    tree.update('impl', {
      taskIndex: 0, totalTasks: 1, agentId: 'impl',
      taskDescription: 'build', status: 'progress',
      toolCalls: 3, currentTool: 'write_file', turn: 2,
    } as any);
    const joined = output.join('');
    expect(joined).toContain('3/15');
    expect(joined).toContain('write_file');
    tree.finish();
  });

  it('update() with done shows tokens and duration', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([{ agentId: 'impl', task: 'build' }]);
    // Simulate some time passing
    tree.update('impl', {
      taskIndex: 0, totalTasks: 1, agentId: 'impl',
      taskDescription: 'build', status: 'done',
      toolCalls: 5, inputTokens: 8200, outputTokens: 4200,
    } as any);
    output = [];
    // Force one more redraw to capture final state
    (tree as any).redraw();
    const joined = output.join('');
    expect(joined).toContain('✓');
    expect(joined).toContain('done');
    expect(joined).toContain('12.4k tok'); // 8200+4200 = 12400
    tree.finish();
  });

  it('finish() resumes readline and stops interval', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([{ agentId: 'impl', task: 'build' }]);
    tree.finish();
    expect(mockRl.resume).toHaveBeenCalled();
    expect(tree.isActive()).toBe(false);
  });

  it('finish() is safe to call when not active', () => {
    const tree = new ProgressTree(mockRl as any);
    expect(() => tree.finish()).not.toThrow();
  });

  it('truncates agent names longer than 16 chars', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([{ agentId: 'gemini-implementer-pro', task: 'build' }]);
    const joined = output.join('');
    expect(joined).toContain('gemini-impleme…');
    tree.finish();
  });
});

describe('ProgressTree token formatting', () => {
  it('formats < 1000 as raw number', () => {
    const tree = new ProgressTree(mockRl as any);
    // Access private helper
    expect((tree as any).formatTokens(847)).toBe('847 tok');
  });

  it('formats >= 1000 with k suffix', () => {
    const tree = new ProgressTree(mockRl as any);
    expect((tree as any).formatTokens(12400)).toBe('12.4k tok');
  });

  it('returns empty string for 0', () => {
    const tree = new ProgressTree(mockRl as any);
    expect((tree as any).formatTokens(0)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/cli/progress-tree.test.ts -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ProgressTree**

Create `apps/cli/src/progress-tree.ts`:

```typescript
import { Interface as ReadlineInterface } from 'readline';
import { TaskProgressEvent } from '@gossip/orchestrator';

const MAX_TURNS = 15;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
};

interface AgentState {
  agentId: string;
  task: string;
  status: 'pending' | 'running' | 'done' | 'error';
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  currentTool: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export class ProgressTree {
  private agents: AgentState[] = [];
  private interval: NodeJS.Timeout | null = null;
  private spinnerIdx = 0;
  private active = false;
  private lineCount = 0;
  private startTime = 0;
  private isTTY: boolean;

  constructor(private rl: ReadlineInterface) {
    this.isTTY = process.stdout.isTTY ?? false;
  }

  start(agents: Array<{ agentId: string; task: string }>): void {
    this.agents = agents.map(a => ({
      agentId: a.agentId, task: a.task,
      status: 'pending', toolCalls: 0,
      inputTokens: 0, outputTokens: 0,
      currentTool: '', startedAt: Date.now(),
    }));
    this.active = true;
    this.startTime = Date.now();
    this.lineCount = this.agents.length + 1; // agents + summary footer
    this.rl.pause();

    if (this.isTTY) {
      this.redraw();
      this.interval = setInterval(() => {
        this.spinnerIdx++;
        this.redraw();
      }, 80);
    } else {
      // Non-TTY: print header
      process.stdout.write(`  ${agents.length} agents running...\n`);
    }
  }

  update(agentId: string, event: TaskProgressEvent): void {
    const agent = this.agents.find(a => a.agentId === agentId);
    if (!agent) return;

    if (event.status === 'start') {
      agent.status = 'running';
      agent.startedAt = Date.now();
    } else if (event.status === 'progress') {
      agent.status = 'running';
      agent.toolCalls = event.toolCalls ?? agent.toolCalls;
      agent.inputTokens = event.inputTokens ?? agent.inputTokens;
      agent.outputTokens = event.outputTokens ?? agent.outputTokens;
      agent.currentTool = event.currentTool ?? agent.currentTool;
    } else if (event.status === 'done') {
      agent.status = 'done';
      agent.toolCalls = event.toolCalls ?? agent.toolCalls;
      agent.inputTokens = event.inputTokens ?? agent.inputTokens;
      agent.outputTokens = event.outputTokens ?? agent.outputTokens;
      agent.completedAt = Date.now();
    } else if (event.status === 'error') {
      agent.status = 'error';
      agent.error = event.error;
      agent.completedAt = Date.now();
    }

    if (!this.isTTY && (event.status === 'done' || event.status === 'error')) {
      const icon = event.status === 'done' ? '✓' : '✗';
      process.stdout.write(`  ${icon} ${agentId}: ${agent.task.slice(0, 40)}\n`);
    }
  }

  finish(): void {
    if (!this.active) return;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.isTTY) {
      this.redraw(); // final state
    } else {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      const totalTok = this.agents.reduce((s, a) => s + a.inputTokens + a.outputTokens, 0);
      const tokStr = totalTok > 0 ? ` · ${this.formatTokens(totalTok)}` : '';
      process.stdout.write(`  ${this.agents.length} agents · ${elapsed}s${tokStr}\n`);
    }
    this.active = false;
    this.rl.resume();
  }

  isActive(): boolean {
    return this.active;
  }

  private redraw(): void {
    // Move cursor up to overwrite previous block
    if (this.lineCount > 0) {
      process.stdout.write(`\x1b[${this.lineCount}A`);
    }

    const cols = process.stdout.columns || 120;
    const showStats = cols >= 100;

    for (const agent of this.agents) {
      process.stdout.write(this.renderAgentLine(agent, showStats) + '\x1b[K\n');
    }
    // Summary footer
    process.stdout.write(this.renderFooter() + '\x1b[K\n');
  }

  private renderAgentLine(agent: AgentState, showStats: boolean): string {
    const name = this.truncate(agent.agentId, 16).padEnd(16);
    const bar = this.renderBar(agent.toolCalls);
    const turns = `${String(agent.toolCalls).padStart(2)}/${MAX_TURNS}`;
    const task = this.truncate(agent.task, 24).padEnd(24);

    let stats = '';
    if (showStats) {
      if (agent.status === 'done' || agent.status === 'error') {
        const totalTok = agent.inputTokens + agent.outputTokens;
        const tokStr = this.formatTokens(totalTok);
        const dur = agent.completedAt
          ? `${((agent.completedAt - agent.startedAt) / 1000).toFixed(1)}s`
          : '';
        stats = `${tokStr ? tokStr + '  ' : ''}${dur}`.padEnd(14);
      } else if (agent.status === 'running') {
        stats = '···'.padEnd(14);
      } else {
        stats = ''.padEnd(14);
      }
    }

    const status = this.renderStatus(agent);
    return `  ${c.cyan}${name}${c.reset}  ${bar}  ${c.dim}${turns}${c.reset}  ${task}  ${stats}${status}`;
  }

  private renderBar(toolCalls: number): string {
    const filled = Math.min(toolCalls, MAX_TURNS);
    return '█'.repeat(filled) + '░'.repeat(MAX_TURNS - filled);
  }

  private renderStatus(agent: AgentState): string {
    switch (agent.status) {
      case 'pending':
        return `${c.dim}○ pending${c.reset}`;
      case 'running': {
        const frame = SPINNER_FRAMES[this.spinnerIdx % SPINNER_FRAMES.length];
        const tool = agent.currentTool ? ` ${agent.currentTool}` : '';
        return `${c.cyan}${frame}${c.reset}${tool}`;
      }
      case 'done':
        return `${c.green}✓ done${c.reset}`;
      case 'error':
        return `${c.red}✗ ${this.truncate(agent.error || 'error', 20)}${c.reset}`;
    }
  }

  private renderFooter(): string {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const totalTok = this.agents.reduce((s, a) => s + a.inputTokens + a.outputTokens, 0);
    const tokStr = totalTok > 0 ? ` · ${this.formatTokens(totalTok)}` : '';
    return `${c.dim}  ${this.agents.length} agents · ${elapsed}s${tokStr}${c.reset}`;
  }

  private formatTokens(total: number): string {
    if (total === 0) return '';
    if (total < 1000) return `${total} tok`;
    return `${(total / 1000).toFixed(1)}k tok`;
  }

  private truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    return str.slice(0, max - 1) + '…';
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/cli/progress-tree.test.ts -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/progress-tree.ts tests/cli/progress-tree.test.ts
git commit -m "feat(cli): add ProgressTree ANSI pipeline renderer"
```

---

### Task 7: Wire ProgressTree into ChatSession + SIGINT fix

**Files:**
- Modify: `apps/cli/src/chat-session.ts:1-10` (imports), `:39` (class fields), `:52-73` (onTaskProgress), `:158-178` (SIGINT), `:815-840` (shutdown)

- [ ] **Step 1: Add import and class field**

In `apps/cli/src/chat-session.ts`:

Add import (after line 7):
```typescript
import { ProgressTree } from './progress-tree';
```

Add to `ChatSessionConfig` import: add `TaskProgressEvent` to the import from `@gossip/orchestrator` (line 2).

Add class field (after line 42, `private currentAbort`):
```typescript
private progressTree: ProgressTree;
```

Initialize in constructor (after line 49, `this.spinner = new Spinner();`):
```typescript
this.progressTree = new ProgressTree(null as any); // rl set after createInterface
```

- [ ] **Step 2: Replace onTaskProgress handler**

Replace lines 52-73 (the existing `this.mainAgent.onTaskProgress(...)` block) with:

```typescript
this.mainAgent.onTaskProgress((event) => {
  if (event.status === 'init' && event.agents) {
    this.spinner.stop();
    this.progressTree.start(event.agents);
    return;
  }
  if (!this.progressTree.isActive()) return;
  if (event.status === 'start' || event.status === 'progress') {
    this.progressTree.update(event.agentId, event);
    return;
  }
  if (event.status === 'done' || event.status === 'error') {
    this.progressTree.update(event.agentId, event);
    return;
  }
  if (event.status === 'finish') {
    this.progressTree.finish();
  }
});
```

- [ ] **Step 3: Initialize ProgressTree with rl after createInterface**

In the `start()` method (after line 130 `this.spinner.setReadline(this.rl);`), add:
```typescript
this.progressTree = new ProgressTree(this.rl);
```

- [ ] **Step 4: Fix SIGINT handler**

In the SIGINT handler (lines 158-178), add `this.progressTree.isActive() && this.progressTree.finish();` at the start of each branch:

```typescript
this.rl.on('SIGINT', () => {
  if (this.progressTree.isActive()) this.progressTree.finish();
  if (this.state === 'processing' && this.currentAbort) {
    this.currentAbort.abort();
    // ... rest unchanged
  } else if (this.state === 'choice') {
    // ... rest unchanged
  } else {
    this.shutdown().catch(() => process.exit(0));
  }
});
```

- [ ] **Step 5: Fix shutdown method**

In `shutdown()` (around line 819), add after `this.spinner.stop();`:
```typescript
if (this.progressTree.isActive()) this.progressTree.finish();
```

- [ ] **Step 6: Run all tests**

Run: `npx jest --config jest.config.base.js`
Expected: ALL PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/chat-session.ts
git commit -m "feat(cli): wire ProgressTree into ChatSession with SIGINT safety"
```

---

### Task 8: Integration smoke test

**Files:**
- Test: `tests/cli/progress-tree-integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// tests/cli/progress-tree-integration.test.ts
import { ProgressTree } from '../../apps/cli/src/progress-tree';
import { TaskProgressEvent } from '@gossip/orchestrator';

describe('ProgressTree integration', () => {
  const mockRl = { pause: jest.fn(), resume: jest.fn() };
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    jest.spyOn(process.stdout, 'isTTY', 'get').mockReturnValue(true as any);
    jest.spyOn(process.stdout, 'columns', 'get').mockReturnValue(120);
    mockRl.pause.mockClear();
    mockRl.resume.mockClear();
  });
  afterEach(() => stdoutSpy.mockRestore());

  it('simulates a full parallel plan lifecycle', () => {
    const tree = new ProgressTree(mockRl as any);

    // init
    tree.start([
      { agentId: 'impl', task: 'build login form' },
      { agentId: 'reviewer', task: 'review auth code' },
    ]);
    expect(tree.isActive()).toBe(true);

    // both start running
    tree.update('impl', { taskIndex: 0, totalTasks: 2, agentId: 'impl', taskDescription: 'build login form', status: 'start' });
    tree.update('reviewer', { taskIndex: 1, totalTasks: 2, agentId: 'reviewer', taskDescription: 'review auth code', status: 'start' });

    // impl progresses
    tree.update('impl', { taskIndex: 0, totalTasks: 2, agentId: 'impl', taskDescription: 'build login form', status: 'progress', toolCalls: 3, currentTool: 'write_file', inputTokens: 5000, outputTokens: 2000 });

    // reviewer finishes first
    tree.update('reviewer', { taskIndex: 1, totalTasks: 2, agentId: 'reviewer', taskDescription: 'review auth code', status: 'done', toolCalls: 2, inputTokens: 3000, outputTokens: 1000 });

    // impl finishes
    tree.update('impl', { taskIndex: 0, totalTasks: 2, agentId: 'impl', taskDescription: 'build login form', status: 'done', toolCalls: 8, inputTokens: 8000, outputTokens: 4200 });

    // finish
    tree.finish();
    expect(tree.isActive()).toBe(false);
    expect(mockRl.resume).toHaveBeenCalled();
  });

  it('handles Ctrl+C mid-execution gracefully', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([{ agentId: 'impl', task: 'build' }]);
    tree.update('impl', { taskIndex: 0, totalTasks: 1, agentId: 'impl', taskDescription: 'build', status: 'progress', toolCalls: 2, currentTool: 'read_file' });
    // Simulate Ctrl+C — finish while still running
    tree.finish();
    expect(tree.isActive()).toBe(false);
    expect(mockRl.resume).toHaveBeenCalled();
  });

  it('handles error status', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([{ agentId: 'impl', task: 'build' }]);
    tree.update('impl', { taskIndex: 0, totalTasks: 1, agentId: 'impl', taskDescription: 'build', status: 'error', error: 'timeout' });
    const output = (stdoutSpy.mock.calls.map(c => c[0]) as string[]).join('');
    expect(output).toContain('✗');
    tree.finish();
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx jest tests/cli/progress-tree-integration.test.ts -v`
Expected: ALL PASS

- [ ] **Step 3: Run full test suite**

Run: `npx jest --config jest.config.base.js`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/cli/progress-tree-integration.test.ts
git commit -m "test: add ProgressTree integration smoke tests"
```
