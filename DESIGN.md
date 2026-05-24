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
| `--ink-3` | `#6B6862` | tertiary, meta, timestamps (darkened from #807A71 to pass WCAG AA 4.5:1 against `--bg`) |
| `--ink-4` | `#807A71` | **NON-TEXT ONLY** — tick marks, hairline axes, decorative glyphs. Contrast 4.3:1; do not use for text labels. |
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
| `--ok` | `#2A6E4F` | `#DCEBE2` | confirmed, healthy, passed, positive delta (darkened from #2F7D5B to clear 4.5:1 for 11px chip text) |
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
| `--c8` | `#B85FA0` | magenta |

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

### Token migration (incremental, non-breaking)

The current `packages/dashboard-v2/src/globals.css` ships its own token set (`--surface`, `--text`, `--accent`, `--color-confirmed`, etc.). Renaming everything in one commit would break every `var(--text)` reference across ~30 components plus any inline `style={{}}` props. Instead, **the first PR adds the new token names as aliases onto the live tokens**, then later PRs migrate consumers incrementally.

Drop this block at the top of `globals.css` `:root { ... }`:

```css
/* DESIGN.md token aliases — keeps both old and new names live during migration */
--bg: var(--color-background);          /* maps to live #f5f4ef */
--surface: var(--color-card);           /* live --surface-elev (#ffffff) */
--surface-2: var(--color-muted);        /* live --surface-sunk (#ede9e0) */
--ink: var(--color-foreground);         /* live --text (#1f1f1d) */
--ink-2: #4A4640;                       /* NEW — no live equivalent */
--ink-3: #6B6862;                       /* NEW — was live --text-dim, darkened for WCAG */
--ink-4: #807A71;                       /* NEW — non-text only */
--accent: var(--color-primary);         /* live #cc785c, near-identical to spec #C97056 */
--accent-soft: rgba(204, 120, 92, 0.12);
--ok: var(--color-confirmed);           /* live #1a7e5e */
--ok-soft: #DCEBE2;
--warn: var(--color-unverified);        /* live #b8741d */
--warn-soft: #F2E4CC;
--bad: var(--color-disputed);           /* live #c0392b — slightly redder than spec rose */
--bad-soft: #EFD4D8;
--info: #3F8B86;                        /* NEW — no live equivalent */
--info-soft: #D5E6E4;
--idle: var(--color-insight);           /* live #6b6a64 */
--idle-soft: #E5E0D7;
```

Once every component has migrated to the new names, the live `--text`/`--surface`/etc. aliases can be deleted. **Until then, both name families render the same colors** — the old name is canonical, the new name is a forward reference. This keeps every existing component working through the refactor.

Chart palette (`--c1`–`--c7`), per-agent identity hues, and DESIGN.md-only tokens (`--ink-2`, `--info`) are net-new — add them as literal hex values, no alias.

### Color rules (load-bearing)

1. **Terracotta accent has six jobs in the live dashboard today and one job here:** brand mark, active nav state, primary CTA, key emphasis on counts that are calls to action. **Never** on chart bars, status indicators, or generic UI furniture.
2. **Status is always semantic.** A red badge always means `bad`. A green badge always means `ok`. No exceptions.
3. **Per-agent color lives in the avatar bloom only.** Card chrome stays neutral. The bloom is the identity.
4. **Charts pick from the chart palette.** Never from semantic colors (unless the chart IS encoding semantics, e.g. consensus-flow sankey using `ok`/`bad`/`info`).

---

## Typography

Two voices + one constrained signature. Cut from the live dashboard's 3–4 voices.

### Font stack

| Role | Font | Source | Why |
|---|---|---|---|
| **Display / route title (H1, H2)** | **Fraunces** (variable, weight 500) | Google Fonts | Editorial soul. Constrained to route titles + section heroes only. Not used in cards, lists, or chrome. |
| **Body / UI / data** | **Geist** (weights 300, 400, 500, 600, 700) with `tabular-nums` always on | **npm `geist`** package (Vercel proprietary — NOT on Google Fonts) | Modern grotesque, exceptional at small sizes, tabular numbers for all metrics |
| **Mono (constrained)** | **JetBrains Mono** (weights 400, 500) | Google Fonts (already loaded) | Task IDs, hashes, code inlines, axis labels. Never body. |

### Font loading (Step 0 of the application checklist)

Fraunces is on Google Fonts; Geist is not. Both must be loaded BEFORE any token PR, otherwise typography silently falls back to system-ui (undetectable drift):

1. **Fraunces** — add the variable font import to `packages/dashboard-v2/index.html`, merged into the existing Inter+JetBrains Mono `<link>`:

   ```html
   <link rel="stylesheet"
     href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap">
   ```

2. **Geist** — `npm install geist` in `packages/dashboard-v2`, then `import { GeistSans } from 'geist/font/sans'` in `App.tsx` (or use the Geist CSS variable approach for non-Next.js per the geist npm README). Update `globals.css` `--font-sans` to chain Geist first, fall back to Inter:

   ```css
   --font-sans: 'Geist', 'Inter', system-ui, sans-serif;
   ```

3. **Verify** — Vite dev server reload, inspect any heading in DevTools, confirm `font-family` resolves to Geist/Fraunces and not Inter/system. If Geist falls back, the npm import is wrong.

Inter stays loaded as the fallback until every component is verified to render in Geist; remove it from the link tag in the final cleanup PR.

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

### Responsive breakpoints

The system is optimized for 1440px. Three breakpoints define progressive collapse:

| Breakpoint | Width | Hero row | Agent grid | Page padding |
|---|---|---|---|---|
| `--bp-xl` | ≥ 1440 | 1.55fr / 1fr side-by-side | 2 cols | `--s-7` / `--s-6` |
| `--bp-lg` | 1280–1439 | 1.55fr / 1fr side-by-side | 2 cols | `--s-7` / `--s-5` |
| `--bp-md` | 1024–1279 | **Stack vertically** — graph above sidebar, sidebar becomes a 3-up row | 2 cols | `--s-6` / `--s-5` |
| `--bp-sm` | 768–1023 | Stack vertically, sidebar becomes a 1-up column under graph | 1 col | `--s-5` / `--s-4` |
| `--bp-xs` | < 768 | Same as `--bp-sm`; topbar nav collapses to overflow menu | 1 col | `--s-5` / `--s-4` |

**Layout-specific rules at narrow widths:**

- The fleet accuracy scope chart needs ≥ 480px to be readable. Below that, fall back to the leaderboard list (top-performers card) and hide the scope. Implementer should add a `@container` query or width-watcher.
- 24h activity waterfall: at `< 1024`, drop the right "Signals · 24h" total column and integrate the count into the agent name row. Heatmap stays.
- Consensus flow sankey: at `< 1024`, becomes a vertical 3-row stacked-bar (model → findings → outcome) instead of horizontal flow.
- Skill graduation grid: 6 cols at xl, 4 cols at lg/md, 2 cols at sm, 1 col at xs.

---

## Components (contracts)

### State coverage (applies to every component below)

Every component contract must specify all four states. Implementations missing any of these fail review:

- **Full** — the normal render with data.
- **Loading** — skeleton shimmer using `--border` opacity 0.4 cells matching the full-state grid density. NO spinners; the dashboard is dense, spinners read as noise. Skeletons should be the same shape as the full state so the layout doesn't shift on load.
- **Empty** — what renders with zero data. Empty must NEVER be three naked zeros (the live dashboard's `SystemPulse` failure mode). Pattern: keep the structural frame, replace numeric values with a short context line (e.g., `Last task completed 1h ago`, `No active dispatches — fleet idle`, `No consensus rounds yet — dispatch your first review`).
- **Error** — connection failure, fetch failure, agent timeout. Pattern: full-card `chip-bad` at top-right with the error reason in mono small; preserve any cached data dimmed at 50% opacity so the operator still sees their last-known state. Never a blank card; never a giant error illustration.

Standard error message vocabulary (for consistency):

- `Relay disconnected — last update 5m ago`
- `Fetch failed — retry in 30s`
- `Agent <id> timed out`
- `Consensus round <consensusId> failed`

### Card

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

Chrome is neutral. The agent's identity color appears only in the gauge stroke, the sub-bar fills, and the sparkline. The agent's identity color drives the gauge stroke (per-agent identity color via `agentColor(id)`, not status). The status chip alongside the agent name carries the semantic healthy/needs-skills color.

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

Grid of 6 columns × N rows. Each cell: title (mono), 100×40 SVG showing the post-bind effectiveness curve with a dashed `--ok` line at the graduation threshold, status text (small-caps semantic).

**Verdict colors — full live-system coverage (6 states):**

| Verdict | Token | Live equivalent | Use |
|---|---|---|---|
| `passed` | `--ok` | emerald | curve above threshold, statistical confidence reached |
| `pending` | `--info` | sky / teal | accumulating evidence, no verdict yet |
| `insufficient_evidence` | `--idle` | yellow → reroute to neutral | not enough signal volume, MIN_EVIDENCE not met |
| `inconclusive` | `--warn` | orange | evidence window completed but no clear verdict |
| `silent_skill` | `--ink-3` | zinc | bound but never injected (no triggering category) |
| `failed` | `--bad` | red | curve below threshold, regression detected |

Note: spec deliberately does NOT use `--accent` for `pending` (would burn the accent for a non-actionable state). Live `SkillCard.tsx` palette must be migrated to these token mappings during Step 8.

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

### Reduced motion (mandatory)

All continuous animations — neural-avatar bloom, signal-stream live pulse, any future scroll-driven motion — MUST respect `@media (prefers-reduced-motion: reduce)`. Freeze the frame at a representative rest pose; do not pause/resume. Implementation pattern in `NeuralAvatar.tsx`:

```tsx
const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
useAnimationFrame((t) => { if (reduced) return; /* ...bloom math */ });
```

Discrete transitions (chip enter, panel slide) under 200ms are exempt — they don't trigger motion sensitivity at that duration. Anything ≥ 350ms or continuous must honor the preference.

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

Each step is **one PR**. Each step has a **gate criterion** that must be true before the next PR starts. Tokens-first (via aliases) ensures every later PR has the system to draw from without breaking the live dashboard.

**Step 0 — Fonts.** Load Fraunces via Google Fonts (`index.html` link tag) + Geist via npm (`npm install geist` + import). Update `--font-sans` in `globals.css` to chain Geist first, Inter as fallback. Verify in DevTools that headings render in Geist, not Inter. *Gate:* `font-family` of `body` resolves to `Geist` in DevTools.

**Step 1 — Token aliases + smoke test.** Add the alias block from the "Token migration" section above to `globals.css` `:root`. Apply the `.h-section` class (new small-caps Geist signature) to ONE existing section header — `TeamHero` is a good first target — to prove the type role renders correctly. **Do NOT rename existing component CSS references yet.** *Gate:* dashboard renders identically to pre-Step-1 except `TeamHero`'s section header now reads in small-caps Geist.

**Step 2 — `.h-section` retroactive sweep.** Apply the small-caps Geist signature to EVERY existing section header across all routes: `SystemPulse`, `TeamHero`, `FindingsMetrics`, `SignalsPage`, `LogsPage`, `AgentPage`, etc. This is mechanical but high-surface-area — Insight I1 from the design review. While here, fix the existing `--accent` violations in `SystemPulse.tsx:91-93` (header text). *Gate:* no all-caps mono header remains; no `var(--accent)` on furniture or chart bars.

**Step 3 — Topbar.** Confirm terracotta is only on brand mark + active nav (the original spec text incorrectly suggested the `connection` chip uses terracotta — it should use `--ok` green when status is `Connected` per the semantic palette; the mockup at `approved-overview-c.html` shows green). Migrate `--text` / `--text-dim` / `--text-faint` references in `TopBar.tsx` to the new ink aliases (`--ink` / `--ink-3`). `--ink-4` is non-text only, so anywhere `--text-faint` styled actual text (placeholders, kbd hints) goes to `--ink-3` instead. The `--surface-elev` references stay — DESIGN.md `--surface` was deliberately not aliased due to the naming collision documented in the Token Migration section. *Gate:* topbar still renders correctly; no orange leaks elsewhere; connection chip is green when Connected.

**Step 4 — Hero row.** Make equal-height (`align-items: stretch`). Adopt the accuracy-scope encoding in `AgentNetworkGraph` — agent radial position derived from `agent.accuracy * scale`. Add the inline legend at top-left (per F6 review finding: `Distance from center = accuracy · spoke color = agent identity`, 11px, below section header). *Gate:* graph card and sidebar share row height; legend visible in viewport without scrolling.

**Step 5 — System Pulse → 24h activity waterfall.** Delete `SystemPulse.tsx`. New component: `ActivityWaterfall.tsx` reading per-agent hourly signal counts. Must implement all four states (full / loading / empty / error per the State Coverage subsection). *Gate:* relay-off renders empty state with copy "No active dispatches — fleet idle", not three zeros.

**Step 6 — Team cards.** Add polar accuracy gauge (SVG) with "ACCURACY" label, severity-mix strip, area sparkline. **Per-agent identity color** (`agentColor(agent.id)`) drives the gauge stroke, all three sub-bar fills, and the sparkline — same color across the whole card. Card chrome (border, background, hover) stays neutral; identity color lives only in the data viz. Status chip (top-right) is semantic: `healthy` (`--ok` dot) when `accuracy ≥ 0.7` and not benched, else `needs skills` (`--warn` dot). *Gate:* no `var(--accent)` in `AgentCardBig.tsx` chart bars.

**Step 7 — Consensus flow.** Backend prerequisite: ship `/api/consensus-flow` endpoint returning `{family_to_findings: [...], findings_to_outcome: [...]}` edges with proportional weights. Frontend component: `ConsensusFlow.tsx`. Both states (loading skeleton + empty "no consensus rounds yet") must ship in the same PR. *Gate:* endpoint returns a non-empty response from `gossip_status()`-active fleet; sankey renders.

**Step 8 — Signal stream.** Replace existing list rendering with severity-tick + small-caps verdict + code-inline finding text. *Gate:* `disputed`/`confirmed`/`unverified` verdicts use semantic small-caps; severity bars use semantic colors only.

**Step 9 — Skill graduation.** New section: `SkillGraduationGrid.tsx`, reading the existing skill state JSON. Handle all SIX verdict states from the Skill graduation contract (passed/pending/insufficient_evidence/inconclusive/silent_skill/failed). *Gate:* every live skill renders with a defined verdict color; no fallthrough to undefined.

**Step 10 — Cleanup.** Remove Inter from the `<link>` tag in `index.html`. Audit `globals.css` for unused legacy tokens (`--text-faint`, `--color-chart-deep`, etc.) and remove. Run a final pass for any remaining all-caps `font-mono` headers. *Gate:* `git grep "uppercase tracking-widest" packages/dashboard-v2/src` returns empty.

Each PR ships a Lighthouse + axe-core report demonstrating WCAG AA compliance maintained.

---

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-24 | Initial design system created via `/design-consultation` | Live dashboard's color, type, and hierarchy didn't read as professional; consolidating into a single source of truth |
| 2026-05-24 | Adopted Option C (editorial canvas + infographic vocabulary) over A (editorial polish only) or B (mission-control dark) | User wanted more infographics while keeping the editorial soul; hybrid achieves both. See `approved.json` |
| 2026-05-24 | Killed Risk #4 (all-caps mono section labels) | User feedback during design: too signature-loaded; small-caps Geist is quieter and more universally clean |
| 2026-05-24 | Revised v0 → v1 after design review (consensus 144335b4, sonnet-designer) | 10 findings + 1 suggestion + 1 insight. Critical: F1 token namespace collision (fixed via alias migration), F2 Geist not on Google Fonts (fixed by Step 0 + npm install). High: F3 added State Coverage subsection, F4 darkened `--ink-3` to #6B6862 / `--ok` to #2A6E4F / restricted `--ink-4` to non-text use, F5 added Responsive breakpoints. F9 expanded skill graduation to 6 states. F6/F7/F8/F10 folded into the revised application checklist (Steps 0/2/4/5/6/7 gates). S1 added prefers-reduced-motion rule. I1 acknowledged via new Step 2 (.h-section retroactive sweep) |
| 2026-05-24 | v1.1 — Step 6 sub-bar / gauge / sparkline colors reverted from chart palette (`--c1/--c2/--c3`) to per-agent identity color (`agentColor(id)`) | The chart-palette mapping was a misreading of the original infographic-vocabulary intent. Per-agent identity flooding the data viz is what was shown in the approved Option C preview; only card chrome stays neutral. Status chip stays semantic. Caught during PR #471 visual review |
| 2026-05-24 | v1.1 clarification — Fraunces is allowed for the gauge center % inside AgentCardBig | Strict reading of §Typography reserves Fraunces for routes/heroes; gauge center % is an explicit editorial-accent carve-out inside an otherwise Geist card. Caught and documented during PR #471 pre-merge consensus |
