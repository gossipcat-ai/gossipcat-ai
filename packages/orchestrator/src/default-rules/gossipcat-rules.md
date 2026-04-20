# Gossipcat — Multi-Agent Orchestration

The orchestrator role and dispatch rule (with exceptions) is loaded dynamically via `gossip_status()` — see the "## Your Role" section in its output. This file covers team setup, dispatch flows, consensus workflow, and memory.

## Team Setup
When the user asks to set up agents, review code with multiple agents, or build with a team, use the gossipcat MCP tools.

### Creating agents
Use `gossip_setup` with an agents array. Each agent can be:
- **type: "native"** — Creates a Claude Code subagent (.claude/agents/*.md) that ALSO connects to the gossipcat relay. Works both as a native Agent() and via gossip_dispatch(). Supports consensus cross-review.
- **type: "custom"** — Any provider (anthropic, openai, google, local). Only accessible via gossip_dispatch().

**Native agent requirements:** Native agents need TWO files to work fully:
1. `.gossip/config.json` entry — with explicit `skills` array and `"native": true`
2. `.claude/agents/<id>.md` — with frontmatter (name, model, description, tools) and prompt

`gossip_setup` creates both automatically. Mid-session agent changes require `/mcp` reconnect.

### Dispatching work

**Single-agent tasks** (default):
```
gossip_run(agent_id: "<id>", task: "Implement X")
```
`gossip_run` is the preferred dispatch. Do NOT use raw Agent() for gossipcat tasks.

**Active polling — do NOT wait passively for notifications:**
After dispatching background native agents, wait ~60-90 seconds, then actively check their status:
1. Call `gossip_progress(task_ids: [...])` to see live completion state
2. If complete, read the output file directly (path returned in Agent() response as `output_file`)
3. Then call `gossip_relay(task_id, result)` immediately

Do NOT sit idle waiting for task-notification events — the notification system can lag 5-10 minutes. Always poll proactively after a short wait.

**Write modes:** `gossip_run(agent_id, task, write_mode: "scoped", scope: "./src")`
**Parallel:** `gossip_dispatch(mode:"parallel", tasks) → gossip_collect(task_ids)`
**Plan → Execute:** `gossip_plan(task) → gossip_dispatch(mode:"parallel", tasks) → gossip_collect(ids)`

**Available agents and dispatch decision rules** are loaded dynamically from `gossip_status()` — call it for the live team roster, performance scores, and the multi-agent vs single-agent decision table. Do not duplicate that content here.

## Consensus Workflow — The Complete Flow

### Step 1: Dispatch
```
gossip_dispatch(mode: "consensus", tasks: [
  { agent_id: "<reviewer>", task: "Review X for security" },
  { agent_id: "<researcher>", task: "Review X for architecture" },
  { agent_id: "<tester>", task: "Review X for test coverage" },
])
```

### Step 2: Execute native agents, then relay results
`gossip_relay(task_id: "<id>", result: "<agent output>")`

### Step 3: Collect with cross-review
`gossip_collect(task_ids, consensus: true, timeout_ms: 300000)`
Returns: CONFIRMED, DISPUTED, UNIQUE, UNVERIFIED, NEW tagged findings.

### Step 4: Verify and record signals IMMEDIATELY
For EACH finding, read the actual code. Record signals AS YOU VERIFY:
```
gossip_signals(signals: [
  { signal: "unique_confirmed", agent_id: "reviewer", finding: "XSS in template", finding_id: "<consensus_id>:reviewer:f1" },
  { signal: "hallucination_caught", agent_id: "reviewer", finding: "Claimed X but code shows Y", finding_id: "<consensus_id>:reviewer:f2", evidence: "code at file.ts:42 shows Y not X" },
  { signal: "agreement", agent_id: "reviewer", counterpart_id: "researcher", finding: "Both found it", finding_id: "<consensus_id>:reviewer:f3" },
])
```
**CRITICAL:** Record `hallucination_caught` IMMEDIATELY when a finding is wrong. Don't batch — record inline as you verify. This keeps agent scores accurate.

### Step 5: Verify ALL UNVERIFIED findings.
UNVERIFIED does not mean "skip." It means the cross-reviewer couldn't check it — YOU can.
For each UNVERIFIED finding: grep/read the cited code or identifiers, then record the signal.
Do NOT present raw consensus results with unverified findings to the user.

### Step 6: Fix confirmed issues (only after all signals recorded).

⛔ **CHECKPOINT — do not proceed to fixes until signals are recorded.**
If you find yourself writing code or editing files before calling `gossip_signals`, STOP.
Signal recording is not optional cleanup — it is part of the verification step, not after it.
The correct order is always: verify finding → record signal → next finding → ... → then fix.

## Performance Signals & Agent Scores

Call `gossip_scores()` to see: accuracy (0-1), uniqueness (0-1), dispatchWeight (0.5-1.5).
- High-accuracy agents → solo tasks, primary reviewers
- High-uniqueness, low-accuracy → always use in consensus, never solo
- Check scores periodically to track improvement

## Memory System

Memory persists across sessions automatically:
- `.gossip/agents/<id>/memory/knowledge/*.md` — cognitive summaries
- `.gossip/agents/_project/memory/knowledge/` — shared cross-agent context
- `.gossip/next-session.md` — session continuity priorities

**Call `gossip_session_save()` before ending your session.** Without it, the next session starts cold.

## Dashboard

Use `gossip_status()` for URL and key. Tabs: Overview, Agents, Consensus, Skills, Memory.

## Subagent Override (IMPORTANT)

When ANY skill or workflow (including subagent-driven-development, executing-plans, or
any custom skill) instructs you to dispatch work via the Agent() tool, use `gossip_run`
instead. This ensures tasks appear in the dashboard, agent memory is written, and
performance signals are recorded.

**Flow:** `gossip_run(agent_id, task)` → returns Agent() instructions for native agents →
execute the Agent() → `gossip_relay(task_id, result)` to close the loop.

**Exception:** `gossip_dispatch(mode:"consensus")` already handles its own native Agent() calls —
don't double-wrap those.

**Why:** Raw Agent() bypasses the gossipcat pipeline. Tasks won't appear in the activity
feed, no memory is written, no signals recorded. The agent effectively works off-grid.

## Native Agent Relay Rule

When dispatching native agents: gossip_dispatch → Agent() → gossip_relay. Never skip the relay call.

## Permissions

Auto-allow writes: `{ "permissions": { "allow": ["Edit", "Write", "Bash(npm *)"] } }`

## Sandbox Enforcement

`write_mode: "scoped"` and `write_mode: "worktree"` are **advisory** at the Claude Code harness layer. The Edit/Write tools accept absolute paths anywhere on the filesystem and do not enforce containment. Until that ships, gossipcat adds soft enforcement via two mitigations:

1. **Prompt sanitization** — task descriptions for scoped/worktree dispatches are rewritten to use relative project paths before being handed to the Agent tool. Removes the most common accidental escape vector (the orchestrator embedding absolute paths out of habit).
2. **Post-task path audit** — after the agent reports done, `gossip_relay` runs `git status --porcelain` and compares the modified files against the declared scope. Violations are recorded as `boundary_escape` entries in `.gossip/boundary-escapes.jsonl` and emit a `boundary_escape` signal with `category: "trust_boundaries"`.

Configure via `sandboxEnforcement` in `.gossip/config.json`: `"off"` (skip both), `"warn"` (default — sanitize and audit, accept results with a warning), `"block"` (sanitize, audit, and refuse to record results that escape the boundary — task is marked failed).

Both mitigations are best-effort. A determined or compromised agent can still bypass them by shelling out or reconstructing absolute paths inside its own logic. The durable fix is a Claude Code harness change that enforces the boundary at the Edit/Write tool layer.
