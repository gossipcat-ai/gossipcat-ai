# Dashboard v4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the dashboard with a CSS Grid hub layout and grid-based data row detail views with sorting, inline expansion, and pagination.

**Architecture:** Backend-first — add pagination and SkillIndex to APIs, then build the shared `lib/data-rows.js` library, then rewrite detail views consuming it, then upgrade the hub layout last (least risk, most visible).

**Tech Stack:** Vanilla JS (no framework), CSS Grid, existing design token system, JSONL flat-file reads.

**Spec:** `docs/superpowers/specs/2026-04-01-dashboard-v4-design.md`

---

### Task 1: Backend — Pagination for tasks API

**Files:**
- Modify: `packages/relay/src/dashboard/routes.ts`
- Modify: `packages/relay/src/dashboard/api-tasks.ts`

- [ ] **Step 1: Update routes.ts to thread query params to tasksHandler**

In `packages/relay/src/dashboard/routes.ts`, find where `tasksHandler` is called (around line 148) and pass the query object:

```typescript
// Before:
const data = await tasksHandler(this.projectRoot);

// After:
const data = await tasksHandler(this.projectRoot, query);
```

- [ ] **Step 2: Update tasksHandler to accept pagination params**

In `packages/relay/src/dashboard/api-tasks.ts`, update the function signature and add pagination:

```typescript
export async function tasksHandler(
  projectRoot: string,
  query?: URLSearchParams
): Promise<{ items: TaskEntry[]; total: number; offset: number; limit: number }> {
  const limit = Math.min(parseInt(query?.get('limit') || '50', 10), 200);
  const offset = parseInt(query?.get('offset') || '0', 10);
```

Replace the final `return` (currently `tasks.slice(0, 100)`) with:

```typescript
  return {
    items: tasks.slice(offset, offset + limit),
    total: tasks.length,
    offset,
    limit,
  };
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd packages/relay && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/relay/src/dashboard/routes.ts packages/relay/src/dashboard/api-tasks.ts
git commit -m "feat(dashboard): add pagination to tasks API"
```

---

### Task 2: Backend — Pagination for signals API

**Files:**
- Modify: `packages/relay/src/dashboard/routes.ts`
- Modify: `packages/relay/src/dashboard/api-signals.ts`

- [ ] **Step 1: Update routes.ts to thread full query to signalsHandler**

In `packages/relay/src/dashboard/routes.ts`, find where `signalsHandler` is called and ensure the full `query` object is passed (it currently passes `query?.get('agent')` only):

```typescript
// Before:
const data = await signalsHandler(this.projectRoot, query?.get('agent') || null);

// After:
const data = await signalsHandler(this.projectRoot, query);
```

- [ ] **Step 2: Update signalsHandler to accept pagination params**

In `packages/relay/src/dashboard/api-signals.ts`, update the signature:

```typescript
export async function signalsHandler(
  projectRoot: string,
  query?: URLSearchParams
): Promise<{ items: SignalEntry[]; total: number; offset: number; limit: number }> {
  const agentFilter = query?.get('agent') || null;
  const limit = Math.min(parseInt(query?.get('limit') || '50', 10), 200);
  const offset = parseInt(query?.get('offset') || '0', 10);
```

Replace the final return (currently `signals.slice(0, MAX_SIGNALS)`) with:

```typescript
  return {
    items: all.slice(offset, offset + limit),
    total: all.length,
    offset,
    limit,
  };
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd packages/relay && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/relay/src/dashboard/routes.ts packages/relay/src/dashboard/api-signals.ts
git commit -m "feat(dashboard): add pagination to signals API"
```

---

### Task 3: Backend — Add skillSlots to agents API

**Files:**
- Modify: `packages/relay/src/dashboard/api-agents.ts`

- [ ] **Step 1: Find the SkillIndex import path**

Run: `grep -r "class SkillIndex" packages/orchestrator/src/` to find the exact import path and the `getSlots` or equivalent method name.

- [ ] **Step 2: Add skillSlots to the agent response**

In `packages/relay/src/dashboard/api-agents.ts`, import SkillIndex and add the field to each agent response. After the existing `skills: config.skills` line (around line 138), add:

```typescript
// Add skillSlots alongside existing skills field
let skillSlots: Array<{ name: string; enabled: boolean; source: string; boundAt: string }> = [];
try {
  const skillIndex = new SkillIndex(projectRoot);
  const slots = skillIndex.getSlots(config.id);
  skillSlots = slots.map(s => ({
    name: s.name,
    enabled: s.enabled,
    source: s.source || 'unknown',
    boundAt: s.boundAt || '',
  }));
} catch {
  // Agent has no skill index entries — return empty array
}
```

Add `skillSlots` to the returned object for each agent.

- [ ] **Step 3: Verify the build compiles**

Run: `cd packages/relay && npx tsc --noEmit`
Expected: No errors. If SkillIndex API differs, adjust the import/method names.

- [ ] **Step 4: Commit**

```bash
git add packages/relay/src/dashboard/api-agents.ts
git commit -m "feat(dashboard): add skillSlots to agents API"
```

---

### Task 4: CSS — Data row system + hub grid

**Files:**
- Modify: `packages/dashboard/src/style.css`

- [ ] **Step 1: Add the data row system classes**

Append to the end of `packages/dashboard/src/style.css`:

