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
    const [overview, agents, tasks, consensus, signals] = await Promise.all([
      api('overview'), api('agents'), api('tasks'),
      api('consensus'), api('signals'),
    ]);
    app.innerHTML = '';

    // Build sections
    app.appendChild(renderOverviewSection(overview));
    app.appendChild(renderTeamSection(agents));
    app.appendChild(renderPerformanceSection(tasks, agents));
    app.appendChild(renderActivitySection(tasks, consensus, signals));
    app.appendChild(renderKnowledgeSection(agents));

    // Wire WS live updates for the hub
    const wsHandler = onDashboardEvent((event) => {
      const refreshEvents = ['task_completed', 'task_failed', 'consensus_complete', 'agent_connected', 'agent_disconnected'];
      if (refreshEvents.includes(event.type)) {
        // Re-fetch and re-render on significant events
        renderHub(app);
      }
    });
    currentCleanup = () => offDashboardEvent(wsHandler);

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
