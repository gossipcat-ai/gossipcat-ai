# Agent Bootstrap + Live Gossip — Design Spec

> Agents load identity from `instructions.md` at boot, receive live gossip from sibling agents mid-task via relay channels, and the orchestrator can update agent instructions at runtime.

**Date:** 2026-03-21
**Status:** Draft
**Dependencies:** Agent Memory (shipped), Prompt Assembler (shipped), Relay channels (Phase 1)
**Inspired by:** Crab-language's mind context assembly — channel subscriptions, gossip memory, identity loading

---

## Problem Statement

Gossipcat agents start nearly blank on every task. Three gaps:

1. **No identity** — `instructions.md` is generated for each agent (role, personality, project rules) but never loaded during task execution. Agents get a generic "You are a skilled developer agent" prompt.

2. **No team awareness** — When multiple agents work the same batch (via `gossip_dispatch_parallel`), they operate in isolation. Agent 1 might find 3 bugs in server.ts, but Agent 2 discovers the same bugs independently — wasted tokens and duplicate findings.

3. **No instruction adaptation** — The orchestrator can't adjust an agent's behavior mid-session based on performance. If an agent hallucinates file paths, there's no way to tell it "double-check paths before citing them" without restarting.

## Design Overview

```
┌─────────────────────────────────────────────────────────────┐
│  BOOT TIME                                                  │
│                                                             │
│  WorkerAgent created → loads instructions.md once           │
│  Stored as instance field, reused for every executeTask()   │
│  Orchestrator can update via update_agent_instructions tool  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  DISPATCH TIME                                              │
│                                                             │
│  assemblePrompt({                                           │
│    instructions,  ← from WorkerAgent instance               │
│    memory,        ← from AgentMemoryReader                  │
│    lens,          ← from ATI Tier 2 (future)                │
│    skills,        ← from loadSkills                         │
│  })                                                         │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  MID-TASK (live gossip)                                     │
│                                                             │
│  Batch agents subscribe to channel "batch:<batchId>"        │
│  When sibling completes → orchestrator summarizes result    │
│  Summary tailored per remaining agent's role                │
│  Published to batch channel via relay CHANNEL message       │
│  Injected into running agent at next tool-call boundary     │
└─────────────────────────────────────────────────────────────┘
```

## Component 1: Instructions Loading at Boot

### WorkerAgent Changes

**File:** `packages/orchestrator/src/worker-agent.ts`

Add `instructions` as a constructor parameter stored as a mutable instance field:

```typescript
export class WorkerAgent {
  private instructions: string;

  constructor(
    private agentId: string,
    private llm: ILLMProvider,
    relayUrl: string,
    private tools: ToolDefinition[],
    instructions?: string,
  ) {
    this.instructions = instructions || 'You are a skilled developer agent. Complete the assigned task using the available tools. Be concise and focused.';
    // ... existing GossipAgent setup
  }

  /** Update instructions at runtime (orchestrator tool) */
  setInstructions(instructions: string): void {
    this.instructions = instructions;
  }

  /** Get current instructions (for serialization/inspection) */
  getInstructions(): string {
    return this.instructions;
  }
}
```

### Loading at Boot

**File:** `apps/cli/src/mcp-server-sdk.ts` — in `doBoot()`

When creating workers, read their `instructions.md`:

```typescript
for (const ac of agentConfigs) {
  const key = await keychain.getKey(ac.provider);
  const llm = m.createProvider(ac.provider, ac.model, key ?? undefined);

  // Load instructions.md for this agent
  const instructionsPath = join(process.cwd(), '.gossip', 'agents', ac.id, 'instructions.md');
  const instructions = existsSync(instructionsPath)
    ? readFileSync(instructionsPath, 'utf-8')
    : undefined;

  const worker = new m.WorkerAgent(ac.id, llm, relay.url, m.ALL_TOOLS, instructions);
  await worker.start();
  workers.set(ac.id, worker);
}
```

Read once at boot. Reused for every `executeTask()` call. No per-dispatch file read.

### System Prompt Assembly

In `executeTask()`, replace the hardcoded generic prompt with the loaded instructions:

