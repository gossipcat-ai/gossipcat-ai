# Design System — Gossipcat

> Source of truth for visual decisions in the gossipcat dashboard. All UI work must read this file before introducing fonts, colors, spacing, or layout choices. Deviations require explicit user approval.
>
> **Direction:** Editorial canvas + infographic vocabulary. Warm cream surface, Fraunces serif for route titles only, Geist for body/UI/data, charts replace numbers where data has shape. Reference preview: `~/.gstack/projects/gossipcat-ai-gossipcat-ai/designs/design-system-20260524/approved-overview-c.html`.

---

## Product Context

- **What this is:** Operator console for gossipcat — a local multi-agent code-review mesh (Claude + Gemini subagents + relay). The dashboard surfaces fleet health, consensus rounds, signal stream, and skill graduation.
- **Audience:** One senior developer running gossipcat locally next to Claude Code in a terminal. Not multi-tenant, not marketing, not public-facing.
- **Industry peers:** Linear, Vercel, Resend, PostHog, Sentry, Datadog. Take their restraint, type confidence, and density discipline. Reject their sameness.
- **Project type:** Local web app, single-page dashboard, dense data, fast scan, status-first.

---

## Aesthetic Direction

- **Direction:** Operator's console with editorial calm. A specialist's dashboard that takes itself seriously without being clinical.
- **Decoration:** Intentional. No flourishes. The agent avatars are the alive element; everything around them tightens to support them.
- **Mood:** Linear's restraint × Resend's warmth × an observatory's spatial composition. Hairline borders, generous whitespace at the hero, tight density in data lists.
- **Reference preview:** `approved-overview-c.html` in the gstack designs dir.

---

## Color

Restrained, semantic-strict. **One accent.** Every other color carries meaning.

### Foundation (light, default)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#FAF7F2` | page canvas (warm cream) |
| `--surface` | `#FFFEFB` | cards, panels |
| `--surface-2` | `#F4EFE5` | recessed surfaces, code inlines |
| `--ink` | `#1A1916` | primary text, large numbers |
| `--ink-2` | `#4A4640` | secondary text, labels |
| `--ink-3` | `#807A71` | tertiary, meta, timestamps |
| `--ink-4` | `#B8B0A1` | quaternary, axis ticks, placeholder |
| `--border` | `#E8E1D6` | hairline card border, dividers |
| `--border-strong` | `#D7CEBE` | dashed dividers, gridlines |

### Accent (single)

| Token | Hex | Use |
|---|---|---|
| `--accent` | `#C97056` | terracotta. **Brand mark, primary CTA, active nav, key count emphasis. Nothing else.** |
| `--accent-soft` | `#F4DCD2` | accent pill bg, hover wash |

### Semantic (status — strict meaning)

| Token | Hex | Soft | Use |
|---|---|---|---|
| `--ok` | `#2F7D5B` | `#DCEBE2` | confirmed, healthy, passed, positive delta |
| `--warn` | `#B47A2A` | `#F2E4CC` | needs skills, drift, low confidence |
| `--bad` | `#A53A4A` | `#EFD4D8` | disputed, hallucination, failed, critical |
| `--info` | `#3F8B86` | `#D5E6E4` | unverified, neutral data viz default |
| `--idle` | `#6B6862` | `#E5E0D7` | offline, dormant, silent skill |

### Chart palette (multi-series ONLY)

| Token | Hex | |
|---|---|---|
| `--c1` | `#3F8B86` | teal |
| `--c2` | `#8C5E97` | plum |
| `--c3` | `#B47A2A` | ochre |
| `--c4` | `#2F7D5B` | sage |
| `--c5` | `#A53A4A` | rose |
| `--c6` | `#6B6862` | slate |
| `--c7` | `#C8A45A` | sand |

### Per-agent identity (avatar bloom only — NEVER card chrome)

| Agent | Hex |
|---|---|
| sonnet-reviewer | `#8C5E97` plum |
| sonnet-designer | `#C8A45A` sand |
| sonnet-implementer | `#A53A4A` rose |
| opus-implementer | `#C97056` terracotta |
| gemini-reviewer | `#3F8B86` teal |
| gemini-tester | `#2F7D5B` sage |
| haiku-researcher | `#6B7A85` slate |

