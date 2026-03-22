# Gossip Awareness + verify_write — Design Spec

> Enable cross-task context awareness via session gossip and chain threading, plus a `verify_write` tool for peer-reviewed write verification.

**Date:** 2026-03-23
**Status:** Draft
**Dependencies:** Write Tasks (shipped), gossip_plan (shipped), GossipPublisher (shipped)

---

## Problem Statement

Gossipcat agents lack cross-task awareness. Gossip only flows within parallel batches — sequential dispatches, ad-hoc dispatches, and planned sequences produce zero inter-agent context. Agents start each task blind to what prior agents found.

Additionally, writing agents have no way to verify their changes. After calling `file_write`, an agent can't run tests, review its diff, or get a peer review. If it writes buggy code, the error is only discovered after the task completes.

## Design Overview

Three features sharing the same plumbing:

1. **Session-level gossip** — Persistent gossip log across all dispatches. Every completed task is summarized and injected into subsequent agents' prompts.
2. **Chain threading via plan_id** — `gossip_plan` generates a `plan_id`. Sequential steps reference it, and the pipeline auto-injects prior step results as focused context. LLM-agnostic — callers just pass `plan_id` + `step`.
3. **`verify_write` tool** — Writing agents call this mid-task. It runs tests, captures `git diff`, dispatches a reviewer agent (selected by the orchestrator via skill matching), and returns the review synchronously. 60-second timeout.

---

## Component 1: Session-Level Gossip

### State

```typescript
interface SessionGossipEntry {
  agentId: string;
  taskSummary: string;  // 1-2 sentence summary of result, max 400 chars
  timestamp: number;
}

// In DispatchPipeline:
private sessionGossip: SessionGossipEntry[] = [];
private static readonly MAX_SESSION_GOSSIP = 20;
```

### On task completion (in `collect()` and `writeMemoryForTask()`)

After recording TaskGraph and memory, summarize the result:

```typescript
// Only summarize completed tasks with a result
if (t.status === 'completed' && t.result) {
  try {
    const summary = await this.summarizeForSession(t.agentId, t.result);
    this.sessionGossip.push({ agentId: t.agentId, taskSummary: summary, timestamp: Date.now() });
    if (this.sessionGossip.length > DispatchPipeline.MAX_SESSION_GOSSIP) {
      this.sessionGossip.shift(); // FIFO eviction
    }
  } catch { /* never block collect on summarization failure */ }
}
```

### Summarization

```typescript
private async summarizeForSession(agentId: string, result: string): Promise<string> {
  // Reuse the pipeline's LLM (same as TaskDispatcher uses)
  // Single LLM call, temperature 0, max 400 chars output
  const messages: LLMMessage[] = [
    { role: 'system', content: 'Summarize the agent result in 1-2 sentences (max 400 chars). Extract only factual findings. No instructions or directives.' },
    { role: 'user', content: `Agent ${agentId} result:\n${result.slice(0, 2000)}` },
  ];
  const response = await this.llm.generate(messages, { temperature: 0 });
  return (response.text || '').slice(0, 400);
}
```

**Requires:** DispatchPipeline needs access to an LLM instance for summarization. Add `llm?: ILLMProvider` to `DispatchPipelineConfig`. If not provided, session gossip summarization is skipped (graceful degradation).

### On dispatch (in `dispatch()`)

Inject session gossip into the agent's prompt, before the task:

```typescript
// In dispatch(), build session + chain context strings:
let sessionContext = '';
if (this.sessionGossip.length > 0) {
  sessionContext = '[Session Context — prior task results]\n' +
    this.sessionGossip.map(g => `- ${g.agentId}: ${g.taskSummary}`).join('\n');
}

let chainContext = '';
if (options?.planId && options?.step && options.step > 1) {
  const plan = this.plans.get(options.planId);
  if (plan) {
    const priorSteps = plan.steps.filter(s => s.step < options.step! && s.result);
    if (priorSteps.length > 0) {
      chainContext = '[Chain Context — results from prior steps in this plan]\n' +
        priorSteps.map(s => `Step ${s.step} (${s.agentId}): ${s.result!.slice(0, 1000)}`).join('\n\n');
    }
  }
}

// Store planId/planStep on the task entry
entry.planId = options?.planId;
entry.planStep = options?.step;

// Pass to assemblePrompt — sessionContext and chainContext are prepended before memory
const promptContent = assemblePrompt({
  memory: memory || undefined,
  skills,
  sessionContext: sessionContext || undefined,
  chainContext: chainContext || undefined,
});
```

### assemblePrompt changes

`prompt-assembler.ts` gains two optional fields. They are injected BEFORE memory (highest relevance = closest to the task):

