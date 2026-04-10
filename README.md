<p align="center">
  <img src="https://raw.githubusercontent.com/gossipcat-ai/gossipcat-ai/master/packages/dashboard-v2/public/assets/banner.png" alt="Gossipcat" width="600" />
</p>

<p align="center">
  <em>agentic orchestration framework — agents that learn, adapt, and get better every round.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/gossipcat"><img src="https://img.shields.io/npm/v/gossipcat?color=0ea5e9" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/gossipcat"><img src="https://img.shields.io/npm/dw/gossipcat?color=0ea5e9" alt="npm weekly downloads" /></a>
  <a href="https://github.com/gossipcat-ai/gossipcat-ai/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="#quickstart"><img src="https://img.shields.io/badge/node-22%2B-green" alt="Node 22+" /></a>
  <a href="https://github.com/gossipcat-ai/gossipcat-ai/stargazers"><img src="https://img.shields.io/github/stars/gossipcat-ai/gossipcat-ai?style=social" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="#quickstart"><strong>Install</strong></a> ·
  <a href="#first-run--5-minutes"><strong>First Run</strong></a> ·
  <a href="#how-to-use-it-day-to-day"><strong>Daily Use</strong></a> ·
  <a href="#reading-the-dashboard"><strong>Dashboard</strong></a> ·
  <a href="#troubleshooting"><strong>Troubleshooting</strong></a> ·
  <a href="#configuration"><strong>Config</strong></a> ·
  <a href="#for-ai-agents"><strong>For AI Agents</strong></a>
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

