# Dashboard Redesign — Design Spec

## Goal

Complete visual redesign of the gossipcat dashboard. Replace the Phase 1 raw UI with a polished, production-grade dashboard that scales with 7+ agents and serves three use cases: real-time monitoring (primary), post-session review, and configuration.

## Architecture

### Client-Side Routing

The SPA uses **hash-based routing** (`#/path`) to support detail views without server changes:

- `#/` or `#/overview` — Hub page (default)
- `#/team` — All agents view
- `#/team/:agentId` — Agent detail
- `#/tasks` — Full task list
- `#/consensus/:taskId` — Consensus run detail
- `#/signals` — Full signal feed
- `#/knowledge/:agentId` — Memory browser

The router listens to `hashchange` events. The server serves `index.html` for all `/dashboard*` paths (catch-all, not exact match). The breadcrumb reads the hash and renders path segments as clickable links.

URL query parameters: the route dispatcher must strip query strings before matching (`url.split('?')[0]`). This fixes a latent bug in the current exact-match router that would break any parameterized endpoint.

### Navigation: Hub + Detail with Top Breadcrumb

- **Top bar**: `gossipcat / Page Name` breadcrumb on left, WebSocket status pill on right
- **Hub page** (Overview) is the home. All content is clickable — agents, consensus runs, signals, memory entries drill into detail views via hash navigation
- **No sidebar, no tab bar** — navigation is through content interaction + "View all" links
- Top bar height: 50px, gradient background (surface → bg)
- Browser back button works via hash history

### Hub Page Layout (5 sections, single scroll)

Each section has a consistent header: **Title** + optional count pill on left, action link on right, thin bottom border separator.

#### 1. Overview (metric cards)

4-column grid of metric cards:

| Card | Icon | Value | Detail |
|------|------|-------|--------|
| Agents | Robot (purple bg) | `7` | `4 online · 3 idle` |
| Tasks | Clipboard+check (green bg) | `142` | `94% success · 3.2s avg` |
| Consensus | Balance/scales (blue bg) | `8` | `31 confirmed · 4 disputed` |
| Signals | Pulse/heartbeat (purple bg) | `231` | `68% agreement rate` |

- Icons are 20×20 SVG in 40×40 rounded colored boxes (8% opacity background)
- Values in JetBrains Mono, 26px, weight 600
- Labels in mono uppercase, 11px
- Cards have subtle bottom accent stripe on hover

#### 2. Team (agent cards — max 3 + overflow)

4-column grid showing top 3 agents (sorted by dispatch weight) + overflow card.

**Sorting & display rules:**
- Sort all agents by dispatch weight descending
- Show top 3 as full cards
- If 4+ agents remain, show overflow card with "+N more agents"
- If ≤3 total agents, show all as cards, no overflow
- If 0 agents, show empty state: "No agents configured. Run gossip_setup to create your team."

**Agent card:**
- Left accent stripe (3px, color-coded by provider: purple=Anthropic, blue=Google)
- Header row: agent name (14px bold) + role subtitle (`Anthropic · Reviewer`, 11px muted)
- Status badge: online (green dot with glow animation) / idle (grey dot)
- 4 metric boxes in a row: Accuracy (purple), Uniqueness (blue), Signals (white), Tokens (green)
- Each metric: mono 14px value over 9px uppercase label, in a surface-raised rounded box
- Idle agents (0 signals) show dashes instead of 50% defaults, dimmed to 35% opacity
- Hover: lift 1px, subtle shadow, border highlights

**Token metric:** Shows total tokens consumed by the agent (`inputTokens + outputTokens` from task-graph.jsonl), formatted as `12.4k` or `1.2M`. This gives visibility into which agents are expensive.

**Overflow card:**
- Dashed border instead of solid
- Stacked initials avatars (overlapping, 22px pills) for hidden agents
- "+N" count (N = total agents minus 3) in mono 20px + "more agents" label
- Hover: border turns accent purple
- Click navigates to `#/team`