```css
/* ═══ Data Row System (v4) ═══ */

.data-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 50px);
  overflow: hidden;
}

.data-header {
  display: grid;
  position: sticky;
  top: 0;
  z-index: 10;
  padding: 0 12px;
  height: 36px;
  align-items: center;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-3);
  user-select: none;
}

.data-header [data-sort] {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}

.data-header [data-sort]:hover {
  color: var(--text-2);
}

.data-sort {
  font-size: 10px;
  opacity: 0.5;
}

.data-sort--active {
  opacity: 1;
  color: var(--accent);
}

.data-rows {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.data-row {
  display: grid;
  padding: 0 12px;
  min-height: 40px;
  align-items: center;
  border-left: 3px solid transparent;
  cursor: pointer;
  transition: background 0.1s, border-color 0.15s;
}

.data-row:hover {
  background: rgba(255, 255, 255, 0.03);
}

.data-row--expanded {
  border-left-color: var(--accent);
  background: rgba(255, 255, 255, 0.02);
}

.data-cell {
  padding: 8px 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--text);
}

.data-cell--right {
  text-align: right;
  font-family: var(--mono);
}

.data-cell--center {
  text-align: center;
}

.data-cell--muted {
  color: var(--text-3);
  font-size: 11px;
}

.data-expand {
  grid-column: 1 / -1;
  padding: 12px 24px 16px;
  border-top: 1px solid var(--border);
  animation: data-expand-in 0.15s ease-out;
}

@keyframes data-expand-in {
  from { opacity: 0; max-height: 0; }
  to { opacity: 1; max-height: 400px; }
}

.data-group {
  padding: 6px 24px;
  font-size: 11px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-top: 1px solid var(--border);
  margin-top: 4px;
}

.data-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.data-bar {
  display: inline-block;
  height: 4px;
  border-radius: 2px;
  background: var(--accent);
  vertical-align: middle;
}

.data-load-more {
  display: flex;
  justify-content: center;
  padding: 12px;
}

.data-load-more button {
  background: var(--surface);
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 20px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.data-load-more button:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
}

.data-empty {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 48px 24px;
  color: var(--text-3);
  font-size: 13px;
}

.data-empty a {
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
}

.data-error {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 48px 24px;
  color: var(--red);
  font-size: 13px;
}

.data-error a {
  color: var(--accent);
  cursor: pointer;
  margin-left: 8px;
}

/* Running task pulse */
@keyframes pulse-border {
  0%, 100% { border-left-color: var(--amber); }
  50% { border-left-color: transparent; }
}

.data-row--running {
  animation: pulse-border 2s ease-in-out infinite;
}

/* ═══ Hub Grid (v4) ═══ */

.hub-grid {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 24px;
  align-items: start;
}

@media (max-width: 1000px) {
  .hub-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 2: Remove dead styles**

Search for and remove `.sig-row` and `.sig-` prefixed styles if they exist. Remove any hardcoded `max-height` inline override classes (check for `.panel-body` max-height overrides).

- [ ] **Step 3: Build the dashboard**

Run: `cd packages/dashboard && node build.js`
Expected: `dist-dashboard/index.html` generated without errors.

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/style.css
git commit -m "feat(dashboard): add data row CSS system and hub grid"
```

---

### Task 5: Frontend — lib/data-rows.js shared library

**Files:**
- Create: `packages/dashboard/src/lib/data-rows.js`
- Modify: `packages/dashboard/build.js`

- [ ] **Step 1: Create lib/data-rows.js**

Create `packages/dashboard/src/lib/data-rows.js` with the shared data row API:

```javascript
// ═══ Data Row Library ═══
// Shared infrastructure for all detail views.

const COST_RATES = {
  anthropic: { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  google:    { input: 1.25 / 1_000_000, output: 10.0 / 1_000_000 },
  default:   { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
};

function formatMetric(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function estimateCost(provider, inputTokens, outputTokens) {
  if (!inputTokens && !outputTokens) return '—';
  const rates = COST_RATES[provider] || COST_RATES.default;
  const cost = (inputTokens || 0) * rates.input + (outputTokens || 0) * rates.output;
  if (cost < 0.005) return '<$0.01';
  return '$' + cost.toFixed(2);
}

function createExpansionManager() {
  let current = null;
  return {
    expand(row) {
      if (current && current !== row) {
        current.classList.remove('data-row--expanded');
        const oldPanel = current.nextElementSibling;
        if (oldPanel && oldPanel.classList.contains('data-expand')) {
          oldPanel.remove();
        }
      }
      current = row;
    },
    collapse() {
      if (current) {
        current.classList.remove('data-row--expanded');
        const panel = current.nextElementSibling;
        if (panel && panel.classList.contains('data-expand')) {
          panel.remove();
        }
        current = null;
      }
    },
    current() { return current; },
  };
}

function createDataView(options) {
  const {
    columns, defaultSort, defaultOrder = 'desc',
    onSort, onLoadMore, total = 0,
    gridTemplateColumns,
  } = options;

  const container = document.createElement('div');
  container.className = 'data-view';

  // Sort state
  let sortKey = defaultSort;
  let sortDir = defaultOrder;

  // Header
  const header = document.createElement('div');
  header.className = 'data-header';
  header.style.gridTemplateColumns = gridTemplateColumns;

  columns.forEach(col => {
    const cell = document.createElement('div');
    cell.className = 'data-cell' + (col.align === 'right' ? ' data-cell--right' : col.align === 'center' ? ' data-cell--center' : '');

    if (col.sortable !== false) {
      cell.setAttribute('data-sort', col.key);
      const arrow = col.key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      cell.innerHTML = _dash.escapeHtml(col.label) + (arrow ? '<span class="data-sort data-sort--active">' + arrow + '</span>' : '');
      cell.addEventListener('click', () => {
        if (sortKey === col.key) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortKey = col.key;
          sortDir = 'desc';
        }
        // Update all header arrows
        header.querySelectorAll('[data-sort]').forEach(c => {
          const k = c.getAttribute('data-sort');
          const isActive = k === sortKey;
          const arrowText = isActive ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
          const labelText = columns.find(cc => cc.key === k)?.label || '';
          c.innerHTML = _dash.escapeHtml(labelText) + (arrowText ? '<span class="data-sort data-sort--active">' + arrowText + '</span>' : '');
        });
        if (onSort) onSort(sortKey, sortDir);
      });
    } else {
      cell.textContent = col.label;
    }

    header.appendChild(cell);
  });

  container.appendChild(header);

  // Scrollable rows area
  const rows = document.createElement('div');
  rows.className = 'data-rows';
  container.appendChild(rows);

  // Load more
  const loadMoreDiv = document.createElement('div');
  loadMoreDiv.className = 'data-load-more';
  loadMoreDiv.style.display = 'none';
  const loadMoreBtn = document.createElement('button');
  loadMoreBtn.textContent = 'Load more';
  loadMoreBtn.addEventListener('click', async () => {
    loadMoreBtn.textContent = 'Loading...';
    loadMoreBtn.disabled = true;
    try {
      if (onLoadMore) await onLoadMore();
    } finally {
      loadMoreBtn.textContent = 'Load more';
      loadMoreBtn.disabled = false;
    }
  });
  loadMoreDiv.appendChild(loadMoreBtn);
  container.appendChild(loadMoreDiv);

  // Public API on the container element
  container._dataView = {
    rows,
    setLoadMoreVisible(visible) {
      loadMoreDiv.style.display = visible ? 'flex' : 'none';
    },
    clear() {
      rows.innerHTML = '';
    },
    getSortState() { return { key: sortKey, dir: sortDir }; },
  };

  return container;
}

function createDataRow(cells, onExpand, gridTemplateColumns) {
  const row = document.createElement('div');
  row.className = 'data-row';
  row.style.gridTemplateColumns = gridTemplateColumns;

  cells.forEach(cell => {
    const el = document.createElement('div');
    el.className = 'data-cell' + (cell.className ? ' ' + cell.className : '');
    if (typeof cell.content === 'string') {
      el.innerHTML = cell.content;
    } else if (cell.content instanceof HTMLElement) {
      el.appendChild(cell.content);
    }
    row.appendChild(el);
  });

  if (onExpand) {
    row.addEventListener('click', (e) => {
      // Don't expand if clicking a link
      if (e.target.tagName === 'A') return;
      onExpand(row);
    });
  }

  return row;
}

function createDateGroup(label) {
  const el = document.createElement('div');
  el.className = 'data-group';
  el.textContent = label;
  return el;
}

function createEmptyState(message, onClear) {
  const el = document.createElement('div');
  el.className = 'data-empty';
  if (onClear) {
    el.innerHTML = _dash.escapeHtml(message) + ' <a>Clear filters</a>';
    el.querySelector('a').addEventListener('click', onClear);
  } else {
    el.textContent = message;
  }
  return el;
}

function createErrorState(onRetry) {
  const el = document.createElement('div');
  el.className = 'data-error';
  el.innerHTML = 'Failed to load' + (onRetry ? ' — <a>Retry</a>' : '');
  if (onRetry) el.querySelector('a').addEventListener('click', onRetry);
  return el;
}

// Expose globally (same pattern as other dashboard modules)
window._dataRows = {
  createDataView,
  createDataRow,
  createDateGroup,
  createExpansionManager,
  createEmptyState,
  createErrorState,
  formatMetric,
  estimateCost,
};
```

