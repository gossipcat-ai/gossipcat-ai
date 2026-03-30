// packages/dashboard/src/app.js — Router, API, Auth, WebSocket, Hub orchestration

// ── Utilities ──────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
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
  if (diff < 0) return 'just now';
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function agentInitials(id) {
  return id.split('-').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function agentColor(agent) {
  if (!agent || (!agent.online && agent.scores?.signals === 0)) return 'var(--text-3)';
  if (agent.provider === 'google') return 'var(--blue)';
  return 'var(--accent)';
}

// ── Task Strip — active tasks when working, recent completed when idle ──
async function renderTaskStrip(container) {
  try {
    // Try active tasks first
    const activeData = await api('active-tasks');
    const MAX_AGE_MS = 30 * 60 * 1000;
    const now = Date.now();
    const active = (activeData.tasks || []).filter(t => now - new Date(t.startedAt).getTime() < MAX_AGE_MS);

    container.innerHTML = '';
    container.hidden = false;

    if (active.length > 0) {
      // Live mode: agents are working
      container.className = 'section live-strip live-active';
      for (const t of active) {
        const desc = escapeHtml((t.task || '').replace(/\n.*/s, '').slice(0, 60));
        const row = document.createElement('div');
        row.className = 'live-task';
        row.innerHTML =
          '<span class="live-icon">&#9889;</span>' +
          '<span class="live-agent">' + escapeHtml(t.agentId) + '</span>' +
          '<span class="live-desc">' + desc + '</span>' +
          '<span class="live-elapsed">' + timeAgo(t.startedAt) + '</span>';
        container.appendChild(row);
      }
      return;
    }

    // Idle mode: show recent completed tasks
    const taskData = await api('tasks');
    const recent = (taskData.tasks || []).slice(0, 10);
    if (recent.length === 0) { container.hidden = true; return; }

    container.className = 'section live-strip';
    for (const t of recent) {
      const color = t.status === 'completed' ? 'var(--green)' : t.status === 'failed' ? 'var(--red)' : 'var(--text-3)';
      const icon = t.status === 'completed' ? '&#10003;' : t.status === 'failed' ? '&#10007;' : '&#8943;';
      const desc = escapeHtml((t.task || '').replace(/\n.*/s, '').slice(0, 60));
      const dur = t.duration > 0 ? (t.duration / 1000).toFixed(1) + 's' : '';
      const row = document.createElement('div');
      row.className = 'live-task';
      row.innerHTML =
        '<span class="live-icon" style="color:' + color + '">' + icon + '</span>' +
        '<span class="live-agent">' + escapeHtml(t.agentId) + '</span>' +
        '<span class="live-desc">' + desc + '</span>' +
        (dur ? '<span class="live-elapsed" style="color:var(--text-3)">' + dur + '</span>' : '') +
        '<span class="live-elapsed">' + timeAgo(t.timestamp) + '</span>';
      container.appendChild(row);
    }
  } catch { container.hidden = true; }
}

// ── API Helper ─────────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch('/dashboard/api/' + path, { credentials: 'include' });
  if (res.status === 401) { showAuth(); throw new Error('Unauthorized'); }
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.error || 'API error: ' + res.status);
  }
  return res.json();
}

// ── Auth ───────────────────────────────────────────────────────────────
const authGate = document.getElementById('auth-gate');
const dashboard = document.getElementById('dashboard');
const authForm = document.getElementById('auth-form');
const authError = document.getElementById('auth-error');

function showAuth() {
  authGate.hidden = false;
  dashboard.hidden = true;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

function showDashboard() {
  authGate.hidden = true;
  dashboard.hidden = false;
  connectWs();
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = authForm.querySelector('button');
  btn.disabled = true;
  const key = document.getElementById('auth-key').value.trim();
  try {
    const res = await fetch('/dashboard/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      credentials: 'include',
    });
    if (!res.ok) { authError.hidden = false; return; }
    const verify = await fetch('/dashboard/api/overview', { credentials: 'include' });
    if (verify.ok) { authError.hidden = true; showDashboard(); route(); }
    else { authError.hidden = false; }
  } catch { authError.hidden = false; }
  finally { btn.disabled = false; }
});

// ── Router ─────────────────────────────────────────────────────────────
function getRoute() {
  const hash = location.hash.slice(1) || '/';
  const parts = hash.split('/').filter(Boolean);
  return { path: '/' + parts.join('/'), parts };
}

function navigate(path) { location.hash = path; }

let currentCleanup = null;

async function route() {
  // Clean up previous view's event listeners
  if (currentCleanup) { currentCleanup(); currentCleanup = null; }

  const { path, parts } = getRoute();
  const app = document.getElementById('app');
  updateBreadcrumb(parts);

  // Hub
  if (path === '/' || path === '/overview') return renderHub(app);

  // Detail views
  if (path === '/team') return renderAllAgents(app);
  if (parts[0] === 'team' && parts[1]) return renderAgentDetail(app, decodeURIComponent(parts[1]));
  if (path === '/tasks') return renderTasksDetail(app);
  if (parts[0] === 'consensus' && parts[1]) return renderConsensusDetail(app, decodeURIComponent(parts[1]));
  if (path === '/signals') return renderSignalsDetail(app);
  if (parts[0] === 'knowledge' && parts[1]) return renderKnowledgeDetail(app, decodeURIComponent(parts[1]));

  app.innerHTML = '<div class="empty-state">Page not found</div>';
}

