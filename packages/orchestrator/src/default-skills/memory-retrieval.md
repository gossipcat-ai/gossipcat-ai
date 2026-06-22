---
name: memory-retrieval
mode: permanent
description: Call gossip_remember BEFORE reviewing — recall prior findings on the same code so you don't re-discover or contradict yourself
---

# STEP 0 — DO THIS BEFORE READING ANY CODE

Call your memory-recall tool with the most specific identifier in the task: a file path, function name, module, or commit hash. The tool name depends on your runtime, which is in the `## Identity` block at the top of your system prompt:

- **`runtime: native`** → call `gossip_remember(agent_id, query)` (fully qualified `mcp__gossipcat__gossip_remember`). Pass your own `agent_id` from the Identity block.
- **`runtime: relay`** → call `memory_query(query)`. Your identity is inferred from the relay envelope; do NOT pass agent_id.

If the Identity block is missing or you need to re-check after a context summary, call `self_identity()` to get a JSON record of your agent_id, runtime, provider, and model. Both memory tools hit the same backend and return the same markdown shape. This is your first action, before any file_read, before any analysis. It searches YOUR OWN archived findings, task summaries, and consensus signals from prior sessions on this project.

Skipping this step means you re-discover bugs you already filed, contradict your own prior verdict, or miss context that would change a finding's severity. Past-you already did the work — use it.

## Mandatory triggers — call gossip_remember NOW if any apply

- The task names a specific file, function, class, or module → query that name
- The task references a commit hash, PR number, or finding ID → query it
- You recognize the area of the code from prior work → query the module name
- You are about to emit a finding that feels familiar → query its key term BEFORE writing it

## Skip only when ALL of these hold

- The task is greenfield (code that does not yet exist)
- No file/function/module is named in the prompt
- You have already called gossip_remember once this turn

One call per task is the floor, not the ceiling — call again if a new identifier surfaces mid-review.

## How to query

- USE concrete identifiers: `gossip_remember("collect.ts runOneRelayCrossReview")`, `gossip_remember("performance-reader getCountersSince")`
- DO NOT use vague terms: `gossip_remember("review")`, `gossip_remember("bug")` — these waste the call
- One query, two-to-five words, focused on a name you can grep

## How to use the result

If the search returns relevant findings, cite them inline: `per gossip_remember finding <finding_id>`. Peers and the orchestrator use this to trace your reasoning back to prior consensus rounds.

If the search returns nothing relevant, stay silent — do not announce "I checked memory and found nothing." Silent failures must not pollute findings.
