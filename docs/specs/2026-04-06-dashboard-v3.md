# Dashboard v3 — Spec

**Date:** 2026-04-06
**Status:** design locked, ready to implement
**Replaces:** `packages/dashboard-v2/` (current live dashboard)
**Mockup:** `/tmp/gossipcat-layouts/` (static HTML/CSS/JS prototype at `http://localhost:8765/d.html`)

---

## Goal

Replace the current dashboard with a visually cohesive, information-dense mission-control layout. Keep the Terminal Amber/Violet palette, bring back the NeuralAvatar but redesigned as a **Vortex** engine with 12 topological variants that evolve with signal count. Tie every visual to real agent metrics.

## Success criteria

1. A new user opening `/dashboard` can answer these in under 5 seconds:
   - Are any agents actively working?
   - Which agents are performing well vs. struggling?
   - What happened in the most recent consensus rounds?
   - Are any agents in a failing state (circuit open)?
2. Each agent's visual identity (avatar) is unique and evolves as they accumulate signals.
3. All metrics (accuracy, uniqueness, impact, weight, signals) are visible without clicking into detail pages.
4. No colorful accents or gratuitous decoration — every color has semantic meaning.

---

## Layout (overview)

```
┌─ TopBar ───────────────────────────────────────────────────┐
│  [logo] gossipcat   Dashboard Team Findings Tasks Logs     │
│                                           [● Connected]    │
└────────────────────────────────────────────────────────────┘

┌─ Left sidebar (280px) ─┐  ┌─ Main area ─────────────────────┐
│  System Pulse           │  │  Team  (3-col hero grid)         │
│  ┌────────┬────────┐    │  │  ┌────────┐ ┌────────┐ ┌───────┐ │
│  │ Agents │ Active │    │  │  │ avatar │ │ avatar │ │ avatar│ │
│  │ 10/7   │   3    │    │  │  │ bars   │ │ bars   │ │ bars  │ │
│  ├────────┼────────┤    │  │  └────────┘ └────────┘ └───────┘ │
│  │ 277    │ 63%    │    │  │  ... 3 more agents                │
│  └────────┴────────┘    │  │                                   │
│  ── secondary stats ──  │  │  Consensus Rounds (5 cards)       │
│  12h activity bars      │  │  [green accent] 6 findings ...    │
│                         │  │  [amber accent] 9 findings ...    │
│  ⚠ Circuit Alerts       │  │  ...                              │
│  sonnet-reviewer        │  │                                   │
│  gemini-tester          │  │  ┌ Recent Tasks ┐ ┌ Memories ┐    │
│                         │  │  │ compact feed │ │ expandable│    │
└─────────────────────────┘  └─────────────────────────────────┘
```

---

## Component specs

### 1. TopBar (`TopBar.tsx`)

**Structure:**
- Logo: `gossip-mini.png` 40px + "gossipcat" text 17px violet
- 5 tabs: Dashboard / Team / Findings / Tasks / Logs (JetBrains Mono 13px)
- Connection pill on the right with colored dot

**Rules:**
- Active tab: `bg-primary/10 text-primary font-semibold`
- Inactive tab: `text-muted-foreground hover:text-foreground`
- Bottom border: `1px solid var(--border)` + subtle violet gradient accent line
- No navigation sidebar — tabs are the only navigation

**Padding:** 14px vertical, 24px horizontal

### 2. System Pulse panel (`SystemPulse.tsx`)

**Location:** top of left sidebar

**Structure:**
- Header strip: "System Pulse" label (violet, uppercase mono 10px) + "● LIVE" indicator
- **Primary 2x2 grid** with cross dividers (`::before` horizontal, `::after` vertical):
  - Agents Online (green, with `/total` suffix)
  - Active Tasks (amber with pulsing dot if >0)
  - Consensus Runs (violet)
  - Confirmed % (green)
  - Each cell: `flex-col items-center text-center padding 18px 14px`
  - Large value: mono `text-2xl font-bold`
- **Secondary stats rows** (mono text-11px, justify-between):
  - tasks completed, signals total, actionable, tasks failed, avg duration, success rate
- **Activity sparkline** (bottom section):
  - 12 bars representing last 12 hours
  - Each bar hoverable with tooltip: "Xh ago\nN tasks · M consensus"
  - Current hour bar highlighted (opacity 0.9)

**Metric sources:** `/api/overview` + `/api/active-tasks` count

