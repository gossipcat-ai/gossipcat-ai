<p align="center">
  <img src="packages/dashboard-v2/public/assets/banner.png" alt="Gossipcat" width="600" />
</p>

<p align="center">
  <em>agentic orchestration framework — agents that learn, adapt, and get better every round.</em>
</p>

<p align="center">
  <a href="https://github.com/ataberk-xyz/gossipcat-ai/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="#quickstart"><img src="https://img.shields.io/badge/node-22%2B-green" alt="Node 22+" /></a>
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> ·
  <a href="#how-it-works"><strong>How It Works</strong></a> ·
  <a href="#usage"><strong>Usage</strong></a> ·
  <a href="#for-ai-agents"><strong>For AI Agents</strong></a> ·
  <a href="#dashboard"><strong>Dashboard</strong></a> ·
  <a href="#configuration"><strong>Configuration</strong></a> ·
  <a href="#roadmap"><strong>Roadmap</strong></a>
</p>

<br/>

## What is Gossipcat?

Gossipcat is an MCP server that orchestrates multiple AI agents to review your code in parallel. Agents independently review, then cross-review each other's findings. Agreements are confirmed. Hallucinations are caught and penalized. Over time, each agent builds an accuracy profile — the system learns who to trust for what.

<br/>

## Why multi-agent?

| Without gossipcat | With gossipcat |
|---|---|
| One AI reviews your code — and hallucinates a finding you waste 20 minutes on | Multiple agents cross-check each other — hallucinations get caught before you see them |
| Every agent gets the same tasks regardless of track record | Dispatch weights route tasks to the agent with the best accuracy in that category |
| An agent keeps making the same class of mistake | Skill files are auto-generated from failure data and injected into future prompts |
| You don't know which agent to trust | Accuracy, uniqueness, and reliability scores are tracked per agent, per category |

<br/>

## Gossipcat is right for you if

- You want **multiple AI models** catching different classes of bugs
- You don't trust a single agent to catch everything
- You want agents to **cross-check each other's findings** before you act on them
- You want to know which agents are **actually accurate** vs. hallucinating
- You want agents that **get better over time** based on their track record

<br/>

## Features

<table>
<tr>
<td align="center" width="33%">
<h3>Consensus Review</h3>
3+ agents review independently, then cross-review each other. Findings tagged as CONFIRMED, DISPUTED, or UNIQUE.
</td>
<td align="center" width="33%">
<h3>Adaptive Dispatch</h3>
Agent accuracy is tracked per-category. Dispatch weights adjust automatically — the best agent for the job gets picked.
</td>
<td align="center" width="33%">
<h3>Skill Development</h3>
When an agent keeps failing in a category, targeted skills are generated from failure data and injected into future prompts. Effectiveness is measured with a z-test on post-bind signals — passed, failed, or inconclusive.
</td>
</tr>
<tr>
<td align="center">
<h3>Multi-Provider</h3>
Mix Anthropic, Google, OpenAI, and OpenClaw agents in one team. Each brings different strengths. Native agents need no API key. 🦞 Lobster friendly.
</td>
<td align="center">
<h3>Live Dashboard</h3>
Real-time view of tasks, consensus reports, agent scores, and activity feed. Terminal Amber theme. WebSocket updates.
</td>
<td align="center">
<h3>Agent Memory</h3>
Per-agent cognitive memory persists across sessions. Agents remember past findings, patterns, and project context.
</td>
</tr>
</table>

<br/>

<div align="center">
<table>
  <tr>
    <td align="center"><strong>Works<br/>with</strong></td>
    <td align="center">
      <img src="https://img.shields.io/badge/Claude%20Code-supported-orange?style=flat&logo=anthropic&logoColor=white" alt="Claude Code" /><br/><sub>Full support</sub>
    </td>
    <td align="center"><strong>Cursor</strong><br/><sub>Not yet</sub></td>
    <td align="center"><strong>Windsurf</strong><br/><sub>Not yet</sub></td>
    <td align="center"><strong>VS Code</strong><br/><sub>Not yet</sub></td>
  </tr>
</table>

<br/>

<table>
  <tr>
    <td align="center"><strong>Provider<br/>gateways</strong></td>
    <td align="center">
      <img src="https://img.shields.io/badge/OpenClaw-gateway-4A90D9?style=flat" alt="OpenClaw" /><br/><sub>HTTP gateway ✅</sub>
    </td>
    <td align="center">
      <img src="https://img.shields.io/badge/Ollama-local-gray?style=flat" alt="Ollama" /><br/><sub>Local models ✅</sub>
    </td>
    <td align="center">
      <img src="https://img.shields.io/badge/OpenAI--compatible-any-green?style=flat" alt="OpenAI-compatible" /><br/><sub>Any base_url ✅</sub>
    </td>
  </tr>
