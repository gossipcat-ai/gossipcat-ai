# Gossipcat

Multi-agent code review mesh that runs inside Claude Code. Multiple AI agents review your code in parallel, cross-review each other's findings, and build accuracy profiles over time — catching bugs that single-agent review misses.

## Why multi-agent?

A single reviewer — human or AI — has optimistic bias. A 40-line change once passed linting, type-checking, all tests, and author review. It contained 3 silent bugs: two race conditions and unbounded file growth. None crashed. None failed tests. They were found only when multiple agents independently reviewed it.

Gossipcat fixes this with **consensus review**: agents review independently, then cross-review each other's findings. Agreements are confirmed. Disagreements surface for investigation. Hallucinations are caught and penalized. Over time, each agent's accuracy is tracked per-category, and the system learns which agent to send which type of task to.

## How it works

```
  dispatch ─→ parallel review ─→ cross-review ─→ consensus
                                                     │
                                               ┌─────┴─────┐
                                               ▼           ▼
                                           signals    skill development
                                               │           │
                                               ▼           ▼
                                        dispatch weights   targeted prompts
                                        (who gets picked)  (agent improves)
```

1. **Dispatch** — tasks are routed to agents based on dispatch weights (accuracy history per category)
2. **Parallel review** — agents work independently, each producing findings with confidence scores
3. **Cross-review** — each agent reviews peers' findings: agree, disagree, unverified, or new finding
4. **Consensus** — findings are deduplicated and tagged: CONFIRMED, DISPUTED, UNVERIFIED, UNIQUE
5. **Signals** — you verify findings against code and record accuracy signals (confirmed or hallucination)
6. **Skill development** — agents with repeated failures in a category get targeted skill files generated from their failure data, injected into future prompts

## Install

### 1. Clone and build

```bash
git clone https://github.com/ataberk-xyz/gossipcat.git
cd gossipcat
npm install
npm run build:mcp
```

This bundles the MCP server into `dist-mcp/mcp-server.js` — the only artifact Claude Code needs.

### 2. Add to Claude Code