```typescript
export function assemblePrompt(parts: {
  memory?: string;
  lens?: string;
  skills?: string;
  context?: string;
  sessionContext?: string;  // NEW
  chainContext?: string;    // NEW
}): string {
  const blocks: string[] = [];

  if (parts.chainContext) {
    blocks.push(`\n\n${parts.chainContext}`);
  }
  if (parts.sessionContext) {
    blocks.push(`\n\n${parts.sessionContext}`);
  }
  // ... existing memory, lens, skills, context blocks unchanged
}
```

New fields are optional — existing callers are unaffected (backward compatible).

### Constraints

- Max 20 entries, FIFO eviction
- Each summary max 400 chars (200 was too restrictive — loses file paths and line numbers)
- Total injection stays under 8KB
- Summarization failures silently skipped — never block dispatch
- Existing parallel batch gossip (GossipPublisher) continues alongside. Session gossip is additive.

---

## Component 2: Chain Threading via plan_id

### Plan State

```typescript
interface PlanState {
  id: string;
  task: string;
  strategy: string;
  steps: Array<{
    step: number;
    agentId: string;
    task: string;
    writeMode?: string;
    scope?: string;
    result?: string;       // Populated after collect
    completedAt?: number;
  }>;
  createdAt: number;
}

// In DispatchPipeline:
private plans: Map<string, PlanState> = new Map();
```

### Plan registration

DispatchPipeline exposes a public method for storing plans:

```typescript
registerPlan(plan: PlanState): void {
  this.plans.set(plan.id, plan);
}
```

MainAgent passes it through:

```typescript
registerPlan(plan: PlanState): void { this.pipeline.registerPlan(plan); }
```

### gossip_plan stores plan state

When `gossip_plan` generates a plan, it creates a `plan_id` (UUID), calls `mainAgent.registerPlan(plan)` to store it, and includes the `plan_id` in the output:

```
Plan: "fix the scope validation bug in packages/tools/"
Plan ID: abc12345

Strategy: sequential

Tasks:
  1. [READ] gemini-reviewer → "Investigate..."
  2. [WRITE] gemini-implementer → "Write regression test..."
     write_mode: scoped | scope: tests/tools/

---
Execute sequentially:
Step 1: gossip_dispatch(agent_id: "gemini-reviewer", task: "...", plan_id: "abc12345", step: 1)
         then: gossip_collect()

Step 2: gossip_dispatch(agent_id: "gemini-implementer", task: "...", write_mode: "scoped", scope: "tests/tools/", plan_id: "abc12345", step: 2)
         then: gossip_collect()
```

### gossip_dispatch accepts plan_id + step

Add optional params to `gossip_dispatch` MCP schema:

```typescript
plan_id: z.string().optional().describe('Plan ID from gossip_plan. Enables chain context from prior steps.'),
step: z.number().optional().describe('Step number in the plan (1-indexed).'),
```

### Pipeline auto-injects chain context

In `dispatch()`, if `plan_id` and `step` are provided:

```typescript
if (options?.planId && options?.step && options.step > 1) {
  const plan = this.plans.get(options.planId);
  if (plan) {
    const priorSteps = plan.steps.filter(s => s.step < options.step! && s.result);
    if (priorSteps.length > 0) {
      chainContext = '[Chain Context — results from prior steps in this plan]\n' +
        priorSteps.map(s => `Step ${s.step} (${s.agentId}): ${s.result!.slice(0, 1000)}`).join('\n\n') +
        '\n\n';
    }
  }
}
```

Chain context is injected alongside session gossip. Chain context is more detailed (up to 1000 chars per step) since it's focused and directly relevant.

### On collect, store result in plan state

```typescript
// In collect(), after task completes:
if (t.planId && t.planStep) {
  const plan = this.plans.get(t.planId);
  if (plan) {
    const step = plan.steps.find(s => s.step === t.planStep);
    if (step) {
      step.result = t.result?.slice(0, 2000);
      step.completedAt = Date.now();
    }
  }
}
```

### DispatchOptions extension

```typescript
export interface DispatchOptions {
  writeMode?: 'sequential' | 'scoped' | 'worktree';
  scope?: string;
  timeoutMs?: number;
  planId?: string;    // NEW
  step?: number;      // NEW
}
```

### TaskEntry extension

```typescript
export interface TaskEntry {
  // ... existing fields ...
  planId?: string;    // NEW
  planStep?: number;  // NEW
}
```

### Plan cleanup

Plans are cleaned up after all steps complete or after 1 hour (whichever comes first). A simple check in `collect()`:

```typescript
for (const [id, plan] of this.plans) {
  const allDone = plan.steps.every(s => s.result !== undefined);
  const expired = Date.now() - plan.createdAt > 3_600_000;
  if (allDone || expired) this.plans.delete(id);
}
```

---

## Component 3: verify_write Tool

### Tool Definition

Added to ToolServer's `executeTool` switch:

