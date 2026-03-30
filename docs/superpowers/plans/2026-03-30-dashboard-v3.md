# Dashboard v3 — Ruthless Trim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current data-dump dashboard with an actionable inbox that shows status, live tasks, trust rings, and actual findings.

**Architecture:** Keep single-page hub layout. Each hub section is an independent pure function returning a DOM node. Delete performance section + chart lib. Rewrite overview (status bar), team (trust rings), activity (run timeline with findings), knowledge (flat list). Add live task strip. One new API endpoint (`active-tasks`). Update build.js to remove deleted files.

**Tech Stack:** Vanilla JS, SVG (trust rings), CSS custom properties

**Spec:** `docs/superpowers/specs/2026-03-30-dashboard-v3-design.md`

---

### Task 1: Delete performance section + chart lib

**Files:**
- Delete: `packages/dashboard/src/hub/performance.js`
- Delete: `packages/dashboard/src/lib/chart.js`
- Modify: `packages/dashboard/src/app.js`
- Modify: `packages/dashboard/build.js`
- Modify: `packages/dashboard/src/style.css`

- [ ] **Step 1: Remove performance from renderHub in app.js**

In `packages/dashboard/src/app.js`, in the `renderHub` function (around line 164-237):

Remove the line:
```js
    app.appendChild(renderPerformanceSection(tasks, agents));
```

Update the Promise.all to drop the `tasks` fetch (it was only needed for charts — activity now uses consensus data):
```js
    const [overview, agents, consensus] = await Promise.all([
      api('overview'), api('agents'), api('consensus'),
    ]);
```

Update the section references. After this change, section order is: [0]=overview, [1]=team, [2]=activity, [3]=knowledge. Update the WS refresh indices:
```js
    // Replace section DOM nodes (new indices: 0=overview, 1=team, 2=activity, 3=knowledge)
    if (ov && sections[0]) { const el = renderOverviewSection(ov); sections[0].replaceWith(el); }
    if (ag && sections[1]) { const el = renderTeamSection(ag); sections[1].replaceWith(el); }
    if ((cx) && sections[2]) { const el = renderActivitySection(cx); sections[2].replaceWith(el); }
    if (ag && sections[3]) { const el = renderKnowledgeSection(ag); sections[3].replaceWith(el); }
```

Update sectionMap — remove 'performance' references:
```js
    const sectionMap = {
      task_dispatched:      ['activity'],
      task_completed:       ['overview', 'activity'],
      task_failed:          ['overview', 'activity'],
      consensus_started:    ['activity'],
      consensus_complete:   ['overview', 'activity'],
      agent_connected:      ['overview', 'team'],
      agent_disconnected:   ['overview', 'team'],
      skill_changed:        [],
    };
```

Update the needs* variables — remove needsTasks and needsSignals:
```js
    const needsOverview = toRefresh.has('overview');
    const needsAgents = toRefresh.has('team') || toRefresh.has('knowledge');
    const needsConsensus = toRefresh.has('activity');

    const [ov, ag, cx] = await Promise.all([
      needsOverview ? api('overview') : null,
      needsAgents ? api('agents') : null,
      needsConsensus ? api('consensus') : null,
    ]);
```

Also update the `renderActivitySection` call to only take consensus:
```js
    app.appendChild(renderActivitySection(consensus));
```

- [ ] **Step 2: Remove performance.js and chart.js from build.js**

In `packages/dashboard/build.js`, remove these two lines from the `jsParts` array:
```js
    join(srcDir, 'lib', 'chart.js'),
    join(srcDir, 'hub', 'performance.js'),
```

- [ ] **Step 3: Remove chart/performance CSS from style.css**

In `packages/dashboard/src/style.css`, remove all rules for: `.chart-grid`, `.chart-card`, `.chart-head`, `.chart-title`, `.chart-legend`, `.lg-dot`, and any SVG chart styles.

- [ ] **Step 4: Delete the files**

```bash
rm packages/dashboard/src/hub/performance.js packages/dashboard/src/lib/chart.js
```

- [ ] **Step 5: Build and verify no errors**

```bash
cd packages/dashboard && node build.js
```

- [ ] **Step 6: Commit**

