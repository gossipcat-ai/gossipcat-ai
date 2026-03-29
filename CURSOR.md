# CURSOR.md

## Gossipcat — Multi-Agent Orchestration

**FIRST:** Read `.gossip/bootstrap.md` before exploring the codebase.
It contains team config, session context from the last session (what shipped, what failed, what's in progress), and dispatch rules. This saves you from re-exploring files the previous session already understood.

Also read `.gossip/next-session.md` if it exists — it has the prioritized task list.

Call `gossip_bootstrap()` to refresh after adding/removing agents.
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
- `gossip_dispatch` / `gossip_dispatch_parallel` — send tasks to agents
- `gossip_collect` / `gossip_collect_consensus` — collect results with cross-review
- `gossip_session_save` — save session context for next session
- `gossip_skill_index` / `gossip_skill_bind` — manage per-agent skill slots
- `gossip_tools` — list all available tools
