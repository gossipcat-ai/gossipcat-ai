# Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete visual redesign of the gossipcat dashboard — hub+detail SPA with hash routing, atmospheric design, charts, token metrics, and real-time updates.

**Architecture:** Replace the Phase 1 tab-based SPA with a hash-routed hub+detail dashboard. All CSS rewritten from scratch. Backend gets 3 API fixes (URL parsing, signals endpoint, agents enrichment). Frontend gets a router, 5 hub sections, 5 detail views, pure SVG charts, and WebSocket-driven live updates.

**Tech Stack:** Vanilla HTML/CSS/JS, esbuild bundler, pure SVG charts, JetBrains Mono + Outfit fonts (Google Fonts CDN)

**Spec:** `docs/superpowers/specs/2026-03-29-dashboard-redesign-design.md`

---

## File Structure

### Backend (packages/relay/src/dashboard/)

| File | Responsibility | Change |
|------|---------------|--------|
| `routes.ts` | HTTP route dispatcher | Modify: fix URL parsing, add signals route, catch-all for SPA |
| `api-signals.ts` | `GET /dashboard/api/signals` | Create: signal feed from agent-performance.jsonl |
| `api-agents.ts` | `GET /dashboard/api/agents` | Modify: add lastTask, totalTokens, online status |
| `api-tasks.ts` | `GET /dashboard/api/tasks` | Modify: expose inputTokens, outputTokens per task |
| `api-memory.ts` | `GET /dashboard/api/memory/:agentId` | Modify: add fileCount, cognitiveCount |
| `api-overview.ts` | `GET /dashboard/api/overview` | No changes |

### Frontend (packages/dashboard/src/)

| File | Responsibility | Change |
|------|---------------|--------|
| `index.html` | SPA shell — single container, Google Fonts link | Rewrite |
| `style.css` | Full design system — new tokens, atmospheric, responsive | Rewrite |
| `app.js` | Router, API helpers, WebSocket, escapeHtml, section orchestration | Rewrite |
| `hub/overview.js` | Hub section 1: metric cards with icons | Create (replaces tabs/overview.js) |
| `hub/team.js` | Hub section 2: agent cards 3+1 | Create (replaces tabs/agents.js) |
| `hub/performance.js` | Hub section 3: SVG area chart + bar chart | Create |
| `hub/activity.js` | Hub section 4: tasks + consensus + signals feeds | Create (replaces tabs/tasks.js, consensus.js) |
| `hub/knowledge.js` | Hub section 5: memory chips + recent learnings | Create (replaces tabs/memory.js) |
| `detail/agent.js` | Detail view: agent profile, tokens, tasks, memory, skills | Create |
| `detail/tasks.js` | Detail view: full task list with filters + search | Create |
| `detail/consensus.js` | Detail view: single consensus run signals | Create |
| `detail/signals.js` | Detail view: full signal feed with filters | Create |
| `detail/knowledge.js` | Detail view: memory browser with markdown | Create |
| `lib/chart.js` | SVG chart generators (area, bar) | Create |
| `lib/markdown.js` | Markdown renderer (extracted from current memory.js) | Create |
| `build.js` | esbuild bundler — updated file list | Modify |

### Tests (tests/relay/)

| File | Tests |
|------|-------|
| `dashboard-api.test.ts` | Modify: add signals, agents enrichment, tasks tokens tests |
| `dashboard-routes.test.ts` | Modify: URL query parsing fix, catch-all SPA route |
| `dashboard-edge-cases.test.ts` | Modify: signals edge cases, token aggregation |

---

## Phase 1: Backend API Fixes (prerequisite for all frontend work)

### Task 1: Fix URL Query String Parsing in Router

**Files:**
- Modify: `packages/relay/src/dashboard/routes.ts:48-70`
- Test: `tests/relay/dashboard-routes.test.ts`

- [ ] **Step 1: Write failing test for query string handling**

