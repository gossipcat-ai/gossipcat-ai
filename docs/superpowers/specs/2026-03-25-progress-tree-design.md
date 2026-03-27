# Progress Tree — Agent Execution Pipeline UI

**Date:** 2026-03-25
**Status:** Design approved
**Scope:** CLI progress visualization + worker agent telemetry

## Problem

During plan execution, gossipcat shows a flat spinner (`⠋ thinking... 3.2s`) and prints checkmark lines after each task completes. There's no visibility into:
- Which agents are running in parallel
- How far along each agent is (tool calls consumed out of budget)
- Token usage per agent
- What tool an agent is currently calling

Claude Code shows a rich agent progress tree. We want similar live visibility, with a distinct "pipeline" visual style that fits gossipcat's multi-agent identity.

## Design

### Visual: Pipeline Progress Bars

One line per agent, rewritten in-place via ANSI cursor control. Each agent gets a progress bar showing tool calls consumed out of MAX_TOOL_TURNS (15).

**States:**

Pending (sequential plans, not yet started):
```
  gemini-impl    ░░░░░░░░░░░░░░░  0/15  build login form                     ○ pending
```

Running (actively executing):
```
  gemini-impl    ██░░░░░░░░░░░░░  2/15  build login form         ···         ⠹ writing form.tsx
```

Done:
```
  gemini-impl    ████████░░░░░░░  8/15  build login form    12.4k tok  3.1s  ✓ done
```

Error:
```
  gemini-impl    ██░░░░░░░░░░░░░  2/15  build login form                     ✗ timeout
```

Summary footer (always last line):
```
  3 agents · 8.2s · 24.1k tokens
```

### Column Layout

Fixed-width columns to prevent layout jitter during redraws:

| Column | Width | Content |
|--------|-------|---------|
| agent | 16 | Agent ID, truncated with `…` |
| bar | 15 | `█` filled + `░` empty, matching MAX_TOOL_TURNS |
| turns | 4 | `N/15` |
| task | 24 | Task description, truncated with `…` |
| stats | 14 | `···` while running, `12.4k tok  3.1s` when done |
| status | variable | Spinner frame + current tool, or `✓ done` / `✗ error` |

**Responsive:** Terminal width < 100 → drop stats column. < 60 → collapse to `agent bar status` only.

## Architecture

### Types — `packages/orchestrator/src/types.ts`

Define a new named type for progress events (currently inline anonymous types in `tool-router.ts:267` and `main-agent.ts:282`):

```typescript
/** Emitted during plan execution for UI progress tracking */
export interface TaskProgressEvent {
  taskIndex: number;
  totalTasks: number;
  agentId: string;
  taskDescription: string;
  status: 'init' | 'start' | 'progress' | 'done' | 'error' | 'finish';
  // Present on 'progress' events:
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  currentTool?: string;
  turn?: number;
  // Present on 'done':
  result?: string;
  // Present on 'error':
  error?: string;
  // Present on 'init' — full agent list for the plan:
  agents?: Array<{ agentId: string; task: string }>;
}
```

Add to `TaskEntry`:
```typescript
toolCalls?: number;  // cumulative tool call count
```

Replace the inline anonymous types in `tool-router.ts:267-275` and `main-agent.ts:282-292` with `TaskProgressEvent`. These two files plus `chat-session.ts:52-73` must be updated atomically — if the named type is widened but the inline types remain, TypeScript won't enforce the new event statuses.

**Export path:** `WorkerProgressCallback` is defined in `worker-agent.ts` and imported by `dispatch-pipeline.ts` (safe — no circular dependency). `TaskProgressEvent` is defined in `types.ts` and exported from `packages/orchestrator/src/index.ts` so `apps/cli` can import it from `@gossip/orchestrator`.

### New File — `apps/cli/src/progress-tree.ts`

ProgressTree renderer. Owns a block of N+1 terminal lines (N agents + 1 summary footer). Rewrites in-place using ANSI escape sequences.