Section header: "Team" + count pill ("7 agents") + "manage →"

#### 3. Performance (charts)

2-column grid:

**Task Volume (area chart):**
- X-axis: day labels for last 7 days (use `toLocaleDateString([], {weekday:'short'})`)
- Y-axis: auto-scaled based on max daily count (round up to nearest 10)
- Green area fill with gradient (10% → 0% opacity)
- Red dashed line for failed tasks
- Grid lines at 4 evenly-spaced levels
- Endpoint dots on latest values
- Data: scan `task-graph.jsonl`, bucket by `new Date(entry.timestamp).toDateString()`, count completed vs failed per day

**Agent Accuracy (horizontal bars):**
- One row per active agent (skip agents with 0 signals)
- Purple bar = accuracy %, blue overlay = uniqueness %
- Agent name labels on left (truncated to 12 chars), percentage on right
- Scale markers: 0%, 50%, 100%
- Max 6 agents shown, sorted by accuracy descending

All charts are pure SVG — no external chart library.

Section header: "Performance" + "last 7 days" pill + "export →"

#### 4. Activity (3-column feed)

Three equal-width panels:

**Recent Tasks:**
- Compact rows: status dot (green=completed, red=failed, purple=consensus event) + mono time + agent name (accent) + task description + duration (mono)
- Max height 280px with scroll
- Shows last 20 tasks

**Consensus Runs:**
- Rows: mono time + description (`3 agents · dashboard`) + colored pills (✓ N green, N red, N amber)
- Click navigates to `#/consensus/:taskId`
- Shows last 10 runs

**Signals:**
- Rows: type badge (agree/halluc./unique/disagree with colored backgrounds) + agent name + optional arrow + counterpart + finding description (truncated)
- Type badges: agree=green, hallucination=red, unique=blue, disagreement=amber
- Shows last 15 signals

Section header: "Activity" + count pill + "all tasks →"

#### 5. Knowledge (2-column compact)

**Agent Memory (left):**
- Flex-wrap grid of compact chips
- Each chip: colored initials avatar (24px) + agent name + file count + cognitive count
- `_project (shared)` included as first chip
- Idle agents dimmed (agents with 0 knowledge files)
- Click navigates to `#/knowledge/:agentId`
- **Cognitive detection:** files whose frontmatter contains `type: cognitive` or whose content starts with "You reviewed" or contains "## What I Learned"

**Recent Learnings (right):**
- Dense rows: tiny avatar (20px) + learning title (from frontmatter `name` or `description`) + type label (cognitive/knowledge, 9px mono) + relative time (from file mtime)
- Shows last 10 entries across all agents, sorted by recency

Section header: "Knowledge" + count pill + "browse →"

### Detail Views

These are drill-down pages accessed by clicking hub elements. All rendered client-side via hash router.

**Agent Detail** (`#/team/:agentId`):
- Identity banner: name, provider, model, role, online/idle status
- Token usage summary: total input tokens, total output tokens, formatted as human-readable (e.g., "45.2k in / 12.8k out")
- Performance metrics: accuracy, uniqueness, reliability, dispatch weight, signal counts
- Task history: last 50 tasks for this agent (client-side filtered from tasks API)
- Memory browser: MEMORY.md index + expandable knowledge files with markdown rendering (reuse existing `renderMarkdown`)
- Skill bindings: toggleable list (reuse existing skill bind API)

**Tasks Detail** (`#/tasks`):
- Full task list from tasks API (max 100)
- Client-side filters: status buttons (all/completed/failed/running)
- Client-side search: filter by agent name or task description substring
- Sortable by: time (default), duration, agent
- Token column: show inputTokens + outputTokens per task

**Consensus Detail** (`#/consensus/:taskId`):
- Header: task ID, timestamp, agent count
- Signal list: all signals for this taskId, grouped by type
- Finding text with agent attribution + evidence (expandable)