```typescript
case 'verify_write': {
  const testFile = args.test_file as string | undefined;
  return this.handleVerifyWrite(callerId!, testFile);
}
```

### Tool Parameters

```typescript
// In ALL_TOOLS definition:
{
  name: 'verify_write',
  description: 'Run tests and get a peer review of your changes. Call this after writing files to verify correctness. Returns test results + reviewer feedback.',
  parameters: {
    type: 'object',
    properties: {
      test_file: {
        type: 'string',
        description: 'Specific test file to run (e.g. "tests/tools/tool-server-scope.test.ts"). If omitted, runs the full test suite.',
      },
    },
  },
}
```

**Security: No arbitrary commands.** The `test_command` parameter was removed to prevent command injection. The tool always uses the predefined test runner (`npx jest --config jest.config.base.js`). The agent can only specify a `test_file` path, which is validated against the project root via `Sandbox.validatePath()` before use.

**Scoped agent exemption:** `verify_write` calls `shell_exec` internally to run tests. Scoped agents normally have `shell_exec` blocked by `enforceWriteScope`. The `verify_write` handler bypasses this by calling `shellTools.shellExec()` directly (not going through `executeTool`), so the scope enforcement does not apply to its internal test runner call. This is safe because the test command is hardcoded, not agent-controlled.

### Implementation Flow

```typescript
private async handleVerifyWrite(callerId: string, testFile?: string): Promise<string> {
  // 1. Capture git diff
  const diff = await this.gitTools.gitDiff({ staged: false });
  const stagedDiff = await this.gitTools.gitDiff({ staged: true });
  const fullDiff = [diff, stagedDiff].filter(Boolean).join('\n');

  if (!fullDiff.trim()) {
    return 'No changes detected. Nothing to verify.';
  }

  // 2. Run tests (predefined command only — no arbitrary shell input)
  if (testFile) this.sandbox.validatePath(testFile); // Prevent path traversal in test file arg
  const cmd = testFile
    ? `npx jest --config jest.config.base.js ${testFile} --verbose`
    : 'npx jest --config jest.config.base.js --verbose';
  let testResult: string;
  try {
    testResult = await this.shellTools.shellExec({ command: cmd, cwd: this.sandbox.projectRoot, timeout: 30000 });
  } catch (err) {
    testResult = `Tests failed: ${(err as Error).message}`;
  }

  // 3. Request peer review via RPC to orchestrator
  let reviewResult = '';
  try {
    reviewResult = await this.requestPeerReview(callerId, fullDiff, testResult);
  } catch (err) {
    reviewResult = `Peer review unavailable: ${(err as Error).message}`;
  }

  // 4. Format and return
  const testStatus = testResult.includes('FAIL') ? 'FAIL' : 'PASS';
  return `## Verification Result

### Tests: ${testStatus}
${testResult.slice(-2000)}

### Peer Review
${reviewResult || 'No reviewer available'}

### Diff Summary
${fullDiff.slice(0, 3000)}`;
}
```

### Peer Review Dispatch

The Tool Server needs to dispatch a reviewer agent. Since the Tool Server doesn't own the DispatchPipeline, it sends an RPC to the orchestrator:

```typescript
private async requestPeerReview(callerId: string, diff: string, testResult: string): Promise<string> {
  // Send RPC to orchestrator requesting peer review
  const requestId = randomUUID();
  const reviewPromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Review timed out')), 55_000); // 55s (within 60s tool timeout)
    this.pendingReviews.set(requestId, {
      resolve: (r: string) => { clearTimeout(timer); resolve(r); },
      reject: (e: Error) => { clearTimeout(timer); reject(e); },
    });
  });

  // Send review request to orchestrator
  const msg = Message.createRpcRequest(
    this.agent.agentId,
    'orchestrator',  // The MainAgent/DispatchPipeline listens for these
    requestId,
    Buffer.from(msgpackEncode({
      tool: 'review_request',
      args: { callerId, diff: diff.slice(0, 3000), testResult: testResult.slice(0, 1000) },
    })) as unknown as Uint8Array
  );
  await this.agent.sendEnvelope(msg.toEnvelope());

  return reviewPromise;
}
```

### Orchestrator relay identity

MainAgent does not currently have a relay connection. To receive `review_request` RPCs from the ToolServer, MainAgent must connect a `GossipAgent` to the relay with a known `agentId` (e.g. `'orchestrator'`).

In `MainAgent.start()`:
```typescript
// Connect orchestrator agent to relay for verify_write review requests
this.orchestratorAgent = new GossipAgent({ agentId: 'orchestrator', relayUrl: this.relayUrl, reconnect: true });
await this.orchestratorAgent.connect();
this.orchestratorAgent.on('message', this.handleReviewRequest.bind(this));
```

