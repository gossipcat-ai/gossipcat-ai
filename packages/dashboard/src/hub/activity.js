// packages/dashboard/src/hub/activity.js — 3-column: tasks + consensus + signals

function renderActivitySection(tasksData, consensusData, signalsData) {
  const { escapeHtml: e, navigate, makeSection } = window._dash;
  const totalToday = tasksData.tasks?.length || 0;
  const section = makeSection('Activity', totalToday + ' tasks', 'all tasks →', '#/tasks');

  const cols = document.createElement('div');
  cols.className = 'three-col';

  // ── Recent Tasks panel ─────────────────────────
  const tasksPanel = document.createElement('div');
  tasksPanel.className = 'panel';
  tasksPanel.innerHTML = '<div class="panel-head"><span class="panel-title">Recent Tasks</span></div>';
  const tasksBody = document.createElement('div');
  tasksBody.className = 'panel-body';

  const tasks = (tasksData.tasks || []).slice(0, 20);
  if (tasks.length === 0) {
    tasksBody.innerHTML = '<div class="empty-state">No tasks yet</div>';
  } else {
    for (const t of tasks) {
      const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const color = t.status === 'completed' ? 'var(--green)' : t.status === 'failed' ? 'var(--red)' : 'var(--accent)';
      const dur = t.duration > 0 ? '<span class="fr-dur">' + (t.duration / 1000).toFixed(1) + 's</span>' : '';
      const desc = e((t.task || '').replace(/\n.*/s, '').slice(0, 50));

      const row = document.createElement('div');
      row.className = 'fr';
      row.innerHTML =
        '<span class="fr-dot" style="background:' + color + '"></span>' +
        '<span class="fr-time">' + time + '</span>' +
        '<span><span class="fr-agent">' + e(t.agentId) + '</span> ' + desc + dur + '</span>';
      tasksBody.appendChild(row);
    }
  }
  tasksPanel.appendChild(tasksBody);
  cols.appendChild(tasksPanel);

  // ── Consensus Runs panel ───────────────────────
  const cxPanel = document.createElement('div');
  cxPanel.className = 'panel';
  cxPanel.innerHTML =
    '<div class="panel-head"><span class="panel-title">Consensus</span>' +
    '<button class="sh-action" role="link">details →</button></div>';
  cxPanel.querySelector('.sh-action')?.addEventListener('click', () => navigate('#/signals'));

  const cxBody = document.createElement('div');
  cxBody.className = 'panel-body';

  const runs = (consensusData.runs || []).slice(0, 10);
  if (runs.length === 0) {
    cxBody.innerHTML = '<div class="empty-state">No consensus runs yet</div>';
  } else {
    for (const run of runs) {
      const time = run.timestamp ? new Date(run.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const c = run.counts || {};
      const pills = [];
      if (c.agreement) pills.push('<span class="pill pill-g">&#10003; ' + c.agreement + '</span>');
      if (c.disagreement || c.hallucination) pills.push('<span class="pill pill-r">' + ((c.disagreement || 0) + (c.hallucination || 0)) + '</span>');
      if (c.unverified) pills.push('<span class="pill pill-y">' + c.unverified + '</span>');

      const row = document.createElement('div');
      row.className = 'cr';
      row.addEventListener('click', () => navigate('#/consensus/' + encodeURIComponent(run.taskId)));
      row.innerHTML =
        '<span class="cr-time">' + time + '</span>' +
        '<span class="cr-info">' + run.agents.length + ' agents</span>' +
        '<div class="cr-pills">' + pills.join('') + '</div>';
      cxBody.appendChild(row);
    }
  }
  cxPanel.appendChild(cxBody);
  cols.appendChild(cxPanel);

  // ── Signals panel ──────────────────────────────
  const sigPanel = document.createElement('div');
  sigPanel.className = 'panel';
  sigPanel.innerHTML =
    '<div class="panel-head"><span class="panel-title">Signals</span>' +
    '<button class="sh-action" role="link">all →</button></div>';
  sigPanel.querySelector('.sh-action')?.addEventListener('click', () => navigate('#/signals'));

  const sigBody = document.createElement('div');
  sigBody.className = 'panel-body';

  const sigs = (signalsData.signals || []).slice(0, 15);
  if (sigs.length === 0) {
    sigBody.innerHTML = '<div class="empty-state">No signals yet</div>';
  } else {
    for (const s of sigs) {
      const typeClass = (s.signal || '').includes('agreement') ? 'agreement'
        : (s.signal || '').includes('hallucination') ? 'hallucination'
        : (s.signal || '').includes('unique') ? 'unique'
        : (s.signal || '').includes('disagree') ? 'disagreement' : 'unique';
      const typeLabel = (s.signal || '').replace(/_/g, ' ').replace(/caught$/, '').trim().slice(0, 10);
      const finding = e((s.evidence || s.finding || '').slice(0, 40));
      const arrow = s.counterpartId ? '<span class="sig-arrow">→</span><span class="sig-agent">' + e(s.counterpartId).slice(0, 12) + '</span>' : '';

      const row = document.createElement('div');
      row.className = 'sig-row';
      row.innerHTML =
        '<span class="sig-type ' + typeClass + '">' + e(typeLabel) + '</span>' +
        '<span class="sig-agent">' + e((s.agentId || '').slice(0, 12)) + '</span>' +
        arrow +
        '<span class="sig-finding">' + finding + '</span>';
      sigBody.appendChild(row);
    }
  }
  sigPanel.appendChild(sigBody);
  cols.appendChild(sigPanel);

  section.appendChild(cols);
  return section;
}