```bash
git add -A packages/dashboard/ dist-dashboard/
git commit -m "feat(dashboard): delete performance charts + chart lib

Charts were never used. Removes ~190 lines of code and 2 API calls
per page load (tasks + signals on hub)."
```

---

### Task 2: Rewrite overview as status bar

**Files:**
- Modify: `packages/dashboard/src/hub/overview.js`
- Modify: `packages/dashboard/src/style.css`

- [ ] **Step 1: Rewrite overview.js**

Replace `packages/dashboard/src/hub/overview.js` entirely:

```js
// packages/dashboard/src/hub/overview.js — Status bar (replaces metric cards)

function renderOverviewSection(data) {
  const { timeAgo } = window._dash;
  const section = document.createElement('div');
  section.className = 'section status-bar';

  const connected = data.relayConnected || 0;
  const native = data.nativeCount || 0;
  const totalOnline = connected + native;

  // Find most recent consensus timestamp from overview
  const lastRun = data.lastConsensusTimestamp;
  const lastRunText = lastRun ? timeAgo(lastRun) : 'never';

  // Unverified findings count
  const unverified = data.unverifiedFindings || 0;

  const dot = '<span class="sb-dot' + (totalOnline > 0 ? ' online' : '') + '"></span>';

  section.innerHTML =
    '<div class="sb-left">' +
      '<span class="sb-brand">gossipcat</span>' +
      dot +
      '<span class="sb-stat">' + totalOnline + ' connected</span>' +
      '<span class="sb-sep">&middot;</span>' +
      '<span class="sb-stat">last run ' + lastRunText + '</span>' +
    '</div>' +
    '<div class="sb-right">' +
      (unverified > 0
        ? '<span class="sb-action">' + unverified + ' findings to review</span>'
        : '<span class="sb-clear">all clear</span>') +
    '</div>';

  return section;
}
```

- [ ] **Step 2: Add status bar CSS, remove metric card CSS**

In `packages/dashboard/src/style.css`:

Remove all `.metric-grid`, `.mc`, `.mc-val`, `.mc-label`, `.mc-detail`, `.mc-pill`, `.mc-icon` rules.

Add:
```css
/* Status bar */
.status-bar { padding: 12px 20px !important; }
.status-bar .sh { display: none; }
.sb-left, .sb-right { display: flex; align-items: center; gap: 10px; }
.status-bar { display: flex; justify-content: space-between; align-items: center; }
.sb-brand { font-weight: 700; font-size: 15px; color: var(--text); letter-spacing: -0.02em; }
.sb-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); }
.sb-dot.online { background: var(--green); }
.sb-stat { color: var(--text-2); font-size: 13px; }
.sb-sep { color: var(--text-3); }
.sb-action { color: var(--amber); font-size: 13px; font-weight: 600; }
.sb-clear { color: var(--green); font-size: 13px; }
```

- [ ] **Step 3: Update overview API to include lastConsensusTimestamp + unverifiedFindings**

In `packages/relay/src/dashboard/api-overview.ts`, add two fields to the response:

Read the last consensus timestamp from `agent-performance.jsonl` (last signal with a consensusId). Count unverified findings (signals with `signal === 'unverified'`).

Add to the response object:
```typescript
  // Last consensus run timestamp
  let lastConsensusTimestamp = '';
  let unverifiedFindings = 0;
  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  if (existsSync(perfPath)) {
    try {
      const lines = readFileSync(perfPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const s = JSON.parse(line);
          if (s.type === 'consensus' && s.timestamp) {
            if (s.timestamp > lastConsensusTimestamp) lastConsensusTimestamp = s.timestamp;
            if (s.signal === 'unverified') unverifiedFindings++;
          }
        } catch {}
      }
    } catch {}
  }
```

Include `lastConsensusTimestamp` and `unverifiedFindings` in the returned object.

- [ ] **Step 4: Build and verify**

```bash
cd packages/dashboard && node build.js
cd ../relay && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/dashboard/ packages/relay/src/dashboard/api-overview.ts dist-dashboard/
git commit -m "feat(dashboard): status bar replaces 4 metric cards

Shows connected count, last run time, and findings-to-review count.
'12 findings to review' is the call to action that keeps the tab open."
```

---

### Task 3: Rewrite team section with trust rings

