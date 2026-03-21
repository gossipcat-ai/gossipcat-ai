# CLAUDE.md

## Gossipcat — Multi-Agent Orchestration

This project has a gossipcat MCP server that dispatches tasks to worker agents (Gemini, GPT, local models) via a WebSocket relay. Config is in `gossip.agents.json`.

### How to use agents

**Gemini/GPT/local agents** — use gossipcat MCP tools:
```
gossip_dispatch(agent_id: "gemini-reviewer", task: "Review packages/relay/src/server.ts for security issues")
gossip_dispatch_parallel(tasks: [{agent_id: "gemini-reviewer", task: "..."}, {agent_id: "gemini-tester", task: "..."}])
gossip_collect(task_ids: ["abc123"])
gossip_agents()   — list available agents
gossip_status()   — check system status
```

**Claude agents (Sonnet/Haiku)** — use Claude Code's built-in Agent tool (free, no API key needed):
```
Agent(model: "sonnet", prompt: "Review this file for bugs...", run_in_background: true)
Agent(model: "haiku", prompt: "Quick check...", run_in_background: true)
```

**Parallel multi-provider dispatch** — combine both in one message:
```
gossip_dispatch(agent_id: "gemini-reviewer", task: "Security review of X")     ← Gemini via relay
Agent(model: "sonnet", prompt: "Review X for performance issues")               ← Sonnet via Claude Code
```
Then synthesize both results.

### Agent skills
Skills are auto-injected from `.gossip/agents/<id>/skills/` and `packages/orchestrator/src/default-skills/`. Project-wide skills in `.gossip/skills/`. No need to pass skills manually.

### Agent memory
Agents accumulate memory across tasks. Memory is stored in `.gossip/agents/<id>/memory/`:
- `MEMORY.md` — index (auto-injected into agent prompt on dispatch)
- `knowledge/` — topic files with warmth scoring
- `tasks.jsonl` — task outcome history
- `calibration/` — per-skill accuracy (future)

**Memory is auto-managed for gossipcat MCP agents** — loaded at dispatch, written at collect.

### Agent memory for Claude Code subagents

Claude Code's `Agent()` tool bypasses gossipcat's MCP pipeline. To give Sonnet/Haiku subagents memory:

**Before dispatching** — read the agent's memory and include it in the prompt:
```
// Read memory for the matching gossipcat agent
const memory = read('.gossip/agents/sonnet-implementer/memory/MEMORY.md');

Agent(model: "sonnet", prompt: `
${memory}

Your task: Fix the bug in worker-agent.ts...
`)
```

**After completion** — write a task entry so the agent remembers next time:
```
// Append to .gossip/agents/sonnet-implementer/memory/tasks.jsonl
{"version":1,"taskId":"...","task":"Fix bug in worker-agent.ts","skills":["debugging"],"scores":{"relevance":3,"accuracy":3,"uniqueness":3},"warmth":1,"importance":0.6,"timestamp":"..."}
```

The matching agent ID is typically `sonnet-implementer` or `sonnet-debugger` from `gossip.agents.json`.

### Adding agents
Edit `gossip.agents.json` — new agents are hot-reloaded on next dispatch (no restart needed).

---

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

### Available skills

- `/office-hours` — YC-style brainstorming and idea validation
- `/plan-ceo-review` — CEO/founder-mode plan review
- `/plan-eng-review` — Engineering manager plan review
- `/plan-design-review` — Designer's eye plan review
- `/design-consultation` — Design system and brand guidelines
- `/review` — Pre-landing PR review
- `/ship` — Ship workflow (test, review, commit, push, PR)
- `/browse` — Headless browser for QA and dogfooding
- `/qa` — QA test and fix bugs
- `/qa-only` — QA report only (no fixes)
- `/design-review` — Visual design audit and fix
- `/setup-browser-cookies` — Import browser cookies for authenticated testing
- `/retro` — Weekly engineering retrospective
- `/investigate` — Systematic root cause debugging
- `/document-release` — Post-ship documentation update
- `/codex` — Second opinion via OpenAI Codex CLI
- `/careful` — Safety guardrails for destructive commands
- `/freeze` — Restrict edits to a specific directory
- `/guard` — Full safety mode (careful + freeze)
- `/unfreeze` — Remove freeze boundary
- `/gstack-upgrade` — Upgrade gstack to latest version
