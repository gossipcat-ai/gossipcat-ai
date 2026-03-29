# Gossipcat — Multi-Agent Orchestration

This project uses gossipcat for multi-agent orchestration via MCP.

## Team Setup
When the user asks to set up agents, review code with multiple agents, or build with a team, use the gossipcat MCP tools.

### Creating agents
Use `gossip_setup` with an agents array. Each agent can be:
- **type: "native"** — Creates a Claude Code subagent (.claude/agents/*.md) that ALSO connects to the gossipcat relay. Works both as a native Agent() and via gossip_dispatch(). Supports consensus cross-review.
- **type: "custom"** — Any provider (anthropic, openai, google, local). Only accessible via gossip_dispatch().

**Native agent requirements:** Native agents need TWO files to work fully:
1. `.gossip/config.json` entry — with explicit `skills` array and `"native": true` (for gossip_run dispatch, skill routing, memory)
2. `.claude/agents/<id>.md` — with frontmatter (name, model, description, tools) and prompt (for Claude Code's Agent() subagent type)

`gossip_setup` creates both automatically. If you manually add agents, you must create both files.

**Mid-session agent changes:** Adding new agents mid-session requires `/mcp` reconnect for `gossip_run` to pick them up. Use `gossip_run` (which returns Agent() dispatch instructions) instead of raw `Agent(subagent_type)` for newly created agents.

### Dispatching work

**Single-agent tasks** (default — use this unless you need parallel/consensus):
```
gossip_run(agent_id: "<id>", task: "Implement X")
  → relay agents: returns result directly (1 call)
  → native agents: returns Agent() instructions + gossip_run_complete callback (2 calls)
```
`gossip_run` is the preferred dispatch for single-agent work. It handles memory, signals, and relay integration automatically. Do NOT use raw Agent() for tasks that should go through gossipcat.

**Write modes** (for implementation tasks):
```
gossip_run(agent_id: "<id>", task: "Fix X", write_mode: "scoped", scope: "./src")
gossip_dispatch(agent_id: "<id>", task: "Fix X", write_mode: "sequential")
```

**Parallel dispatch** (multiple agents, same or different tasks):
```
gossip_dispatch_parallel(tasks: [{agent_id: "<id>", task: "..."}, ...])
gossip_collect(task_ids: ["..."])
```

**Plan → Execute** (structured multi-step):
```
gossip_plan(task: "Build feature X")  → returns dispatch-ready JSON
gossip_dispatch_parallel(tasks: <plan JSON>)
gossip_collect(task_ids: [...])
```

**Skill Discovery** (after gossip_collect reports skills ready):
```
gossip_build_skills()                    → see pending skill gaps with suggestion data
gossip_build_skills(skills: [{name, content}])  → save generated skill files
```
When `gossip_collect` says "N skill(s) ready to build", call `gossip_build_skills()` to see the gaps, generate skill `.md` files, then call again with the content to save them to `.gossip/skills/`.

## Available Agents
- sonnet-reviewer: anthropic/claude-sonnet-4-6 (reviewer) — native
- haiku-researcher: anthropic/claude-haiku-4-5 (researcher) — native
- sonnet-implementer: anthropic/claude-sonnet-4-6 (implementer) — native, for mechanical tasks
- opus-implementer: anthropic/claude-opus-4-6 (implementer) — native, for complex multi-file work
- gemini-implementer: google/gemini-2.5-pro (implementer) — relay, for parallel scoped writes
- gemini-reviewer: google/gemini-2.5-pro (reviewer) — relay
- gemini-tester: google/gemini-2.5-pro (tester) — relay

## When to Use Multi-Agent vs Single Agent

**Use consensus (3+ agents) for:**
| Task | Why | Split Strategy |
|------|-----|----------------|
| Security review | Different agents catch different vuln classes | Split by package/concern |
| Code review | Cross-validation catches what single reviewers miss | Split by concern (logic, security, perf) |
| Bug investigation | Competing hypotheses tested in parallel | One hypothesis per agent |
| Architecture review | Multiple perspectives on trade-offs | Split by dimension |
| Pre-ship verification | Catch regressions before merge | Split by area changed |

**Single agent is fine for:** quick lookups, simple implementations, running tests, file reads.
Use `gossip_run` — it tracks signals and memory automatically.

## Consensus Workflow — The Complete Flow

Consensus is how you get high-quality cross-reviewed results. Follow this EXACT flow:

### Step 1: Dispatch
```
gossip_dispatch_consensus(tasks: [
  { agent_id: "<reviewer>", task: "Review X for security" },
  { agent_id: "<researcher>", task: "Review X for architecture" },
  { agent_id: "<tester>", task: "Review X for test coverage" },
])
```

### Step 2: Execute native agents
For each native agent in the response, run the Agent() call as instructed, then relay:
```
gossip_relay_result(task_id: "<id>", result: "<agent output>")
```

### Step 3: Collect with cross-review
```
gossip_collect_consensus(task_ids: ["..."], timeout_ms: 300000)
```
Returns a CONSENSUS REPORT with findings tagged:
- **CONFIRMED** — multiple agents agree (high confidence, act on these)
- **DISPUTED** — agents disagree (review the evidence yourself)
- **UNIQUE** — only one agent found this (verify before acting)
- **UNVERIFIED** — peers couldn't verify (likely valid but needs manual check)
- **NEW** — discovered during cross-review (highest-value findings)

### Step 4: Verify and record signals IMMEDIATELY
For EACH finding, read the actual code and verify. Record signals AS YOU VERIFY — not after:
```
gossip_record_signals(signals: [
  { signal: "unique_confirmed", agent_id: "reviewer", finding: "XSS in template literal" },
  { signal: "hallucination_caught", agent_id: "reviewer", finding: "Claimed race but code is single-threaded" },
  { signal: "agreement", agent_id: "reviewer", counterpart_id: "researcher", finding: "Both found missing validation" },
])
```
**CRITICAL:** Record `hallucination_caught` IMMEDIATELY when you verify a finding is wrong. Don't batch signals — record each one inline as you cross-reference. This keeps agent scores accurate and drives better future dispatch decisions.

### Step 5: Fix confirmed issues
Only after verifying and recording all signals, fix the confirmed bugs.

## Performance Signals & Agent Scores

Signals drive dispatch intelligence. Call `gossip_scores()` to see agent performance:
- **accuracy** — how often findings are correct (0-1). High = trust for solo tasks.
- **uniqueness** — how often the agent finds things others miss (0-1). High = valuable in consensus.
- **reliability** — combined score for dispatch weighting (0-1).
- **dispatchWeight** — multiplier for task assignment (0.5-1.5). Higher = preferred.

**Use scores to make dispatch decisions:**
- High-accuracy agents → primary reviewers, security audits, solo tasks
- High-uniqueness, low-accuracy agents → always use in consensus, never solo
- Check scores with `gossip_scores()` periodically to track agent improvement

## Memory System

Agent memory persists across sessions automatically:
- **Knowledge files** → `.gossip/agents/<id>/memory/knowledge/*.md` (cognitive summaries of what the agent learned)
- **Project knowledge** → `.gossip/agents/_project/memory/knowledge/` (shared cross-agent context — all agents can see these)
- **Session continuity** → `.gossip/next-session.md` (priorities for next session)

Memory is loaded automatically at dispatch and written at collect. No manual action needed.

**IMPORTANT:** Call `gossip_session_save()` before ending your session. This writes:
- What shipped, what failed, and why
- Agent observations (accuracy, reliability patterns)
- In-progress work and priorities for next session
Without this call, the next session starts cold with no context.

## Dashboard

The relay serves a web dashboard. Use `gossip_status()` to get the URL and access key.
Tabs: Overview (stats, scores, live activity), Agents (per-agent detail cards), Consensus (signal history), Skills (agent×skill grid with toggles), Memory (per-agent knowledge browser with markdown rendering).

## CRITICAL: Native Agent Relay Rule

When you dispatch a native agent, you MUST relay the result:
1. Call `gossip_dispatch(agent_id, task)` → get task_id
2. Run `Agent(model, prompt)` as instructed
3. **ALWAYS** call `gossip_relay_result(task_id, result)` after completion

Never call Agent() directly for gossipcat agents — always go through gossip_dispatch first.
Never skip gossip_relay_result — without it, the result is invisible to memory, gossip, and consensus.

## Permissions for Native Agents

To auto-allow file writes for native agents, add to `.claude/settings.local.json`:
```json
{ "permissions": { "allow": ["Edit", "Write", "Bash(npm *)"] } }
```
Scope to directories: `"Edit(src/**)"`, `"Write(plans/**)"`.