**Files:**
- Modify: `packages/dashboard/src/hub/team.js`
- Modify: `packages/dashboard/src/style.css`

- [ ] **Step 1: Rewrite team.js**

Replace `packages/dashboard/src/hub/team.js` entirely:

```js
// packages/dashboard/src/hub/team.js — Trust ring agent cards

function renderTeamSection(agents) {
  const { escapeHtml: e, navigate, makeSection, timeAgo, agentInitials } = window._dash;
  const online = agents.filter(a => a.online).length;
  const section = makeSection('Team', online + '/' + agents.length + ' online', 'all agents →', '#/team');

  const grid = document.createElement('div');
  grid.className = 'ag-grid';

  // Sort by dispatch weight descending
  const sorted = [...agents].sort((a, b) =>
    (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0)
  );

  const show = sorted.slice(0, 6);
  const rest = sorted.length - show.length;

  for (const agent of show) {
    const btn = document.createElement('button');
    btn.className = 'ag';
    btn.addEventListener('click', () => navigate('#/team/' + encodeURIComponent(agent.id)));

    const w = agent.scores?.dispatchWeight ?? 0;
    const signals = agent.scores?.signals ?? 0;
    const ringColor = signals === 0 ? 'var(--text-3)'
      : w >= 1.5 ? 'var(--green)'
      : w >= 0.8 ? 'var(--amber)'
      : 'var(--red)';
    const ringOpacity = signals === 0 ? '0.35' : '1';

    const lastTask = agent.lastTask;
    const lastText = lastTask
      ? e((lastTask.task || '').replace(/\n.*/s, '').slice(0, 55))
      : 'idle';
    const lastTime = lastTask?.timestamp ? timeAgo(lastTask.timestamp) : '';

    btn.innerHTML =
      '<div class="ag-ring-wrap">' +
        '<svg class="ag-ring" viewBox="0 0 48 48" style="opacity:' + ringOpacity + '">' +
          '<circle cx="24" cy="24" r="21" fill="none" stroke="' + ringColor + '" stroke-width="3" opacity="0.2"/>' +
          '<circle cx="24" cy="24" r="21" fill="none" stroke="' + ringColor + '" stroke-width="3"' +
            ' stroke-dasharray="' + (132 * Math.min(1, (agent.scores?.accuracy ?? 0))) + ' 132"' +
            ' transform="rotate(-90 24 24)"/>' +
        '</svg>' +
        '<span class="ag-initials" style="color:' + ringColor + '">' + agentInitials(agent.id) + '</span>' +
      '</div>' +
      '<span class="ag-name">' + e(agent.id) + '</span>' +
      '<span class="ag-last">' + lastText +
        (lastTime ? ' <span class="ag-time">' + lastTime + '</span>' : '') +
      '</span>';

    grid.appendChild(btn);
  }

  if (rest > 0) {
    const more = document.createElement('button');
    more.className = 'ag ag-more';
    more.addEventListener('click', () => navigate('#/team'));
    more.innerHTML = '<span class="ag-more-count">+' + rest + '</span><span class="ag-more-label">more agents</span>';
    grid.appendChild(more);
  }

  section.appendChild(grid);
  return section;
}
```

- [ ] **Step 2: Update agents API to include lastTask**

In `packages/relay/src/dashboard/api-agents.ts`, add `lastTask` to each agent response. Read from `task-graph.jsonl` and find the most recent `task.completed` event per agent:

```typescript
  // Build lastTask per agent from task-graph
  const lastTaskMap = new Map<string, { task: string; timestamp: string }>();
  const taskGraphPath = join(projectRoot, '.gossip', 'task-graph.jsonl');
  if (existsSync(taskGraphPath)) {
    try {
      const lines = readFileSync(taskGraphPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'task.completed' && ev.agentId) {
            const existing = lastTaskMap.get(ev.agentId);
            if (!existing || ev.timestamp > existing.timestamp) {
              lastTaskMap.set(ev.agentId, { task: ev.task || '', timestamp: ev.timestamp });
            }
          }
        } catch {}
      }
    } catch {}
  }
```

Then include `lastTask: lastTaskMap.get(agent.id) || null` in each agent's response object.

- [ ] **Step 3: Replace agent card CSS**

Remove all `.ag-metrics`, `.ag-m`, `.ag-m-val`, `.ag-m-lbl` rules.