### Dark mode

Separate redesign, not a token flip. Warm-charcoal foundation (`#14120F` bg, `#1C1A16` surface), cream text (`#F2EDE3`), semantic colors at +10% lightness to compensate for dark canvas. Accent shifts to `#D58267` (slightly warmer). Avatar blooms gain a subtle outer glow (`box-shadow: 0 0 12px color-mix(in srgb, var(--bc) 70%, transparent)`).

### Color rules (load-bearing)

1. **Terracotta accent has six jobs in the live dashboard today and one job here:** brand mark, active nav state, primary CTA, key emphasis on counts that are calls to action. **Never** on chart bars, status indicators, or generic UI furniture.
2. **Status is always semantic.** A red badge always means `bad`. A green badge always means `ok`. No exceptions.
3. **Per-agent color lives in the avatar bloom only.** Card chrome stays neutral. The bloom is the identity.
4. **Charts pick from the chart palette.** Never from semantic colors (unless the chart IS encoding semantics, e.g. consensus-flow sankey using `ok`/`bad`/`info`).

---

## Typography

Two voices + one constrained signature. Cut from the live dashboard's 3–4 voices.

### Font stack

| Role | Font | Why |
|---|---|---|
| **Display / route title (H1, H2)** | **Fraunces** (variable, weight 500) | Editorial soul. Constrained to route titles + section heroes only. Not used in cards, lists, or chrome. |
| **Body / UI / data** | **Geist** (weights 300, 400, 500, 600, 700) with `tabular-nums` always on | Modern grotesque, exceptional at small sizes, tabular numbers for all metrics |
| **Mono (constrained)** | **JetBrains Mono** (weights 400, 500) | Task IDs, hashes, code inlines, axis labels. Never body. |

Loaded via Google Fonts in `index.html` (or self-hosted if CSP requires). Variable font for Fraunces.

### Scale (rem-equivalent shown for reference; use px in tokens)

| Token | px | Use |
|---|---|---|
| `--t-display` | 56px / line 1.05 | Hero `Overview` on landing |
| `--t-route` | 44px / line 1.1 | Other route titles |
| `--t-h3` | 22px | Section headers inside content |
| `--t-body-lg` | 16px | Lead paragraph |
| `--t-body` | 14px | Default body |
| `--t-meta` | 13px | Subheads, secondary |
| `--t-small` | 12px | Tertiary, meta |
| `--t-micro` | 11px | Labels, sublabels |
| `--t-mono-data` | 13–14px | Metric numbers (Geist + tabular-nums) |
| `--t-mono-id` | 11–12px | Code, hashes, axis (JetBrains Mono) |
| `--t-section` | 13px small-caps | The signature `team · tasks · recent signals` headers |

### Section header signature

The most distinctive type role:

```css
.h-section {
  font-family: Geist;
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.04em;
  text-transform: lowercase;
  font-variant: small-caps;
  color: var(--ink-2);
}
```

This appears on EVERY section header (`fleet`, `team`, `tasks`, `recent signals`, `consensus flow`, `skill graduation`). It is the signature that unifies every panel. Do not use all-caps mono for these — that was Risk #4, killed during design.

### Typography rules

1. **Fraunces is for route titles and section heroes only.** If you need a third weight, you're misusing it. Body, cards, lists, chrome — all Geist.
2. **All numbers use `font-variant-numeric: tabular-nums`.** No exceptions in data contexts. The `.num` utility class enforces this.
3. **JetBrains Mono is reserved.** Task IDs, hashes, hex values, axis tick labels, inline `<code>`. Never body.
4. **Section headers use the small-caps signature, not all-caps mono.** Hierarchy comes from weight + font-variant, not from shouting.

---

## Spacing

Base 4px. **Two densities, applied intentionally.**

| Token | px |
|---|---|
| `--s-1` | 4 |
| `--s-2` | 8 |
| `--s-3` | 12 |
| `--s-4` | 16 |
| `--s-5` | 24 |
| `--s-6` | 32 |
| `--s-7` | 48 |
| `--s-8` | 64 |

### Density modes

