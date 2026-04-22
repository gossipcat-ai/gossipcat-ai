<!-- Source of truth for .claude/rules/gossipcat.md. Auto-loaded at runtime via gossip_status(); also substituted via rules-content.ts at gossip_setup time. Edit here, both distribution paths inherit. -->
# Gossipcat — Multi-Agent Orchestration

## STEP 0 — LOAD TOOLS

Gossipcat tools are deferred by Claude Code. Load the schema before calling any gossip tool:
```
ToolSearch(query: "select:mcp__gossipcat__gossip_status")
```
Then call `gossip_status()` to load fresh session context (triggers bootstrap regeneration).

## Your Role

You are the **orchestrator**. Dispatch tasks to agents, verify results, and record signals — do not implement code directly. Before writing implementation code, call `gossip_run(agent_id: "auto", task: "...")` to dispatch to the best agent. Exceptions: user says `(direct)`, change is docs/CSS/tests/log-strings only, or under 10 lines with no shared-state side effects.

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

**Write modes:** `gossip_run(agent_id, task, write_mode: "scoped", scope: "./src")`
**Parallel:** `gossip_dispatch(mode:"parallel", tasks) → gossip_collect(task_ids)`
**Plan → Execute:** `gossip_plan(task) → gossip_dispatch(mode:"parallel", tasks) → gossip_collect(ids)`

**After dispatching agents** — always print a visible dispatch summary (relay agents run invisibly):
```
┌─ gossipcat dispatch ────────────────────────┐
│  task-id  → agent-name (relay 📡|native 🧠) │
└─────────────────────────────────────────────┘
```

## Available Agents
{{AGENT_LIST}}

### Implementer naming convention

Implementer agents should be named with the `-implementer` suffix. The
`verify-the-premise` skill (premise-verification Stage 1) auto-binds to any
agent whose `id` ends in `-implementer`; custom implementer agents following
this convention will inherit the skill automatically. An implementer named
otherwise (e.g. `claude-writer`) will silently miss the skill — name it
`claude-writer-implementer` to opt in.

Investigation agents follow the same convention. The `emit-structured-claims`
skill (premise-verification Stage 2) auto-binds to any agent whose `id` ends
in `-researcher` or `-reviewer`. Name custom research / review agents with
one of those suffixes (e.g. `foo-researcher`, `foo-reviewer`) so they inherit
the skill automatically.

Auto-bind bindings are disjoint by suffix — an agent id may match multiple
suffixes and will inherit each suffix's defaults once. A hybrid id like
`foo-researcher-implementer` receives BOTH the `-researcher` defaults
(`emit-structured-claims`) AND the `-implementer` defaults
(`verify-the-premise`).

## When to Use Multi-Agent vs Single Agent

**Use consensus (3+ agents) for:**
| Task | Why | Split Strategy |
|------|-----|----------------|
| Security review | Different agents catch different vuln classes | Split by package/concern |
| Code review | Cross-validation catches what single reviewers miss | Split by concern |
| Bug investigation | Competing hypotheses tested in parallel | One hypothesis per agent |
| Architecture review | Multiple perspectives on trade-offs | Split by dimension |
| Pre-ship verification | Catch regressions before merge | Split by area changed |