Add:
```css
/* Trust ring */
.ag-ring-wrap { position: relative; width: 48px; height: 48px; margin: 0 auto 8px; }
.ag-ring { width: 48px; height: 48px; }
.ag-initials { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; }
.ag-last { font-size: 11px; color: var(--text-3); line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 4px; text-align: center; }
.ag-time { color: var(--text-3); opacity: 0.7; }
.ag { text-align: center; padding: 16px 12px; }
.ag-name { font-size: 12px; display: block; margin-top: 2px; }
```

- [ ] **Step 4: Build and verify**

```bash
cd packages/dashboard && node build.js
cd ../relay && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/dashboard/ packages/relay/src/dashboard/api-agents.ts dist-dashboard/
git commit -m "feat(dashboard): trust ring agent cards replace 4-number grid

Single SVG ring shows accuracy fill + color by dispatch weight.
Last task outcome in plain English replaces raw metrics."
```

---

### Task 4: Rewrite activity as consensus run timeline

**Files:**
- Modify: `packages/dashboard/src/hub/activity.js`
- Modify: `packages/dashboard/src/style.css`

- [ ] **Step 1: Rewrite activity.js**

Replace `packages/dashboard/src/hub/activity.js` entirely:

```js
// packages/dashboard/src/hub/activity.js — Consensus run timeline with expandable findings

function renderActivitySection(consensusData) {
  const { escapeHtml: e, navigate, makeSection, timeAgo, agentInitials } = window._dash;
  const runs = consensusData.runs || [];
  const section = makeSection('Recent Runs', runs.length + ' runs', 'all signals →', '#/signals');

  const list = document.createElement('div');
  list.className = 'run-list';

  if (runs.length === 0) {
    list.innerHTML = '<div class="empty-state">No consensus runs yet. Dispatch agents with gossip_dispatch_consensus.</div>';
    section.appendChild(list);
    return section;
  }

  for (const run of runs.slice(0, 10)) {
    const card = document.createElement('div');
    card.className = 'run-card';

    const c = run.counts || {};
    const total = (c.agreement || 0) + (c.disagreement || 0) + (c.hallucination || 0) + (c.unverified || 0) + (c.unique || 0) + (c.new || 0);

    // Summary pills
    const pills = [];
    if (c.agreement) pills.push('<span class="pill pill-g">' + c.agreement + ' confirmed</span>');
    if (c.disagreement || c.hallucination) pills.push('<span class="pill pill-r">' + ((c.disagreement || 0) + (c.hallucination || 0)) + ' disputed</span>');
    if (c.unverified) pills.push('<span class="pill pill-y">' + c.unverified + ' unverified</span>');
    if (c.unique) pills.push('<span class="pill pill-b">' + c.unique + ' unique</span>');

    // Agent initials
    const agentChips = run.agents.slice(0, 4).map(a =>
      '<span class="run-agent-chip">' + agentInitials(a) + '</span>'
    ).join('');
    const moreAgents = run.agents.length > 4 ? '<span class="run-agent-more">+' + (run.agents.length - 4) + '</span>' : '';

    // Header (always visible)
    const header = document.createElement('div');
    header.className = 'run-header';
    header.innerHTML =
      '<div class="run-top">' +
        '<span class="run-expand">&#9654;</span>' +
        '<span class="run-title">' + total + ' findings</span>' +
        '<span class="run-agents">' + agentChips + moreAgents + '</span>' +
        '<span class="run-time">' + timeAgo(run.timestamp) + '</span>' +
      '</div>' +
      '<div class="run-pills">' + pills.join('') + '</div>';

    // Findings (collapsed by default)
    const findings = document.createElement('div');
    findings.className = 'run-findings';
    findings.hidden = true;

    for (const sig of run.signals) {
      if (sig.signal === 'signal_retracted') continue;

      let tag = '', tagClass = '';
      if (sig.signal === 'agreement' || sig.signal === 'unique_confirmed') { tag = 'CONFIRMED'; tagClass = 'tag-g'; }
      else if (sig.signal === 'disagreement' || sig.signal === 'hallucination_caught') { tag = 'DISPUTED'; tagClass = 'tag-r'; }
      else if (sig.signal === 'unverified' || sig.signal === 'unique_unconfirmed') { tag = 'UNVERIFIED'; tagClass = 'tag-y'; }
      else if (sig.signal === 'new_finding') { tag = 'NEW'; tagClass = 'tag-b'; }
      else continue;

      const evidence = e((sig.evidence || '').slice(0, 200));
      const attribution = sig.counterpartId
        ? e(sig.agentId) + ' &amp; ' + e(sig.counterpartId)
        : e(sig.agentId);

      const row = document.createElement('div');
      row.className = 'finding-row';
      row.innerHTML =
        '<span class="finding-tag ' + tagClass + '">' + tag + '</span>' +
        '<div class="finding-body">' +
          '<div class="finding-text">' + evidence + '</div>' +
          '<div class="finding-attr">' + attribution + '</div>' +
        '</div>';
      findings.appendChild(row);
    }

    // Toggle expand/collapse
    header.addEventListener('click', () => {
      const isOpen = !findings.hidden;
      findings.hidden = isOpen;
      header.querySelector('.run-expand').innerHTML = isOpen ? '&#9654;' : '&#9660;';
      card.classList.toggle('run-open', !isOpen);
    });

    card.appendChild(header);
    card.appendChild(findings);
    list.appendChild(card);
  }

  section.appendChild(list);
  return section;
}
```