- **Comfortable** (use `--s-5` / `--s-6` / `--s-7` padding) — hero, route intros, marketing-y empty states. Cards breathe.
- **Compact** (use `--s-2` / `--s-3` / `--s-4`) — data tables, signal stream, skill small-multiples, waterfall rows. Density is the point.

Don't mix densities within a single card. Don't apply compact to hero content.

---

## Layout

- **App grid:** 12-column, max-width 1440px, gutter 24px (`--s-5`).
- **Page padding:** `var(--s-7) var(--s-6)` (48px vertical, 32px horizontal).
- **Hero row:** strict 1.55fr / 1fr grid (graph card + side rail). Equal-height row — side rail and graph card must share row height via `align-items: stretch`. Live dashboard today violates this; fix as part of the refactor.
- **Section rhythm:** `margin: var(--s-7) 0 var(--s-3)` between major sections. Section header has a 1px bottom border (`--border`).
- **Radius scale:** `--r-sm: 4px`, `--r-md: 8px`, `--r-lg: 12px`, `--r-pill: 9999px`. Cards = `--r-lg`. Inline chips = `--r-pill`. Inputs = `--r-md`.
- **Borders:** 1px hairline using `--border` for all card chrome. **No drop shadows by default.** Hover may add a `0 1px 0 var(--border-strong)` inset, nothing more.

---

## Components (contracts)

### Card

```css
background: var(--surface);
border: 1px solid var(--border);
border-radius: var(--r-lg);
padding: var(--s-5);
```

No shadow. Hover: optional 1px inset. Header uses `.h-section` left + `.meta` right.

### Chip

Status indicators. Always semantic.

```css
padding: 3px 9px;
border-radius: var(--r-pill);
font-size: 11px;
font-weight: 500;
```

Variants: `chip-ok`, `chip-bad`, `chip-warn`, `chip-info`, `chip-idle`, `chip-accent`. Each uses its semantic `*-soft` bg + `*` color.

### Agent card (Team grid)

Two-column: 100px gauge column + flexible meta column.

- **Gauge column:** 90×90 SVG polar accuracy gauge (Fraunces % in center), then a 4-segment severity-mix strip, then a tiny `severity mix` label.
- **Meta column:** name + status chip; 3-up sub-bars (reliability / unique / impact); 7d area sparkline with delta badge; bottom row with signal count + timestamp (mono, small).

Chrome is neutral. The agent's identity color appears only in the gauge stroke, the sub-bar fills, and the sparkline. Status of the agent (healthy / needs skills) drives the gauge stroke color — green if accuracy ≥ baseline, amber if drift, rose if failing.

### Fleet accuracy scope (replaces decorative hub-and-spoke)

Radial chart. Distance of an agent's avatar from center encodes its accuracy (closer to center = higher accuracy). Concentric % bands at 25/50/75/100. Spoke color = agent identity. A small readout in the top-right shows the current consensus round ID + conf/disp/unver counts + epsilon cap. Legend bottom-left: `Distance from center = accuracy · spoke color = agent identity`.

This is the dashboard's signature visualization. It carries information, not decoration.

### 24h activity waterfall (replaces "0 / 0 / 71%" pulse band)

Per-agent heatmap. 24 columns (hours of day). Row per agent. Cell intensity = signal volume in that hour (l0 idle → l4 saturated). Left: agent name + identity dot. Right: 24h total + % of fleet.

