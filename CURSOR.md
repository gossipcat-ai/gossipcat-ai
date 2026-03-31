# CURSOR.md

## Gossipcat — Multi-Agent Orchestration

**FIRST:** Read `.gossip/bootstrap.md` before exploring the codebase.
It contains team config, session context from the last session (what shipped, what failed, what's in progress), and dispatch rules. This saves you from re-exploring files the previous session already understood.

Also read `.gossip/next-session.md` if it exists — it has the prioritized task list.

Call `gossip_setup(mode: "merge", ...)` to refresh after adding/removing agents.
Call `gossip_session_save()` before ending your session to preserve context.

## Project Structure

- `packages/orchestrator/src/` — core orchestration (dispatch, consensus, memory, skills)
- `packages/relay/src/` — WebSocket relay server
- `apps/cli/src/mcp-server-sdk.ts` — MCP server with all gossipcat tools
- `.gossip/` — project data (config, agent memory, performance signals, skill index)
- `tests/orchestrator/` — test suites (jest)
- `docs/specs/` — feature specs

## Key Commands

- `npm run build:mcp` — build MCP server bundle
- `npx jest --config jest.config.base.js tests/orchestrator/<file>.test.ts` — run tests
- `npx tsc --noEmit -p packages/orchestrator/tsconfig.json` — type check

## Gossipcat MCP Tools

This project uses gossipcat for multi-agent orchestration via MCP. Key tools:
- `gossip_run(agent_id, task)` — run task on one agent (agent_id:"auto" for decomposer)
- `gossip_dispatch(mode, ...)` — dispatch tasks (single/parallel/consensus)
- `gossip_collect(task_ids?, consensus?)` — collect results with optional cross-review
- `gossip_relay(task_id, result)` — feed native Agent() result back into gossipcat
- `gossip_signals(action, ...)` — record or retract consensus signals
- `gossip_status()` — system status + agent list
- `gossip_setup(mode, agents)` — create/update team
- `gossip_session_save()` — save session context for next session
- `gossip_plan(task)` — plan task with write-mode suggestions
- `gossip_scores()` — view agent performance scores
- `gossip_skills(action, ...)` — manage per-agent skills
- `gossip_tools()` — list all available tools