```typescript
async executeTask(task: string, context?: string, skillsContent?: string): Promise<string> {
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: `${this.instructions}${skillsContent || ''}${context ? `\n\nContext:\n${context}` : ''}`,
    },
    { role: 'user', content: task },
  ];
  // ... tool loop unchanged
}
```

The `skillsContent` parameter now comes from `assemblePrompt()` which includes memory + lens + skills. Instructions are the base, everything else is appended.

### Token Cost

Instructions files are typically 500-800 tokens. This replaces the current ~50 token generic prompt. Net cost: ~450-750 extra tokens per dispatch. Pays for itself by:
- Preventing role confusion ("I'm a reviewer, not an implementer")
- Providing project rules (<300 lines, interface-first, etc.)
- Teaching tool availability and conventions

## Component 2: Prompt Assembler Update

**File:** `packages/orchestrator/src/prompt-assembler.ts`

The prompt assembler no longer needs an `instructions` field — instructions are the base system prompt in `WorkerAgent`, not part of the assembled content. The assembler handles everything that gets appended AFTER instructions.

Current order (unchanged):
```
--- MEMORY ---
{memory content}
--- END MEMORY ---

--- LENS ---
{lens content — ATI future}
--- END LENS ---

--- SKILLS ---
{skills content}
--- END SKILLS ---

{context if provided}
```

The final system prompt is:
```
{WorkerAgent.instructions}      ← identity, role, project rules
{assemblePrompt output}         ← memory + lens + skills + context
```

No changes needed to `assemblePrompt()` — it already handles the content that comes after instructions.

## Component 3: Live Gossip via Relay Channels

### Batch Channel Protocol

When `gossip_dispatch_parallel` dispatches N agents, it creates a batch channel:

```typescript
const batchId = randomUUID().slice(0, 8);
// Each worker subscribes to the batch channel
for (const worker of dispatchedWorkers) {
  worker.subscribeToBatch(batchId);
}
```

The batch channel name: `batch:<batchId>` (e.g., `batch:a1b2c3d4`).

### Gossip Message Format

When a sibling agent completes, the orchestrator publishes a CHANNEL message:

```typescript
interface GossipMessage {
  type: 'gossip';
  batchId: string;
  fromAgentId: string;       // who completed
  forAgentId: string;        // who this summary is tailored for
  summary: string;           // role-tailored summary (~100 tokens)
  timestamp: string;
}
```

### Gossip Flow

```
1. gossip_dispatch_parallel creates batch channel "batch:abc123"
2. All dispatched workers subscribe to "batch:abc123"
3. Workers start executeTask() — tool loops begin

4. Agent 1 (gemini-reviewer) completes:
   - MCP server detects completion (promise resolves)
   - BEFORE marking as collected, triggers gossip publisher

5. Gossip Publisher:
   - Reads Agent 1's result
   - Gets list of still-running siblings in this batch
   - Makes ONE cheap LLM call with structured output:
     "Summarize this result for each remaining agent, tailored to their role."
     Returns: { "gemini-tester": "...", "sonnet-debugger": "..." }
   - Publishes tailored CHANNEL messages to "batch:abc123"

6. Still-running agents receive the CHANNEL message via relay listener
7. Message is queued for injection at next tool-call boundary

8. At the boundary (between tool call response and next LLM turn):
   - Check gossip queue
   - If messages pending, append as a user message:
     "[Team Update] gemini-reviewer completed: <tailored summary>"
   - Continue tool loop with enriched context
```

### WorkerAgent Gossip Listener

**File:** `packages/orchestrator/src/worker-agent.ts`

Add a gossip queue and channel subscription:

```typescript
export class WorkerAgent {
  private gossipQueue: string[] = [];

  /** Subscribe to a batch channel for live gossip */
  async subscribeToBatch(batchId: string): Promise<void> {
    await this.agent.subscribe(`batch:${batchId}`).catch(err =>
      console.error(`[${this.agentId}] Failed to subscribe to batch:${batchId}: ${err.message}`)
    );
  }

  /** Unsubscribe from batch channel (called after task completes) */
  async unsubscribeFromBatch(batchId: string): Promise<void> {
    await this.agent.unsubscribe(`batch:${batchId}`).catch(() => {});
  }
}
```

