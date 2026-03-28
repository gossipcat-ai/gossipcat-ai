# Gossipcat Dashboard — Local Web UI

**Date:** 2026-03-29
**Status:** Spec (approved mockups)

---

## Overview

A local web dashboard served from the gossipcat relay server. Shows agent metrics, live consensus activity, skill management, and memory exploration. Real-time updates via WebSocket.

**Users:** End users who install gossipcat in their projects.
**Theme:** Deep purple (dark indigo backgrounds, violet/purple accents, subtle gradients).
**Layout:** Tabbed sections — Overview, Agents, Consensus, Skills, Memory.
**Interactivity:** Read-only with light controls (skill enable/disable toggles).
**Updates:** Live via WebSocket from the relay.

## Authentication

Simple shared-secret auth for local access:

1. On first boot, generate a random 32-char hex key, save to `.gossip/dashboard-key`
2. Relay serves dashboard at `http://localhost:<relay-port>/dashboard`
3. If no valid session cookie, show a key prompt page
4. User enters key → validated against file → session cookie set (24h expiry)
5. CLI prints on boot: `[gossipcat] Dashboard: http://localhost:59103/dashboard (key: <first 8 chars>...)`
6. Key is regenerated on `gossip_setup` (invalidates old sessions)

No OAuth, no user accounts. Local-only access.

## Architecture

### Server-side (relay package)

The relay already has an HTTP server (`createServer` in `packages/relay/src/server.ts`). Add HTTP routes:

```
GET /dashboard           → serve index.html (SPA)
GET /dashboard/assets/*  → serve static assets (CSS, JS)
GET /dashboard/api/auth  → validate key, set session cookie
GET /dashboard/api/overview  → stat counts
GET /dashboard/api/agents    → agent scores + configs
GET /dashboard/api/consensus → recent consensus reports
GET /dashboard/api/skills    → skill index data
GET /dashboard/api/memory/:agentId → agent knowledge files
POST /dashboard/api/skills/bind   → bind/unbind/toggle skill
WS  /dashboard/ws        → live event stream
```

API reads directly from `.gossip/` files — same data the MCP tools use. No database.

### Client-side (single-page app)

Vanilla HTML/CSS/JS — no React, no build step. Served as static files from the relay. The dashboard is small enough to be a single bundled HTML file with inline CSS/JS, or a few static assets.

**Why no framework?** The dashboard has 5 views with simple data rendering. A framework adds build complexity, dependencies, and maintenance burden for something that's essentially a formatted data viewer. Vanilla JS with template literals is sufficient.

### WebSocket live events

The relay broadcasts events to connected dashboard clients:

```typescript
interface DashboardEvent {
  type: 'task_dispatched' | 'task_completed' | 'task_failed'
      | 'consensus_started' | 'consensus_complete'
      | 'skill_changed' | 'agent_connected' | 'agent_disconnected';
  timestamp: string;
  data: Record<string, unknown>;
}
```

Dashboard JS connects to `/dashboard/ws`, receives events, updates the UI incrementally. No polling.

## Tabs

### 1. Overview (landing page)

**Top row:** 4 stat cards
- Agents Online (count, relay vs native breakdown)
- Consensus Runs (today count)
- Total Findings (confirmed count highlighted)
- Performance Signals (lifetime count)

**Bottom left:** Agent Scores
- Each agent: name, native badge, dispatch weight
- Bar charts: accuracy, uniqueness, reliability (0-1 scale)
- Sorted by dispatch weight descending

**Bottom right:** Live Activity Timeline
- Chronological event feed with colored dots
- Green: consensus complete / task success
- Purple: task dispatched / relay events
- Yellow: skill gaps / warnings
- Red: task failures / disputes
- Auto-scrolls as new events arrive via WebSocket

### 2. Agents

Per-agent detail cards (expandable):
- Provider, model, preset
- Dispatch weight + signal breakdown (agree/disagree/unique/hallucinate counts)
- Assigned skills (from skill index, with enabled/disabled state)
- Recent tasks (last 5 from tasks.jsonl)
- Competency profile: reviewStrengths per category as small bar charts

### 3. Consensus

List of consensus runs (most recent first):
- For each run: agent count, timestamp, finding counts (confirmed/disputed/unverified/unique/new)
- Expandable: shows individual findings with tags, evidence, agent attributions
- Color-coded: green confirmed, red disputed, yellow unverified, gray unique, blue new
- Shows which agents agreed/disagreed on each finding

### 4. Skills

