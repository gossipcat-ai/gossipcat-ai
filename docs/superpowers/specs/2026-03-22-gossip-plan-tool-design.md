# gossip_plan — Write-Mode-Aware Task Planning

> Enable the orchestrator to detect when a task needs write access, suggest appropriate write modes, and return a dispatch-ready plan for user approval before execution.

**Date:** 2026-03-22
**Status:** Draft
**Dependencies:** Write Tasks (shipped), DispatchPipeline write modes (shipped)

---

## Problem Statement

The gossipcat orchestrator has three write modes (sequential, scoped, worktree) but no intelligence to suggest them. The caller LLM (Claude Code, Cursor) must manually pass `write_mode` on every dispatch — and it never does because nothing in the tool descriptions, bootstrap prompt, or orchestrator flow makes write modes salient.

Result: every gossipcat dispatch is read-only by default. Implementation tasks are either handled directly by the caller LLM (bypassing gossipcat entirely) or dispatched without write mode (agents can't modify files). The write coordination layer is unused.

## Design Overview

**Add a `gossip_plan` MCP tool** that decomposes a task, classifies each sub-task as read or write, suggests write modes, and returns a structured plan the caller can approve and dispatch.

**Update tool descriptions and bootstrap prompt** so the caller LLM knows to call `gossip_plan` before dispatching implementation tasks.

```
User: "fix the scope validation bug in packages/tools/"
  ↓
Caller calls gossip_plan(task)
  ↓
TaskDispatcher.decompose() → assignAgents() → classifyWriteModes()
  ↓
Returns plan with write-mode suggestions + dispatch-ready JSON
  ↓
Caller shows plan to user, user approves/modifies
  ↓
Caller calls gossip_dispatch_parallel(tasks) with the plan's JSON
```

---

## Component 1: `gossip_plan` MCP Tool

### Schema

```typescript
server.tool('gossip_plan', '...', {
  task: z.string().describe('Task description'),
  strategy: z.enum(['parallel', 'sequential', 'single']).optional()
    .describe('Override decomposition strategy. Omit to let the orchestrator decide.'),
}, async ({ task, strategy }) => { ... });
```

### Implementation Flow

1. Boot gossipcat (same lazy boot as other tools)
2. Call `TaskDispatcher.decompose(task)` — produces `DispatchPlan` with sub-tasks
3. If `strategy` override provided, replace the plan's strategy
4. Call `TaskDispatcher.assignAgents(plan)` — assigns agents by skill match
5. Call `TaskDispatcher.classifyWriteModes(plan)` — classifies each sub-task as read/write, suggests write mode + scope
6. Build response with human-readable summary + `PLAN_JSON` block

### Response Format

```
Plan: "fix the scope validation bug in packages/tools/"

Strategy: sequential

Tasks:
  1. [WRITE] sonnet-implementer → "Fix scope validation in enforceWriteScope"
     write_mode: scoped | scope: packages/tools/
  2. [READ] gemini-reviewer → "Verify the fix handles path traversal correctly"

---
PLAN_JSON:
{"strategy":"sequential","tasks":[{"agent_id":"sonnet-implementer","task":"Fix scope validation in enforceWriteScope","write_mode":"scoped","scope":"packages/tools/"},{"agent_id":"gemini-reviewer","task":"Verify the fix handles path traversal correctly"}]}
```

The `PLAN_JSON` block is a single-line JSON object that the caller LLM can extract and pass directly to `gossip_dispatch_parallel`. The `tasks` array matches the `gossip_dispatch_parallel` input schema exactly — each entry has `agent_id`, `task`, and optional `write_mode`/`scope`.

### Execution

The caller LLM:
1. Calls `gossip_plan(task)`
2. Shows the human-readable summary to the user
3. User approves, modifies, or rejects
4. If approved: caller extracts `PLAN_JSON`, calls `gossip_dispatch_parallel(tasks)`
5. Calls `gossip_collect()` to get results

`gossip_plan` never executes tasks. It only plans.

---

## Component 2: Write Classification in TaskDispatcher

### New Method

```typescript
async classifyWriteModes(plan: DispatchPlan): Promise<PlannedTask[]>
```

Iterates the plan's sub-tasks (which already have `assignedAgent` set by `assignAgents`), calls the LLM once with all sub-tasks in a single batch, and returns a `PlannedTask[]` with write classifications.

### LLM Prompt

```
Classify each sub-task as read-only or write. For write tasks, suggest a write mode and scope.

Sub-tasks:
1. [agent: sonnet-implementer] Fix scope validation in enforceWriteScope
2. [agent: gemini-reviewer] Verify the fix handles path traversal correctly

Rules:
- Tasks with action verbs (fix, implement, add, create, refactor, update, delete, write, build, migrate) → write
- Tasks with observation verbs (review, analyze, check, verify, list, explain, summarize, audit, trace) → read
- If the task mentions a specific directory or package path → write_mode: scoped, scope: that path
- If the task is broad with no clear directory boundary → write_mode: sequential
- If the task says "experiment", "try", "prototype", or "spike" → write_mode: worktree

Respond as JSON array:
[
  { "index": 1, "access": "write", "write_mode": "scoped", "scope": "packages/tools/" },
  { "index": 2, "access": "read" }
]
```

### Fallback

If the LLM returns invalid JSON or fails, fall back to marking all tasks as read-only. This preserves backward compatibility — a failed classification never blocks dispatch.

### New Type

```typescript
/** A planned task with write-mode classification */
export interface PlannedTask {
  agentId: string;
  task: string;
  access: 'read' | 'write';
  writeMode?: 'sequential' | 'scoped' | 'worktree';
  scope?: string;
}
```

---

## Component 3: Tool Description Updates

### `gossip_dispatch`

Current:
```
Send a task to a specific agent. Returns task ID for collecting results.
```

Updated:
```
Send a task to a specific agent. Returns task ID for collecting results. For implementation tasks that modify files, use gossip_plan first to get a write-mode-aware dispatch plan, or pass write_mode explicitly. Without write_mode, agents can only read files.
```

### `gossip_dispatch_parallel`

Current:
```
Fan out tasks to multiple agents simultaneously.
```

Updated:
```
Fan out tasks to multiple agents simultaneously. For tasks involving file modifications, use gossip_plan first to get a pre-built task array with write modes, then pass it here. The PLAN_JSON output from gossip_plan is directly passable as the tasks parameter.
```

### `gossip_tools`

Add entry:
```typescript
{ name: 'gossip_plan', desc: 'Plan a task with write-mode suggestions. Returns dispatch-ready JSON for approval before execution.' }
```

---

## Component 4: Bootstrap Prompt Update

Add the following section to the template in `BootstrapGenerator.generate()`, after the existing dispatch rules section:

```markdown
## Write Modes

Agents can modify files when dispatched with a write mode:
- `sequential` — one write task at a time (safe default for implementation)
- `scoped` — parallel writes locked to non-overlapping directories
- `worktree` — fully isolated git branch per task

**Workflow for implementation tasks:**
1. Call `gossip_plan(task)` to get a decomposed plan with write-mode suggestions
2. Review the plan — adjust write modes or agents if needed
3. Call `gossip_dispatch_parallel` with the plan's task array to execute

For read-only tasks (reviews, analysis), use `gossip_dispatch` or `gossip_orchestrate` directly — no write mode needed.
```

---

## Files Changed

| File | Action | Change |
|------|--------|--------|
| `packages/orchestrator/src/types.ts` | **Edit** | Add `PlannedTask` interface |
| `packages/orchestrator/src/task-dispatcher.ts` | **Edit** | Add `classifyWriteModes(plan)` method |
| `packages/orchestrator/src/index.ts` | **Edit** | Export `PlannedTask` type |
| `packages/orchestrator/src/bootstrap.ts` | **Edit** | Add write modes section to generated bootstrap prompt |
| `apps/cli/src/mcp-server-sdk.ts` | **Edit** | Add `gossip_plan` tool, update `gossip_dispatch`/`gossip_dispatch_parallel`/`gossip_tools` descriptions |
| `tests/orchestrator/task-dispatcher.test.ts` | **Edit** | Tests for `classifyWriteModes` |

**Not changed:**
- `dispatch-pipeline.ts` — plan is consumed by existing dispatch tools
- `main-agent.ts` — `gossip_orchestrate` stays read-only
- `tool-server.ts` — no changes

---

## Testing Strategy

- **classifyWriteModes:** Unit test with mocked LLM — verify write classification for known task patterns (fix → write/scoped, review → read, experiment → write/worktree)
- **classifyWriteModes fallback:** Test that invalid LLM response falls back to all-read
- **gossip_plan MCP tool:** Integration test — verify response contains both human-readable summary and valid PLAN_JSON
- **PLAN_JSON schema:** Verify the tasks array matches `gossip_dispatch_parallel` input schema
- **Tool descriptions:** Manual verification — check updated descriptions mention gossip_plan

---

## Security Constraints

- `gossip_plan` is read-only — it never dispatches tasks or modifies files
- Write classification is a suggestion — the user must approve before execution
- Invalid LLM classification falls back to read-only (fail-safe, not fail-open)
- The PLAN_JSON is a convenience format — the caller can always construct dispatch params manually