**Requirements:** Node.js 22+ and [Claude Code](https://claude.com/claude-code).

### One-liner

```bash
npm install -g https://github.com/gossipcat-ai/gossipcat-ai/releases/latest/download/gossipcat.tgz && \
claude mcp add gossipcat -s user -- gossipcat
```

Restart Claude Code. Then in any project, ask:

> "Set up a gossipcat team for this project"

Claude Code will call `gossip_setup()` to scaffold `.gossip/config.json` and your agent team. First-run bootstrap also writes the dispatch rules and tool catalog so Claude Code knows how to use gossipcat — no manual config needed.

Gossipcat ships from **[GitHub Releases](https://github.com/gossipcat-ai/gossipcat-ai/releases)**, not the npm registry. The install URL above always points at the latest release. `npm` downloads the tarball directly, installs it globally, and drops a `gossipcat` binary on your `PATH` — no `npm publish` involved.

### What the install ships

| | What you get |
|---|---|
| **MCP server** | Bundled binary at `dist-mcp/mcp-server.js`, wired as the `gossipcat` command on `PATH` |
| **Dashboard** | Prebuilt static assets in `dist-dashboard/` — launches automatically on a dynamic port (ask Claude Code *"what's my gossipcat dashboard URL?"*). Override with `GOSSIPCAT_PORT=24420` if you want a stable port. |
| **Default skills + rules + archetypes** | 18 bundled skill templates, operational rules, and project archetypes copied into the install |
| **Postinstall wizard** | Writes `.mcp.json` with correct absolute paths for your machine |

### Alternative install paths

**Pin to a specific version:**
```bash
npm install -g https://github.com/gossipcat-ai/gossipcat-ai/releases/download/v0.1.1/gossipcat-0.1.1.tgz
```

**Project-local install** (each project gets its own gossipcat):
```bash
cd your-project
npm install --save-dev https://github.com/gossipcat-ai/gossipcat-ai/releases/latest/download/gossipcat.tgz
```
The postinstall writes `.mcp.json` to your project root. Open Claude Code in that directory and gossipcat connects automatically — no `claude mcp add` needed.

**From source** (contributors):
```bash
git clone https://github.com/gossipcat-ai/gossipcat-ai.git
cd gossipcat-ai
npm install
npm run build:mcp
claude mcp add gossipcat -s user -- node "$PWD/dist-mcp/mcp-server.js"
```

### Upgrading

Re-run the one-liner — npm will fetch the latest release tarball and replace the installed version:
```bash
npm install -g https://github.com/gossipcat-ai/gossipcat-ai/releases/latest/download/gossipcat.tgz
```
Or in-session, ask Claude Code: *"Check for gossipcat updates"* — the `gossip_update` tool fetches the latest release notes and applies the upgrade with your confirmation.

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
claude mcp add gossipcat -s user -- gossipcat
```
Then in session ask for a team built from `sonnet-reviewer` / `haiku-researcher` / `opus-implementer`. Native agents dispatch through `Agent()` and relay back. Good zero-config starting point.

**Anthropic API** (direct, bypasses Claude Code):
```bash
claude mcp add gossipcat -s user \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -- gossipcat
```
Use this if you want relay agents running Claude models without going through the Claude Code subscription path — e.g. for parallelism beyond Claude Code's concurrency cap, or for running long background reviews while you keep working.

**Google Gemini**:
```bash
claude mcp add gossipcat -s user \
  -e GOOGLE_API_KEY=AIza... \
  -- gossipcat
```
Enables `gemini-reviewer`, `gemini-tester`, `gemini-implementer` on the relay. Watch the quota — gossipcat has a built-in 429 watcher that falls back to native agents when Gemini is cooling down.

**OpenAI** (and OpenAI-compatible gateways):
```bash
claude mcp add gossipcat -s user \
  -e OPENAI_API_KEY=sk-... \
  -- gossipcat
```
For Azure / Together / Groq / OpenRouter, add `OPENAI_BASE_URL`:
```bash
claude mcp add gossipcat -s user \
  -e OPENAI_API_KEY=your-key \
  -e OPENAI_BASE_URL=https://api.groq.com/openai/v1 \
  -- gossipcat
```

**OpenClaw** (local gateway):
```bash
# Start the OpenClaw daemon first (see openclaw docs), default port 18789
claude mcp add gossipcat -s user -- gossipcat
```
No env vars. Configure an agent with `provider: "openclaw"` in `.gossip/config.json` and gossipcat talks to the local gateway automatically. Override the port with `base_url` in the agent config if your daemon runs elsewhere.

**Ollama** (fully local, no API):
```bash
# Pull a model once
ollama pull llama3.1:8b
# Then register gossipcat
claude mcp add gossipcat -s user -- gossipcat
```
Configure the agent with `provider: "local"` and `model: "llama3.1:8b"` in `.gossip/config.json`. Good for airgapped dev, offline work, and burning-down-test-debt sessions where you don't want to spend API credits.

**Mixed setup** (common production shape — Gemini cheap reviewers + Anthropic heavy implementers):
```bash
claude mcp add gossipcat -s user \
  -e GOOGLE_API_KEY=AIza... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -- gossipcat
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

## First Run — 5 Minutes

The fastest path from "just installed" to "first useful review". If you skip this section you'll probably get stuck on the same things everyone else gets stuck on.

### Step 1 — Open Claude Code in any project

```bash
cd ~/your-project
claude
```

Gossipcat is registered globally now, so it boots automatically. You'll see it in the MCP server list.

### Step 2 — Bootstrap once

In Claude Code, just type:

> **Run gossip_status**

This loads gossipcat's operating rules into the current session, creates `.gossip/` in your project on first run, and prints the dashboard URL + auth key. Copy the key — you'll paste it into the dashboard once.

You'll see something like:
```
Status:
  Host: claude-code (native agents supported)
  Relay: running :49664
  Workers: 0
  Dashboard: http://localhost:49664/dashboard (key: c3208820f8f70605fd45fa90004a2a4b)
  Quota: google — OK
```

Open the dashboard URL in your browser, paste the key. You're now connected.

### Step 3 — Create your first team

Tell Claude what you're building:

> **"Set up a gossipcat team for this project — it's a TypeScript Next.js app with a Postgres backend and Stripe payments."**

Claude calls `gossip_setup()` and proposes a team. Typical proposal:

```
Proposed team:
  - sonnet-reviewer    (anthropic/claude-sonnet-4-6, native)   reviewer + security
  - gemini-reviewer    (google/gemini-2.5-pro, relay)          reviewer + types
  - haiku-researcher   (anthropic/claude-haiku-4-5, native)    researcher
  - opus-implementer   (anthropic/claude-opus-4-6, native)     implementer

Approve? (y/n)
```

Native agents (`native: true`) run through your existing Claude Code subscription — **no API key needed**. Relay agents need a key for their provider. If you don't have a Google API key, drop `gemini-reviewer` from the team for now and add it later.

Once you approve, gossipcat writes `.gossip/config.json` and the agents are live.

### Step 4 — Run your first review

In a project where you've made some changes:

> **"Do a consensus review of my recent changes"**

What happens (typical timing):

| Phase | Time | What you see |
|---|---|---|
| 1. Decompose | 1s | Claude picks agents and dispatches them in parallel |
| 2. Independent review | 30s–2min | Each agent reads your diff and reports findings |
| 3. Cross-review | 30s–1min | Each agent reviews the others' findings |
| 4. Consensus report | <1s | Findings tagged CONFIRMED / DISPUTED / UNVERIFIED / UNIQUE |
| 5. Verification | varies | Claude reads UNVERIFIED findings against the code, decides if they're real |
| 6. Signal recording | <1s | Accuracy signals saved per agent |

You get a report like:

```
Consensus round b81956b2-e0fa4ea4 — 3 agents

CONFIRMED (2):
  [critical] Race condition in tasks Map at server.ts:47 — sonnet + gemini
  [high]     Missing auth on WebSocket upgrade at server.ts:112 — sonnet + gemini

UNIQUE (1):
  [medium]   String concat in SQL query at queries.ts:88 — only sonnet caught this

DISPUTED (1):
  [low]      "Memory leak in timer" — haiku says yes, sonnet/gemini say no
             → verified, sonnet was right (not a leak — cleanup is in finally)

Final: 3 real bugs to fix, 1 false alarm caught by cross-review.
```

You only act on **CONFIRMED** + verified **UNIQUE** findings. The cross-review is the whole point — single-agent reviews ship hallucinated bugs as critical findings 5–10% of the time. Cross-review with verification drops that to under 1%.

### Step 5 — Watch the dashboard

The dashboard shows everything live: agents, scores, active tasks, consensus reports, signals. You can leave it open in a tab while you work — every gossipcat tool call pushes an update via WebSocket.

That's the basic loop. The rest of this README covers advanced workflows, troubleshooting, and how to interpret what you're seeing.

<br/>

## How to use it day-to-day

Concrete recipes for the most common workflows. Each one shows what to type, what you'll get back, and what to do with it.

### Recipe 1: Review a diff before committing

**Type:**
> "Review my staged changes"

**What you'll get:** A consensus report (1–3 minutes) with findings tagged CONFIRMED / UNIQUE / DISPUTED. Claude verifies UNVERIFIED findings against the code and tells you which are real.

**What to do with it:** Fix the CONFIRMED + verified-real findings. Ignore disputed-but-falsified findings. If a finding looks important but you disagree, ask Claude *"verify finding f3 against the code yourself"* — it'll re-check and either back you up or push back.

**When NOT to use it:** Tiny diffs (under 20 lines) — overhead exceeds value. Just eyeball them.

---

### Recipe 2: Catch security issues before shipping a feature

**Type:**
> "Security audit the payment handler at lib/stripe/webhook.ts"

**What you'll get:** Each security-skilled agent reviews from a different angle (OWASP, input validation, auth, secrets). Findings get cross-validated. Real vulns surface; theoretical ones get caught and dropped.

**What to do with it:** Fix critical/high findings before merge. Bookmark medium/low findings for the next pass.

**Tip:** Be specific about the file or module. "Security audit the codebase" is too broad and produces noisy results. "Security audit `lib/stripe/webhook.ts`" produces actionable findings.

---

### Recipe 3: Understand a piece of code before changing it

**Type:**
> "Research how the WebSocket connection lifecycle works in this project before I touch it"

**What you'll get:** A research agent (haiku-researcher by default — fast and cheap) reads the code, traces call paths, and writes a summary. The summary is saved to that agent's cognitive memory so the next time you ask about the same area it remembers.

**What to do with it:** Use the summary to plan your change. The agent will reference it next time you ask anything related — no re-discovery cost.

---

### Recipe 4: Verify your own assumption

**Type:**
> "I think there's a race condition in the tasks Map at server.ts:47 — check if I'm right"

**What you'll get:** Two agents independently check the specific claim and either confirm or push back. Author self-review is optimistic — this isn't.

**What to do with it:** If both agree with you, fix it. If they push back, read their reasoning before defending your hypothesis. They might be right.

---

### Recipe 5: See which agents you can actually trust

**Type:**
> "Show me agent scores"

**What you'll get:** A table of agents sorted by reliability with per-category accuracy and dispatch weights. Categories include `trust_boundaries`, `injection_vectors`, `concurrency`, `error_handling`, `data_integrity`, `type_safety`, etc.

**What to do with it:** If `gemini-reviewer` is sitting at 30% accuracy on `concurrency`, you know not to trust its concurrency findings without cross-review. If `sonnet-reviewer` is at 90% on `trust_boundaries`, you can ship its findings on auth/session bugs with high confidence.

---

### Recipe 6: Improve an agent that keeps making the same mistake

**Type:**
> "gemini-reviewer keeps hallucinating about concurrency — develop a skill for it"

**What you'll get:** Gossipcat reads gemini-reviewer's failure data, generates a targeted skill file with concrete anti-patterns, and injects it into the agent's prompt for all future concurrency-related reviews. Effectiveness is measured statistically (z-test on post-bind signals) — it'll tell you if the skill is actually working after ~30 dispatches.

**What to do with it:** Nothing — it's automatic. Just keep using the agent. Over time, the failure rate drops.

---

### Recipe 7: Set up a team for a brand-new project

**Type:**
> "Set up a gossipcat team for a TypeScript Cloudflare Workers project with Drizzle ORM and KV storage"

**What you'll get:** A proposed team with archetypes matched to your stack. Worker projects need different reviewers than long-running Node services — gossipcat picks accordingly.

**What to do with it:** Review the proposal, drop agents you can't run (missing API keys), approve.

---

### Things to avoid

- **Don't ask for "review the whole codebase"** — too broad, agents will pick whatever they find first. Scope to a file, module, or diff.
- **Don't approve findings without reading them** — even after cross-review, ~5% of findings are genuinely wrong. The reasoning matters more than the verdict.
- **Don't ignore the dashboard** — when something feels weird (slow dispatch, repeated failures, suspicious findings), the dashboard usually shows you why before you have to ask.
- **Don't run consensus mode for trivial questions** — `gossip_run` with one agent is fine for "what does this function do?"-tier queries. Save consensus for changes that touch shared state, auth, persistence, or the dispatch pipeline itself.

<br/>

## Reading the dashboard

The dashboard at `http://localhost:<port>/dashboard` is the visual layer over everything gossipcat knows. Open it once with the auth key from `gossip_status`, leave the tab open while you work. Updates push live via WebSocket.

| Panel | What it shows | When to look at it |
|---|---|---|
| **Overview** | Active agents, dispatch weights, recent finding counts | First thing in the morning — quick sanity check |
| **Team** | All agents sorted by reliability score, with category breakdowns | Picking which agent to trust for a tricky finding |
| **Tasks** | Live + historical task list with agent, duration, status | When something feels stuck — find it here first |
| **Findings** | Consensus reports paginated by round, with CONFIRMED/DISPUTED/UNVERIFIED breakdowns | Reviewing what got caught in a recent review |
| **Agent detail** | Per-agent memory entries, skills, score history, task history | Diagnosing why a specific agent keeps failing in a category |
| **Signals** | Raw signal feed (agreement / hallucination / unique_confirmed) | Auditing the scoring pipeline if scores look wrong |
| **Logs** | mcp.log content (boot, errors, warnings) | When the MCP server is misbehaving and you need raw evidence |

**Auth keys rotate every session.** A fresh key is generated each time gossipcat boots. If the dashboard says "unauthorized", run `gossip_status` again to get the new key.

<br/>

## Troubleshooting

### "Dashboard says unauthorized / 401"
The auth key rotates every boot. Run `gossip_status` in Claude Code to get the current key, paste it into the dashboard login.

### "Dashboard URL doesn't load at all"
Check `~/.gossip/mcp.log` (or `<your-project>/.gossip/mcp.log`) for the boot log. Look for the `[gossipcat] 🌐 Dashboard:` line — that's the actual port. If it's missing, the relay didn't start. Common causes:
- **Conflicting `.gossip/relay.pid`** from a crashed previous boot — delete it and restart Claude Code
- **`GOSSIPCAT_PORT` set to a port already in use** — unset the env var or pick a free port

### "Boot says 'No gossip.agents.json found' and nothing happens"
This was a critical bug in v0.1.0 — fixed in v0.1.1. Upgrade with the install one-liner above. v0.1.1+ boots in degraded mode (dashboard + relay only) so you can run `gossip_setup` from inside Claude Code.

### "Agents keep returning empty findings"
Usually a model or quota problem. Check `gossip_status` — it shows `Quota: google — OK` (or `cooling down`) per provider. If you're rate-limited, gossipcat will fall back to native agents automatically, but fallback agents may not be in your team. Either wait for the cooldown or add native agents to your team.

### "The same hallucinated finding keeps coming back"
Record a `hallucination_caught` signal: ask Claude *"record a hallucination_caught signal for finding f3 in the last consensus round — it claimed X but the code shows Y"*. After 3 such signals, the offending agent's score drops in that category and the orchestrator stops asking it questions in that area.

### "I want to use my own model / provider"
Edit `.gossip/config.json` directly. Any OpenAI-compatible endpoint works via `provider: "openai"` + `base_url`. Local models work via Ollama (`provider: "local"`). See the [Configuration](#configuration) section.

### "Multiple Claude Code instances all want gossipcat"
Already supported as of v0.1.1 — each instance gets its own dynamic port. If you want a stable port for one specific instance (e.g. for browser bookmarks), set `GOSSIPCAT_PORT=24420` for that one project's environment.

### "How do I uninstall?"
```bash
npm uninstall -g gossipcat
claude mcp remove gossipcat -s user
rm -rf ~/.gossip  # if you want to wipe global memory + signals
rm -rf <project>/.gossip  # if you want to wipe per-project state
```

### Still stuck?
File an issue at https://github.com/gossipcat-ai/gossipcat-ai/issues. Include the contents of `.gossip/mcp.log` (last 100 lines) and the output of `gossip_status`. Or ask Claude in-session: *"file a gossipcat bug report about <...>"* — the `gossip_bug_feedback` tool packages it up automatically.

<br/>

## Under the hood

Claude Code translates your natural-language requests into gossipcat MCP tool calls automatically — you don't need to type these — but if you want fine-grained control they're documented here:

```
gossip_run(agent_id: "auto", task: "...")        → single-agent task
gossip_dispatch(mode: "consensus", tasks: [...]) → multi-agent review with cross-review
gossip_collect(consensus: true)                  → wait for results, run consensus
gossip_signals(action: "record", signals: [...]) → record accuracy after verification
gossip_scores()                                  → view agent performance
gossip_skills(action: "develop", ...)            → improve a struggling agent
gossip_status()                                  → system status + dashboard URL
gossip_setup(...)                                → create or update your team
```

The dispatch rules at `.claude/rules/gossipcat.md` (auto-generated on first boot) teach Claude Code when to pick which mode based on what your change touches. You can edit these rules to bias the dispatch.

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

## Dashboard internals

> User-facing dashboard guide is in [Reading the dashboard](#reading-the-dashboard) above. This section covers the build + tech stack.

Built with React + Vite + shadcn/ui. Source lives at `packages/dashboard-v2/`. The bundled assets ship in `dist-dashboard/` and the relay serves them as static files at `http://localhost:<dynamic-port>/dashboard/`. Live updates push via WebSocket — every gossipcat tool call emits an event that connected dashboard tabs receive in real time.

To rebuild from source (contributors only):
```bash
npm run build:dashboard
```

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
| npm package — one-liner install with bundled MCP server + dashboard | ✅ Shipped |
| Full implementation workflow (agents write code) | 🔄 In progress |
| Dashboard enrichment (graphs, trends, session history) | ☐ Planned |
| Local Postgres migration (embedded Postgres for tasks/signals/consensus/memory — unblocks full task results, real queries, no more JSONL scans) | ☐ Planned |
| Full Cursor support | ☐ Planned |
| Windsurf / VS Code parity | ☐ Planned |
| Standalone CLI (no IDE required) | ☐ Planned |
| CLI parity with MCP pipeline (gossip, task graph, agent memory in chat mode) | ☐ Planned |

<br/>

## Contributing

Gossipcat is open source and early-stage — bug reports, feature ideas, and PRs are all welcome.

- **Bugs / feature requests** → [open an issue](https://github.com/gossipcat-ai/gossipcat-ai/issues). Or ask Claude Code directly: *"File a gossipcat bug report about <...>"* — the `gossip_bug_feedback` tool posts structured issues from your current session.
- **Pull requests** → fork, branch, PR against `master`. Run `npm test` before pushing. Commit messages follow conventional commits (`fix:`, `feat:`, `chore:`, `docs:`).
- **Discussions** → new ideas, design questions, "should this be a feature?" → [GitHub Discussions](https://github.com/gossipcat-ai/gossipcat-ai/discussions).

See `CLAUDE.md` in the repo for the operational rules gossipcat's own agents follow during development — it's a useful read if you want to understand the signal pipeline and consensus workflow from the inside.

### Cutting a release (maintainers)

Releases go to GitHub Releases via a two-stage script that respects branch protection — no direct commits to master.

```bash
# Stage 1 — open the version bump PR
./scripts/release.sh 0.1.2

# review + merge the PR via gh or web UI
gh pr merge <pr-number> --squash --delete-branch

# Stage 2 — build, tag, release (from master, after the PR is merged)
git checkout master && git pull
./scripts/release.sh   # no args
```

Stage 1 creates `chore/release-X.Y.Z`, bumps `package.json`, opens the PR, exits. Stage 2 reads the version from `package.json`, builds the MCP bundle + dashboard, packs the tarball, tags, pushes the tag, and creates the GitHub release with auto-generated notes from commits since the last tag.

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
