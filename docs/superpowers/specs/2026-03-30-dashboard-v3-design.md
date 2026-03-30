# Dashboard v3 — Ruthless Trim Redesign

**Date:** 2026-03-30
**Status:** Design approved
**Consensus:** 5/5 agents unanimously picked Approach A. 21 confirmed, 0 disputed.

## Problem

The dashboard shows internal metrics (signal counts, task totals, accuracy percentages) instead of answering the questions developers actually have:
- "What are my agents doing right now?"
- "What did they find?"
- "Which agents can I trust?"

Specific issues:
- Charts are never looked at (waste of space)
- Overview cards show vanity numbers ("388 tasks" -- so what?)
- Task descriptions are truncated and all look the same
- Agent cards show 4 numbers when 1 would do
- Signal list shows metadata (unique_confirmed, agreement) not findings
- Knowledge chips are cluttered

## Approach: Ruthless Trim

Keep the single-page hub layout. Cut everything that doesn't answer a real question. Replace vanity metrics with actionable summaries. The dashboard becomes an **inbox**, not a monitor.

## New Layout (top to bottom)

### 1. Status Bar (replaces 4 metric cards)

Single row at the top. Answers "is my system healthy?" in one glance.

```
gossipcat   3 connected · last run 2m ago · 12 findings to review   ● WS
```

Content:
- **Connected count:** `relayConnected` agents (not config count)
- **Last run:** relative timestamp of most recent consensus run
- **Findings to review:** count of unverified findings from recent consensus runs
- **WS indicator:** green dot when WebSocket is live

The "findings to review" count is the call to action. It's the notification badge that brings developers back.

**Removes:** `overview.js` and the entire `.metric-grid`. The `overview` API response still provides the data, just rendered differently.

### 2. Live Task Strip (new, conditional)

Only visible when agents are actively working. Disappears when idle.

```
⚡ gemini-reviewer  analyzing dispatch pipeline...  42s
⚡ haiku-researcher  reviewing signal validation...  18s
```

Each row shows: agent name, task description (first 60 chars, human-readable), elapsed time.

**Data source:** Active tasks from the relay's task map (tasks with `task.created` but no `task.completed`). New lightweight API: `/dashboard/api/active-tasks` returns currently running tasks. WebSocket pushes `task_started` and `task_completed` events for instant updates.

**Behavior:** Fades in when first task starts, fades out 3s after last task completes. Uses a subtle animation to draw the eye without being distracting.

### 3. Team (redesigned agent cards)

Replace 4-number agent cards with trust ring + last action.

**Each agent card shows:**
- **Trust ring:** Single SVG circle. Color based on dispatch weight:
  - Green (weight >= 1.5): reliable
  - Amber (weight 0.8-1.5): average or insufficient data
  - Red (weight < 0.8): unreliable or circuit-open
  - Grey: no signals yet (0.35 opacity, desaturated)
- **Agent initials** in the center of the ring
- **Agent name** below the ring
- **Last task outcome** in plain English: "reviewed signal validation spec, found 3 issues" or "idle" if no recent activity. Use the task description from the most recent `task.completed` event, not the truncated task text. Relative timestamp: "2m ago".

**Overflow card:** Same as today but with trust rings instead of colored pips.

**Sort order:** By dispatch weight descending (best agents first). This is unchanged.

**Removes:** The 4-metric grid (accuracy/unique/signals/tokens) from each card. These are still available on the agent detail page.

### 4. Recent Runs (replaces activity feed)

The current activity section has 3 side-by-side panels (Recent Tasks, Consensus, Signals). Replace with a single reverse-chronological list of consensus runs, each expandable.

**Collapsed run card:**
```
▶ Signal validation review · 4 agents · 2m ago · 12 confirmed, 1 disputed
```

Shows: task summary (first meaningful line, not the full prompt), agent count, relative timestamp, finding breakdown as colored pills.

**Expanded run card (click to toggle):**
```
▼ Signal validation review · 4 agents · 2m ago
  Agents: GT  GI  GR  SR

  ✓ CONFIRMED  Race condition in dispatch-pipeline.ts line 142
               Found by: gemini-tester, confirmed by: sonnet-reviewer

  ✓ CONFIRMED  Empty taskId breaks retraction matching
               Found by: sonnet-reviewer, confirmed by: haiku-researcher

  ✗ DISPUTED   Unbounded memory growth in task-graph.jsonl
               Found by: gemini-reviewer, disputed by: sonnet-reviewer
               Reason: entry count bounded by MAX_SIGNALS=100

  ◇ UNVERIFIED extractSummary fallback truncation
               Found by: gemini-implementer, not verified by peers
```

Each finding shows:
- **Tag:** CONFIRMED (green), DISPUTED (red), UNVERIFIED (amber) -- uses existing consensus tag from `ConsensusReport`
- **Finding text:** Full finding description, not truncated. From `ConsensusFinding.finding`.
- **Attribution:** Who found it, who confirmed/disputed it. From `ConsensusFinding.originalAgentId`, `confirmedBy`, `disputedBy`.
- **Dispute reason:** When disputed, show the counterargument. From `disputedBy[].reason`.

**Single-agent tasks:** Tasks dispatched via `gossip_run` (not consensus) appear as simple rows between run cards:
```
  gemini-implementer  implemented validateSignal function  3m ago  ✓ completed
```

**Data source:** Existing `/dashboard/api/consensus` for run data. Existing `/dashboard/api/tasks` for single-agent tasks. Both already return the needed fields. The consensus API may need the full `finding` text included (currently available in the response).

**Replaces:** `activity.js` entirely. The three-column layout (tasks, consensus, signals) becomes one unified timeline.

### 5. Knowledge (simplified)

