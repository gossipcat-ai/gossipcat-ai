# Gossipcat — Multi-Agent Dispatch Rules

This project uses gossipcat for multi-agent orchestration via MCP.

## Dispatch Rules

### READ tasks (review, research, analysis) — no file changes needed:

**Non-Claude agents** — gossipcat MCP tools:
```
gossip_dispatch(agent_id: "gemini-reviewer", task: "Review packages/relay/src/server.ts for security issues")
gossip_dispatch_parallel(tasks: [{agent_id: "gemini-reviewer", task: "..."}, {agent_id: "gemini-tester", task: "..."}])
gossip_collect(task_ids: ["abc123"])
```

**Claude agents** — Claude Code Agent tool (free):
```
Agent(model: "sonnet", prompt: "Review this file for bugs...", run_in_background: true)
```

### WRITE tasks (implementation, bug fixes, refactoring) — file changes needed:

**Non-Claude agents** — gossipcat MCP tools (workers have full Tool Server access):
```
gossip_dispatch(agent_id: "gemini-implementer", task: "Fix the timer leak in worker-agent.ts")
```

**Claude agents** — use `isolation: "worktree"` for full write access:
```
Agent(
  model: "sonnet",
  prompt: "Fix the timer leak in packages/orchestrator/src/worker-agent.ts. Read the file, apply the fix, run tests.",
  isolation: "worktree"
)
```
The worktree gives the agent its own branch with unrestricted file access.
After completion, review the changes and merge if approved.

### Parallel multi-provider — combine in one message:
```
gossip_dispatch(agent_id: "gemini-reviewer", task: "Security review of X")
Agent(model: "sonnet", prompt: "Performance review of X", isolation: "worktree", run_in_background: true)
```

## Agent Memory

**Gossipcat MCP agents** get memory auto-injected at dispatch and auto-written at collect. No manual action needed.

**Claude Code subagents** (Agent tool) bypass the MCP pipeline. You MUST manually handle memory:

**Before dispatching:**
```
// Read the matching agent's memory
Read('.gossip/agents/sonnet-implementer/memory/MEMORY.md')
// Include the content in the Agent prompt
Agent(model: "sonnet", prompt: "[memory content here]\n\nYour task: ...")
```

**After completion:** Append a task entry to `.gossip/agents/<id>/memory/tasks.jsonl`:
```jsonl
{"version":1,"taskId":"<id>","task":"<description>","skills":["<skill>"],"scores":{"relevance":3,"accuracy":3,"uniqueness":3},"warmth":1,"importance":0.6,"timestamp":"<ISO>"}
```

Match the agent ID to the gossip.agents.json equivalent: `sonnet-implementer` or `sonnet-debugger`.

## Available agents
Run `gossip_agents()` to see current team. Edit `gossip.agents.json` to add agents (hot-reloads, no restart).

## Skills
Auto-injected from agent config. Project skills in `.gossip/skills/`. Default skills in `packages/orchestrator/src/default-skills/`.

## When to Use Multi-Agent Dispatch (REQUIRED)

These tasks MUST use parallel multi-agent dispatch. Never use a single agent or Explore subagent.

| Task Type | Why Multi-Agent | Split Strategy |
|-----------|----------------|----------------|
| Security review | Different agents catch different vulnerability classes | Split by package |
| Code review | Cross-validation finds bugs single reviewers miss | Split by concern (logic, style, perf) |
| Bug investigation | Competing hypotheses tested in parallel | One agent per hypothesis |
| Architecture review | Multiple perspectives on trade-offs | Split by dimension (scale, security, DX) |

### Single agent is fine for:
- Quick lookups ("what does function X do?")
- Simple implementation tasks
- Running tests
- File reads / grep searches

### Pattern:
```
gossip_dispatch_parallel(tasks: [
  {agent_id: "<reviewer>", task: "Review packages/relay/ for <concern>"},
  {agent_id: "<tester>", task: "Review packages/tools/ for <concern>"}
])
Agent(model: "sonnet", prompt: "Review packages/orchestrator/ for <concern>", run_in_background: true)
```
Then synthesize all results — cross-reference findings, deduplicate, resolve conflicts.