**Borders:** Only border-radius on the outermost panel and first/last child to preserve rounded corners without using `overflow: hidden` (tooltips need to escape bounds).

### 3. Circuit Alerts panel (`CircuitAlerts.tsx`)

**Location:** below System Pulse in left sidebar

**Structure:**
- Header: `!` icon (red square) + "Circuit Alerts" + count badge
- One row per agent with `circuitOpen === true`:
  - Red dot with glow
  - Agent name
  - Sub-line: "N consecutive fails" + "Xm ago"
- Empty state: hide panel entirely if no circuits open

**Background:** `rgba(248, 113, 113, 0.04)` on header
**Hover state:** `rgba(248, 113, 113, 0.03)` row bg

### 4. Team Hero Cards (`TeamHero.tsx` + `AgentCardBig.tsx`)

**Location:** top of main area, 3-column grid

**Card structure:**
```
┌─────────────────────────────────┐
│ [avatar 72px]  agent-name  [wt] │
│ [halo glow]    N signals · time │
│                                 │
│ ┌─── metrics panel ───┐         │
│ │ accuracy ████░░ 75% │         │
│ │ unique   ██░░░░ 38% │         │
│ │ impact   █████░ 82% │         │
│ └─────────────────────┘         │
└─────────────────────────────────┘
```