```typescript
// Append to tests/relay/dashboard-routes.test.ts
describe('URL query string handling', () => {
  it('routes /dashboard/api/overview?t=123 to overview handler', async () => {
    const req = mockReq('GET', '/dashboard/api/overview?t=123', validCookie);
    const res = mockRes();
    await router.handle(req, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.agentsOnline).toBeDefined();
  });

  it('routes /dashboard/api/signals?agent=sonnet-reviewer to signals handler', async () => {
    const req = mockReq('GET', '/dashboard/api/signals?agent=sonnet-reviewer', validCookie);
    const res = mockRes();
    await router.handle(req, res);
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/relay/dashboard-routes.test.ts --no-coverage -t "query string"`
Expected: FAIL — overview handler not matched due to exact string comparison

- [ ] **Step 3: Fix URL parsing in routes.ts**

In `routes.ts`, change the `handle` method to strip query strings:

```typescript
async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const rawUrl = req.url ?? '';
  if (!rawUrl.startsWith('/dashboard')) return false;
  const qIdx = rawUrl.indexOf('?');
  const url = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const query = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)) : null;
  // ... rest of method uses `url` (no query) for matching, passes `query` to handlers
```

Update `handleApi` signature to accept `query: URLSearchParams | null` and pass it through.

- [ ] **Step 4: Also fix SPA catch-all for hash routing**

Change the dashboard serving condition from exact match to prefix match so `/dashboard/anything` serves the SPA:

```typescript
// Serve static dashboard (SPA) — catch-all for client-side routing
if (url === '/dashboard' || url === '/dashboard/' || (url.startsWith('/dashboard') && !url.startsWith('/dashboard/api/') && !url.startsWith('/dashboard/assets/'))) {
  return this.serveDashboard(res);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/relay/dashboard-routes.test.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/dashboard/routes.ts tests/relay/dashboard-routes.test.ts
git commit -m "fix: strip query strings in dashboard router, add SPA catch-all"
```

---

### Task 2: Signals API Endpoint

**Files:**
- Create: `packages/relay/src/dashboard/api-signals.ts`
- Modify: `packages/relay/src/dashboard/routes.ts`
- Test: `tests/relay/dashboard-api.test.ts`

- [ ] **Step 1: Write failing tests for signals API**

```typescript
// Append to tests/relay/dashboard-api.test.ts
import { signalsHandler } from '@gossip/relay/dashboard/api-signals';

describe('Signals API', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  });

  it('returns empty array when no performance file', async () => {
    const result = await signalsHandler(projectRoot, null);
    expect(result.signals).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('returns consensus signals sorted by time descending', async () => {
    const signals = [
      { type: 'consensus', signal: 'agreement', agentId: 'a', taskId: 't1', timestamp: '2026-03-29T14:00:00Z' },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'b', taskId: 't1', timestamp: '2026-03-29T14:01:00Z' },
    ];
    writeFileSync(join(projectRoot, '.gossip', 'agent-performance.jsonl'), signals.map(s => JSON.stringify(s)).join('\n') + '\n');
    const result = await signalsHandler(projectRoot, null);
    expect(result.signals).toHaveLength(2);
    expect(result.signals[0].signal).toBe('hallucination_caught'); // most recent first
  });

  it('filters by agent when query param provided', async () => {
    const signals = [
      { type: 'consensus', signal: 'agreement', agentId: 'agent-a', taskId: 't1', timestamp: '2026-03-29T14:00:00Z' },
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'agent-b', taskId: 't1', timestamp: '2026-03-29T14:01:00Z' },
    ];
    writeFileSync(join(projectRoot, '.gossip', 'agent-performance.jsonl'), signals.map(s => JSON.stringify(s)).join('\n') + '\n');
    const result = await signalsHandler(projectRoot, 'agent-a');
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].agentId).toBe('agent-a');
  });

  it('limits to 100 signals', async () => {
    const signals = Array.from({ length: 150 }, (_, i) => ({
      type: 'consensus', signal: 'agreement', agentId: 'a', taskId: `t${i}`, timestamp: new Date(Date.now() - i * 1000).toISOString(),
    }));
    writeFileSync(join(projectRoot, '.gossip', 'agent-performance.jsonl'), signals.map(s => JSON.stringify(s)).join('\n') + '\n');
    const result = await signalsHandler(projectRoot, null);
    expect(result.signals).toHaveLength(100);
    expect(result.total).toBe(150);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage -t "Signals API"`