</table>
</div>

<br/>

## How it works

```
  dispatch ──→ parallel review ──→ cross-review ──→ consensus
                                                       │
                                                 ┌─────┴─────┐
                                                 ▼           ▼
                                             signals    skill development
                                                 │           │
                                                 ▼           ▼
                                          dispatch weights   targeted prompts
                                          (who gets picked)  (agent improves)
```

| Step | What happens |
|------|-------------|
| **Dispatch** | Tasks routed to agents based on dispatch weights (accuracy history per category) |
| **Parallel review** | Agents work independently, each producing findings with confidence scores |
| **Cross-review** | Each agent reviews peers' findings: agree, disagree, unverified, or new finding |
| **Consensus** | Findings deduplicated and tagged: CONFIRMED, DISPUTED, UNVERIFIED, UNIQUE |
| **Signals** | You verify findings against code and record accuracy signals |
| **Skill development** | Agents with repeated failures get targeted skill files injected into future prompts |

<br/>

## Two types of agents

| | Native | Relay |
|---|---|---|
| **Runs as** | Claude Code subagent (`Agent()` tool) | WebSocket worker on relay server |
| **Providers** | Anthropic (Claude) | Google (Gemini), OpenAI, any provider |
| **API key** | None — uses your Claude Code subscription | Required per provider |
| **Defined in** | `.claude/agents/*.md` | `.gossip/config.json` |
| **Consensus** | Yes | Yes |
| **Memory & Skills** | Yes | Yes |

Both types participate equally in consensus, cross-review, and skill development. Native subagents get skill files injected into their system prompts and can call `gossip_remember` for memory recall. Relay workers call the equivalent `memory_query` tool and get `file_read` + `file_grep` during cross-review so their verification parity matches natives.

<br/>

## Quickstart

**Requirements:** Node.js 22+

### 1. Clone and build

```bash
git clone https://github.com/ataberk-xyz/gossipcat-ai.git
cd gossipcat-ai
npm install
npm run build:mcp
```

`npm install` generates `.mcp.json` with the correct paths for your machine. `build:mcp` bundles the MCP server. Open Claude Code in this directory and gossipcat connects automatically.

To register globally (available in all projects):
```bash
claude mcp add gossipcat -s user -- node /absolute/path/to/gossipcat-ai/dist-mcp/mcp-server.js
```

### 2. Build the dashboard (optional)

```bash
npm run build:dashboard
```

Launches automatically on port `24420`. Skip this if you don't need the visual dashboard.

### 3. API keys

Add env vars for the providers you want to use. Pass them with `-e` when registering, or set them in your shell environment.

| Provider | Env var | Notes |
|----------|---------|-------|
| Native (Claude Code) | — | Dispatches through your active Claude Code subscription. No key needed. |
| Anthropic API | `ANTHROPIC_API_KEY` | Direct API access if you don't want to go through Claude Code. |
| Google Gemini | `GOOGLE_API_KEY` | Gemini Pro / Flash relay agents. |
| OpenAI | `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`) | GPT-4 / GPT-4o relay agents. `OPENAI_BASE_URL` lets you point at OpenAI-compatible gateways (Azure, Together, Groq, etc.). |
| OpenClaw | — (local gateway) | OpenAI-compatible, defaults to `http://127.0.0.1:18789/v1`. No API key — auth handled by your local OpenClaw daemon. |
| Ollama (local) | — | Runs locally via `http://localhost:11434`. No key. Pull your model first with `ollama pull llama3.1:8b`. |

#### Examples — registering gossipcat with each provider

**Native only** (zero API keys — everything runs through Claude Code):
```bash
claude mcp add gossipcat -s user -- node /path/to/gossipcat/dist-mcp/mcp-server.js
```
Then in session ask for a team built from `sonnet-reviewer` / `haiku-researcher` / `opus-implementer`. Native agents dispatch through `Agent()` and relay back. Good zero-config starting point.

**Anthropic API** (direct, bypasses Claude Code):
```bash
claude mcp add gossipcat -s user \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -- node /path/to/gossipcat/dist-mcp/mcp-server.js
```
Use this if you want relay agents running Claude models without going through the Claude Code subscription path — e.g. for parallelism beyond Claude Code's concurrency cap, or for running long background reviews while you keep working.