- [ ] **Step 2: Add run timeline CSS, remove old activity CSS**

Remove all `.three-col`, `.panel`, `.panel-head`, `.panel-title`, `.panel-body`, `.fr`, `.fr-*`, `.cr`, `.cr-*`, `.sig-row`, `.sig-*` rules.

Add:
```css
/* Run timeline */
.run-list { display: flex; flex-direction: column; gap: 8px; }
.run-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.run-card.run-open { border-color: var(--accent); border-color: rgba(167,139,250,0.3); }
.run-header { padding: 12px 16px; cursor: pointer; }
.run-header:hover { background: var(--surface-raised); }
.run-top { display: flex; align-items: center; gap: 10px; }
.run-expand { color: var(--text-3); font-size: 10px; width: 14px; }
.run-title { font-size: 14px; font-weight: 600; color: var(--text); flex: 1; }
.run-agents { display: flex; gap: 4px; }
.run-agent-chip { background: var(--surface-raised); color: var(--text-2); font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; }
.run-agent-more { color: var(--text-3); font-size: 10px; padding: 2px 4px; }
.run-time { color: var(--text-3); font-size: 12px; white-space: nowrap; }
.run-pills { display: flex; gap: 6px; margin-top: 6px; padding-left: 24px; }
.pill { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
.pill-g { background: rgba(52,211,153,0.15); color: var(--green); }
.pill-r { background: rgba(248,113,113,0.15); color: var(--red); }
.pill-y { background: rgba(251,191,36,0.15); color: var(--amber); }
.pill-b { background: rgba(167,139,250,0.15); color: var(--accent); }

/* Findings */
.run-findings { padding: 0 16px 12px; }
.finding-row { display: flex; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); }
.finding-tag { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; white-space: nowrap; height: fit-content; margin-top: 2px; }
.tag-g { background: rgba(52,211,153,0.15); color: var(--green); }
.tag-r { background: rgba(248,113,113,0.15); color: var(--red); }
.tag-y { background: rgba(251,191,36,0.15); color: var(--amber); }
.tag-b { background: rgba(167,139,250,0.15); color: var(--accent); }
.finding-body { flex: 1; min-width: 0; }
.finding-text { font-size: 13px; color: var(--text); line-height: 1.4; }
.finding-attr { font-size: 11px; color: var(--text-3); margin-top: 2px; }
```

- [ ] **Step 3: Build and verify**

```bash
cd packages/dashboard && node build.js
```

- [ ] **Step 4: Commit**

```bash
git add -A packages/dashboard/ dist-dashboard/
git commit -m "feat(dashboard): consensus run timeline replaces 3-column activity

Each run is an expandable card showing findings with CONFIRMED/DISPUTED/
UNVERIFIED tags, agent attribution, and evidence text. Replaces the
truncated task list, raw signal metadata, and separate consensus panel."
```

---

### Task 5: Simplify knowledge section