In the existing `handleMessage` method, add gossip detection:

```typescript
private handleMessage(data: unknown, envelope: MessageEnvelope): void {
  // Existing RPC_RESPONSE handling...

  // NEW: Handle CHANNEL messages (gossip)
  if (envelope.t === MessageType.CHANNEL) {
    const payload = data as Record<string, unknown>;
    if (payload?.type === 'gossip' && payload?.forAgentId === this.agentId) {
      this.gossipQueue.push(payload.summary as string);
    }
  }
}
```

### Gossip Injection in Tool Loop

In `executeTask()`, check for gossip messages between tool calls:

```typescript
for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
  // Inject any pending gossip before the next LLM turn
  while (this.gossipQueue.length > 0) {
    const gossip = this.gossipQueue.shift()!;
    messages.push({
      role: 'user',
      content: `[Team Update] ${gossip}`,
    });
  }

  const response = await this.llm.generate(messages, { tools: this.tools });
  // ... rest of tool loop unchanged
}
```

Gossip is injected as a `user` message (not `system`) so the LLM sees it as new information arriving during the conversation, not a change to its instructions.

### Token Cost

Per gossip message: ~100 tokens (orchestrator-summarized, role-tailored).
Per batch with 3 agents where 1 completes first: 2 gossip messages × ~100 tokens = ~200 tokens total.
LLM call for summarization: ~500 tokens in (result), ~200 tokens out (2 tailored summaries) = ~$0.0001.

Negligible.

## Component 4: Gossip Publisher

**File:** `packages/orchestrator/src/gossip-publisher.ts`

The gossip publisher sits in the MCP server and is triggered when a batch task completes.

### Interface

```typescript
export class GossipPublisher {
  constructor(
    private llm: ILLMProvider,        // cheap model for summarization
    private relay: GossipAgent,       // to publish CHANNEL messages
  );

  /**
   * Publish gossip for a completed task's batch siblings.
   * Makes one LLM call to produce tailored summaries per remaining agent.
   */
  async publishGossip(params: {
    batchId: string;
    completedAgentId: string;
    completedResult: string;
    remainingSiblings: Array<{ agentId: string; preset: string; skills: string[] }>;
  }): Promise<void>;
}
```

### Summarization Prompt

One LLM call produces all tailored summaries:

```
A team member just completed their task. Summarize their findings
for each remaining team member, tailored to their role.

Completed agent: {completedAgentId} ({preset})
Their result: {completedResult (truncated to 2000 chars)}

Remaining team members:
{for each: agentId, preset, skills}

For each remaining agent, write a 1-2 sentence summary that:
- Highlights findings relevant to their role
- Suggests what they should focus on (avoid duplicating work)
- Is actionable, not just informational

Return JSON: { "<agentId>": "<summary>", ... }
```

### Integration with MCP Server

In `gossip_dispatch_parallel`, when a task's promise resolves:

```typescript
entry.promise = worker.executeTask(task, undefined, promptContent)
  .then(async (result: string) => {
    entry.status = 'completed';
    entry.result = result;
    entry.completedAt = Date.now();

    // Publish gossip to still-running batch siblings
    if (batchId && gossipPublisher) {
      const remaining = getBatchSiblings(batchId, entry.agentId);
      if (remaining.length > 0) {
        gossipPublisher.publishGossip({
          batchId,
          completedAgentId: entry.agentId,
          completedResult: result,
          remainingSiblings: remaining,
        }).catch(err => process.stderr.write(`[gossipcat] Gossip error: ${err.message}\n`));
      }
    }
  })
```

### Batch Tracking

The MCP server needs to track which tasks belong to which batch:

```typescript
const batches = new Map<string, Set<string>>(); // batchId → Set<taskId>

// In gossip_dispatch_parallel:
const batchId = randomUUID().slice(0, 8);
batches.set(batchId, new Set(taskIds));

// Helper to find still-running siblings:
function getBatchSiblings(batchId: string, excludeAgentId: string): AgentConfig[] {
  const batch = batches.get(batchId);
  if (!batch) return [];
  return Array.from(batch)
    .map(tid => tasks.get(tid))
    .filter(t => t && t.status === 'running' && t.agentId !== excludeAgentId)
    .map(t => agentConfigs.find(ac => ac.id === t.agentId))
    .filter(Boolean);
}
```