**Google Gemini**:
```bash
claude mcp add gossipcat -s user \
  -e GOOGLE_API_KEY=AIza... \
  -- node /path/to/gossipcat/dist-mcp/mcp-server.js
```
Enables `gemini-reviewer`, `gemini-tester`, `gemini-implementer` on the relay. Watch the quota — gossipcat has a built-in 429 watcher that falls back to native agents when Gemini is cooling down.

**OpenAI** (and OpenAI-compatible gateways):
```bash
claude mcp add gossipcat -s user \
  -e OPENAI_API_KEY=sk-... \
  -- node /path/to/gossipcat/dist-mcp/mcp-server.js
```
For Azure / Together / Groq / OpenRouter, add `OPENAI_BASE_URL`:
```bash
claude mcp add gossipcat -s user \
  -e OPENAI_API_KEY=your-key \
  -e OPENAI_BASE_URL=https://api.groq.com/openai/v1 \
  -- node /path/to/gossipcat/dist-mcp/mcp-server.js
```

**OpenClaw** (local gateway):
```bash
# Start the OpenClaw daemon first (see openclaw docs), default port 18789
claude mcp add gossipcat -s user -- node /path/to/gossipcat/dist-mcp/mcp-server.js
```
No env vars. Configure an agent with `provider: "openclaw"` in `.gossip/config.json` and gossipcat talks to the local gateway automatically. Override the port with `base_url` in the agent config if your daemon runs elsewhere.

**Ollama** (fully local, no API):
```bash
# Pull a model once
ollama pull llama3.1:8b
# Then register gossipcat
claude mcp add gossipcat -s user -- node /path/to/gossipcat/dist-mcp/mcp-server.js
```
Configure the agent with `provider: "local"` and `model: "llama3.1:8b"` in `.gossip/config.json`. Good for airgapped dev, offline work, and burning-down-test-debt sessions where you don't want to spend API credits.

**Mixed setup** (common production shape — Gemini cheap reviewers + Anthropic heavy implementers):
```bash
claude mcp add gossipcat -s user \
  -e GOOGLE_API_KEY=AIza... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -- node /path/to/gossipcat/dist-mcp/mcp-server.js
```
Then set up a team with `gemini-reviewer` + `haiku-researcher` (native) + `opus-implementer` (native) + `sonnet-reviewer` (native). Gossipcat dispatches by category strength from the signal pipeline.

Keys are stored persistently and cross-platform:
- **macOS** — OS Keychain
- **Linux** — Secret Service (`secret-tool`)
- **Windows / other** — AES-256-GCM encrypted file

### 4. Initialize your team

Start a Claude Code session in any project and ask Claude to set up your team:

```
"Set up a gossipcat team with a Gemini reviewer and a Sonnet implementer"
```

Claude Code calls `gossip_setup()` to create your `.gossip/config.json` and agent definitions. You choose the providers, models, and roles — gossipcat adapts to your setup.

Available presets: `reviewer`, `implementer`, `tester`, `researcher`, `debugger`, `architect`, `security`, `designer`, `planner`, `devops`, `documenter`

<br/>

## Use Cases

### Build something — gossipcat picks the team

```
"I want to build a Stripe integration, set up a team for that"
"I'm adding real-time notifications — what agents do I need?"
"Set up a team for a TypeScript REST API project"
```

Describe what you're building. Gossipcat proposes an agent team tailored to the task — right presets, right skills, right mix of providers. You review the proposal and approve it. From that point on, agents dispatch automatically based on what your code touches.

---

### Review code before committing

```
"Review the changes I just made"
"Do a consensus review on the auth module"
"Check my last 3 commits for bugs"
```

Three agents review your diff independently, then cross-check each other's findings. You get a report with CONFIRMED bugs (multiple agents agree), DISPUTED findings (agents disagree), and UNIQUE findings (only one agent found it). You only act on what's verified.

---

### Catch security issues

```
"Security audit the payment handler"
"Check the login flow for vulnerabilities"
"Review the API endpoints for injection risks"
```

Dispatch your security-focused agents in parallel. Each reviews from a different angle — one checks OWASP vectors, another checks input validation, another checks auth logic. Findings that survive cross-review are real.

---

### Research a codebase before building

```
"Research how the WebSocket connection lifecycle works before I touch it"
"Explain the dispatch pipeline — I need to add a new routing mode"
```