Expected: FAIL — cannot resolve `@gossip/relay/dashboard/api-signals`

- [ ] **Step 3: Implement signalsHandler**

```typescript
// packages/relay/src/dashboard/api-signals.ts
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface SignalEntry {
  type: string;
  signal: string;
  agentId: string;
  counterpartId?: string;
  taskId?: string;
  evidence?: string;
  finding?: string;
  timestamp: string;
}

export interface SignalsResponse {
  signals: SignalEntry[];
  total: number;
}

const MAX_SIGNALS = 100;

export async function signalsHandler(projectRoot: string, agentFilter: string | null): Promise<SignalsResponse> {
  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  if (!existsSync(perfPath)) return { signals: [], total: 0 };

  const all: SignalEntry[] = [];
  try {
    const lines = readFileSync(perfPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'consensus') continue;
        if (agentFilter && entry.agentId !== agentFilter) continue;
        all.push(entry);
      } catch { /* skip malformed */ }
    }
  } catch { return { signals: [], total: 0 }; }

  all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { signals: all.slice(0, MAX_SIGNALS), total: all.length };
}
```

- [ ] **Step 4: Wire into routes.ts**

Add import and route in `handleApi`:

```typescript
import { signalsHandler } from './api-signals';

// Inside handleApi, before the memory route:
if (url === '/dashboard/api/signals' && req.method === 'GET') {
  const agentFilter = query?.get('agent') || null;
  const data = await signalsHandler(this.projectRoot, agentFilter);
  this.json(res, 200, data);
  return true;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/dashboard/api-signals.ts packages/relay/src/dashboard/routes.ts tests/relay/dashboard-api.test.ts
git commit -m "feat(dashboard): signals API endpoint with agent filtering"
```

---

### Task 3: Enrich Agents API (lastTask, totalTokens, online status)

**Files:**
- Modify: `packages/relay/src/dashboard/api-agents.ts`
- Modify: `packages/relay/src/dashboard/routes.ts` (pass context)
- Test: `tests/relay/dashboard-api.test.ts`

- [ ] **Step 1: Write failing tests for enriched agents response**

```typescript
// Append to Agents API describe block in tests/relay/dashboard-api.test.ts
it('includes lastTask field from task-graph.jsonl', async () => {
  const configs = [{ id: 'agent-a', provider: 'anthropic' as const, model: 'm', skills: [] }];
  const tasks = [
    { type: 'task.created', taskId: 't1', agentId: 'agent-a', task: 'Review auth module', timestamp: '2026-03-29T14:00:00Z' },
    { type: 'task.completed', taskId: 't1', duration: 5000, timestamp: '2026-03-29T14:00:05Z', inputTokens: 1000, outputTokens: 500 },
  ];
  writeFileSync(join(projectRoot, '.gossip', 'task-graph.jsonl'), tasks.map(t => JSON.stringify(t)).join('\n') + '\n');
  const result = await agentsHandler(projectRoot, configs, []);
  expect(result[0].lastTask).toBeDefined();
  expect(result[0].lastTask.task).toContain('Review auth');
  expect(result[0].totalTokens).toBe(1500);
});

it('includes online status from onlineAgents list', async () => {
  const configs = [
    { id: 'agent-a', provider: 'anthropic' as const, model: 'm', skills: [] },
    { id: 'agent-b', provider: 'google' as const, model: 'g', skills: [] },
  ];
  const result = await agentsHandler(projectRoot, configs, ['agent-a']);
  expect(result[0].online).toBe(true);
  expect(result[1].online).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage -t "lastTask|online status"`