## Component 5: Orchestrator Tool — update_agent_instructions

### Tool Definition

**File:** `packages/tools/src/definitions.ts`

```typescript
export const ORCHESTRATOR_TOOLS: ToolDefinition[] = [
  {
    name: 'update_agent_instructions',
    description: 'Update a worker agent\'s instructions for subsequent tasks. Use when an agent needs adjusted guidance based on performance or role change.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to update' },
        instruction_update: { type: 'string', description: 'New instructions content' },
        mode: { type: 'string', description: '"append" to add to existing, "replace" to overwrite' },
      },
      required: ['agent_id', 'instruction_update', 'mode'],
    },
  },
];
```

### Tool Execution

**File:** `packages/tools/src/tool-server.ts`

This tool is special — it doesn't execute on the ToolServer (which handles file/shell/git). It executes on the MCP server where workers are accessible.

**File:** `apps/cli/src/mcp-server-sdk.ts`

Register as an MCP tool:

```typescript
server.tool(
  'gossip_update_instructions',
  'Update a worker agent\'s instructions for subsequent tasks',
  {
    agent_id: z.string(),
    instruction_update: z.string(),
    mode: z.enum(['append', 'replace']),
  },
  async ({ agent_id, instruction_update, mode }) => {
    await boot();
    const worker = workers.get(agent_id);
    if (!worker) {
      return { content: [{ type: 'text' as const, text: `Agent "${agent_id}" not found.` }] };
    }

    if (mode === 'replace') {
      worker.setInstructions(instruction_update);
    } else {
      worker.setInstructions(worker.getInstructions() + '\n\n' + instruction_update);
    }

    // Optionally persist to instructions.md
    const instructionsPath = join(process.cwd(), '.gossip', 'agents', agent_id, 'instructions.md');
    writeFileSync(instructionsPath, worker.getInstructions());

    return { content: [{ type: 'text' as const, text: `Updated instructions for ${agent_id} (${mode}).` }] };
  }
);
```

This is an **MCP tool** (callable by Claude Code orchestrator), not a ToolServer tool (callable by worker agents). Workers shouldn't be able to modify their own instructions — that's the orchestrator's job.

## Component 6: Cleanup — Batch Channel Lifecycle

When all tasks in a batch complete (or batch is collected):

```typescript
// In gossip_collect, after processing all targets:
for (const [batchId, taskIdSet] of batches) {
  const allDone = Array.from(taskIdSet).every(tid => {
    const t = tasks.get(tid);
    return !t || t.status !== 'running';
  });
  if (allDone) {
    // Unsubscribe all workers from this batch channel
    for (const tid of taskIdSet) {
      const t = tasks.get(tid);
      if (t) {
        const worker = workers.get(t.agentId);
        if (worker) worker.unsubscribeFromBatch(batchId);
      }
    }
    batches.delete(batchId);
  }
}
```

## Files Changed/Created

| File | Action | Component |
|------|--------|-----------|
| `packages/orchestrator/src/worker-agent.ts` | Edit | Accept instructions at constructor, `setInstructions()`, gossip queue, channel subscription, mid-task injection |
| `packages/orchestrator/src/gossip-publisher.ts` | Create | Summarize completed results, tailored per sibling role, publish to batch channel |
| `packages/orchestrator/src/prompt-assembler.ts` | No change | Instructions are base prompt in WorkerAgent, not in assembler |
| `apps/cli/src/mcp-server-sdk.ts` | Edit | Load instructions at boot, batch tracking, gossip publisher trigger, `gossip_update_instructions` MCP tool, batch cleanup |
| `packages/orchestrator/src/types.ts` | Edit | Add GossipMessage type |
| `packages/orchestrator/src/index.ts` | Edit | Export GossipPublisher |
| `tests/orchestrator/worker-agent.test.ts` | Edit | Test instructions loading, gossip queue, setInstructions |
| `tests/orchestrator/gossip-publisher.test.ts` | Create | Test summarization, tailored output, channel publishing |