**Memory Browser** (`#/knowledge/:agentId`):
- MEMORY.md rendered with markdown (reuse `renderMarkdown` from current memory.js)
- Knowledge files list: expandable with frontmatter display
- Cognitive summaries highlighted with left border accent
- Task history table for this agent

**All Signals** (`#/signals`):
- Full signal feed from signals API
- Client-side type filter buttons (all/agree/disagree/unique/hallucination)
- Client-side agent filter dropdown
- Evidence text expandable on click
- Paginated: show 50 at a time with "load more"

### Empty & Error States

Every section must handle:
- **Empty state** (0 data): centered muted text explaining what to do (e.g., "No tasks yet. Dispatch agents to generate activity.")
- **Loading state**: show "Loading..." placeholder text
- **Error state**: show "Failed to load: {error}" in muted text with retry suggestion
- **API failure**: individual sections fail independently — a 500 on `/api/signals` should not break the overview cards

### WebSocket Real-Time Updates

Define which events update which hub sections:

| WS Event | Updates |
|----------|---------|
| `task_dispatched` | Activity → Recent Tasks |
| `task_completed` | Overview → Tasks count, Activity → Recent Tasks, Performance → charts (if visible) |
| `task_failed` | Overview → Tasks count, Activity → Recent Tasks |
| `consensus_started` | Activity → Recent Tasks, Activity → Consensus Runs |
| `consensus_complete` | Overview → Consensus count, Activity → Consensus Runs |
| `agent_connected` | Overview → Agents count, Team → status dots |
| `agent_disconnected` | Overview → Agents count, Team → status dots |
| `skill_changed` | (no hub update — detail view only) |

Strategy: on each WS event, re-fetch the affected API endpoint(s) and re-render only the changed section. Do NOT re-render the entire page.

### Responsive Breakpoints

| Breakpoint | Layout Changes |
|-----------|---------------|
| > 1200px | Full 4-column grids, 3-column activity, 2-column knowledge |
| 900–1200px | 2-column agent grid, 2-column activity (signals hidden), 1-column charts |
| < 900px | 1-column everything, metric cards 2×2, panels stack vertically |
| < 600px | 1-column metric cards, simplified agent cards (hide metric boxes, show inline text) |

### Accessibility

- All clickable cards use `<button>` or `<a>` with proper `role` attributes
- Tab navigation works through all interactive elements in DOM order
- `aria-label` on SVG icons and charts
- Color is never the only indicator — status also uses text labels (online/idle/completed/failed)
- Focus-visible outlines on all interactive elements (2px accent color)
- Minimum contrast: all text passes WCAG AA (4.5:1 for body, 3:1 for large text)

## Design System

### Colors

```css
:root {
  --bg: #08090e;
  --surface: #0e1017;
  --surface-raised: #131620;
  --surface-hover: #181c28;
  --border: rgba(255,255,255,0.05);
  --border-active: rgba(167,139,250,0.25);
  --text: #e4e6ef;
  --text-2: #a0a4b8;
  --text-3: #6c7089;
  --accent: #a78bfa;
  --green: #34d399;
  --red: #f87171;
  --amber: #fbbf24;
  --blue: #60a5fa;
}
```

Soft glow variants for badges/pills: 12% opacity backgrounds (`rgba(color, 0.12)`).

**Migration note:** This replaces the existing Phase 1 CSS variables entirely. The old `--bg-primary`, `--bg-card`, `--accent-primary` etc. are removed. All CSS is rewritten from scratch — no incremental migration.

### Typography