**Files:**
- Modify: `packages/dashboard/src/hub/knowledge.js`
- Modify: `packages/dashboard/src/style.css`

- [ ] **Step 1: Rewrite knowledge.js**

Replace `packages/dashboard/src/hub/knowledge.js` entirely:

```js
// packages/dashboard/src/hub/knowledge.js — Flat text list of agent memories

function renderKnowledgeSection(agents) {
  const { escapeHtml: e, navigate, makeSection } = window._dash;
  const section = makeSection('Knowledge', agents.length + ' agents');

  const list = document.createElement('div');
  list.className = 'know-list';

  // _project (shared) first
  const projLink = document.createElement('button');
  projLink.className = 'know-item';
  projLink.textContent = '_project (shared)';
  projLink.addEventListener('click', () => navigate('#/knowledge/_project'));
  list.appendChild(projLink);

  // Agent knowledge links
  const sorted = [...agents].sort((a, b) =>
    (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0)
  );

  for (const agent of sorted) {
    const btn = document.createElement('button');
    btn.className = 'know-item';
    btn.textContent = agent.id;
    btn.addEventListener('click', () => navigate('#/knowledge/' + encodeURIComponent(agent.id)));
    list.appendChild(btn);
  }

  section.appendChild(list);
  return section;
}
```

- [ ] **Step 2: Replace knowledge CSS**

Remove `.know-grid`, `.ka`, `.ka-name`, `.ka-avatar`, `.ka-stat`, `.learn-row`, `.learn-*` rules.

Add:
```css
/* Knowledge flat list */
.know-list { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 4px; }
.know-item { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; font-size: 12px; color: var(--text-2); cursor: pointer; transition: all 0.15s; }
.know-item:hover { background: var(--surface-raised); color: var(--text); border-color: var(--accent); }
```

- [ ] **Step 3: Build and verify**

```bash
cd packages/dashboard && node build.js
```

- [ ] **Step 4: Commit**

```bash
git add -A packages/dashboard/ dist-dashboard/
git commit -m "feat(dashboard): flat knowledge list replaces chip grid + learnings

Simple clickable text buttons linking to each agent's memory.
Removes the learnings API call on hub load."
```

---

### Task 6: Add live task strip + active-tasks API

**Files:**
- Modify: `packages/dashboard/src/app.js`
- Create: `packages/relay/src/dashboard/api-active-tasks.ts`
- Modify: `packages/relay/src/dashboard/routes.ts`
- Modify: `packages/dashboard/src/style.css`

- [ ] **Step 1: Create active-tasks API endpoint**

Create `packages/relay/src/dashboard/api-active-tasks.ts`:

```typescript
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface ActiveTask {
  taskId: string;
  agentId: string;
  task: string;
  startedAt: string;
}

export async function activeTasksHandler(projectRoot: string): Promise<{ tasks: ActiveTask[] }> {
  const taskGraphPath = join(projectRoot, '.gossip', 'task-graph.jsonl');
  if (!existsSync(taskGraphPath)) return { tasks: [] };

  const created = new Map<string, { agentId: string; task: string; timestamp: string }>();
  const finished = new Set<string>();

  try {
    const lines = readFileSync(taskGraphPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'task.created' && ev.taskId) {
          created.set(ev.taskId, { agentId: ev.agentId || '', task: ev.task || '', timestamp: ev.timestamp || '' });
        } else if (ev.type === 'task.completed' || ev.type === 'task.failed' || ev.type === 'task.cancelled') {
          finished.add(ev.taskId);
        }
      } catch {}
    }
  } catch { return { tasks: [] }; }

  const active: ActiveTask[] = [];
  for (const [taskId, info] of created) {
    if (finished.has(taskId)) continue;
    active.push({ taskId, agentId: info.agentId, task: info.task, startedAt: info.timestamp });
  }

  // Most recent first, cap at 10
  active.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { tasks: active.slice(0, 10) };
}
```

- [ ] **Step 2: Register the endpoint in routes.ts**

In `packages/relay/src/dashboard/routes.ts`, import and register:

```typescript
import { activeTasksHandler } from './api-active-tasks';
```

Add a route handler alongside the existing ones (inside the `setupRoutes` method or equivalent):

```typescript
// Active tasks (live strip)
router.get('/api/active-tasks', async () => {
  return await activeTasksHandler(this.projectRoot);
});
```

