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

**Mid-session agent changes:** Adding new agents mid-session requires `/mcp` reconnect for `gossip_run` to pick them up. Claude Code's `Agent(subagent_type)` only scans `.claude/agents/` at session start — newly created agents won't be available as subagent types until the next session. Use `gossip_run` (which returns Agent() dispatch instructions) instead of raw `Agent(subagent_type)` for newly created agents.

### Dispatching work

**Single-agent tasks** (default — use this unless you need parallel/consensus):
```
gossip_run(agent_id: "<id>", task: "Implement X")
  → relay agents: returns result directly (1 call)
  → native agents: returns Agent() instructions + gossip_run_complete callback (2 calls)
```
`gossip_run` is the preferred dispatch for single-agent work. It handles memory, signals, and relay integration automatically. Use it for implementation, review, research — any task going to one agent. Do NOT use raw Agent() for tasks that should go through gossipcat.

**Parallel dispatch** (multiple agents, same or different tasks):
```
gossip_dispatch_parallel(tasks: [{agent_id: "<id>", task: "..."}, ...])
gossip_collect(task_ids: ["..."])
```

**Consensus** (cross-review for quality):
```
gossip_dispatch_consensus(tasks: [{agent_id: "<id>", task: "..."}, ...])
gossip_collect_consensus(task_ids: ["..."])
```

**Plan → Execute** (structured multi-step):
```
gossip_plan(task: "Build feature X")  → returns dispatch-ready JSON
gossip_dispatch_parallel(tasks: <plan JSON>)
gossip_collect(task_ids: [...])
```

**Write modes** (for implementation tasks):
```
gossip_run(agent_id: "<id>", task: "Fix X", write_mode: "scoped", scope: "./src")
gossip_dispatch(agent_id: "<id>", task: "Fix X", write_mode: "sequential")
```

**Skill Discovery** (after gossip_collect reports skills ready):
```
gossip_build_skills()                    → see pending skill gaps with suggestion data
gossip_build_skills(skills: [{name, content}])  → save generated skill files
```
When `gossip_collect` says "🔧 N skill(s) ready to build", call `gossip_build_skills()` to see the gaps, generate skill `.md` files, then call again with the content to save them to `.gossip/skills/`.

## Available Agents
- sonnet-reviewer: anthropic/claude-sonnet-4-6 (reviewer) — native
- haiku-researcher: anthropic/claude-haiku-4-5 (researcher) — native
- sonnet-implementer: anthropic/claude-sonnet-4-6 (implementer) — native, for mechanical tasks
- opus-implementer: anthropic/claude-opus-4-6 (implementer) — native, for complex multi-file work
- gemini-implementer: google/gemini-2.5-pro (implementer) — relay, for parallel scoped writes
- gemini-reviewer: google/gemini-2.5-pro (reviewer) — relay
- gemini-tester: google/gemini-2.5-pro (tester) — relay

## When to Use Multi-Agent Dispatch
| Task | Why Multi-Agent | Split Strategy |
|------|----------------|----------------|
| Security review | Different agents catch different vuln classes | Split by package/concern |
| Code review | Cross-validation catches what single reviewers miss | Split by concern |
| Bug investigation | Competing hypotheses tested in parallel | One hypothesis per agent |
| Feature implementation | Parallel modules, faster delivery | Split by module with scoped writes |

Single agent is fine for: quick lookups, simple tasks, running tests. Use `gossip_run` for these — it tracks signals and memory automatically.