Agents read the code, trace call paths, and write a summary back to session memory. Next time you ask about the same area, they already know it.

---

### Get a second opinion on your own review

```
"I think there's a race condition in this Map — check if I'm right"
"Verify whether this fix actually resolves the issue"
```

Describe what you think you're seeing. Agents check independently and either confirm or disprove it. Author self-review is optimistic by nature — this isn't.

---

### Track which agents are actually reliable

```
"Show me agent scores"
"Which agent is best at security reviews?"
```

Every finding gets verified and turned into a signal. Accuracy, uniqueness, and reliability are tracked per agent. Over time, dispatch weights shift — the agents that keep catching real bugs get more work.

---

### Improve a struggling agent

```
"Gemini keeps hallucinating about concurrency — fix it"
"Develop a skill for the reviewer's repeated type-safety misses"
```

Gossipcat generates a targeted skill file from the agent's failure data and injects it into future prompts. Signals penalize past mistakes; skills prevent future ones.

<br/>

## Usage

Once gossipcat is installed, you interact with it through natural language in Claude Code. The CLAUDE.md rules file (auto-generated on first boot) teaches Claude Code how to use the gossipcat tools — you just describe what you want.

### What to say to Claude Code

| What you want | What to type |
|---------------|-------------|
| Review your latest changes | *"Review my recent changes"* |
| Deep review of critical code | *"Do a consensus review on the auth module"* |
| Catch security issues | *"Security audit the payment handler"* |
| Research before building | *"How does the dispatch pipeline work?"* |
| Get a second opinion | *"Check if I'm right about this race condition"* |
| Check which agents are performing well | *"Show me agent scores"* |
| Improve a struggling agent | *"Develop a skill for the reviewer's type-safety misses"* |
| Save context for next session | *"Save session"* |

Claude Code reads the dispatch rules from `.claude/rules/gossipcat.md` and automatically decides whether to use single-agent, parallel, or consensus mode based on what your change touches.

### Example session

```
You:    "Review the changes I made to the relay server with the gossipcat team"

Claude: Dispatches 3 agents via gossip_dispatch(mode: "consensus")
        → sonnet-reviewer checks for security issues
        → gemini-reviewer checks for logic bugs
        → gemini-tester checks for edge cases

        Cross-review round: agents review each other's findings

        Consensus report:
        ✓ CONFIRMED: race condition in connection cleanup (3/3 agree)
        ✓ CONFIRMED: missing error handler on WebSocket close (2/3 agree)
        ? UNVERIFIED: potential memory leak in Map (1 found, others couldn't verify)

        Claude verifies the UNVERIFIED finding against your code,
        records accuracy signals, and presents the final report.
```

### Under the hood

Claude Code translates your requests into gossipcat MCP tool calls:

```
gossip_run(agent_id: "auto", task: "...")        → single-agent task
gossip_dispatch(mode: "consensus", tasks: [...]) → multi-agent review
gossip_collect(consensus: true)                  → cross-review + report
gossip_signals(action: "record", signals: [...]) → record accuracy
gossip_scores()                                  → view agent performance
gossip_skills(action: "develop", ...)            → improve struggling agents
```

You don't need to type these — Claude Code handles tool selection. But you can call them directly if you want fine-grained control.

<br/>

## For AI Agents

> **Currently supported orchestrator: Claude Code only.** Cursor, Windsurf, and VS Code agents do not yet have native agent support and cannot run consensus cross-review. If you are reading this as a Claude Code instance with the gossipcat MCP server connected, this guide applies to you.

If you are a Claude Code instance reading this to understand how to use gossipcat, here is the complete operational guide.

**You are the orchestrator.** Gossipcat gives you tools to dispatch work to a team of specialized agents, collect their results, run cross-review consensus, and record accuracy signals. You do not implement code directly — you coordinate.

### Step 1 — Check what you have

```
gossip_status()
```

This tells you: which agents are available, their providers/models, relay status, dashboard URL, and suggested workflows. Always call this first in a new session.

### Step 2 — Dispatch work

**Single agent (auto-selected):**
```
gossip_run(agent_id: "auto", task: "Review the auth module for security issues")
```
The system picks the best agent for the task based on past accuracy. For relay agents, this returns the result directly. For native agents (Claude Code subagents), it returns `⚠️ EXECUTE NOW` instructions — follow them immediately in the same response.

**Parallel (fan-out, no consensus):**
```
gossip_dispatch(mode: "parallel", tasks: [
  { agent_id: "gemini-reviewer", task: "..." },
  { agent_id: "sonnet-reviewer", task: "..." }
])
```