Follow the exact pattern of the existing route registrations in `routes.ts`.

- [ ] **Step 3: Add live strip rendering in app.js**

In `packages/dashboard/src/app.js`, add a `renderLiveStrip` function after the utilities section:

```js
// ── Live Task Strip ──────────────────────────────────────────────────────
async function renderLiveStrip(container) {
  try {
    const data = await api('active-tasks');
    const tasks = data.tasks || [];
    container.innerHTML = '';
    if (tasks.length === 0) { container.hidden = true; return; }
    container.hidden = false;

    for (const t of tasks) {
      const elapsed = Math.floor((Date.now() - new Date(t.startedAt).getTime()) / 1000);
      const desc = escapeHtml((t.task || '').replace(/\n.*/s, '').slice(0, 60));
      const row = document.createElement('div');
      row.className = 'live-task';
      row.innerHTML =
        '<span class="live-icon">&#9889;</span>' +
        '<span class="live-agent">' + escapeHtml(t.agentId) + '</span>' +
        '<span class="live-desc">' + desc + '</span>' +
        '<span class="live-elapsed">' + elapsed + 's</span>';
      container.appendChild(row);
    }
  } catch { container.hidden = true; }
}
```

In `renderHub`, after building the app DOM, insert the live strip container before the team section:

```js
    // Live task strip (conditional — only shows when agents are working)
    const liveStrip = document.createElement('div');
    liveStrip.className = 'section live-strip';
    liveStrip.hidden = true;
    app.insertBefore(liveStrip, app.children[1]); // After status bar, before team
    renderLiveStrip(liveStrip);
```

Add `task_dispatched` and `task_completed` events to refresh the live strip:

In the WS handler, add:
```js
    if (event.type === 'task_dispatched' || event.type === 'task_completed' || event.type === 'task_failed') {
      renderLiveStrip(app.querySelector('.live-strip'));
    }
```

- [ ] **Step 4: Add live strip CSS**

```css
/* Live task strip */
.live-strip { padding: 8px 20px !important; background: rgba(251,191,36,0.05); border: 1px solid rgba(251,191,36,0.15); }
.live-strip .sh { display: none; }
.live-task { display: flex; align-items: center; gap: 10px; padding: 4px 0; font-size: 13px; }
.live-icon { font-size: 14px; }
.live-agent { color: var(--accent); font-weight: 600; min-width: 140px; }
.live-desc { color: var(--text-2); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-elapsed { color: var(--amber); font-variant-numeric: tabular-nums; min-width: 40px; text-align: right; }
```

- [ ] **Step 5: Build and type-check**

```bash
cd packages/dashboard && node build.js
cd ../relay && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add -A packages/dashboard/ packages/relay/src/dashboard/ dist-dashboard/
git commit -m "feat(dashboard): live task strip shows active agents in real-time

Conditional strip appears when agents are working, disappears when idle.
New /dashboard/api/active-tasks endpoint reads task-graph.jsonl for
tasks with task.created but no completion event."
```

---

### Task 7: Update build.js + full rebuild + visual verification

**Files:**
- Modify: `packages/dashboard/build.js`

- [ ] **Step 1: Update build.js to reflect deleted files**

Verify `build.js` no longer references `chart.js` or `performance.js` (should be done in Task 1, but verify).

- [ ] **Step 2: Full build**

```bash
cd packages/dashboard && node build.js
cd ../relay && npx tsc
```

- [ ] **Step 3: Visual verification with browse**

Open the dashboard in a browser and verify:
- Status bar shows connected count + last run + findings to review
- Agent cards have trust rings with correct colors
- Consensus runs are expandable with findings
- Knowledge section is a flat list of clickable buttons
- No chart section exists
- No metric cards exist

- [ ] **Step 4: Commit build output**

```bash
git add dist-dashboard/ packages/relay/dist/
git commit -m "build: dashboard v3 full rebuild"
```

---

## Deferred Work (NOT in this plan)

- One-click signal verification on finding cards
- Trust ring drill-down to causative finding
- Historical accuracy trends / sparklines
- Agent task duration predictions / ETAs
- Relative timestamp auto-refresh (setInterval)
- Mobile responsive tweaks