```typescript
interface AgentState {
  agentId: string;
  task: string;
  status: 'pending' | 'running' | 'done' | 'error';
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  currentTool: string;      // last tool name called (shown during running)
  startedAt: number;
  completedAt?: number;
  error?: string;
}

class ProgressTree {
  constructor(rl: ReadlineInterface);
  start(agents: Array<{ agentId: string; task: string }>): void;
  update(agentId: string, event: TaskProgressEvent): void;
  finish(): void;
  isActive(): boolean;
}
```

**Lifecycle:** `start()` → `update()` ... → `finish()`

- `start()` — prints initial block (all agents as pending), saves line count, pauses readline, starts spinner interval
- `update()` — updates internal `AgentState` for the given agent, triggers redraw
- `finish()` — stops spinner interval, resumes readline, lines stay as final state
- `isActive()` — returns whether the tree is currently rendering

**Mutual exclusion with Spinner:** ProgressTree and Spinner must never render simultaneously. ChatSession must call `spinner.stop()` before `progressTree.start()`. ProgressTree owns readline pause/resume while active.

**ANSI rewriting:** On each redraw:
1. Move cursor up `lineCount` lines: `\x1b[${lineCount}A`
2. Rewrite all lines top-to-bottom
3. Each line ends with `\x1b[K` (clear to end of line)

**Spinner:** Single `setInterval(80ms)` drives frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` for running agents. The interval triggers a full redraw (cheap — just string writes).

**Non-TTY fallback:** If `!process.stdout.isTTY`, `update()` appends a new line per status change instead of rewriting. No ANSI escapes, no animation.

### Modified Files

#### `packages/orchestrator/src/worker-agent.ts`

Add `onProgress` callback as 4th parameter to `executeTask`:

```typescript
export type WorkerProgressCallback = (event: {
  toolCalls: number;       // cumulative
  inputTokens: number;     // cumulative
  outputTokens: number;    // cumulative
  currentTool: string;     // name of last tool called
  turn: number;            // current turn (0-indexed)
}) => void;