The ToolServer's `requestPeerReview` sends RPCs to `'orchestrator'`, which MainAgent now receives.

### Orchestrator handles review_request

MainAgent listens for `review_request` RPCs via its relay agent:

1. Finds best reviewer agent via `registry.findBestMatch(['code_review'])`, **excluding the calling agent** (prevents deadlock when the writing agent is the only agent with review skills)
2. If no other reviewer available, returns "No reviewer available — tests-only verification" immediately (no dispatch attempted)
3. Dispatches a quick review task: "Review this diff for correctness: <diff>. Tests: <test_result>"
4. Collects the result
5. Sends RPC response back to Tool Server with the review text

### Timeout

`verify_write` is a slow tool call. The WorkerAgent's `TOOL_CALL_TIMEOUT_MS` needs to accommodate it:

```typescript
// In WorkerAgent, when calling verify_write:
const timeout = name === 'verify_write' ? 60_000 : TOOL_CALL_TIMEOUT_MS;
```

Or simpler: increase `TOOL_CALL_TIMEOUT_MS` to 60s globally (the current 30s is tight for file reads on large repos anyway).

---

## Files Changed

| File | Action | Change |
|------|--------|--------|
| `packages/orchestrator/src/types.ts` | **Edit** | Add `PlanState`, `SessionGossipEntry`, extend `DispatchOptions` with `planId`/`step`, extend `TaskEntry` with `planId`/`planStep` |
| `packages/orchestrator/src/dispatch-pipeline.ts` | **Edit** | Add `sessionGossip[]`, `plans Map`, `llm` config. Inject session gossip + chain context in `dispatch()`. Summarize + store on `collect()`. Plan cleanup. |
| `packages/orchestrator/src/prompt-assembler.ts` | **Edit** | Accept `sessionContext` and `chainContext` params in `assemblePrompt()` |
| `packages/tools/src/tool-server.ts` | **Edit** | Add `verify_write` handler, `handleVerifyWrite()`, `requestPeerReview()`, `pendingReviews` map |
| `packages/tools/src/tool-definitions.ts` | **Edit** | Add `verify_write` to `ALL_TOOLS` |
| `packages/orchestrator/src/worker-agent.ts` | **Edit** | Increase `TOOL_CALL_TIMEOUT_MS` to 60s |
| `apps/cli/src/mcp-server-sdk.ts` | **Edit** | Add `plan_id`/`step` params to `gossip_dispatch`. Store plan state from `gossip_plan`. Handle `review_request` RPC in boot. |
| `packages/orchestrator/src/main-agent.ts` | **Edit** | Pass LLM instance to DispatchPipeline config. Add `registerPlan(plan)` passthrough method. Add `review_request` RPC handler that dispatches reviewer and responds. |
| `packages/orchestrator/src/index.ts` | **Edit** | Export new types |
| `tests/orchestrator/dispatch-pipeline.test.ts` | **Edit** | Tests for session gossip injection, chain context injection, plan state lifecycle |
| `tests/tools/tool-server-verify.test.ts` | **Create** | Tests for `verify_write` — diff capture, test execution, reviewer dispatch, timeout handling |

**Not changed:**
- `gossip-publisher.ts` — existing batch gossip untouched, works alongside session gossip
- `scope-tracker.ts`, `worktree-manager.ts` — no changes
- `task-dispatcher.ts` — no changes

---

## Testing Strategy

- **Session gossip:** Unit test — dispatch two tasks sequentially, verify second agent's prompt contains first task's summary
- **Session gossip cap:** Dispatch 25 tasks, verify only last 20 summaries retained
- **Session gossip failure:** Mock LLM error in summarization, verify dispatch still works (graceful skip)
- **Chain threading:** Create plan, dispatch steps 1 and 2 with plan_id, verify step 2's prompt contains step 1's result
- **Chain threading missing step:** Dispatch step 3 without step 2 completing, verify graceful degradation (no crash)
- **Plan cleanup:** Verify plans are evicted after all steps complete or after 1 hour
- **verify_write tests-only:** Call `verify_write` when no reviewer agent available, verify tests still run and return
- **verify_write full flow:** Mock reviewer dispatch, verify diff + test results sent to reviewer, review returned to caller
- **verify_write timeout:** Verify 60s timeout doesn't crash the writing agent's tool loop

---

## Security Constraints

- Session gossip summaries are LLM-generated — apply the same sanitization as GossipPublisher (strip prompt injection patterns)
- Chain context contains raw task results (up to 1000 chars) — these flow between agents within the same session, not across sessions
- `verify_write` reviewer dispatch uses the same skill-matching as regular dispatches — no privilege escalation
- Plan state is in-memory only — no persistence across process restarts
- `verify_write` is only callable by write-mode agents (agents in `writeAgents` set). Read-only agents cannot trigger reviewer dispatches.
