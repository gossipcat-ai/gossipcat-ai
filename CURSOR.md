# CURSOR.md

## Gossipcat — Multi-Agent Orchestration

**FIRST:** Read `.gossip/bootstrap.md` before exploring the codebase.
It contains team config, session context from the last session (what shipped, what failed,
what's in progress), and dispatch rules. This saves you from re-exploring files the
previous session already understood.

Also read `.gossip/next-session.md` if it exists — it has the prioritized task list.

Call `gossip_setup(mode: "merge", ...)` to refresh after adding/removing agents.
Call `gossip_session_save()` before ending your session to preserve context.

**After dispatching agents:** Always print a visible dispatch summary so the user can see
what's running. Use a code block with this format:
```
┌─ gossipcat dispatch ────────────────────────┐
│  task-id  → agent-name (relay)              │
│  task-id  → agent-name (relay)              │
└─────────────────────────────────────────────┘
```
This is important — relay agents run invisibly without terminal indicators. The user needs
to see what was dispatched and track task IDs for progress checks.

**Note:** Cursor does not support native agents (no `Agent()` tool). All agents run via the
relay server using API keys (Gemini, OpenAI, etc.). Native Anthropic agents are unavailable
in Cursor — use relay-based agents only.

**After consensus:** Verify ALL UNVERIFIED findings against the code before presenting
results. UNVERIFIED means the cross-reviewer couldn't check — you can and must. Do not
show raw consensus results with unexamined UNVERIFIED findings.

**Resolving findings in the dashboard:** When you verify an UNVERIFIED finding, pass
`finding_id` in your `gossip_signals` call so the consensus report is updated. The
finding ID is the `id` field shown in the consensus report (e.g., `f9`, `f12`). This
moves the finding from UNVERIFIED → CONFIRMED in the report JSON, so the dashboard
displays the resolved status.

```
gossip_signals(action: "record", signals: [{
  signal: "unique_confirmed",  // or "hallucination_caught"
  agent_id: "<who found it>",
  finding: "<description>",
  finding_id: "<id from consensus report>"  // ← THIS resolves it in dashboard
}])
```

Without `finding_id`, signals update agent scores but the dashboard still shows the
finding as UNVERIFIED.

## Project Structure

- `packages/orchestrator/src/` — core orchestration (dispatch, consensus, memory, skills)
- `packages/relay/src/` — WebSocket relay server + dashboard API
- `packages/dashboard-v2/` — React + Vite dashboard (Terminal Amber theme)
- `apps/cli/src/mcp-server-sdk.ts` — MCP server with all gossipcat tools
- `.gossip/` — project data (config, agent memory, performance signals, skill index)
- `tests/orchestrator/` — test suites (jest)

## Key Commands

- `npm run build:mcp` — build MCP server bundle
- `npm run build:dashboard` — build dashboard frontend
- `npx jest --config jest.config.base.js tests/orchestrator/<file>.test.ts` — run tests
- `npx tsc --noEmit -p packages/orchestrator/tsconfig.json` — type check

## Agent Accuracy — Skill Development

When an agent has low accuracy or repeated hallucinations, **use the skill system, not
instruction edits.** Instructions (`.gossip/agents/<id>/instructions.md`) are the base
prompt — they set role and rules. Skills (`.gossip/agents/<id>/skills/*.md`) are
specialized knowledge injected per-dispatch based on the agent's actual failure patterns.

**How to improve a struggling agent:**
1. Check `gossip_scores()` to identify low-accuracy agents
2. Call `gossip_skills(action: "develop", agent_id: "<id>", category: "<category>")`
   - This generates an agent-specific skill file from their failure data
   - Categories: `trust_boundaries`, `injection_vectors`, `input_validation`,
     `concurrency`, `resource_exhaustion`, `type_safety`, `error_handling`, `data_integrity`
3. Bind if not auto-bound: `gossip_skills(action: "bind", agent_id: "<id>", skill: "<name>")`
4. Verify with `gossip_skills(action: "list")` — skill should show as enabled

**Skill resolution order:** agent-local → project-wide → bundled defaults.
Agent-local skills (from `develop`) override defaults with targeted improvements.

**Do NOT:** Edit `instructions.md` to fix accuracy. Instructions set the base contract.
Skills are the mechanism for targeted, evidence-based improvement.

## Gossipcat MCP Tools

| Tool | Purpose |
|------|---------|
| `gossip_status` | System status, dashboard URL, agent list |
| `gossip_run` | Single-agent dispatch with auto-classification |
| `gossip_dispatch` | Multi-agent dispatch: `single`, `parallel`, or `consensus` mode |
| `gossip_collect` | Collect results with optional cross-review synthesis |
| `gossip_plan` | Decompose task into sub-tasks with agent assignments |
| `gossip_signals` | Record or retract accuracy signals |
| `gossip_scores` | View agent accuracy, uniqueness, and dispatch weights |
| `gossip_skills` | Develop, bind, unbind, or list per-agent skills |
| `gossip_setup` | Create or update agent team configuration |
| `gossip_session_save` | Save session context for the next session |
| `gossip_remember` | Search an agent's cognitive memory |
| `gossip_progress` | Check in-progress task status |
| `gossip_tools` | List all available MCP tools |

## Scoped Agent Contract

When an agent is dispatched with `write_mode: "scoped"`:
- **Can:** `file_write`, `file_delete` (within scope), `file_read` (anywhere), `run_tests`, `run_typecheck`, `git status/diff/log/show`
- **Cannot:** `shell_exec` (except read-only git), `git_commit`, `git_branch`
- **Orchestrator commits** on behalf of scoped agents after verifying their output

This is intentional: scoped agents write files, the orchestrator validates and commits.