Expected: FAIL

- [ ] **Step 3: Update agentsHandler to accept onlineAgents and read task-graph.jsonl**

Update `agentsHandler` signature to `(projectRoot, configs, onlineAgents: string[])`. Add task-graph reading logic to extract `lastTask` per agent and sum `inputTokens + outputTokens` per agent into `totalTokens`. Add `online: boolean` field from `onlineAgents.includes(config.id)`.

- [ ] **Step 4: Update routes.ts to pass onlineAgents**

Add `onlineAgents: string[]` to `DashboardContext`. Pass it from the relay server's connection manager. In `handleApi`, pass `this.ctx.onlineAgents ?? []` to `agentsHandler`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/dashboard/api-agents.ts packages/relay/src/dashboard/routes.ts tests/relay/dashboard-api.test.ts
git commit -m "feat(dashboard): agents API enriched with lastTask, totalTokens, online status"
```

---

### Task 4: Expose Token Fields in Tasks API

**Files:**
- Modify: `packages/relay/src/dashboard/api-tasks.ts`
- Test: `tests/relay/dashboard-api.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('exposes inputTokens and outputTokens per task', async () => {
  const events = [
    { type: 'task.created', taskId: 't1', agentId: 'a', task: 'Review', timestamp: '2026-03-29T14:00:00Z' },
    { type: 'task.completed', taskId: 't1', duration: 5000, timestamp: '2026-03-29T14:00:05Z', inputTokens: 2000, outputTokens: 800 },
  ];
  writeFileSync(join(projectRoot, '.gossip', 'task-graph.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const result = await tasksHandler(projectRoot);
  expect(result.tasks[0].inputTokens).toBe(2000);
  expect(result.tasks[0].outputTokens).toBe(800);
});
```

- [ ] **Step 2: Implement — add token fields to TaskEntry and completed map**

In `api-tasks.ts`, update the `completed` Map value type to include `inputTokens?: number; outputTokens?: number`. Extract these from `task.completed` events. Add them to the output `TaskEntry`.

- [ ] **Step 3: Run tests**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add packages/relay/src/dashboard/api-tasks.ts tests/relay/dashboard-api.test.ts
git commit -m "feat(dashboard): expose token usage per task in tasks API"
```

---

### Task 5: Add fileCount and cognitiveCount to Memory API

**Files:**
- Modify: `packages/relay/src/dashboard/api-memory.ts`
- Test: `tests/relay/dashboard-api.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('returns fileCount and cognitiveCount', async () => {
  const memDir = join(projectRoot, '.gossip', 'agents', 'test-agent', 'memory', 'knowledge');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'regular.md'), '---\nname: test\ntype: knowledge\n---\nContent');
  writeFileSync(join(memDir, 'cognitive.md'), '---\nname: review\ntype: cognitive\n---\nYou reviewed the auth module');
  const result = await memoryHandler(projectRoot, 'test-agent');
  expect(result.fileCount).toBe(2);
  expect(result.cognitiveCount).toBe(1);
});
```

- [ ] **Step 2: Implement**

In `memoryHandler`, after building the `knowledge` array, compute:
- `fileCount = knowledge.length`
- `cognitiveCount = knowledge.filter(k => k.frontmatter.type === 'cognitive' || k.content.includes('You reviewed') || k.content.includes('## What I Learned')).length`

Add both to the `MemoryResponse` interface and return value.

- [ ] **Step 3: Run tests and commit**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage`

```bash
git add packages/relay/src/dashboard/api-memory.ts tests/relay/dashboard-api.test.ts
git commit -m "feat(dashboard): add fileCount and cognitiveCount to memory API"
```

---

## Phase 2: Frontend Foundation (HTML shell, CSS design system, router)

### Task 6: HTML Shell + CSS Design System

**Files:**
- Rewrite: `packages/dashboard/src/index.html`
- Rewrite: `packages/dashboard/src/style.css`

- [ ] **Step 1: Rewrite index.html**

Replace the current 6-tab HTML with the new SPA shell:
- Google Fonts `<link>` for Outfit + JetBrains Mono
- Single `#app` container (no tabs)
- Topbar with breadcrumb + WS status
- Auth gate (keep existing auth form structure)

The HTML should have: `<div id="auth-gate">` (unchanged), `<div id="dashboard" hidden>` containing topbar + `<main id="app"></main>`.

- [ ] **Step 2: Rewrite style.css from scratch**

Use the full CSS from the approved mockup (`hub-v10.html`) as the starting point. Add:
- All design tokens from spec
- Atmospheric `body::before` and `body::after`
- Responsive breakpoints (1200/900/600px)
- Accessibility: `:focus-visible` outlines, reduced-motion media query
- All component styles: metric cards, agent cards, overflow card, charts, panels, feeds, signals, knowledge

- [ ] **Step 3: Build and verify**

Run: `npm run build:dashboard`
Open `dist-dashboard/index.html` in browser — should show auth gate.

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/index.html packages/dashboard/src/style.css
git commit -m "feat(dashboard): new HTML shell and design system CSS"
```

---

### Task 7: Router + App Core

**Files:**
- Rewrite: `packages/dashboard/src/app.js`
- Modify: `packages/dashboard/build.js` (update file list)

- [ ] **Step 1: Implement hash router in app.js**

```javascript
// packages/dashboard/src/app.js

// ── Utilities ──────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function formatTokens(n) {
  if (n == null || n === 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}

// ── API Helper ─────────────────────────────────────────
async function api(path) {
  const res = await fetch(`/dashboard/api/${path}`, { credentials: 'include' });
  if (res.status === 401) { showAuth(); throw new Error('Unauthorized'); }
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `API error: ${res.status}`); }
  return res.json();
}