- [ ] **Step 2: Add lib/data-rows.js to build.js**

In `packages/dashboard/build.js`, find the JS file list array and add `lib/data-rows.js` after `lib/markdown.js`:

```javascript
'lib/data-rows.js',
```

- [ ] **Step 3: Build and verify**

Run: `cd packages/dashboard && node build.js`
Expected: Builds without errors. The output `dist-dashboard/index.html` contains the data-rows code.

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/lib/data-rows.js packages/dashboard/build.js
git commit -m "feat(dashboard): add shared data-rows library"
```

---

### Task 6: Frontend — Rewrite #/tasks detail view

**Files:**
- Modify: `packages/dashboard/src/detail/tasks.js`

- [ ] **Step 1: Rewrite tasks.js with grid data rows**

Replace the entire content of `packages/dashboard/src/detail/tasks.js` with:

```javascript
// ═══ Tasks Detail View (v4) ═══

function renderTasksDetail(app) {
  app.innerHTML = '<div class="data-empty">Loading...</div>';

  const GRID = '32px 120px 1fr 80px 80px 70px 80px';
  const COLUMNS = [
    { key: 'status', label: '', width: '32px', align: 'center', sortable: false },
    { key: 'agentId', label: 'Agent', width: '120px' },
    { key: 'task', label: 'Task', width: '1fr' },
    { key: 'duration', label: 'Duration', width: '80px', align: 'right' },
    { key: 'tokens', label: 'Tokens', width: '80px', align: 'right' },
    { key: 'cost', label: 'Cost', width: '70px', align: 'right' },
    { key: 'timestamp', label: 'Time', width: '80px', align: 'right' },
  ];

  let allItems = [];
  let total = 0;
  let activeFilter = 'all';
  let searchQuery = '';
  const expander = _dataRows.createExpansionManager();

  const statusIcons = {
    completed: '<span style="color:var(--green)">&#10003;</span>',
    failed: '<span style="color:var(--red)">&#10007;</span>',
    running: '<span style="color:var(--amber)">&#9678;</span>',
    cancelled: '<span style="color:var(--text-3)">&mdash;</span>',
  };

  function formatDuration(ms) {
    if (!ms) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m + 'm' + (s % 60 ? (s % 60) + 's' : '');
  }

  function getFiltered() {
    return allItems.filter(t => {
      if (activeFilter !== 'all' && t.status !== activeFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!t.agentId?.toLowerCase().includes(q) && !t.task?.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  function sortItems(items, key, dir) {
    return items.slice().sort((a, b) => {
      let va = a[key], vb = b[key];
      if (key === 'tokens') { va = (a.inputTokens || 0) + (a.outputTokens || 0); vb = (b.inputTokens || 0) + (b.outputTokens || 0); }
      if (key === 'timestamp') { va = new Date(a.timestamp || 0).getTime(); vb = new Date(b.timestamp || 0).getTime(); }
      if (key === 'duration') { va = a.duration || 0; vb = b.duration || 0; }
      if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return dir === 'asc' ? (va || 0) - (vb || 0) : (vb || 0) - (va || 0);
    });
  }

  function renderRows(view) {
    const { rows } = view._dataView;
    rows.innerHTML = '';
    expander.collapse();

    const { key, dir } = view._dataView.getSortState();
    const filtered = sortItems(getFiltered(), key, dir);

    if (filtered.length === 0) {
      const msg = (activeFilter !== 'all' || searchQuery) ? null : 'No tasks yet';
      rows.appendChild(msg
        ? _dataRows.createEmptyState('No matching items', () => { activeFilter = 'all'; searchQuery = ''; renderRows(view); })
        : _dataRows.createEmptyState('No tasks yet'));
      return;
    }

    // Date groups
    let lastDate = '';
    filtered.forEach(t => {
      const d = new Date(t.timestamp || Date.now());
      const dateStr = d.toLocaleDateString();
      const now = new Date();
      let label = dateStr;
      if (dateStr === now.toLocaleDateString()) label = 'Today';
      else if (dateStr === new Date(now - 86400000).toLocaleDateString()) label = 'Yesterday';

      if (label !== lastDate) {
        rows.appendChild(_dataRows.createDateGroup(label));
        lastDate = label;
      }

      const totalTokens = (t.inputTokens || 0) + (t.outputTokens || 0);
      const provider = t.agentId?.includes('gemini') ? 'google' : 'anthropic';

      const row = _dataRows.createDataRow([
        { content: statusIcons[t.status] || '—', className: 'data-cell--center' },
        { content: _dash.escapeHtml(t.agentId || '—') },
        { content: _dash.escapeHtml((t.task || '').split('\n')[0].slice(0, 100)) },
        { content: formatDuration(t.duration), className: 'data-cell--right' },
        { content: _dataRows.formatMetric(totalTokens), className: 'data-cell--right' },
        { content: _dataRows.estimateCost(provider, t.inputTokens, t.outputTokens), className: 'data-cell--right' },
        { content: '<span data-timestamp="' + (t.timestamp || '') + '">' + _dash.timeAgo(t.timestamp) + '</span>', className: 'data-cell--right' },
      ], (clickedRow) => {
        if (clickedRow.classList.contains('data-row--expanded')) {
          expander.collapse();
          return;
        }
        expander.expand(clickedRow);
        clickedRow.classList.add('data-row--expanded');

        const panel = document.createElement('div');
        panel.className = 'data-expand';
        panel.innerHTML = '<div style="margin-bottom:8px"><strong>Task:</strong></div>'
          + '<div style="white-space:pre-wrap;color:var(--text-2);margin-bottom:12px;font-size:12px">' + _dash.escapeHtml(t.task || '—') + '</div>'
          + (t.result ? '<div style="margin-bottom:8px"><strong>Result:</strong></div><div style="white-space:pre-wrap;color:var(--text-2);font-size:12px">' + _dash.escapeHtml(t.result.slice(0, 500)) + '</div>' : '')
          + '<div style="margin-top:8px;color:var(--text-3);font-size:11px">'
          + 'Input: ' + _dataRows.formatMetric(t.inputTokens) + ' · Output: ' + _dataRows.formatMetric(t.outputTokens)
          + (t.consensusId ? ' · <a href="#/consensus/' + t.consensusId + '" style="color:var(--accent)">View consensus</a>' : '')
          + '</div>';
        clickedRow.after(panel);
      }, GRID);

      if (t.status === 'running') row.classList.add('data-row--running');
      rows.appendChild(row);
    });

    // Search scope indicator
    if (searchQuery && allItems.length < total) {
      const note = document.createElement('div');
      note.style.cssText = 'text-align:center;padding:8px;color:var(--text-3);font-size:11px';
      note.textContent = '(searching ' + allItems.length + ' loaded of ' + total + ' total)';
      rows.appendChild(note);
    }

    view._dataView.setLoadMoreVisible(allItems.length < total);
  }

  async function load(view, append) {
    try {
      const offset = append ? allItems.length : 0;
      const data = await _dash.api('tasks?limit=50&offset=' + offset);
      if (append) {
        allItems = allItems.concat(data.items || data.tasks || []);
      } else {
        allItems = data.items || data.tasks || [];
      }
      total = data.total || allItems.length;
      renderRows(view);
    } catch {
      app.innerHTML = '';
      app.appendChild(_dataRows.createErrorState(() => load(view, false)));
    }
  }

  // Build the view
  app.innerHTML = '';

  // Filters
  const filterBar = document.createElement('div');
  filterBar.style.cssText = 'display:flex;gap:8px;padding:12px 0;align-items:center;flex-wrap:wrap';

  const filters = ['all', 'running', 'completed', 'failed', 'cancelled'];
  filters.forEach(f => {
    const pill = document.createElement('span');
    pill.className = 'pill pill-filter' + (f === activeFilter ? ' active' : '');
    pill.textContent = f.charAt(0).toUpperCase() + f.slice(1);
    pill.addEventListener('click', () => {
      activeFilter = f;
      filterBar.querySelectorAll('.pill-filter').forEach(p => p.classList.toggle('active', p.textContent.toLowerCase() === f));
      renderRows(view);
    });
    filterBar.appendChild(pill);
  });

  // Search
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search agent or task...';
  search.style.cssText = 'margin-left:auto;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:4px 10px;color:var(--text);font-size:12px;width:200px';
  search.addEventListener('input', () => {
    searchQuery = search.value;
    renderRows(view);
  });
  filterBar.appendChild(search);
  app.appendChild(filterBar);

  const view = _dataRows.createDataView({
    columns: COLUMNS,
    defaultSort: 'timestamp',
    defaultOrder: 'desc',
    gridTemplateColumns: GRID,
    total: 0,
    onSort: () => renderRows(view),
    onLoadMore: () => load(view, true),
  });
  app.appendChild(view);

  load(view, false);
}
```

- [ ] **Step 2: Build and verify**

Run: `cd packages/dashboard && node build.js`
Expected: Builds without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/detail/tasks.js
git commit -m "feat(dashboard): rewrite tasks detail with grid data rows"
```

---

### Task 7: Frontend — Rewrite #/signals detail view

**Files:**
- Modify: `packages/dashboard/src/detail/signals.js`

- [ ] **Step 1: Rewrite signals.js with grid data rows**

Replace the entire content of `packages/dashboard/src/detail/signals.js`:

```javascript
// ═══ Signals Detail View (v4) ═══

function renderSignalsDetail(app) {
  app.innerHTML = '<div class="data-empty">Loading...</div>';

  const GRID = '120px 120px 120px 1fr 80px 80px';
  const COLUMNS = [
    { key: 'signal', label: 'Type', width: '120px', sortable: false },
    { key: 'agentId', label: 'Agent', width: '120px' },
    { key: 'counterpartId', label: 'Counterpart', width: '120px' },
    { key: 'evidence', label: 'Evidence', width: '1fr', sortable: false },
    { key: 'taskId', label: 'Task', width: '80px', sortable: false },
    { key: 'timestamp', label: 'Time', width: '80px', align: 'right' },
  ];

  const TAG_COLORS = {
    agreement: 'tag-g',
    unique_confirmed: 'tag-g',
    disagreement: 'tag-r',
    hallucination_caught: 'tag-r',
    unique_unconfirmed: 'tag-u',
    new_finding: 'tag-b',
  };

  let allItems = [];
  let total = 0;
  let activeFilter = 'all';
  const expander = _dataRows.createExpansionManager();

  function getFiltered() {
    if (activeFilter === 'all') return allItems;
    const map = {
      agreement: ['agreement', 'unique_confirmed'],
      disagreement: ['disagreement'],
      unique: ['unique_unconfirmed'],
      hallucination: ['hallucination_caught'],
    };
    const types = map[activeFilter] || [];
    return allItems.filter(s => types.includes(s.signal));
  }

  function renderRows(view) {
    const { rows } = view._dataView;
    rows.innerHTML = '';
    expander.collapse();

    const filtered = getFiltered();

    if (filtered.length === 0) {
      rows.appendChild(activeFilter !== 'all'
        ? _dataRows.createEmptyState('No matching items', () => { activeFilter = 'all'; renderRows(view); })
        : _dataRows.createEmptyState('No signals recorded'));
      return;
    }

    filtered.forEach(s => {
      const tagClass = TAG_COLORS[s.signal] || 'tag-u';
      const label = (s.signal || '').replace(/_/g, ' ');
      const evidence = s.evidence || s.finding || '';

      const row = _dataRows.createDataRow([
        { content: '<span class="finding-tag ' + tagClass + '">' + _dash.escapeHtml(label) + '</span>' },
        { content: _dash.escapeHtml(s.agentId || '—') },
        { content: _dash.escapeHtml(s.counterpartId || '—') },
        { content: _dash.escapeHtml(evidence.slice(0, 80) + (evidence.length > 80 ? '...' : '')) },
        { content: s.taskId ? '<a href="#/consensus/' + _dash.escapeHtml(s.taskId) + '" style="color:var(--accent);font-family:var(--mono);font-size:11px">' + _dash.escapeHtml((s.taskId || '').slice(0, 8)) + '</a>' : '—' },
        { content: '<span data-timestamp="' + (s.timestamp || '') + '">' + _dash.timeAgo(s.timestamp) + '</span>', className: 'data-cell--right' },
      ], (clickedRow) => {
        if (clickedRow.classList.contains('data-row--expanded')) {
          expander.collapse();
          return;
        }
        expander.expand(clickedRow);
        clickedRow.classList.add('data-row--expanded');

        const panel = document.createElement('div');
        panel.className = 'data-expand';
        panel.innerHTML = '<div style="white-space:pre-wrap;color:var(--text-2);font-size:12px">' + _dash.escapeHtml(evidence) + '</div>'
          + (s.taskId ? '<div style="margin-top:8px"><a href="#/consensus/' + _dash.escapeHtml(s.taskId) + '" style="color:var(--accent);font-size:12px">View consensus run &rarr;</a></div>' : '');
        clickedRow.after(panel);
      }, GRID);

      rows.appendChild(row);
    });

    view._dataView.setLoadMoreVisible(allItems.length < total);
  }

  async function load(view, append) {
    try {
      const offset = append ? allItems.length : 0;
      const data = await _dash.api('signals?limit=50&offset=' + offset);
      if (append) {
        allItems = allItems.concat(data.items || data.signals || []);
      } else {
        allItems = data.items || data.signals || [];
      }
      total = data.total || allItems.length;
      renderRows(view);
    } catch {
      app.innerHTML = '';
      app.appendChild(_dataRows.createErrorState(() => load(view, false)));
    }
  }

  app.innerHTML = '';

  // Filters
  const filterBar = document.createElement('div');
  filterBar.style.cssText = 'display:flex;gap:8px;padding:12px 0;align-items:center';

  ['all', 'agreement', 'disagreement', 'unique', 'hallucination'].forEach(f => {
    const pill = document.createElement('span');
    pill.className = 'pill pill-filter' + (f === activeFilter ? ' active' : '');
    pill.textContent = f.charAt(0).toUpperCase() + f.slice(1);
    pill.addEventListener('click', () => {
      activeFilter = f;
      filterBar.querySelectorAll('.pill-filter').forEach(p => p.classList.toggle('active', p.textContent.toLowerCase() === f));
      renderRows(view);
    });
    filterBar.appendChild(pill);
  });
  app.appendChild(filterBar);

  const view = _dataRows.createDataView({
    columns: COLUMNS,
    defaultSort: 'timestamp',
    defaultOrder: 'desc',
    gridTemplateColumns: GRID,
    onSort: () => renderRows(view),
    onLoadMore: () => load(view, true),
  });
  app.appendChild(view);

  load(view, false);
}
```

- [ ] **Step 2: Build and verify**

Run: `cd packages/dashboard && node build.js`
Expected: Builds without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/detail/signals.js
git commit -m "feat(dashboard): rewrite signals detail with grid data rows"
```

---

### Task 8: Frontend — Rewrite #/team agent detail view

**Files:**
- Modify: `packages/dashboard/src/detail/agent.js`

- [ ] **Step 1: Rewrite agent.js with grid data rows and inline expansion**

Replace the entire content of `packages/dashboard/src/detail/agent.js`. The `#/team` route shows all agents as grid rows. The `#/team/:id` route is handled here too — when an agent ID is present, scroll to and expand that row.

```javascript
// ═══ Agent Detail View (v4) ═══
// Renders either all agents as grid rows (#/team) or scrolls to one (#/team/:id)

function renderAgentDetail(app, agentId) {
  app.innerHTML = '<div class="data-empty">Loading...</div>';

  const GRID = '48px 1fr 100px 90px 90px 90px 80px 100px';
  const COLUMNS = [
    { key: 'ring', label: '', width: '48px', sortable: false },
    { key: 'id', label: 'Agent', width: '1fr' },
    { key: 'dispatchWeight', label: 'Weight', width: '100px', align: 'right' },
    { key: 'accuracy', label: 'Accuracy', width: '90px', align: 'right' },
    { key: 'reliability', label: 'Reliability', width: '90px', align: 'right' },
    { key: 'uniqueness', label: 'Unique', width: '90px', align: 'right' },
    { key: 'signals', label: 'Signals', width: '80px', align: 'right' },
    { key: 'totalTokens', label: 'Tokens', width: '100px', align: 'right' },
  ];

  const expander = _dataRows.createExpansionManager();

  function pct(v) { return v != null ? Math.round(v * 100) + '%' : '—'; }

  function renderRing(agent) {
    const w = agent.scores?.dispatchWeight || 0;
    const color = w >= 1.5 ? 'var(--green)' : w >= 0.8 ? 'var(--amber)' : 'var(--red)';
    const acc = agent.scores?.accuracy || 0;
    const arcLen = acc * 251; // 2*PI*40 ≈ 251
    const el = document.createElement('div');
    el.innerHTML = '<svg width="32" height="32" viewBox="0 0 100 100">'
      + '<circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="8"/>'
      + '<circle cx="50" cy="50" r="40" fill="none" stroke="' + color + '" stroke-width="8" stroke-dasharray="' + arcLen + ' 251" stroke-linecap="round" transform="rotate(-90 50 50)"/>'
      + '<text x="50" y="55" text-anchor="middle" fill="' + color + '" font-size="28" font-weight="700">' + _dash.escapeHtml(_dash.agentInitials(agent.id)) + '</text>'
      + '</svg>';
    return el.firstChild;
  }

  function renderWeightBar(w) {
    const width = Math.min(Math.max(w / 2.5, 0), 1) * 60;
    return '<span class="data-bar" style="width:' + width + 'px;margin-right:6px"></span>' + w.toFixed(2);
  }

  function buildExpansion(agent) {
    const panel = document.createElement('div');
    panel.className = 'data-expand';

    let html = '';

    // Skills
    const slots = agent.skillSlots || [];
    if (slots.length > 0) {
      html += '<div style="margin-bottom:12px"><strong style="font-size:12px;color:var(--text-2)">Skills</strong><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">';
      slots.forEach(s => {
        const opacity = s.enabled ? '1' : '0.4';
        html += '<span class="data-pill" style="background:rgba(167,139,250,0.15);color:var(--accent);opacity:' + opacity + '">' + _dash.escapeHtml(s.name) + (s.enabled ? '' : ' (off)') + '</span>';
      });
      html += '</div></div>';
    }

    // Signal breakdown
    const sc = agent.scores || {};
    const ag = sc.agreements || 0, dis = sc.disagreements || 0, hal = sc.hallucinations || 0;
    const sigTotal = ag + dis + hal || 1;
    html += '<div style="margin-bottom:12px"><strong style="font-size:12px;color:var(--text-2)">Signals</strong>'
      + '<div style="display:flex;height:6px;border-radius:3px;overflow:hidden;margin-top:6px;max-width:300px">'
      + '<div style="width:' + (ag / sigTotal * 100) + '%;background:var(--green)"></div>'
      + '<div style="width:' + (dis / sigTotal * 100) + '%;background:var(--red)"></div>'
      + '<div style="width:' + (hal / sigTotal * 100) + '%;background:var(--amber)"></div>'
      + '</div>'
      + '<div style="font-size:11px;color:var(--text-3);margin-top:4px">' + ag + ' agree · ' + dis + ' disagree · ' + hal + ' hallucination</div>'
      + '</div>';

    // Provider info
    html += '<div style="font-size:11px;color:var(--text-3)">' + _dash.escapeHtml(agent.provider || '') + ' · ' + _dash.escapeHtml(agent.model || '') + (agent.preset ? ' · ' + _dash.escapeHtml(agent.preset) : '') + '</div>';

    panel.innerHTML = html;
    return panel;
  }

  async function render() {
    try {
      const agents = await _dash.api('agents');
      app.innerHTML = '';

      if (!agents || agents.length === 0) {
        app.appendChild(_dataRows.createEmptyState('No agents configured'));
        return;
      }

      const view = _dataRows.createDataView({
        columns: COLUMNS,
        defaultSort: 'dispatchWeight',
        defaultOrder: 'desc',
        gridTemplateColumns: GRID,
        onSort: (key, dir) => {
          const sorted = agents.slice().sort((a, b) => {
            let va, vb;
            if (key === 'id') { va = a.id; vb = b.id; }
            else if (key === 'totalTokens') { va = a.totalTokens || 0; vb = b.totalTokens || 0; }
            else { va = a.scores?.[key] || 0; vb = b.scores?.[key] || 0; }
            if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
            return dir === 'asc' ? va - vb : vb - va;
          });
          renderAgentRows(view, sorted);
        },
      });

      const sorted = agents.slice().sort((a, b) => (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0));
      renderAgentRows(view, sorted);
      app.appendChild(view);

      // If agentId specified, expand that row
      if (agentId) {
        const targetRow = view.querySelector('[data-agent="' + agentId + '"]');
        if (targetRow) {
          targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetRow.click();
        }
      }
    } catch {
      app.innerHTML = '';
      app.appendChild(_dataRows.createErrorState(render));
    }
  }

  function renderAgentRows(view, agents) {
    const { rows } = view._dataView;
    rows.innerHTML = '';
    expander.collapse();

    agents.forEach(agent => {
      const sc = agent.scores || {};
      const nameEl = document.createElement('div');
      nameEl.innerHTML = '<div style="font-weight:600">' + _dash.escapeHtml(agent.id) + '</div>'
        + '<div style="font-size:11px;color:var(--text-3)">' + _dash.escapeHtml(agent.provider || '') + ' · ' + _dash.escapeHtml(agent.model || '') + '</div>';

      const row = _dataRows.createDataRow([
        { content: renderRing(agent) },
        { content: nameEl },
        { content: renderWeightBar(sc.dispatchWeight || 0), className: 'data-cell--right' },
        { content: pct(sc.accuracy), className: 'data-cell--right' },
        { content: pct(sc.reliability), className: 'data-cell--right' },
        { content: pct(sc.uniqueness), className: 'data-cell--right' },
        { content: String(sc.signals || 0), className: 'data-cell--right' },
        { content: _dataRows.formatMetric(agent.totalTokens), className: 'data-cell--right' },
      ], (clickedRow) => {
        if (clickedRow.classList.contains('data-row--expanded')) {
          expander.collapse();
          return;
        }
        expander.expand(clickedRow);
        clickedRow.classList.add('data-row--expanded');
        clickedRow.after(buildExpansion(agent));
      }, GRID);

      row.setAttribute('data-agent', agent.id);
      rows.appendChild(row);
    });
  }

  render();
}
```

- [ ] **Step 2: Build and verify**

Run: `cd packages/dashboard && node build.js`
Expected: Builds without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/detail/agent.js
git commit -m "feat(dashboard): rewrite agent detail with grid data rows"
```

---

### Task 9: Frontend — Rewrite #/consensus detail view

**Files:**
- Modify: `packages/dashboard/src/detail/consensus.js`

- [ ] **Step 1: Rewrite consensus.js with grid data rows and dispute comparison**

Replace the entire content of `packages/dashboard/src/detail/consensus.js`:

```javascript
// ═══ Consensus Detail View (v4) ═══

function renderConsensusDetail(app, taskId) {
  app.innerHTML = '<div class="data-empty">Loading...</div>';

  const GRID = '110px 1fr 140px 140px';
  const expander = _dataRows.createExpansionManager();

  const TAG_MAP = {
    agreement: { cls: 'tag-g', label: 'CONFIRMED' },
    unique_confirmed: { cls: 'tag-g', label: 'CONFIRMED' },
    disagreement: { cls: 'tag-r', label: 'DISPUTED' },
    hallucination_caught: { cls: 'tag-r', label: 'DISPUTED' },
    unverified: { cls: 'tag-y', label: 'UNVERIFIED' },
    unique_unconfirmed: { cls: 'tag-u', label: 'UNIQUE' },
    new_finding: { cls: 'tag-b', label: 'NEW' },
  };

  async function render() {
    try {
      const { runs } = await _dash.api('consensus');
      const run = (runs || []).find(r => r.taskId === taskId);

      if (!run) {
        app.innerHTML = '';
        app.appendChild(_dataRows.createEmptyState('Consensus run not found'));
        return;
      }

      app.innerHTML = '';

      // Summary pills
      const pills = document.createElement('div');
      pills.style.cssText = 'display:flex;gap:8px;padding:12px 0;flex-wrap:wrap';
      const c = run.counts || {};
      const pillData = [
        { label: 'Confirmed', count: (c.agreement || 0), cls: 'tag-g' },
        { label: 'Disputed', count: (c.disagreement || 0), cls: 'tag-r' },
        { label: 'Unverified', count: (c.unverified || 0), cls: 'tag-y' },
        { label: 'Unique', count: (c.unique || 0), cls: 'tag-u' },
        { label: 'New', count: (c.new || 0), cls: 'tag-b' },
      ];
      pillData.forEach(p => {
        if (p.count > 0) {
          const el = document.createElement('span');
          el.className = 'finding-tag ' + p.cls;
          el.textContent = p.count + ' ' + p.label;
          pills.appendChild(el);
        }
      });
      app.appendChild(pills);

      // Finding rows
      const view = _dataRows.createDataView({
        columns: [
          { key: 'tag', label: 'Status', width: '110px', sortable: false },
          { key: 'finding', label: 'Finding', width: '1fr', sortable: false },
          { key: 'agentId', label: 'Found By', width: '140px', sortable: false },
          { key: 'counterpartId', label: 'Verified By', width: '140px', sortable: false },
        ],
        defaultSort: 'tag',
        gridTemplateColumns: GRID,
      });

      const { rows } = view._dataView;
      (run.signals || []).forEach(s => {
        const tagInfo = TAG_MAP[s.signal] || { cls: 'tag-u', label: s.signal };
        const evidence = s.evidence || s.finding || '';

        const row = _dataRows.createDataRow([
          { content: '<span class="finding-tag ' + tagInfo.cls + '">' + _dash.escapeHtml(tagInfo.label) + '</span>' },
          { content: _dash.escapeHtml(evidence.slice(0, 120) + (evidence.length > 120 ? '...' : '')) },
          { content: _dash.escapeHtml(s.agentId || '—') },
          { content: _dash.escapeHtml(s.counterpartId || '—') },
        ], (clickedRow) => {
          if (clickedRow.classList.contains('data-row--expanded')) {
            expander.collapse();
            return;
          }
          expander.expand(clickedRow);
          clickedRow.classList.add('data-row--expanded');

          const panel = document.createElement('div');
          panel.className = 'data-expand';

          if (s.signal === 'disagreement' || s.signal === 'hallucination_caught') {
            // Two-column dispute view
            panel.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">'
              + '<div><div style="font-size:11px;color:var(--text-3);margin-bottom:4px">Claim (' + _dash.escapeHtml(s.agentId || '') + ')</div>'
              + '<div style="white-space:pre-wrap;font-size:12px;color:var(--text-2)">' + _dash.escapeHtml(evidence) + '</div></div>'
              + '<div><div style="font-size:11px;color:var(--text-3);margin-bottom:4px">Counter (' + _dash.escapeHtml(s.counterpartId || '') + ')</div>'
              + '<div style="white-space:pre-wrap;font-size:12px;color:var(--text-2)">' + _dash.escapeHtml(s.reason || s.counterEvidence || 'No counterargument recorded') + '</div></div>'
              + '</div>';
          } else if (s.signal === 'unverified' || s.signal === 'unique_unconfirmed') {
            panel.innerHTML = '<div style="white-space:pre-wrap;font-size:12px;color:var(--text-2)">' + _dash.escapeHtml(evidence) + '</div>'
              + '<div style="margin-top:8px;font-size:11px;color:var(--text-3);font-style:italic">Not verified by peers</div>';
          } else {
            panel.innerHTML = '<div style="white-space:pre-wrap;font-size:12px;color:var(--text-2)">' + _dash.escapeHtml(evidence) + '</div>'
              + (s.counterpartId ? '<div style="margin-top:8px;font-size:11px;color:var(--text-3)">Confirmed by: ' + _dash.escapeHtml(s.counterpartId) + '</div>' : '');
          }
          clickedRow.after(panel);
        }, GRID);

        rows.appendChild(row);
      });

      app.appendChild(view);
    } catch {
      app.innerHTML = '';
      app.appendChild(_dataRows.createErrorState(render));
    }
  }

  render();
}
```

- [ ] **Step 2: Build and verify**

Run: `cd packages/dashboard && node build.js`
Expected: Builds without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/detail/consensus.js
git commit -m "feat(dashboard): rewrite consensus detail with grid data rows"
```

---

### Task 10: Frontend — Update knowledge detail task history

**Files:**
- Modify: `packages/dashboard/src/detail/knowledge.js`

- [ ] **Step 1: Replace the task history section with grid data rows**

In `packages/dashboard/src/detail/knowledge.js`, find the task history rendering (around line 69-81 where it renders `task-history-row` divs) and replace it with:

```javascript
// Task history as grid data rows
if (data.tasks && data.tasks.length > 0) {
  const taskSection = document.createElement('div');
  taskSection.innerHTML = '<div class="sh" style="margin-top:24px">Task History <span class="sh-count">' + data.tasks.length + '</span></div>';

  const TASK_GRID = '100px 1fr 80px';
  const taskView = _dataRows.createDataView({
    columns: [
      { key: 'timestamp', label: 'Date', width: '100px' },
      { key: 'task', label: 'Task', width: '1fr', sortable: false },
      { key: 'importance', label: 'Importance', width: '80px', align: 'right', sortable: false },
    ],
    defaultSort: 'timestamp',
    defaultOrder: 'desc',
    gridTemplateColumns: TASK_GRID,
  });

  const { rows } = taskView._dataView;
  data.tasks.forEach(t => {
    const row = _dataRows.createDataRow([
      { content: '<span data-timestamp="' + (t.timestamp || '') + '">' + _dash.timeAgo(t.timestamp) + '</span>', className: 'data-cell--muted' },
      { content: _dash.escapeHtml((t.task || t.result || '').split('\n')[0].slice(0, 100)) },
      { content: t.importance != null ? String(t.importance) : '—', className: 'data-cell--right' },
    ], null, TASK_GRID);
    rows.appendChild(row);
  });

  taskSection.appendChild(taskView);
  // Set a reasonable max height since this is embedded, not a full detail view
  taskView.style.maxHeight = '400px';
  app.appendChild(taskSection);
}
```

Keep the MEMORY.md rendering and knowledge files sections unchanged.

- [ ] **Step 2: Build and verify**

Run: `cd packages/dashboard && node build.js`
Expected: Builds without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/detail/knowledge.js
git commit -m "feat(dashboard): upgrade knowledge task history to grid data rows"
```

---

### Task 11: Frontend — Hub grid layout + status bar + live timestamps

**Files:**
- Modify: `packages/dashboard/src/app.js`
- Modify: `packages/dashboard/src/hub/overview.js`
- Modify: `packages/dashboard/src/hub/activity.js`

- [ ] **Step 1: Update app.js — hub grid layout**

In `packages/dashboard/src/app.js`, find the `renderHub` function (around line 234). Replace the section rendering to wrap Team and Recent Runs in a `.hub-grid` div:

```javascript
// After rendering overview section and task strip, wrap team + activity:
const hubGrid = document.createElement('div');
hubGrid.className = 'hub-grid';

const teamSection = makeSection('Team', agents.length, 'all agents →', '#/team');
// ... existing team rendering into teamSection ...
hubGrid.appendChild(teamSection);

const runsSection = makeSection('Recent Runs', (consensusData.runs || []).length, 'all signals →', '#/signals');
// ... existing activity rendering into runsSection ...
hubGrid.appendChild(runsSection);

app.appendChild(hubGrid);
```

- [ ] **Step 2: Fix section refresh selectors**

In `app.js`, find the WS-driven section refresh code (around line 292-295) that uses `sections[N]` index-based selection. Replace with class-based or data-attribute selection:

```javascript
// Before:
// const sections = app.querySelectorAll('.section');
// sections[0] → overview, sections[2] → team, etc.

// After: add data-section attributes when creating sections
// then use: app.querySelector('[data-section="team"]')
```

Add `data-section` attributes to each section when creating them in `renderHub`.

- [ ] **Step 3: Add live timestamp intervals**

At the end of `renderHub` in `app.js`, add the timestamp refresh intervals:

```javascript
// Live timestamp updates
if (window._timestampInterval) clearInterval(window._timestampInterval);
if (window._elapsedInterval) clearInterval(window._elapsedInterval);

// Refresh relative timestamps every 30s
window._timestampInterval = setInterval(() => {
  document.querySelectorAll('[data-timestamp]').forEach(el => {
    const ts = el.getAttribute('data-timestamp');
    if (ts) el.textContent = _dash.timeAgo(ts);
  });
}, 30000);

// Refresh active task elapsed time every 1s
window._elapsedInterval = setInterval(() => {
  document.querySelectorAll('[data-started]').forEach(el => {
    const started = new Date(el.getAttribute('data-started')).getTime();
    const elapsed = Math.round((Date.now() - started) / 1000);
    el.textContent = elapsed < 60 ? elapsed + 's' : Math.floor(elapsed / 60) + 'm' + (elapsed % 60) + 's';
  });
}, 1000);
```

- [ ] **Step 4: Update overview.js — add aggregate metrics**

In `packages/dashboard/src/hub/overview.js`, add total tasks and consensus rate to the status bar. After the existing actionable findings display, add:

```javascript
// Add aggregate metrics
if (data.totalTasks != null) {
  // append: " · 388 tasks · 82% consensus rate"
  const taskCount = data.totalTasks || 0;
  const consensusRate = data.confirmedFindings && data.totalFindings
    ? Math.round((data.confirmedFindings / data.totalFindings) * 100) + '%'
    : '—';
  // Append to the existing status line
}
```

Note: Check if `overviewHandler` already returns `totalTasks`/`confirmedFindings`/`totalFindings`. If not, add them to `api-overview.ts`.

- [ ] **Step 5: Update activity.js — add NEW pill**

In `packages/dashboard/src/hub/activity.js`, find where pills are rendered for each consensus run (the section that renders confirmed/disputed/unverified/unique pills from `run.counts`). Add a NEW pill:

```javascript
// After the existing pill rendering, add:
if (run.counts.new > 0) {
  const newPill = document.createElement('span');
  newPill.className = 'finding-tag tag-b';
  newPill.textContent = run.counts.new + ' New';
  pillContainer.appendChild(newPill);
}
```

- [ ] **Step 6: Build and verify**

Run: `cd packages/dashboard && node build.js`
Expected: Builds without errors.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/src/app.js packages/dashboard/src/hub/overview.js packages/dashboard/src/hub/activity.js
git commit -m "feat(dashboard): hub grid layout, live timestamps, NEW pill"
```

---

### Task 12: Build + visual verification

**Files:**
- Build output: `dist-dashboard/index.html`

- [ ] **Step 1: Full build**

Run: `cd packages/dashboard && node build.js`
Expected: `dist-dashboard/index.html` generated without errors.

- [ ] **Step 2: Build the relay**

Run: `npm run build:mcp` (or the workspace build command)
Expected: No TypeScript errors.

- [ ] **Step 3: Verify with /browse or manual inspection**

Open the dashboard in a browser and verify:
- Hub grid: team + runs side-by-side on wide viewport, stacked on narrow
- Status bar: shows aggregate metrics
- NEW pill: visible on runs with new findings
- Timestamps: update live (wait 30s to verify)
- #/tasks: grid data rows with filters, search, sort, expand, load more
- #/signals: grid data rows with type pills, task links, expand
- #/team: agent grid rows with trust rings, sort by weight, expand to skills
- #/consensus/:id: finding rows with dispute comparison

- [ ] **Step 4: Commit the built output**

```bash
git add dist-dashboard/index.html
git commit -m "build: dashboard v4 bundle"
```