**Consensus (cross-review):**
```
gossip_dispatch(mode: "consensus", tasks: [
  { agent_id: "gemini-reviewer", task: "..." },
  { agent_id: "sonnet-reviewer", task: "..." },
  { agent_id: "haiku-researcher", task: "..." }
])
```

### Step 3 — Collect results

```
gossip_collect(task_ids: ["id1", "id2", "id3"], consensus: true)
```

With `consensus: true`, agents cross-review each other's findings. If native agents are in the round, `gossip_collect` returns `⚠️ EXECUTE NOW` with prompts — dispatch those `Agent()` calls immediately, then relay each result via `gossip_relay_cross_review`.

### Step 4 — Verify and record signals

After consensus, **verify every UNVERIFIED finding** against the actual code (grep/read the cited files). Then record signals:

```
gossip_signals(action: "record", signals: [{
  signal: "unique_confirmed",   // or "hallucination_caught", "agreement"
  agent_id: "gemini-reviewer",
  finding: "Race condition in task map at line 47",
  finding_id: "<consensus_id>:<agent_id>:f1"   // mandatory
}])
```

Signals update dispatch weights. Agents that hallucinate get penalized. Agents that catch real bugs get promoted.

### Key rules

- **Always follow `⚠️ EXECUTE NOW`** — dispatch those `Agent()` calls in the same response, do not wait.
- **Never leave UNVERIFIED findings unexamined** — read the code, confirm or deny, record the signal.
- **`finding_id` is mandatory on every signal** — format: `<consensus_id>:<agent_id>:fN`.
- **Use `gossip_progress` after reconnect** — if a consensus round was in flight, it re-surfaces the pending EXECUTE NOW prompts.

### When to use consensus

Use `gossip_dispatch(mode: "consensus")` when the change touches: shared mutable state, auth/sessions, file persistence, or the core dispatch pipeline. Use `gossip_run` for single-agent research, exploration, or review tasks that don't need cross-validation.

---

## MCP Tools

These tools are called by the internal LLM (the orchestrator — Claude Code with gossipcat MCP). You don't invoke them manually; the orchestrator selects and calls them based on your requests.

| Tool | Purpose |
|------|---------|
| `gossip_status` | System status, dashboard URL, agent list |
| `gossip_run` | Single-agent dispatch with auto agent selection |
| `gossip_dispatch` | Multi-agent dispatch: `single`, `parallel`, or `consensus` |
| `gossip_collect` | Collect results with optional cross-review synthesis |
| `gossip_relay` | Feed native agent results back into the pipeline |
| `gossip_relay_cross_review` | Feed native cross-review results into consensus |
| `gossip_plan` | Decompose task into sub-tasks with agent assignments |
| `gossip_signals` | Record or retract accuracy signals |
| `gossip_scores` | View agent accuracy, uniqueness, and dispatch weights |
| `gossip_skills` | Develop, bind, unbind, or list per-agent skills |
| `gossip_setup` | Create or update agent team |
| `gossip_session_save` | Save session context for next session |
| `gossip_remember` | Search an agent's cognitive memory |
| `gossip_progress` | Check in-progress task status |
| `gossip_tools` | List all available tools |
| `gossip_update` | Check for or apply gossipcat updates from npm |
| `gossip_bug_feedback` | File a GitHub issue on the gossipcat repo from an in-session bug report |

<br/>

## Dashboard

Build the dashboard (one time):
```bash
npm run build:dashboard
```

The dashboard launches automatically on port `24420` when gossipcat boots. Run `gossip_status` to get the URL and auth key:

```
Dashboard: http://localhost:24420/dashboard (key: a1b2c3...)
```

A new auth key is generated each session. Paste it when prompted to log in.

Built with React + Vite + shadcn/ui:

- **Overview** — agent cards with dispatch weights, recent tasks, finding metrics
- **Team** — all agents sorted by reliability
- **Tasks** — task history with agent, duration, and status
- **Findings** — consensus reports with CONFIRMED/DISPUTED/UNVERIFIED breakdowns
- **Agent detail** — per-agent memory, skills, scores, and task history

Live updates via WebSocket — every tool call pushes events to connected clients.

<br/>

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

<br/>

## OpenClaw Integration

<p align="center">
  <img src="https://img.shields.io/badge/OpenClaw-gateway-4A90D9?style=for-the-badge" alt="OpenClaw" />
  <img src="https://img.shields.io/badge/%F0%9F%A6%9E-lobster%20friendly-red?style=for-the-badge" alt="Lobster friendly" />