// ── Auth ───────────────────────────────────────────────
// (Keep existing auth logic unchanged — showAuth, showDashboard, auth form listener)

// ── Router ─────────────────────────────────────────────
function getRoute() {
  const hash = location.hash.slice(1) || '/';
  const parts = hash.split('/').filter(Boolean);
  return { path: '/' + parts.join('/'), parts };
}

function navigate(path) { location.hash = path; }

async function route() {
  const { path, parts } = getRoute();
  const app = document.getElementById('app');
  updateBreadcrumb(parts);

  if (path === '/' || path === '/overview') return renderHub(app);
  if (path === '/team') return renderAllAgents(app);
  if (parts[0] === 'team' && parts[1]) return renderAgentDetail(app, parts[1]);
  if (path === '/tasks') return renderTasksDetail(app);
  if (parts[0] === 'consensus' && parts[1]) return renderConsensusDetail(app, parts[1]);
  if (path === '/signals') return renderSignalsDetail(app);
  if (parts[0] === 'knowledge' && parts[1]) return renderKnowledgeDetail(app, parts[1]);

  app.innerHTML = '<div class="empty-state">Page not found</div>';
}

function updateBreadcrumb(parts) {
  const el = document.getElementById('breadcrumb-page');
  if (!el) return;
  if (parts.length === 0) { el.textContent = 'Overview'; return; }
  el.textContent = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' / ');
}

window.addEventListener('hashchange', route);

// ── WebSocket ──────────────────────────────────────────
// (Keep existing WS logic — connectWs, onDashboardEvent, offDashboardEvent)