When idle: cells render at `--border` opacity 0.55; agent rows still appear (don't hide them — the empty timeline is itself information).

### Consensus flow (sankey-ish)

Three-column flow. Left: model-family bands (sonnet / gemini / opus-haiku). Center: peer-verified findings bucket with total count. Right: semantic outcome rects (`confirmed` / `disputed` / `unverified`). Bezier ribbon widths proportional to flow volume.

### Signal stream

Severity-banded list. Columns: time (mono small) · 3px severity tick · verdict (semantic small-caps) · agent (mono small) · finding (Geist body with code inlines) · confidence ratio (mono small, right-aligned). Hover row: subtle `--bg` wash. Live row (rare): subtle accent-soft wash.

### Skill graduation small-multiples

Grid of 6 columns × N rows. Each cell: title (mono), 100×40 SVG showing the post-bind effectiveness curve with a dashed `--ok` line at the graduation threshold, status text (small-caps semantic). Verdict colors: passed=`--ok`, pending=`--accent`, failed=`--bad`, silent=`--ink-3`.

### Topbar

Sticky-cardlike: hairline border, `--surface` bg, `--r-md` radius. Brand mark left (terracotta circle with serif `g`), nav center (active state uses `--accent-soft`), search + connection chip right.

---

## Motion

**Minimal-functional.** Motion is for state changes that need to be noticed, not for entrance animation.

| Easing | Use |
|---|---|
| `ease-out` | enter (chip appears, data updates) |
| `ease-in` | exit (chip dismisses, panel collapses) |
| `ease-in-out` | move (scroll, sort, reorder) |

| Duration | Use |
|---|---|
| `100ms` | micro (color tween, hover) |
| `200ms` | short (chip enter, data crossfade) |
| `350ms` | medium (panel slide, list reorder) |
| `600ms` | long (rare — only modal/route transitions) |

The neural-avatar bloom animation in `AnimationScheduler` predates this system and serves a purpose (the fleet feels alive). Keep it; do not extend it to other components.

---

## Risks (deliberate departures from category norms)

These are the system's face. Each was approved during `/design-consultation`.

1. **Fraunces serif on route titles.** Most operator dashboards (Linear, Vercel, Resend) are grotesque-only. Cost: an extra font weight loaded, risks reading as marketing-y if misapplied. **Mitigation:** constrain to H1/H2 only. Never use serif in cards, lists, chrome, or charts. Gain: gossipcat reads as a magazine for your fleet, not a Grafana clone.
2. **Neural-avatar agents as primary visual.** Every other dashboard centers a bar/line chart. Cost: requires real engineering to make the graph carry information, not decoration. **Mitigation:** the accuracy-scope encoding (distance = accuracy) makes the graph *mean something*. Gain: gossipcat is the dashboard with a fleet that lives on screen.
3. **No per-agent color in card chrome.** The live dashboard today tints each agent card with a wash. Cost: agents become slightly harder to distinguish at-a-glance. **Mitigation:** the avatar bloom carries identity strongly, and the system color = status (green/amber/rose) rather than identity. Gain: much calmer dashboard, status reads instantly.

**Risk killed during design:** Risk #4 (all-caps mono section labels everywhere) was rejected. Section labels use small-caps Geist instead. The signature is quieter and more universally clean.

---

## Application checklist (for the dashboard-v2 refactor)

When refactoring `packages/dashboard-v2`, in this order:

1. **Tokens.** Replace `globals.css` color and type variables with the tokens above.
2. **Topbar.** Already close. Confirm terracotta is only on brand + active nav + the single `connection` chip when status is `Connected`.
3. **Hero row (graph + side rail).** Make equal-height (`align-items: stretch`). Adopt the accuracy-scope encoding in `AgentNetworkGraph` — agent radial position derived from `agent.accuracy * scale`.
4. **System Pulse → 24h activity waterfall.** Delete `SystemPulse.tsx`. New component: `ActivityWaterfall.tsx` reading per-agent hourly signal counts.
5. **Team cards.** Add polar accuracy gauge (SVG), severity-mix strip, area sparkline. Remove per-agent color from card chrome.
6. **Consensus flow.** New section: `ConsensusFlow.tsx`, server-side aggregate `/api/consensus-flow` returning {family, family_to_findings, findings_to_outcome} edges.
7. **Signal stream.** Replace existing list rendering with severity-tick + small-caps verdict + code-inline finding text.
8. **Skill graduation.** New section: `SkillGraduationGrid.tsx`, reading the existing skill state JSON.

Each step is one PR. Tokens-first ensures every later PR has the system to draw from.

---

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-24 | Initial design system created via `/design-consultation` | Live dashboard's color, type, and hierarchy didn't read as professional; consolidating into a single source of truth |
| 2026-05-24 | Adopted Option C (editorial canvas + infographic vocabulary) over A (editorial polish only) or B (mission-control dark) | User wanted more infographics while keeping the editorial soul; hybrid achieves both. See `approved.json` |
| 2026-05-24 | Killed Risk #4 (all-caps mono section labels) | User feedback during design: too signature-loaded; small-caps Geist is quieter and more universally clean |
