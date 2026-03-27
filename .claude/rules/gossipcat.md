# Gossipcat — Multi-Agent Orchestration

This project uses gossipcat for multi-agent orchestration via MCP.

## Team Setup
When the user asks to set up agents, review code with multiple agents, or build with a team, use the gossipcat MCP tools.

### Creating agents
Use `gossip_setup` with an agents array. Each agent can be:
- **type: "native"** — Creates a Claude Code subagent (.claude/agents/*.md) that ALSO connects to the gossipcat relay. Works both as a native Agent() and via gossip_dispatch(). Supports consensus cross-review.
- **type: "custom"** — Any provider (anthropic, openai, google, local). Only accessible via gossip_dispatch().

### Dispatching work
**READ tasks** (review, research, analysis):
```
gossip_dispatch(agent_id: "<id>", task: "Review X for security issues")
gossip_dispatch_parallel(tasks: [{agent_id: "<id>", task: "..."}, ...])
gossip_collect(task_ids: ["..."])
```

**WRITE tasks** (implementation, bug fixes):
```
gossip_dispatch(agent_id: "<id>", task: "Fix X", write_mode: "scoped", scope: "./src")
```

**Consensus** (cross-review for quality):
```
gossip_dispatch_consensus(task: "Review this PR for issues")
gossip_collect_consensus(task_ids: ["..."])
```

**Plan → Execute** (structured multi-step):
```
gossip_plan(task: "Build feature X")  → returns dispatch-ready JSON
gossip_dispatch_parallel(tasks: <plan JSON>)
gossip_collect(task_ids: [...])
```

## Available Agents
- sonnet-reviewer: anthropic/claude-sonnet-4-6 (reviewer)
- haiku-researcher: anthropic/claude-haiku-4-5 (researcher)
- gemini-implementer: google/gemini-2.5-pro (implementer)

## When to Use Multi-Agent Dispatch
| Task | Why Multi-Agent | Split Strategy |
|------|----------------|----------------|
| Security review | Different agents catch different vuln classes | Split by package/concern |
| Code review | Cross-validation catches what single reviewers miss | Split by concern |
| Bug investigation | Competing hypotheses tested in parallel | One hypothesis per agent |
| Feature implementation | Parallel modules, faster delivery | Split by module with scoped writes |

Single agent is fine for: quick lookups, simple tasks, running tests.