function updateBreadcrumb(parts) {
  const el = document.getElementById('breadcrumb-page');
  if (!el) return;
  if (parts.length === 0) { el.textContent = 'Overview'; return; }
  el.textContent = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' / ');
}

window.addEventListener('hashchange', route);

// ── WebSocket ──────────────────────────────────────────────────────────
let ws = null;
const wsStatus = document.getElementById('ws-status');
const wsLabel = document.getElementById('ws-label');
const eventListeners = new Set();

function onDashboardEvent(fn) { eventListeners.add(fn); return fn; }
function offDashboardEvent(fn) { eventListeners.delete(fn); }

function connectWs() {
  if (ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/dashboard/ws');

  ws.onopen = () => {
    if (wsStatus) wsStatus.className = 'ws-dot online';
    if (wsLabel) wsLabel.textContent = 'Connected';
  };

  ws.onclose = () => {
    if (wsStatus) wsStatus.className = 'ws-dot offline';
    if (wsLabel) wsLabel.textContent = 'Disconnected';
    ws = null;
    if (!dashboard.hidden) setTimeout(connectWs, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      for (const fn of eventListeners) fn(event);
    } catch { /* ignore */ }
  };
}

// ── Hub Renderer ───────────────────────────────────────────────────────
async function renderHub(app) {
  app.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const [overview, agents, consensus] = await Promise.all([
      api('overview'), api('agents'), api('consensus'),
    ]);
    app.innerHTML = '';

    // Build sections
    app.appendChild(renderOverviewSection(overview));

    const liveStrip = document.createElement('div');
    liveStrip.className = 'section live-strip';
    liveStrip.hidden = true;
    app.appendChild(liveStrip);
    renderTaskStrip(liveStrip);

    app.appendChild(renderTeamSection(agents));
    app.appendChild(renderActivitySection(consensus));
    app.appendChild(renderKnowledgeSection(agents));

    // Wire WS live updates — selective section refresh, debounced
    let refreshTimer = null;
    const pendingSections = new Set();

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

    const wsHandler = onDashboardEvent((event) => {
      if (event.type === 'task_dispatched' || event.type === 'task_completed' || event.type === 'task_failed') {
        const strip = app.querySelector('.live-strip');
        if (strip) renderTaskStrip(strip);
      }

      const sections = sectionMap[event.type];
      if (!sections || sections.length === 0) return;
      for (const s of sections) pendingSections.add(s);

      // Debounce: wait 500ms to batch rapid events
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        const toRefresh = new Set(pendingSections);
        pendingSections.clear();

        try {
          // Only fetch APIs needed for the sections being refreshed
          const needsOverview = toRefresh.has('overview');
          const needsAgents = toRefresh.has('team') || toRefresh.has('knowledge');
          const needsConsensus = toRefresh.has('activity');

          const [ov, ag, cx] = await Promise.all([
            needsOverview ? api('overview') : null,
            needsAgents ? api('agents') : null,
            needsConsensus ? api('consensus') : null,
          ]);

          // Replace only the affected section DOM nodes
          // sections: [0]=overview, [1]=team, [2]=activity, [3]=knowledge
          const sections = app.querySelectorAll('.section');
          if (ov && sections[0]) { const el = renderOverviewSection(ov); sections[0].replaceWith(el); }
          if (ag && sections[1]) { const el = renderTeamSection(ag); sections[1].replaceWith(el); }
          if (cx && sections[2]) { const el = renderActivitySection(cx); sections[2].replaceWith(el); }
          if (ag && sections[3]) { const el = renderKnowledgeSection(ag); sections[3].replaceWith(el); }
        } catch { /* best-effort live update */ }
      }, 500);
    });
    currentCleanup = () => { offDashboardEvent(wsHandler); if (refreshTimer) clearTimeout(refreshTimer); };

  } catch (err) {
    app.innerHTML = '<div class="empty-state">Failed to load dashboard: ' + escapeHtml(err.message) + '</div>';
  }
}

// ── Section Helper ─────────────────────────────────────────────────────
function makeSection(title, count, actionText, actionTarget) {
  const section = document.createElement('div');
  section.className = 'section';

  const header = document.createElement('div');
  header.className = 'sh';
  header.innerHTML =
    '<div class="sh-left">' +
      '<span class="sh-title">' + escapeHtml(title) + '</span>' +
      (count != null ? '<span class="sh-count">' + escapeHtml(String(count)) + '</span>' : '') +
    '</div>' +
    (actionText ? '<button class="sh-action" role="link">' + escapeHtml(actionText) + '</button>' : '');

  if (actionTarget) {
    const btn = header.querySelector('.sh-action');
    if (btn) btn.addEventListener('click', () => navigate(actionTarget));
  }

  section.appendChild(header);
  return section;
}

// ── Init ───────────────────────────────────────────────────────────────
api('overview')
  .then(() => { showDashboard(); route(); })
  .catch(() => showAuth());

// Export for hub/detail modules
window._dash = { api, navigate, escapeHtml, formatTokens, timeAgo, agentInitials, agentColor, onDashboardEvent, offDashboardEvent, makeSection };