Two panels:
- **Left:** Skill index table — all agents × all skills as a grid
  - Cells show enabled (purple check) / disabled (gray X) / unbound (empty)
  - Click to toggle enable/disable (calls POST /dashboard/api/skills/bind)
- **Right:** Skill gap suggestions
  - From getSkillGapSuggestions() output
  - Agent name, weak category, score vs team median
  - "Develop Skill" button (shows the MCP command to copy)

### 5. Memory

Agent selector dropdown, then:
- **MEMORY.md** rendered as HTML (the agent's index)
- **Knowledge files** listed with descriptions, expandable to show full content
- **Cognitive summaries** highlighted (the LLM-generated "You reviewed..." entries)
- **Tasks.jsonl** as a table: date, task summary, importance, warmth score

## File structure

```
packages/dashboard/
├── src/
│   ├── index.html        ← SPA shell with inline CSS
│   ├── app.js            ← Tab routing, WebSocket, API calls
│   ├── tabs/
│   │   ├── overview.js   ← Overview tab renderer
│   │   ├── agents.js     ← Agents tab renderer
│   │   ├── consensus.js  ← Consensus tab renderer
│   │   ├── skills.js     ← Skills tab renderer
│   │   └── memory.js     ← Memory tab renderer
│   └── style.css         ← Deep purple theme
├── package.json
└── build.js              ← Simple esbuild bundle → single file
```

Build output: `dist-dashboard/index.html` (self-contained, served by relay).

## API endpoints (detail)

All endpoints require valid session cookie (from auth flow).

### GET /dashboard/api/overview
Returns: `{ agentsOnline, relayCount, nativeCount, consensusRuns, totalFindings, confirmedFindings, totalSignals }`
Source: count from agent configs + parse `agent-performance.jsonl` summary

### GET /dashboard/api/agents
Returns: `Array<{ id, provider, model, preset, native, scores: { accuracy, uniqueness, reliability, dispatchWeight, signals, agrees, disagrees, hallucinations } }>`
Source: `PerformanceReader.getScores()` + agent configs

### GET /dashboard/api/consensus
Returns: `Array<{ timestamp, agentCount, confirmed, disputed, unverified, unique, newFindings, findings: [...] }>`
Source: New file `.gossip/consensus-history.jsonl` — each `runConsensus()` call appends the full `ConsensusReport` as a JSON line. This is a new write added to `dispatch-pipeline.ts` alongside the existing signal writes. Without this, consensus data must be reconstructed from individual signals in `agent-performance.jsonl`, which loses finding text and agent attributions.

### GET /dashboard/api/skills
Returns: `{ index: SkillIndexData, suggestions: string[] }`
Source: `SkillIndex.getIndex()` + `getSkillGapSuggestions()`

### GET /dashboard/api/memory/:agentId
Returns: `{ index: string, knowledge: Array<{ filename, frontmatter, content }>, tasks: Array<TaskMemoryEntry> }`
Source: Read from `.gossip/agents/:agentId/memory/`

### POST /dashboard/api/skills/bind
Body: `{ agent_id, skill, enabled }`
Action: Calls `SkillIndex.bind()` or `SkillIndex.enable()`/`disable()`
Broadcasts: `skill_changed` event to WebSocket clients

## Design tokens

```css
--bg-primary: #09090f;
--bg-card: linear-gradient(135deg, #1a1a2e, #16132e);
--bg-nav: #12122a;
--border: #2d2b55;
--text-primary: #f8fafc;
--text-secondary: #7c7c9e;
--text-muted: #6b7280;
--accent-primary: #a78bfa;    /* violet */
--accent-secondary: #818cf8;  /* indigo */
--status-confirmed: #4ade80;  /* green */
--status-disputed: #ef4444;   /* red */
--status-unverified: #fbbf24; /* yellow */
--status-unique: #6b7280;     /* gray */
--status-new: #60a5fa;        /* blue */
--radius-card: 10px;
--radius-button: 6px;
```

## Non-goals (v1)

- No task dispatch from the dashboard (use MCP tools)
- No agent creation/deletion (use gossip_setup)
- No historical trend charts (future: signal history over time)
- No multi-user / auth roles
- No remote access (localhost only)

## Risk

**Low.** The dashboard is read-only except for skill toggling. All data comes from existing `.gossip/` files. The relay HTTP server already exists — we're adding routes, not a new process. WebSocket infrastructure is already built.

**Security:** Dashboard key prevents unauthorized local access. Session cookie is httpOnly. API endpoints validate session before returning data. Skill toggle is the only write operation and it goes through the same `SkillIndex` class with all its validation.