Register gossipcat as an MCP server. You can add it per-project (`.claude/settings.json`) or globally (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "gossipcat": {
      "command": "node",
      "args": ["/absolute/path/to/gossipcat/dist-mcp/mcp-server.js"],
      "env": {
        "GOOGLE_API_KEY": "your-gemini-key"
      }
    }
  }
}
```

Replace `/absolute/path/to/gossipcat` with the actual clone path. The working directory becomes the project root — all `.gossip/` state is written there.

### 3. API keys

| Provider | Env var | Required? | Notes |
|----------|---------|-----------|-------|
| Google Gemini | `GOOGLE_API_KEY` | For relay agents | Powers gemini-reviewer, gemini-implementer, gemini-tester |
| Anthropic | — | No | Native agents run via Claude Code's `Agent()` tool — uses your existing subscription |
| OpenAI | `OPENAI_API_KEY` | Optional | If you add OpenAI-based agents |

Keys can also be stored persistently via the setup wizard:
- **macOS** — OS Keychain (`security` CLI)
- **Linux** — Secret Service (`secret-tool`)
- **Windows / other** — AES-256-GCM encrypted file (`.gossip/keys.enc`)

The system auto-detects the best backend. Env vars take precedence over stored keys.

**Native agents need no API key.** They run as Claude Code subagents using your subscription credentials.

### 4. Initialize your team

Start a Claude Code session in any project. Gossipcat boots automatically on first tool call. The default team ships with 7 agents:

| Agent | Provider | Type | Role |
|-------|----------|------|------|
| sonnet-reviewer | Anthropic | Native | Code review, security audit |
| sonnet-implementer | Anthropic | Native | TDD implementation |
| opus-implementer | Anthropic | Native | Complex multi-file integration |
| haiku-researcher | Anthropic | Native | Fast codebase exploration |
| gemini-reviewer | Google | Relay | Code review, security audit |
| gemini-implementer | Google | Relay | Implementation, testing |
| gemini-tester | Google | Relay | Testing, debugging |

To customize, run `gossip_setup(mode: "create", agents: [...])` or edit `.gossip/config.json` directly.

## Two types of agents

**Native agents** run as Claude Code subagents via the `Agent()` tool. They use your Claude subscription, need no API key, and have access to Claude Code's tools (Bash, Read, Write, etc.). Defined in `.claude/agents/*.md`.

**Relay agents** connect to the gossipcat WebSocket relay server. They use provider API keys (Gemini, OpenAI), run in parallel workers, and are managed by the relay. Defined in `.gossip/config.json`.

Both types participate equally in consensus, cross-review, memory, and skill development.

## Usage

### Quick single-agent task

```
gossip_run(agent_id: "auto", task: "review the auth middleware changes")
```

The orchestrator picks the best agent based on dispatch weights and task classification.

### Consensus review (critical changes)

For changes touching shared state, auth, persistence, or core pipeline:

```
gossip_dispatch(mode: "consensus", tasks: [
  { agent_id: "sonnet-reviewer", task: "review for security vulnerabilities" },
  { agent_id: "gemini-reviewer", task: "review for logic and concurrency bugs" },
  { agent_id: "gemini-tester", task: "review for edge cases and test coverage gaps" }
])
```

Collect with cross-review:

```
gossip_collect(consensus: true)
```

This triggers the full cycle: each agent reviews peers' findings, a consensus report is generated with CONFIRMED/DISPUTED/UNVERIFIED/UNIQUE tags, and the dashboard updates in real time.

### Record accuracy signals

After verifying findings against the actual code:

```
gossip_signals(action: "record", signals: [
  { signal: "unique_confirmed", agent_id: "sonnet-reviewer", finding: "race condition in line 45", finding_id: "f9" },
  { signal: "hallucination_caught", agent_id: "gemini-reviewer", finding: "claimed deadlock but code is safe" }
])
```

Signals update dispatch weights — accurate agents get picked more often, inaccurate ones get deprioritized.

### Check agent performance

```
gossip_scores()
```

Shows per-agent accuracy, uniqueness, reliability, and dispatch weight.

### Develop skills for struggling agents

When an agent repeatedly fails in a category:

```
gossip_skills(action: "develop", agent_id: "gemini-reviewer", category: "concurrency")
```

This generates a targeted skill file from the agent's failure data and project context, automatically injected into future prompts for that category.

### Plan and execute

```
gossip_plan(task: "implement the caching layer")
```

Returns a decomposed plan with agent assignments and write modes. Review it, then dispatch.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `gossip_status` | System status, dashboard URL, agent list with providers and skills |
| `gossip_run` | Single-agent dispatch with automatic agent selection |
| `gossip_dispatch` | Multi-agent dispatch: `single`, `parallel`, or `consensus` mode |
| `gossip_collect` | Collect results with optional cross-review synthesis |
| `gossip_relay` | Feed native `Agent()` results back into the gossipcat pipeline |
| `gossip_relay_cross_review` | Feed native cross-review results into consensus |
| `gossip_plan` | Decompose task into sub-tasks with agent assignments |
| `gossip_signals` | Record or retract accuracy signals |
| `gossip_scores` | View agent accuracy, uniqueness, and dispatch weights |
| `gossip_skills` | Develop, bind, unbind, or list per-agent skills |
| `gossip_setup` | Create or update agent team configuration |
| `gossip_session_save` | Save session context for the next session |
| `gossip_remember` | Search an agent's cognitive memory |
| `gossip_progress` | Check in-progress task status |
| `gossip_tools` | List all available MCP tools |

## Dashboard

The dashboard launches automatically on port `24420` when gossipcat boots. Access the URL shown by `gossip_status`.

Built with React + Vite + shadcn/ui (Terminal Amber theme). Shows:

- **Overview** — agent cards with dispatch weights, recent tasks, finding metrics
- **Team** — all agents sorted by reliability
- **Tasks** — task history with agent, duration, and status
- **Findings** — consensus reports with CONFIRMED/DISPUTED/UNVERIFIED breakdowns
- **Agent detail** — per-agent memory, skills, scores, and task history

Live updates via WebSocket — every tool call pushes events to connected clients.

## Architecture

```
gossipcat/
  apps/
    cli/                  MCP server, native agent bridge, boot sequence
  packages/
    orchestrator/         Dispatch pipeline, consensus engine, memory, skills,
                          performance scoring, task graph, prompt assembly
    relay/                WebSocket relay server, dashboard REST/WS API
    dashboard-v2/         React + Vite frontend (Terminal Amber theme)
    client/               Lightweight WebSocket client for relay connections
    tools/                File/shell/git tool implementations for worker agents
    types/                Shared TypeScript types and message protocol
```

### Runtime state (`.gossip/`)

Created automatically per-project. Contains agent config, memory, consensus reports, performance signals, skill files, and task persistence. Gitignored by default.

## Configuration

Config is searched in order: `.gossip/config.json` > `gossip.agents.json` > `gossip.agents.yaml`.

```json
{
  "main_agent": {
    "provider": "google",
    "model": "gemini-2.5-pro"
  },
  "utility_model": {
    "provider": "native",
    "model": "haiku"
  },
  "consensus_judge": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "native": true
  },
  "agents": {
    "sonnet-reviewer": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "preset": "reviewer",
      "skills": ["code_review", "security_audit", "typescript"],
      "native": true
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `main_agent` | Orchestrator LLM for routing and synthesis |
| `utility_model` | Used for memory compaction, gossip, lens generation. `provider: "native"` uses Claude Code Agent() |
| `consensus_judge` | Model for cross-review synthesis |
| `agents.<id>.provider` | `anthropic`, `google`, `openai`, or `native` |
| `agents.<id>.native` | `true` = runs via Claude Code Agent(), no API key needed |
| `agents.<id>.preset` | `reviewer`, `implementer`, `tester`, `researcher`, `debugger`, `architect` |
| `agents.<id>.skills` | Skill labels for dispatch matching and default skill injection |

## Host compatibility

Gossipcat auto-detects the host environment:

| Host | Detection | Native agents | Rules file |
|------|-----------|---------------|------------|
| Claude Code | `CLAUDECODE=1` | Yes (Agent() tool) | `.claude/rules/gossipcat.md` |
| Cursor | `CURSOR_TRACE_ID` | No | `.cursor/rules/gossipcat.mdc` |
| Windsurf | `WINDSURF` | No | `.windsurfrules` |
| VS Code | `VSCODE_PID` | No | — |

## Requirements

- Node.js 22+
- Claude Code (for native agent dispatch)
- Google API key (optional, for Gemini relay agents)

## License

MIT