Load via Google Fonts `<link>` in `index.html`:
```html
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

- **Body**: Outfit, 14px base, weight 400–700
- **Data/mono**: JetBrains Mono, weights 400–600
- **Hierarchy**: 26px metric values, 14px names, 13px body/titles, 12px secondary, 11px labels/times, 10px small badges, 9px micro labels

### Atmosphere

- Radial gradient bloom: purple (20% from top-left), green (85% from bottom-right) via `body::before`
- Film grain: static SVG `feTurbulence` filter as `body::after` at 1.2% opacity (not animated, not canvas)
- No CRT scanlines, no vignette

### Spacing & Radius

- Section margin-bottom: 28px
- Card padding: 14–18px
- Card border-radius: 12px
- Panel border-radius: 12px
- Badge/pill radius: 4–5px
- Grid gaps: 10px
- Section header padding-bottom: 10px with border-bottom

### Animations

- Page load: staggered fadeUp via CSS `@keyframes` with `animation-delay` per `.section:nth-child(N)` (works with innerHTML because the section divs are set once, not re-injected)
- Card hover: translateY(-1px) + box-shadow + border-color transition (0.2s)
- WebSocket dot: pulse glow animation (2.5s ease-in-out infinite)
- All transitions: 0.15–0.2s

### Agent Color Coding

| Agent Type | Left Stripe | Initials BG |
|-----------|-------------|-------------|
| Anthropic (all) | `--accent` (purple) | `rgba(accent, 0.1)` |
| Google (all) | `--blue` | `rgba(blue, 0.1)` |
| Idle (all) | `--text-3` (grey) | `rgba(text-3, 0.1)` |

### Icons

SVG icons are defined inline in the hub JS. Reference implementations in the approved mockup (`hub-v10.html`). Each icon uses a 24×24 viewBox with 1.5px stroke, `stroke-linecap="round"`, `stroke-linejoin="round"`, and `fill="none"`.

## Tech Stack

- Vanilla HTML/CSS/JS — no framework
- Pure SVG for all charts and icons
- CSS custom properties for theming
- esbuild bundler → single `dist-dashboard/index.html`
- Google Fonts loaded via `<link>` tag
- WebSocket for real-time updates
- All data from `.gossip/` JSONL files via existing REST API

## API Changes Required

### New endpoints

- `GET /dashboard/api/signals` — returns last 100 signals from `agent-performance.jsonl` (all types, not just consensus). Supports query param `?agent=X` for filtering.

### Modified endpoints

- `GET /dashboard/api/overview` — no changes needed (current implementation already derives all metrics)
- `GET /dashboard/api/agents` — add `lastTask` field (description + timestamp) and `totalTokens` field (sum of inputTokens + outputTokens from task-graph.jsonl for this agent). To avoid double file scan, cache the task-graph parse result in the request handler and pass to both tasks and agents handlers.
- `GET /dashboard/api/memory/:agentId` — add `fileCount` (number of .md files) and `cognitiveCount` (files with frontmatter `type: cognitive` or content matching cognitive heuristic) to response.
- `GET /dashboard/api/tasks` — add `inputTokens` and `outputTokens` fields to each task entry (already in task-graph.jsonl, just not exposed).

### Route dispatcher fix

Before adding any new endpoints, fix the URL matching in `routes.ts` to use `const pathname = url.split('?')[0]` and match against `pathname` instead of `url`. This prevents query strings from breaking existing routes.

### Agent online/idle status

The relay server already tracks connected agent IDs via WebSocket. Add an `onlineAgents: string[]` field to the `DashboardContext` interface (populated by the relay's connection manager). The agents API returns this alongside configs so the frontend can show green/grey status dots per agent.

### Existing endpoints (unchanged)

- `GET /dashboard/api/consensus` — consensus runs with signals
- `GET /dashboard/api/skills` — skill index
- `POST /dashboard/api/skills/bind` — skill toggle
- `POST /dashboard/api/auth` — authentication

## Mockups

Interactive mockups in `.superpowers/brainstorm/62969-*/content/`:
- `hub-v10.html` — final hub design (approved) — includes SVG icon implementations
- Earlier iterations: v1–v9 (design evolution history)

## Reference Designs

- **crab-language dashboard** — surface layering, atmospheric effects, typography
- **Linear** — clean cards, hub+detail navigation
- **Raycast** — compact density, mono numbers