</p>

Gossipcat supports [OpenClaw](https://github.com/openclaw/openclaw) as a provider gateway. OpenClaw runs locally and exposes an OpenAI-compatible HTTP API — gossipcat talks to it like any other relay agent, with your stored gateway token and a separate quota slot so OpenClaw rate limits never bleed into your OpenAI agents.

### Wiring an OpenClaw agent

Store your gateway token once (macOS):
```bash
security add-generic-password -s gossip-mesh -a openclaw -w <your-gateway-token>
```

On Linux:
```bash
secret-tool store --label "Gossip Mesh openclaw" service gossip-mesh provider openclaw
# (enter token when prompted)
```

Then add it to your team:
```
"Add an OpenClaw reviewer to my team"
```

Or directly via `gossip_setup`:
```
gossip_setup(mode: "merge", agents: [{
  id: "openclaw-agent",
  type: "custom",
  provider: "openclaw",
  custom_model: "openclaw/default",
  role: "reviewer",
  skills: ["code_review", "typescript"]
}])
```

The gateway runs at `http://127.0.0.1:18789/v1` by default. Override with `base_url` if yours is on a different port. Available models: `openclaw`, `openclaw/default`, `openclaw/main`.

Once added, the agent participates in consensus rounds, accumulates accuracy signals, and gets skill files generated from its failure patterns — same as any other agent in the mesh.

<br/>

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
| `main_agent` | Internal tool LLM for routing, planning, and synthesis |
| `utility_model` | Memory compaction, gossip, lens generation |
| `consensus_judge` | Model for cross-review synthesis |
| `agents.<id>.provider` | `anthropic`, `google`, `openai`, `openclaw`, `local` |
| `agents.<id>.base_url` | Custom endpoint for `openai`/`openclaw` (e.g. `http://127.0.0.1:18789/v1`) |
| `agents.<id>.native` | `true` = runs via Claude Code Agent(), no API key |
| `agents.<id>.preset` | `reviewer`, `implementer`, `tester`, `researcher`, `debugger`, `architect`, `security`, `designer`, `planner`, `devops`, `documenter` |
| `agents.<id>.skills` | Skill labels for dispatch matching |

<br/>

## Host compatibility

Gossipcat auto-detects the host environment:

| Host | Native agents | Rules file |
|------|---------------|------------|
| Claude Code | Yes | `.claude/rules/gossipcat.md` |
| Cursor | No | `.cursor/rules/gossipcat.mdc` |
| Windsurf | No | `.windsurfrules` |
| VS Code | No | — |

<br/>

## Roadmap

| Feature | Status |
|---------|--------|
| Consensus code review | ✅ Shipped |
| Adaptive dispatch weights | ✅ Shipped |
| Per-agent skill development | ✅ Shipped |
| Agent cognitive memory | ✅ Shipped |
| Live dashboard | ✅ Shipped |
| Cross-platform key storage | ✅ Shipped |
| OpenAI-compatible gateway support (`base_url`) | ✅ Shipped |
| OpenClaw provider integration 🦞 | ✅ Shipped |
| Local LLM support (Ollama) | ✅ Shipped |
| Statistical skill effectiveness (z-test on per-category accuracy, auto pass/fail verdicts) | ✅ Shipped |
| Native subagents get skill injection + cognitive memory recall | ✅ Shipped |
| Relay cross-reviewers get `file_read` + `file_grep` (closes tool-blindness gap with natives) | ✅ Shipped |
| Full implementation workflow (agents write code) | 🔄 In progress |
| Dashboard enrichment (graphs, trends, session history) | ☐ Planned |
| Local Postgres migration (embedded Postgres for tasks/signals/consensus/memory — unblocks full task results, real queries, no more JSONL scans) | ☐ Planned |
| Full Cursor support | ☐ Planned |
| Windsurf / VS Code parity | ☐ Planned |
| Standalone CLI (no IDE required) | ☐ Planned |
| CLI parity with MCP pipeline (gossip, task graph, agent memory in chat mode) | ☐ Planned |

<br/>


<br/>

## Star History

<a href="https://www.star-history.com/?repos=gossipcat-ai%2Fgossipcat-ai&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=gossipcat-ai/gossipcat-ai&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=gossipcat-ai/gossipcat-ai&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=gossipcat-ai/gossipcat-ai&type=date&legend=top-left" />
 </picture>
</a>

## License

[MIT](LICENSE)