Replace the 2-column grid (memory chips + recent learnings) with a flat list of agents linking to their memory.

```
Knowledge · 7 agents
_project (shared)  ·  sonnet-reviewer (3 files)  ·  haiku-researcher (5 files)  ·  gemini-tester (20 files)  ·  ...
```

Each agent name is a link to `#/knowledge/{agentId}`. File count shown inline. No cards, no chips, no avatars. Just a scannable text row.

**Removes:** The "Recent Learnings" panel. Learnings are visible in the knowledge detail view when you click through. The hub doesn't need to preview them.

**Removes:** The `learnings` API call on hub load. One fewer fetch on every page render and WebSocket refresh.

## What's Killed

| Component | Why |
|-----------|-----|
| `performance.js` + chart lib | Charts never looked at. Unbounded task data risk. |
| `.metric-grid` (4 overview cards) | Vanity numbers. Replaced by status bar. |
| `.chart-grid` + `.chart-card` | Dead with performance.js. |
| `.ag-metrics` (4-number grid per agent) | Too much data. Replaced by trust ring. |
| 3-column activity layout | Fragmented view. Replaced by unified run timeline. |
| Signal list (raw metadata) | Replaced by findings inside run cards. |
| Knowledge chips + learnings panel | Replaced by flat text list. |

## What's New

| Component | Why |
|-----------|-----|
| Status bar with "findings to review" | Call to action, keeps tab open |
| Live task strip (conditional) | Answers "what's happening now?" |
| Trust ring per agent | One-glance agent quality |
| Consensus run cards (expandable) | Actual findings with context |
| `/dashboard/api/active-tasks` endpoint | Powers live task strip |

## CSS Changes

- Remove: `.metric-grid`, `.mc`, `.mc-*` (metric card styles)
- Remove: `.chart-grid`, `.chart-card`, `.chart-*` (chart styles)
- Remove: `.ag-metrics`, `.ag-m`, `.ag-m-*` (agent metric grid)
- Remove: `.know-grid`, `.ka`, `.ka-*` (knowledge chip styles)
- Remove: `.sig-row`, `.sig-*` (signal row styles)
- Add: `.status-bar` (single row, flex, monospace counts)
- Add: `.live-strip`, `.live-task` (conditional task progress)
- Add: `.trust-ring` (SVG circle with color)
- Add: `.run-card`, `.run-findings` (expandable consensus runs)
- Add: `.finding-row`, `.finding-tag` (individual findings)
- Modify: `.ag` (simpler card with ring instead of metrics)

## API Changes

**New endpoint:** `GET /dashboard/api/active-tasks`
Returns tasks currently in-flight (created but not completed/failed/cancelled).
```json
{
  "tasks": [
    { "taskId": "abc", "agentId": "gemini-reviewer", "task": "analyzing dispatch...", "startedAt": "..." }
  ]
}
```

Source: scan `task-graph.jsonl` for `task.created` entries without a matching `task.completed`/`task.failed`/`task.cancelled`. Cap at 20 most recent.

**Modified endpoint:** `GET /dashboard/api/consensus` -- ensure full `finding` text is included in the response (not truncated). Already mostly there, verify the `ConsensusRun.signals` array includes evidence.

**No changes to:** `overview`, `agents`, `memory`, `learnings`, `signals`, `tasks`.

## WebSocket Changes

**New events to handle:**
- `task_started` -> show in live task strip (or refresh strip)
- `task_completed` -> remove from live task strip, refresh Recent Runs section

Existing events continue to work for section-level refresh via the `sectionMap` pattern.

## Files to Change

| File | Change |
|------|--------|
| `packages/dashboard/src/hub/overview.js` | Rewrite: status bar |
| `packages/dashboard/src/hub/team.js` | Rewrite: trust ring cards |
| `packages/dashboard/src/hub/activity.js` | Rewrite: run timeline with findings |
| `packages/dashboard/src/hub/knowledge.js` | Rewrite: flat text list |
| `packages/dashboard/src/hub/performance.js` | Delete |
| `packages/dashboard/src/lib/chart.js` | Delete (if exists) |
| `packages/dashboard/src/app.js` | Remove performance section, add live strip, update sectionMap |
| `packages/dashboard/src/style.css` | Remove dead styles, add new component styles |
| `packages/relay/src/dashboard/api-active-tasks.ts` | New: active tasks endpoint |
| `packages/relay/src/dashboard/routes.ts` | Register new endpoint |

## Relative Timestamps

All timestamps in the dashboard use relative format: "2m ago", "1h ago", "yesterday". Implemented as a shared `timeAgo(isoString)` utility. Updates every 30s via a single `setInterval` that refreshes all `[data-timestamp]` elements.

## Detail Views

Detail views (`#/team/:id`, `#/knowledge/:id`, `#/consensus/:id`) are **unchanged** in this redesign. They keep their current full-data layouts. The hub redesign only affects the main page.

## Out of Scope

- One-click signal verification on finding cards (follow-up)
- Trust ring drill-down to causative finding (follow-up)
- Historical accuracy trends / sparklines (follow-up)
- Agent task duration predictions / ETAs (follow-up)
- Two-panel layout (not justified until agent drill-down exists)
- Mobile responsive tweaks (current breakpoints are adequate)

## Test Plan

- Status bar shows correct connected count + relative timestamp
- Live task strip appears when agent is working, disappears when idle
- Trust ring color matches dispatch weight thresholds
- Agent card shows last task outcome in plain English
- Consensus run cards expand/collapse on click
- Findings display with correct CONFIRMED/DISPUTED/UNVERIFIED tags
- Finding attribution shows correct agent names
- Knowledge section links to correct detail views
- WebSocket updates refresh relevant sections without full page reload
- No performance regression: hub loads in < 500ms with 400+ tasks