async executeTask(
  task: string,
  context?: string,
  skillsContent?: string,
  onProgress?: WorkerProgressCallback,
): Promise<TaskExecutionResult>
```

Inside the existing tool loop, fire `onProgress` at two points:
1. After each LLM response — updates token counts
2. After each tool call completes — updates tool count + currentTool name

Add a `toolCallCount` counter (starts at 0, increments per tool call in the inner for-loop at line 145).

#### `packages/orchestrator/src/dispatch-pipeline.ts`

**Interface change:** Update `WorkerLike` interface (line 27-31) to match the new `executeTask` signature:

```typescript
interface WorkerLike {
  executeTask(
    task: string,
    lens?: string,
    promptContent?: string,
    onProgress?: WorkerProgressCallback,
  ): Promise<TaskExecutionResult>;
  // ... rest unchanged
}
```

**Progress callback stored on TrackedTask:** Do NOT add `onProgress` to `DispatchOptions`. Instead, store the callback directly on the `TrackedTask` entry inside the promise chain. The reason: `collect()` blocks with `Promise.all` until tasks complete, so `DispatchOptions` is consumed before `collect()` awaits. Progress events must fire *during* execution from inside the worker promise chain.

**Mechanism:** Add an optional `onProgress` field to the internal `TrackedTask` type:

```typescript
// Internal to dispatch-pipeline.ts
interface TrackedTask {
  // ... existing fields
  onProgress?: WorkerProgressCallback;
}
```

Add a `setTaskProgressCallback` method on `DispatchPipeline`:

```typescript
setTaskProgressCallback(cb: ((taskId: string, event: WorkerProgressEvent) => void) | null): void;
```

When a task is dispatched, the pipeline creates a per-task `onProgress` closure that:
1. Updates `TrackedTask.toolCalls`, `TrackedTask.inputTokens`, `TrackedTask.outputTokens` in-place
2. Calls the pipeline-level `setTaskProgressCallback` with the taskId and event

This closure is passed as the 4th argument to `worker.executeTask()` at all 4 call sites (lines ~201, ~221, ~241, ~257). For the `enqueueSequential` path at line ~201, the closure is captured in the outer scope before being passed into the lambda.

**Call site pattern:**
```typescript
const progressCb: WorkerProgressCallback = (evt) => {
  entry.toolCalls = evt.toolCalls;
  entry.inputTokens = evt.inputTokens;
  entry.outputTokens = evt.outputTokens;
  this.taskProgressCallback?.(taskId, evt);
};
// Then: worker.executeTask(task, undefined, promptContent, progressCb)
```

#### `packages/orchestrator/src/tool-router.ts`

**`ToolExecutor.executePlan()`** changes:

1. **Emit `'init'` event** before execution begins — carries the full `agents` list so the UI can call `progressTree.start()`:
   ```typescript
   this.onTaskProgress?.({
     taskIndex: 0, totalTasks: tasks.length,
     agentId: '', taskDescription: '',
     status: 'init',
     agents: tasks.map(t => ({ agentId: t.agentId, task: t.task })),
   });
   ```

2. **Wire pipeline progress to `onTaskProgress`:** Before dispatching, set the pipeline's task progress callback to relay `'progress'` events:
   ```typescript
   this.pipeline.setTaskProgressCallback((taskId, evt) => {
     const idx = tasks.findIndex(t => /* match by taskId */);
     this.onTaskProgress?.({
       taskIndex: idx, totalTasks: tasks.length,
       agentId: tasks[idx].agentId,
       taskDescription: tasks[idx].task,
       status: 'progress',
       toolCalls: evt.toolCalls,
       inputTokens: evt.inputTokens,
       outputTokens: evt.outputTokens,
       currentTool: evt.currentTool,
       turn: evt.turn,
     });
   });
   ```
   Clear the callback in the `finally` block after `executePlan` completes.

3. **Emit `'finish'` event** after all tasks complete (both parallel and sequential paths), regardless of individual success/failure. This is the safety net for the `completedCount` approach in ChatSession:
   ```typescript
   // After all collect() calls and result iteration:
   this.onTaskProgress?.({
     taskIndex: tasks.length, totalTasks: tasks.length,
     agentId: '', taskDescription: '',
     status: 'finish',
   });
   ```

4. Replace inline anonymous type on `onTaskProgress` (line 267) with the named `TaskProgressEvent` type.

#### `packages/orchestrator/src/main-agent.ts`

Replace inline anonymous type on `onTaskProgress` (line 282) with the named `TaskProgressEvent` type. No other changes — MainAgent already forwards the callback to ToolExecutor.

#### `packages/orchestrator/src/llm-client.ts`

Fix `GeminiProvider.parseGeminiResponse` to extract token usage from the `usageMetadata` field that Gemini already returns:

```typescript
// Gemini API returns:
// { usageMetadata: { promptTokenCount: N, candidatesTokenCount: N } }
const usage = data.usageMetadata as {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
} | undefined;
return {
  text: textParts.join(''),
  toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  usage: usage ? {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
  } : undefined,
};
```

#### `apps/cli/src/chat-session.ts`

Add `private progressTree: ProgressTree` class field, initialized in constructor with `this.rl`.

Replace current `onTaskProgress` handler (lines 52-73):

```typescript
this.mainAgent.onTaskProgress((event) => {
  if (event.status === 'init' && event.agents) {
    // Plan is about to start — initialize the tree with all agents
    this.spinner.stop();  // mutual exclusion: stop spinner before starting tree
    this.progressTree.start(event.agents);
    return;
  }
  if (!this.progressTree.isActive()) return;  // ignore events if tree not initialized
  if (event.status === 'start' || event.status === 'progress') {
    this.progressTree.update(event.agentId, event);
    return;
  }
  if (event.status === 'done' || event.status === 'error') {
    this.progressTree.update(event.agentId, event);
    return;
  }
  if (event.status === 'finish') {
    // Fired by executePlan after all tasks complete — guaranteed safety net
    this.progressTree.finish();
  }
});
```

**SIGINT handler** (lines 158-178): All three branches must call `if (this.progressTree.isActive()) this.progressTree.finish()` before existing cleanup logic. The `shutdown()` method (line 819) also needs this guard. Without this, Ctrl+C during plan execution leaves the spinner interval running and readline paused (dead terminal).

Spinner continues to be used for non-plan operations (simple thinking/processing).

## Edge Cases

### Sequential vs Parallel Plans

- **Both:** The `'init'` event fires before any execution, carrying the full agent list. `progressTree.start()` is always called with the complete list upfront.
- **Parallel:** All agents transition from `pending` → `running` almost immediately as tasks are dispatched.
- **Sequential:** Agents transition from `pending` → `running` one at a time. Prior agents stay in their final done/error state. The tree does NOT grow dynamically — all agents are shown from the start, with pending agents visible.

### Single-Task Dispatches

No ProgressTree for single-agent dispatches (`/dispatch`, cognitive mode single tool call, or LLM-originated `dispatch_parallel`). ProgressTree activates only for **plan execution** via `executePlan()`, which is the only code path that emits `'init'`. The LLM's `handleDispatchParallel()` at `tool-router.ts:398` does NOT emit `'init'` — it uses the existing spinner-based flow. This is intentional: plan execution is the structured path where the user has reviewed and approved the task breakdown; direct parallel dispatch is an ad-hoc LLM decision.

### Spinner Mutual Exclusion

ProgressTree and Spinner must never render simultaneously. `spinner.stop()` is called synchronously before `progressTree.start()` in the `'init'` handler (same microtask, no readline-live window). While ProgressTree is active, the spinner is not used. After `progressTree.finish()`, the spinner is available again for subsequent operations.

### Completion Safety

The `'finish'` event is emitted by `executePlan()` after all tasks are collected, regardless of individual success or failure. This replaces the fragile `completedCount >= currentPlanSize` approach — if early errors reduce the actual result count, or if dispatch fails for some agents, `'finish'` still fires from the `finally` block. ChatSession does not need to count completions.

### Non-TTY

If `!process.stdout.isTTY`, fall back to log-append — print each status change as a new line with the same info. No ANSI rewriting, no animation.

### Ctrl+C

`finish()` is safe to call at any time. Stops the interval, resumes readline. Partially-completed agents show their last known state. ChatSession's existing SIGINT handler should call `progressTree.finish()` if active.

### Agent Names > 16 chars

Truncate with ellipsis: `gemini-impleme…`

### Zero Tokens

If tokens are 0 after completion (Ollama, or Gemini before fix), show duration only: `3.1s` instead of `12.4k tok  3.1s`.

### Token Formatting

- < 1000: show raw number (`847 tok`)
- >= 1000: show with `k` suffix, one decimal (`12.4k tok`)

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `apps/cli/src/progress-tree.ts` | Create | ProgressTree renderer |
| `apps/cli/src/chat-session.ts` | Modify | Wire ProgressTree into task progress handler |
| `packages/orchestrator/src/worker-agent.ts` | Modify | Add onProgress callback with tool/token telemetry |
| `packages/orchestrator/src/types.ts` | Modify | Add toolCalls to TaskEntry, extend progress event |
| `packages/orchestrator/src/dispatch-pipeline.ts` | Modify | Relay worker progress events to pipeline callback |
| `packages/orchestrator/src/tool-router.ts` | Modify | Emit 'progress' events during plan execution |
| `packages/orchestrator/src/llm-client.ts` | Modify | Fix Gemini token extraction |

## Not In Scope

- Cost calculation per agent (token data enables this later)
- Expand/collapse tree (ctrl+o in Claude Code) — can add later
- Streaming text output from agents during execution
- Progress bars for non-plan dispatches
