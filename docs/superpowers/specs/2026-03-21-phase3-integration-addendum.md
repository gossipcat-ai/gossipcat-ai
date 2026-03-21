# Phase 3 Integration Addendum

> Resolves conflicts, gaps, and ordering issues between the three Phase 3 specs: CLI Image Support, Adaptive Team Intelligence, and Agent Memory.

**Date:** 2026-03-21
**Status:** Draft
**Found by:** 3-agent cross-spec review (gemini-reviewer, gemini-researcher, sonnet)

---

## Resolution 1: Prompt Assembly Order (Blocking)

**Problem:** Memory, Lens, and Skills all get injected into the worker's system prompt via the `skillsContent` parameter. If each spec independently wraps content in delimiters, the result has duplicate `--- SKILLS ---` markers and is malformed.

**Resolution:** Define a single prompt assembly order. The MCP server builds the final prompt string, not individual components:

```
{base system prompt — "You are a skilled developer agent..."}

--- MEMORY ---
{MEMORY.md index + relevant knowledge files + calibration}
--- END MEMORY ---

--- LENS ---
{lens focus directive — only when co-dispatched with overlapping agents}
--- END LENS ---

--- SKILLS ---
{skill content from loadSkills}
--- END SKILLS ---

{context if provided}
```

**Implementation:** Create `packages/orchestrator/src/prompt-assembler.ts` — a single function that takes memory, lens, skills, and context as separate strings and produces the final `skillsContent` parameter. All three specs feed into this assembler rather than independently mutating the string.

```typescript
export function assemblePrompt(parts: {
  memory?: string;    // from agent-memory.ts
  lens?: string;      // from lens-generator.ts (ATI Tier 2)
  skills?: string;    // from loadSkills
  context?: string;   // from dispatch caller
}): string;
```

**Who calls it:** `mcp-server-sdk.ts` dispatch handlers — after loading all parts, before calling `worker.executeTask()`.

---

## Resolution 2: Collect Pipeline Order (Blocking)

**Problem:** `gossip_collect` has a growing post-processing pipeline. Memory's `writeAgentMemory` depends on ATI's `AgentScore` output, but ATI fires scoring as void fire-and-forget. The dependency chain is broken.

**Resolution:** Define the collect post-processing as an explicit async pipeline with chained promises:

```typescript
// After gossip_collect returns results to the MCP client:

async function postCollectPipeline(targets: TaskEntry[]): Promise<void> {
  // Step 1: Surface skill gap warnings (already shipped)
  const gapTracker = new SkillGapTracker(process.cwd());
  for (const t of targets) {
    surfaceSkillSuggestions(t, gapTracker);
  }
  const skeletonMessages = gapTracker.checkAndGenerate();

  // Step 2: Score agent outputs (ATI Tier 3 — returns scores, not fire-and-forget)
  const scores = await scoreAgentOutputs(targets);  // returns Map<agentId, AgentScore>

  // Step 3: Write agent memories (depends on scores from Step 2)
  for (const t of targets) {
    const score = scores.get(t.agentId);
    if (score) {
      await writeAgentMemory(t.agentId, t.task, t.result, score);
    }
  }
}

// Called as fire-and-forget from collect handler:
postCollectPipeline(targets).catch(err =>
  process.stderr.write(`[gossipcat] Post-collect pipeline error: ${err.message}\n`)
);
```

**Key change to ATI spec:** `scoreAgentOutputs` returns `Promise<Map<string, AgentScore>>`, not void. The entire pipeline is fire-and-forget (non-blocking to the collect response), but WITHIN the pipeline, steps are chained.

---

## Resolution 3: Dispatch Handler Structure (Blocking)

**Problem:** ATI requires a two-pass rewrite of `dispatch_parallel` for lens generation. Memory spec assumes the existing single-loop structure for memory injection.

**Resolution:** Define the final `dispatch_parallel` structure as three passes:

```typescript
// Pass 1: Load all agent configs, skills, and memories
const agentData = new Map<string, { skills: string; memory: string; config: AgentConfig }>();
for (const def of taskDefs) {
  const skills = loadSkills(def.agent_id, projectRoot);
  const memory = loadAgentMemory(def.agent_id, projectRoot, def.task);
  const config = allAgentConfigs.find(a => a.id === def.agent_id);
  agentData.set(def.agent_id, { skills, memory, config });
}

// Pass 2: Generate lenses for co-dispatched agents with overlapping skills (ATI Tier 2)
const lenses = await generateLenses(agentData, taskDefs);

// Pass 3: Assemble prompts and dispatch
for (const def of taskDefs) {
  const { skills, memory } = agentData.get(def.agent_id)!;
  const lens = lenses.get(def.agent_id);
  const promptContent = assemblePrompt({ memory, lens, skills });
  // dispatch with promptContent...
}
```