**Rules:**
- No colored top border — avatar provides identity
- Weight pill: top-right, bordered, tooltip "Dispatch weight X.XX\nScale 0.3 → 2.0" (left-positioned)
- `CIRCUIT` badge inline with name if `circuitOpen`
- Metric bars: `accuracy` (threshold color: green/amber/red), `unique` (purple), `impact` (rose #fb7185, NOT red to avoid confusing with disputed)
- Bar labels have tooltips explaining each metric
- Hover: `z-index: 10`, `translateY(-1px)`, border brightens
- No `overflow: hidden` (tooltips must escape)

**Shows:** 6 agents max (3 cols × 2 rows). "view all" → `#/team`

### 5. Vortex NeuralAvatar (`NeuralAvatar.tsx` + `lib/vortex-engine.ts`)

**This is the biggest change from v2.** Canvas-based animated entity with 12 topological variants.

#### Metric → visual mapping

| Metric | Effect | Formula (with compounding) |
|--------|--------|----------------------------|
| signals | size + complexity + core growth | `exp = pow(s/2000, 0.55)`, capped at 1.4; scale = `min(0.95, 0.3 + exp * 0.87)` |
| accuracy | brightness | `brightMul = 0.2 + accuracy × experienceMul × 0.8` |
| uniqueness | nova event rate | `novaRate = uniqueness × experienceMul` |
| impact | rotation speed + trail length | `rotMul = 0.3 + impact × experienceMul × 1.9` |

Where `experienceMul = 0.4 + exp × 0.6` — metrics **compound** with experience. Elders who earned their accuracy shine brighter than newborns who happen to have high accuracy.

#### Shape emergence

Shape identity emerges gradually:
```
structureFactor = clamp((exp - 0.15) × 1.8, 0, 1)
chaosFactor = 1 - structureFactor
```

At low signals (~100), particles occupy random "chaos" positions. As signals grow, they lock into their variant's topology. Fully formed around ~1000 signals. Visual effect: a newborn is a scattered cloud of potential; an elder has crystallized identity.

Per-particle chaos position stored in constructor (`chaosX`, `chaosY`, `chaosDriftPhase`). Blend is skipped when `chaosFactor <= 0.01` to save work.

#### 12 variants (deterministic from `agentHash(id) % 12`)

| # | Name | Description | Signature feature |
|---|------|-------------|-------------------|
| 0 | Spiral Galaxy | 2 curved arms, particles follow arms | Visible spiral arms |
| 1 | Saturn Ring | Single dense narrow belt | Thin outer ring only |
| 2 | Triple Belt | 3 distinct orbital rings | 3 concentric bands |
| 3 | Binary Cores | 2 counter-rotating clusters | NO central singularity, 2 separate cores |
| 4 | Chaotic Swarm | Random eccentric tilted orbits | No structure |
| 5 | Pulsar Jets | 2 opposing beam cones + faint disk | Narrow axial jets |
| 6 | Nebula Cloud | Diffuse non-orbital particles | Soft halos per particle |
| 7 | Cometary Tail | Asymmetric head + elongated tail | Clear direction of travel |
| 8 | Gyroscope | 3 tilted orthogonal orbital planes | 3D illusion |
| 9 | Maelstrom | Tight inward-spiraling sink | Particles fade as they approach center |
| 10 | Ouroboros | Single flowing ring with directional current | Rotational "head" highlight |
| 11 | Double Helix | 2 intertwining strands (DNA-like) | Vertical serpentine |

**Implementation:** Reference the prototype at `/tmp/gossipcat-layouts/avatar-engines.js` — the full `VortexEngine` class with constructor branching per variant and draw method handling each variant's position calculation.

#### Sizes

- Team hero card: 72px
- Agent detail page header: 120px
- Team roster (compact list): 40px
- Tasks row / memory row: not used (no avatar inline)

### 6. Consensus Round Card (`ConsensusCard.tsx`)

**Structure:**
```
┌[accent]────────────────────────────────┐
│ 6 findings · 2 rounds  [GR][GT]   2h ago│
│ ████████████░░░░░░░░░░░░░░░░░░░░         │
│ 5 confirmed · 1 disputed                 │
└──────────────────────────────────────────┘
```

**Accent color (left border 3px):**
- Green (`--confirmed`) if `confirmed / total >= 0.5`
- Red (`--disputed`) if `disputed / total >= 0.4`
- Amber (`--unverified`) otherwise

**Header row:**
- Big count (mono 16px bold)
- "findings" label
- "· N rounds" meta
- Agent initials as colored circles (with full name tooltip below)
- Time ago (right aligned)

**Progress bar:** thin (1.5px) multi-segment horizontal bar with proportional widths, no border radius

**Stat chips:** colored by category
- confirmed (green)
- disputed (red)
- unverified (amber)
- unique (purple)
- **insights (gray `#71717a`)** — distinct from unique

**Agent initial tooltips:** `data-tooltip="sonnet-reviewer" data-tooltip-pos="bottom"` — CSS-only, wraps long text.

### 7. Recent Tasks feed (`TasksSection.tsx`)

**Structure:**
- Each row: status dot + agent name (bold) + truncated desc (max 50 chars) + time ago
- **No colorful left border accents** — rows are clean
- Status dot: green (completed), red (failed), amber pulse (running), gray (cancelled)
- Max 8 rows shown, "view all" link

### 8. Recent Memories (`RecentMemories.tsx`)

**Structure:**
- Section header: "Recent Memories" + count
- List (max 6 items) with:
  - Collapse arrow
  - Type badge (colored pill): `cognitive` (primary violet), `knowledge` (blue), `skill` (green), `review` (purple), `task` (amber), `session` (amber), `memory` (gray)
  - Memory name (truncated)
  - Agent attribution badge on the right: bordered pill `text-muted-foreground border-border/40`
- Expanded state: shows `<pre>` with max-height 40 and scroll

**Type inference** (if frontmatter `type` missing):
- Search filename + frontmatter.name + frontmatter.description + first 200 chars of content
- Keywords: `session`, `cognitive`, `skill`, `consensus/finding/review`, `dispatch/implement`, `design/architecture` → review
- Fallback: if frontmatter has `name` → `knowledge`, else `note`

**Dedup:** by filename (`arr.findIndex(x => x.filename === m.filename) === i`)

---

## Design tokens (update to `globals.css`)

```css
@theme {
  /* Base palette (unchanged from v2) */
  --color-background: #0a0a0f;
  --color-foreground: #f0f0f5;
  --color-card: #13131a;
  --color-card-foreground: #f0f0f5;
  --color-muted: #1c1c26;
  --color-muted-foreground: #9898a8;
  --color-border: rgba(139, 92, 246, 0.12);
  --color-input: rgba(139, 92, 246, 0.12);
  --color-ring: #8b5cf6;
  --color-primary: #8b5cf6;
  --color-primary-foreground: #fafafa;
  --color-secondary: #1c1c26;
  --color-secondary-foreground: #f0f0f5;
  --color-accent: #1e1e30;
  --color-accent-foreground: #f0f0f5;
  --color-destructive: #f87171;

  /* Semantic colors */
  --color-confirmed: #34d399;
  --color-disputed: #f87171;
  --color-unverified: #fbbf24;
  --color-unique: #c084fc;

  /* NEW — add to v3 */
  --color-impact: #fb7185;          /* coral red, distinct from disputed */
  --color-insight: #71717a;         /* gray-zinc */
  --color-text-dim: #666674;        /* 4th text tier */

  /* Fonts */
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;

  /* Radii */
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
}

body {
  font-size: 15px;
  line-height: 1.55;
}
```

### Typography scale

- Body: Inter 15px / 1.55
- Section titles: JetBrains Mono 11px uppercase 0.1em tracking, bold
- Values/metrics: JetBrains Mono, tabular-nums
- Primary stats: 28px bold
- Secondary stats: 11px

### Spacing

- Base unit 4px. Scale: 4/8/12/16/20/24/32/48
- Section gap: 24-28px
- Inside card padding: 14-18px
- Tight row padding (tasks/memories): 8-11px vertical

---

## Tooltip system (CSS-only, reusable)

Already specified in shared.css of the prototype. Reusable `[data-tooltip="..."]` attribute pattern:

```css
[data-tooltip] { position: relative; cursor: help; }
[data-tooltip]::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%) translateY(-6px);
  padding: 8px 12px;
  background: rgba(14, 14, 20, 0.98);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-family: 'Inter';
  font-size: 11px;
  line-height: 1.45;
  color: var(--text);
  white-space: pre-line;
  width: max-content;
  max-width: 220px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 150ms ease 50ms;
  z-index: 1000;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.7);
}
[data-tooltip]:hover::after { opacity: 1; }
/* plus position variants: data-tooltip-pos="top|bottom|left|right" */
```

**Rule:** any element with `overflow: hidden` will clip tooltips. Team hero cards and metric panels MUST NOT have `overflow: hidden`. Use individual border-radius on children if rounded corners are needed.

---

## Backend API changes (mostly shipped)

### `/api/overview` — shipped
`agentsOnline` now counts only agents with active (non-stale, non-finished) tasks via `task-graph.jsonl`, not "all native agents connected".

### `/api/active-tasks` — shipped
30-minute staleness cutoff: tasks older than that are assumed dead.

### `/api/agents` — shipped
Now includes in `scores`:
- `impactScore` (severity-weighted finding quality)
- `circuitOpen` (boolean)
- `consecutiveFailures` (int)
- `categoryStrengths` (Record<string, number> — per-category competency)

### `/api/signals?agent=<id>` — already exists
Used by the SignalTimeline on agent detail page (not yet wired in v3).

### `/api/logs` — already exists
mcp.log stream with filter + tail, plus live WS `log_lines` events.

### New — `/api/consensus-history` (OPTIONAL)
Not needed. Dashboard reads from `agent-performance.jsonl` signals (already implemented).

---

## Pages

| Route | Component | Status |
|-------|-----------|--------|
| `#/` | Main dashboard (above) | NEW |
| `#/team` | Full team grid (existing) | KEEP |
| `#/agent/:id` | Agent detail (existing) | ENHANCE with Vortex avatar + categoryStrengths bars + SignalTimeline |
| `#/findings` | All consensus rounds (existing) | KEEP |
| `#/tasks` | Full tasks table (existing) | KEEP |
| `#/logs` | Live log viewer (existing) | KEEP |

---

## Implementation order

1. **Port Vortex engine** to `packages/dashboard-v2/src/lib/vortex-engine.ts` (from prototype `avatar-engines.js`) — keep it canvas-based, single class, 12 variants
2. **Replace NeuralAvatar** with Vortex-backed version in `packages/dashboard-v2/src/components/NeuralAvatar.tsx`
3. **Update design tokens** in `globals.css` (add impact/insight/text-dim colors, bump body font size)
4. **Build SystemPulse panel** in left sidebar (replace current `SystemPulse.tsx`)
5. **Build CircuitAlerts panel** (new)
6. **Rebuild AgentCardBig** with weight pill + 3 metric bars + tooltips (replace `AgentRow.tsx` for team hero)
7. **Rebuild ConsensusCard** with accent border + agent initial tooltips + insight gray color
8. **Rebuild TasksSection** (remove left border accents)
9. **Rebuild RecentMemories** with expanded type inference + dedup + attribution badges
10. **Update App.tsx** layout — left sidebar + main area (2-column)
11. **Add tooltip CSS** to globals.css
12. **Type-check + build + visual QA** via `/browse`

---

## What this does NOT change

- WebSocket infrastructure (`useWebSocket`, `DashboardWs`)
- Authentication (`AuthGate`, cookie session)
- Data fetching pattern (`useDashboardData`, `lib/api.ts`)
- Routing (hash-based `useRoute`)
- Backend handlers except where listed above
- Existing pages for `#/team`, `#/findings`, `#/tasks`, `#/logs`

## Known issues carried over

1. **Saturn Ring / Ouroboros clipping past ~3500 signals.** Outer ring particles become hard to see at very high signal counts because the core glow + bright center dominates. Multiple fix attempts broke other variants. Accepted as a minor visual issue for now — the vast majority of agents never reach 3500 signals.

2. **Vortex performance.** 12 canvas-based avatars running at 60fps each. Profile on first build; consider reducing animation frequency or using `requestAnimationFrame` throttling if CPU usage is high.

3. **Tooltip clipping.** Cards with `overflow: hidden` will clip tooltips. Avoid it or use `position: fixed` tooltips as a fallback.

---

## Files that will be modified

| File | Change |
|------|--------|
| `packages/dashboard-v2/src/lib/vortex-engine.ts` | NEW — 12-variant canvas engine |
| `packages/dashboard-v2/src/components/NeuralAvatar.tsx` | Replace OrbAvatarEngine with VortexEngine |
| `packages/dashboard-v2/src/components/SystemPulse.tsx` | Rewrite for panel layout with primary 2x2 + secondary stats + activity bars |
| `packages/dashboard-v2/src/components/CircuitAlerts.tsx` | NEW |
| `packages/dashboard-v2/src/components/AgentCardBig.tsx` | NEW (extracted from current `AgentRow.tsx`) |
| `packages/dashboard-v2/src/components/TeamHero.tsx` | NEW — 3-col grid of AgentCardBig |
| `packages/dashboard-v2/src/components/FindingsMetrics.tsx` | Update ConsensusCard rendering with new accent + insights color |
| `packages/dashboard-v2/src/components/TasksSection.tsx` | Remove left border accents |
| `packages/dashboard-v2/src/components/RecentMemories.tsx` | Expanded type inference + dedup |
| `packages/dashboard-v2/src/components/TopBar.tsx` | Logo bump to 40px, tab nav styling |
| `packages/dashboard-v2/src/components/AgentPage.tsx` | Use Vortex avatar + categoryStrengths section (already scaffolded) |
| `packages/dashboard-v2/src/globals.css` | New color tokens, typography, tooltip styles |
| `packages/dashboard-v2/src/App.tsx` | 2-column layout with left sidebar |
| `packages/dashboard-v2/src/lib/types.ts` | Already has new score fields — verify |

## Files that will be deleted

- `packages/dashboard-v2/src/components/AgentDetailModal.tsx` — unused
- `packages/dashboard-v2/src/lib/neural-avatar.ts` — replaced by `vortex-engine.ts`

---

## Decision log (source of truth for "why")

- **Why Vortex over the 4 static SVG options?** Because the current NeuralAvatar is a *living entity* that evolves — static SVG data visualizations don't carry that philosophy. The user chose "living organism" direction over "abstract data portrait".
- **Why 12 variants?** The current design has 6 topologies (hub, spiral, cluster, star, chain, mesh). 12 gives each agent a more distinct identity even with similar metrics.
- **Why compound metrics with exp?** An elder who earned 70% accuracy is fundamentally more trustworthy than a newborn with 70%. The visual should reflect earned authority vs. beginner luck.
- **Why chaos → structure emergence?** Gives the "growing up" feeling. Early signals are uncertain potential; later signals lock in identity.
- **Why impact = rose red (#fb7185) not #f87171?** Rose is a coral/red distinct from the alerting `disputed` red. Impact reads as "weight/severity" not "failure".
- **Why insights gray (#71717a) not unique purple?** In the backend `unique` and `insights` are separate arrays. Visually they should be distinct. Insights are observations/suggestions, not findings.
- **Why no left border accent on Tasks feed?** Too much color noise. The agent name in the row is enough identification.
- **Why no overflow: hidden on agent cards?** Tooltips need to escape card bounds. Use individual child border-radius for rounded corners.
- **Why sidebar on left with SystemPulse/CircuitAlerts instead of right?** Navigation patterns read left-to-right. Persistent system state on the left, content on the right.
- **Why 2x2 divided grid for primary metrics instead of flat row?** The cross-divider visually groups the 4 most important KPIs and makes them feel "architectural" rather than "floating numbers".