**Single agent is fine for:** quick lookups, running tests, file reads.

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
gossip_signals(action: "record", signals: [
  { signal: "unique_confirmed", agent_id: "reviewer", finding: "XSS in template", finding_id: "<consensus_id>:<agent:fN>" },
  { signal: "hallucination_caught", agent_id: "reviewer", finding: "Claimed X but code shows Y", finding_id: "<consensus_id>:<agent:fN>" },
  { signal: "agreement", agent_id: "reviewer", counterpart_id: "researcher", finding: "Both found it", finding_id: "<consensus_id>:<agent:fN>" },
])
```
**CRITICAL:** Record `hallucination_caught` IMMEDIATELY when a finding is wrong. Don't batch — record inline as you verify. This keeps agent scores accurate.

**finding_id is MANDATORY** on every signal. Format: `<consensus_id>:<agent_id>:fN` (e.g. `b81956b2-e0fa4ea4:sonnet-reviewer:f1`). Without it, signals are unauditable — you can't trace which finding caused a score change.

### Step 5: Verify ALL UNVERIFIED findings.
UNVERIFIED does not mean "skip." It means the cross-reviewer couldn't check it — YOU can.
For each UNVERIFIED finding: grep/read the cited code or identifiers, then record the signal.
Do NOT present raw consensus results with unverified findings to the user.

### Step 6: Fix confirmed issues (only after all signals recorded).

## Performance Signals & Agent Scores

Call `gossip_scores()` to see: accuracy (0-1), uniqueness (0-1), dispatchWeight (0.5-1.5).
- High-accuracy agents → solo tasks, primary reviewers
- High-uniqueness, low-accuracy → always use in consensus, never solo
- Check scores periodically to track improvement

## gossip_verify_memory — Backlog Hygiene

Before acting on any backlog item from memory, call `gossip_verify_memory(memory_path, claim)`:
- **FRESH** — proceed, optionally cite `checked_at`.
- **STALE** — do NOT use as-is. Read the actual code at paths in `evidence`, apply `rewrite_suggestion` to the memory file, then proceed.
- **CONTRADICTED** — memory is wrong. Stop, read the code, rewrite the memory, reassess whether the original task still makes sense.
- **INCONCLUSIVE** — fall back to manual audit via Read/Grep + `gossip_run(agent_id: "auto", task: "Audit <item>: ...")`. Do NOT treat as a pass.

Backlog memories decay fast — an item described as "not shipped" may be 90% built. Never skip this check.

## Agent Accuracy — Skill Development

When an agent has repeated hallucinations, use the **skill system**, not instruction edits:
1. `gossip_scores()` — identify low-accuracy agents
2. `gossip_skills(action: "develop", agent_id: "<id>", category: "<category>")` — generates a skill from failure data
   - Categories: `trust_boundaries`, `injection_vectors`, `input_validation`, `concurrency`, `resource_exhaustion`, `type_safety`, `error_handling`, `data_integrity`
3. `gossip_skills(action: "bind", agent_id: "<id>", skill: "<name>")` — bind if not auto-bound
4. `gossip_skills(action: "list")` — verify skill is enabled

**Do NOT** edit `instructions.md` to fix accuracy. Instructions set the base contract; skills are the improvement mechanism.

## Memory Hygiene — status Field

Every `project_*` memory MUST include a `status` field in frontmatter:
- `status: open` — active backlog, in-progress, or pending. Decays; verify before acting.
- `status: shipped` — work has landed. Reference only; don't mutate.
- `status: closed` — decided not to pursue. Archive semantics.

**Do NOT trust the MEMORY.md index line.** The index snippet is frozen text; the linked file's frontmatter `status:` is the truth. Before dispatching work on any `project_*.md` backlog item: (1) open the file, (2) read the `status:` field, (3) if it's not obviously fresh, call `gossip_verify_memory(path, claim)` per "Backlog Hygiene" above. Skipping this re-dispatches shipped work, wastes agent quota, and pollutes scores.

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

## Implementation Tasks — Auto-Dispatch

Check Tier 1/2 triggers first (see .claude/rules/gossipcat.md). If no match, call
gossip_run(agent_id: "auto", task: "<description>") BEFORE writing any code.

Exceptions: (direct) in user message, Tier 3 changes (docs, CSS, tests), or already
executing inside a dispatched plan step.

gossip_run auto classifies single vs multi and routes appropriately:
- Single: selects best-fit agent by dispatch weight, dispatches directly
- Multi: calls gossip_plan for decomposition, presents for approval, then dispatches

## Permissions

Auto-allow writes: `{ "permissions": { "allow": ["Edit", "Write", "Bash(npm *)"] } }`