**For single `gossip_dispatch`:** Pass 2 (lens generation) is skipped. Only memory + skills loaded and assembled.

---

## Resolution 4: Field Name Normalization (Medium)

**Problem:** ATI's `AgentScore` uses `scores: { relevance, accuracy, uniqueness }` (plural). Memory's `TaskMemoryEntry` uses `score: { relevance, accuracy, uniqueness }` (singular).

**Resolution:** Normalize to `scores` (plural) everywhere — it's a composite object containing multiple scores.

- ATI: `AgentScore.scores` — no change
- Memory: `TaskMemoryEntry.scores` — rename from `score` to `scores`

---

## Resolution 5: Multimodal Content in Memory (Medium)

**Problem:** Image spec adds `ContentBlock[]` to messages. Memory writer must handle this when extracting knowledge from task results.

**Resolution:** The memory writer's knowledge extraction LLM call receives `result: string` (the worker's text response), not the original `ContentBlock[]` input. The image was seen by the main agent, not the worker. If the main agent's response references an image, the knowledge extraction treats it as text ("the user shared a screenshot of the relay server logs").

No base64 data ever enters memory files. The image is ephemeral — seen once by the main LLM, then replaced by a text placeholder in conversation history (per image spec, Component "Conversation History").

---

## Resolution 6: Calibration Data — Single Source (Medium)

**Problem:** ATI writes performance scores to `.gossip/agent-performance.jsonl`. Memory reads them for `calibration/accuracy.md`. Same data, two locations.

**Resolution:** ATI's `agent-performance.jsonl` is the single source of truth for scoring data. The memory writer reads FROM the performance JSONL when updating calibration — it does not maintain a separate scoring system.

```
ATI scoring → writes to agent-performance.jsonl
                     ↓
Memory writer → reads agent-performance.jsonl
                     ↓
                writes calibration/accuracy.md (human-readable summary)
```

`calibration/accuracy.md` is a derived view — if deleted, it regenerates from the performance JSONL on next dispatch.

---

## Resolution 7: LLM Call Optimization (Low)

**Problem:** Per task completion: scoring (ATI) + knowledge extraction (Memory) = 2 cheap LLM calls. Plus occasional lens generation (ATI) at dispatch. Adds up.

**Resolution:** Combine scoring and knowledge extraction into a single LLM call:

```
Score this agent's output AND extract any project knowledge worth remembering.

Task: {task}
Agent: {agentId}
Output: {result}

Return JSON:
{
  "scores": { "relevance": 1-5, "accuracy": 1-5, "uniqueness": 1-5 },
  "knowledge": { "update": "filename", "content": "..." } | { "none": true }
}
```

One call instead of two. Same cost as ATI-only scoring. Knowledge extraction is free.

---

## Resolution 8: `gossip_dispatch` Asymmetry (Low)

**Problem:** Single dispatch needs memory injection but not lens injection. This asymmetry is undocumented.

**Resolution:** Documented here:

| Handler | Memory | Lens | Skill Catalog Check |
|---------|--------|------|-------------------|
| `gossip_dispatch` | Yes | No (single agent, no overlap) | Yes |
| `gossip_dispatch_parallel` | Yes | Yes (if overlap detected) | Yes |
| `gossip_orchestrate` | Via MainAgent | Via MainAgent | Via TaskDispatcher |

---

## New Shared File

All three specs should share a prompt assembler:

| File | Action | Purpose |
|------|--------|---------|
| `packages/orchestrator/src/prompt-assembler.ts` | Create | Single function assembling memory + lens + skills + context into final prompt string |

This file is referenced by all three specs and owned by none — it's the integration layer.

---

## Implementation Order

Given these dependencies, the implementation order is:

```
1. CLI Image Support (independent — no conflicts with other specs)
2. prompt-assembler.ts (shared dependency — create before ATI or Memory)
3. Agent Memory (needs prompt-assembler, no ATI dependency for basic read/write)
4. Adaptive Team Intelligence (needs prompt-assembler + Agent Memory for calibration)
```

CLI Image Support can be implemented NOW. The other two need prompt-assembler first, then Memory before ATI.