## Security Constraints

- **Workers can't modify their own instructions** — `update_agent_instructions` is an MCP tool, not a ToolServer tool. Only the orchestrator (Claude Code) can call it.
- **Gossip is read-only for workers** — workers receive CHANNEL messages but can't publish to batch channels. Only the orchestrator (via GossipPublisher) publishes.
- **Instructions persist to disk** — `update_agent_instructions` writes to `instructions.md` so changes survive MCP restart.
- **Gossip summaries are ephemeral** — not persisted. They exist only in the running agent's message history for the current task.
- **Batch channels are scoped** — channel name includes a unique batchId. Workers only see gossip from their current batch.

## Reviewer Fixes (from 2-agent review + self-review)

### Fix 1: subscribeToBatch/unsubscribeFromBatch must be async

GossipAgent's `subscribe()` and `unsubscribe()` return `Promise<void>`. The wrapper methods must be async with error handling. **Fixed above in Component 3.**

### Fix 2: GossipPublisher uses existing relay connection

The `GossipPublisher` does NOT create its own relay connection. It receives a `GossipAgent` instance (the MCP server's own agent or the MainAgent's agent) and publishes CHANNEL messages through it. No new connections.

```typescript
export class GossipPublisher {
  constructor(
    private llm: ILLMProvider,
    private relayAgent: GossipAgent,  // existing connection, not new
  );
}
```

### Fix 3: suggest_skill prompt text migration

Currently the `suggest_skill` teaching text is hardcoded in `executeTask()`'s system prompt (lines 51-59). When `this.instructions` becomes the base prompt, this text should either:
- Be moved into the `instructions.md` template (generated by `create-agent.ts`) — preferred, keeps `executeTask` clean
- Or remain appended after `this.instructions` in `executeTask`

Recommendation: move to instructions template. Update `create-agent.ts` to include the suggest_skill teaching in all generated instructions files.

### Fix 4: agentConfigs accessible to getBatchSiblings

The MCP server's `workers` Map stores `WorkerAgent` instances but `getBatchSiblings` needs agent configs with `preset` and `skills`. Store `agentConfigs` at boot time as a module-level array (same scope as `workers` Map):

```typescript
let agentConfigsCache: AgentConfig[] = [];

// In doBoot():
agentConfigsCache = agentConfigs;

// In getBatchSiblings():
.map(t => agentConfigsCache.find(ac => ac.id === t.agentId))
```

### Fix 5: Batch cleanup uses async unsubscribe

```typescript
// Cleanup must await all unsubscriptions:
if (allDone) {
  const unsubPromises: Promise<void>[] = [];
  for (const tid of taskIdSet) {
    const t = tasks.get(tid);
    if (t) {
      const worker = workers.get(t.agentId);
      if (worker) unsubPromises.push(worker.unsubscribeFromBatch(batchId));
    }
  }
  await Promise.all(unsubPromises);
  batches.delete(batchId);
}
```

### Fix 6: Race condition acknowledgment

When 2 agents complete simultaneously, both trigger gossip publishing. The gossip summaries are generated in parallel with non-deterministic ordering. This is acceptable — each gossip message is self-contained (references the completing agent by name). If an agent receives 2 gossip messages, it sees both as sequential `[Team Update]` messages. No data corruption, just non-deterministic order.

## Testing Strategy

- **Instructions loading:** Unit test — create WorkerAgent with instructions, verify system prompt includes them
- **setInstructions:** Unit test — update instructions, verify next executeTask uses new text
- **Gossip queue:** Unit test — push gossip messages, verify they're injected between tool calls
- **GossipPublisher:** Unit test with mocked LLM — verify tailored summaries per agent role
- **Batch tracking:** Unit test — create batch, complete one task, verify siblings identified correctly
- **Channel subscription:** Integration test — subscribe to batch channel, publish message, verify receipt
- **MCP update_agent_instructions:** Unit test — call tool, verify worker instructions changed and persisted to file
- **End-to-end:** Dispatch 2 agents in parallel → first completes → verify second receives gossip → verify gossip appears in second agent's messages