// ── Hub Renderer ───────────────────────────────────────
async function renderHub(app) {
  app.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const [overview, agents, tasks, consensus, signals, memory] = await Promise.all([
      api('overview'), api('agents'), api('tasks'),
      api('consensus'), api('signals'), api('agents'), // agents doubled for knowledge section
    ]);
    app.innerHTML = '';
    const frag = document.createDocumentFragment();
    frag.appendChild(renderOverviewSection(overview));
    frag.appendChild(renderTeamSection(agents));
    frag.appendChild(renderPerformanceSection(tasks, agents));
    frag.appendChild(renderActivitySection(tasks, consensus, signals));
    frag.appendChild(renderKnowledgeSection(agents));
    app.appendChild(frag);
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Failed to load dashboard: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Init ───────────────────────────────────────────────
api('overview').then(() => { showDashboard(); route(); }).catch(() => showAuth());
window._dash = { api, navigate, escapeHtml, formatTokens, timeAgo, onDashboardEvent, offDashboardEvent };
```

- [ ] **Step 2: Update build.js file list**

```javascript
const jsParts = [
  join(srcDir, 'app.js'),
  join(srcDir, 'lib', 'chart.js'),
  join(srcDir, 'lib', 'markdown.js'),
  join(srcDir, 'hub', 'overview.js'),
  join(srcDir, 'hub', 'team.js'),
  join(srcDir, 'hub', 'performance.js'),
  join(srcDir, 'hub', 'activity.js'),
  join(srcDir, 'hub', 'knowledge.js'),
  join(srcDir, 'detail', 'agent.js'),
  join(srcDir, 'detail', 'tasks.js'),
  join(srcDir, 'detail', 'consensus.js'),
  join(srcDir, 'detail', 'signals.js'),
  join(srcDir, 'detail', 'knowledge.js'),
].map(f => readFileSync(f, 'utf-8'));
```

- [ ] **Step 3: Create stub files for all new modules**

Create empty files in `hub/`, `detail/`, `lib/` directories so the build doesn't fail. Each stub should contain a single comment: `// TODO: implement`.

- [ ] **Step 4: Build and test**

Run: `npm run build:dashboard`
Expected: builds successfully, auth gate works

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/app.js packages/dashboard/build.js packages/dashboard/src/hub/ packages/dashboard/src/detail/ packages/dashboard/src/lib/
git commit -m "feat(dashboard): hash router, app core, stub module structure"
```

---

## Phase 3: Hub Sections

### Task 8: Overview Section (metric cards with icons)

**Files:**
- Create: `packages/dashboard/src/hub/overview.js`

Implement `renderOverviewSection(overview)` returning a DOM element with:
- Section header: "Overview"
- 4-column metric grid with SVG icons from mockup (robot, clipboard, balance, pulse)
- Values from overview API, details formatted with escapeHtml
- Hover accent stripe animation

- [ ] **Step 1: Write the section renderer**
- [ ] **Step 2: Build and verify in browser**
- [ ] **Step 3: Commit**

---

### Task 9: Team Section (agent cards 3+1)

**Files:**
- Create: `packages/dashboard/src/hub/team.js`

Implement `renderTeamSection(agents)` with:
- Sort agents by `dispatchWeight` descending
- Top 3 as full cards with accent stripe, metrics (accuracy, uniqueness, signals, tokens), online/idle status
- Overflow card if 4+ agents with stacked avatars and "+N more agents"
- Empty state if 0 agents
- Click handlers → `navigate('#/team/agentId')`

- [ ] **Step 1: Write the section renderer with all edge cases**
- [ ] **Step 2: Build and verify with real data**
- [ ] **Step 3: Commit**

---

### Task 10: Performance Section (SVG charts)

**Files:**
- Create: `packages/dashboard/src/lib/chart.js`
- Create: `packages/dashboard/src/hub/performance.js`

**chart.js** exports two functions:
- `renderAreaChart(data, options)` — generates SVG area chart from `[{label, value, failed}]` array
- `renderBarChart(data, options)` — generates SVG horizontal bar chart from `[{label, value, secondary}]` array

Both return SVG element strings. Pure math: scale data points to viewBox coordinates, generate polyline/path/rect elements, add grid lines and axis labels.

**performance.js** calls `renderAreaChart` with day-bucketed task data and `renderBarChart` with agent accuracy data.

- [ ] **Step 1: Implement chart.js with area and bar chart generators**
- [ ] **Step 2: Implement performance section using chart generators**
- [ ] **Step 3: Build and verify charts render with real data**
- [ ] **Step 4: Commit**

---

### Task 11: Activity Section (3-column feed)

**Files:**
- Create: `packages/dashboard/src/hub/activity.js`

Implement `renderActivitySection(tasks, consensus, signals)` with:
- Recent Tasks panel (last 20, compact rows)
- Consensus Runs panel (last 10, colored pills)
- Signals panel (last 15, type badges with finding text)
- All with "view all →" links to detail views

- [ ] **Step 1: Write the section renderer**
- [ ] **Step 2: Build and verify**
- [ ] **Step 3: Commit**

---

### Task 12: Knowledge Section (compact 2-column)

**Files:**
- Create: `packages/dashboard/src/hub/knowledge.js`

Implement `renderKnowledgeSection(agents)` with:
- Agent memory chips (flex-wrap, colored initials, file/cognitive counts)
- Recent learnings feed (fetched per-agent from memory API on demand, or from a new bulk endpoint)
- Click handlers → `navigate('#/knowledge/agentId')`

- [ ] **Step 1: Write the section renderer**
- [ ] **Step 2: Build and verify**
- [ ] **Step 3: Commit**

---

## Phase 4: Detail Views

### Task 13: Agent Detail View

**Files:**
- Create: `packages/dashboard/src/detail/agent.js`

Implement `renderAgentDetail(app, agentId)` with:
- Identity banner, token usage, performance metrics
- Task history (filtered from tasks API)
- Memory browser (from memory API)
- Skill bindings (from skills API)

- [ ] **Step 1: Implement**
- [ ] **Step 2: Test with real agent data**
- [ ] **Step 3: Commit**

---

### Task 14: Tasks Detail + Signals Detail + Consensus Detail + Knowledge Detail

**Files:**
- Create: `packages/dashboard/src/detail/tasks.js`
- Create: `packages/dashboard/src/detail/signals.js`
- Create: `packages/dashboard/src/detail/consensus.js`
- Create: `packages/dashboard/src/detail/knowledge.js`
- Create: `packages/dashboard/src/lib/markdown.js` (extract from current memory.js)

Each detail view follows the same pattern: fetch data, render full-page view with filters/search, back-nav via breadcrumb.

- [ ] **Step 1: Extract markdown renderer to lib/markdown.js**
- [ ] **Step 2: Implement tasks detail with filters + search + token column**
- [ ] **Step 3: Implement signals detail with type/agent filters**
- [ ] **Step 4: Implement consensus detail with signal breakdown**
- [ ] **Step 5: Implement knowledge detail with markdown rendering**
- [ ] **Step 6: Build and test all detail views**
- [ ] **Step 7: Commit**

---

## Phase 5: WebSocket Live Updates + Polish

### Task 15: WebSocket Event Routing

**Files:**
- Modify: `packages/dashboard/src/app.js`

Wire WS events to section re-renders per the spec's event→section mapping table. On each event, re-fetch only the affected API endpoint and update only the changed DOM section.

- [ ] **Step 1: Implement event→section mapping in app.js**
- [ ] **Step 2: Test with live relay running**
- [ ] **Step 3: Commit**

---

### Task 16: Delete Old Tab Files + Final Build

**Files:**
- Delete: `packages/dashboard/src/tabs/` (all 6 files)
- Modify: `packages/dashboard/build.js` (remove old file refs)

- [ ] **Step 1: Delete old tab files**
- [ ] **Step 2: Rebuild dashboard and MCP bundles**
- [ ] **Step 3: Run full test suite**
- [ ] **Step 4: Final commit**

```bash
git commit -m "feat(dashboard): phase 2 complete — redesigned dashboard with hub+detail, charts, tokens"
```
