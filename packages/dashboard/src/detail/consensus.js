// packages/dashboard/src/detail/consensus.js — Single consensus run detail

async function renderConsensusDetail(app, taskId) {
  const { api, escapeHtml: e, makeSection } = window._dash;
  app.innerHTML = '<div class="loading">Loading consensus run...</div>';

  try {
    const data = await api('consensus');
    const run = (data.runs || []).find(r => r.taskId === taskId);
    if (!run) { app.innerHTML = '<div class="empty-state">Consensus run not found: ' + e(taskId) + '</div>'; return; }

    app.innerHTML = '';
    const section = makeSection('Consensus Run', run.agents.length + ' agents');

    // Run info
    const info = document.createElement('div');
    info.className = 'detail-stats';
    const c = run.counts || {};
    const statItems = [
      { label: 'Agreements', value: c.agreement || 0, color: 'var(--green)' },
      { label: 'Disagreements', value: c.disagreement || 0, color: 'var(--red)' },
      { label: 'Hallucinations', value: c.hallucination || 0, color: 'var(--red)' },
      { label: 'Unverified', value: c.unverified || 0, color: 'var(--amber)' },
      { label: 'Unique', value: c.unique || 0, color: 'var(--blue)' },
    ];
    for (const s of statItems) {
      const stat = document.createElement('div');
      stat.className = 'detail-stat';
      stat.innerHTML = '<div class="detail-stat-val" style="color:' + s.color + '">' + s.value + '</div><div class="detail-stat-lbl">' + s.label + '</div>';
      info.appendChild(stat);
    }
    section.appendChild(info);

    // Signals list
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = '<div class="panel-head"><span class="panel-title">Signals</span></div>';
    const body = document.createElement('div');
    body.className = 'panel-body';
    body.style.maxHeight = '500px';

    for (const s of (run.signals || [])) {
      const typeClass = (s.signal || '').includes('agreement') ? 'agreement'
        : (s.signal || '').includes('hallucination') ? 'hallucination'
        : (s.signal || '').includes('unique') ? 'unique'
        : (s.signal || '').includes('disagree') ? 'disagreement' : 'unique';
      const typeLabel = (s.signal || '').replace(/_/g, ' ').replace(/caught$/, '').trim();
      const arrow = s.counterpartId ? '<span class="sig-arrow">→</span><span class="sig-agent">' + e(s.counterpartId) + '</span>' : '';
      const evidence = s.evidence ? '<div style="color:var(--text-3);font-size:11px;margin-top:4px;padding-left:72px">' + e(s.evidence.slice(0, 200)) + '</div>' : '';

      const row = document.createElement('div');
      row.className = 'sig-row';
      row.style.flexWrap = 'wrap';
      row.innerHTML =
        '<span class="sig-type ' + typeClass + '">' + e(typeLabel) + '</span>' +
        '<span class="sig-agent">' + e(s.agentId || '') + '</span>' +
        arrow + evidence;
      body.appendChild(row);
    }

    panel.appendChild(body);
    section.appendChild(panel);
    app.appendChild(section);
  } catch (err) {
    app.innerHTML = '<div class="empty-state">Failed to load consensus: ' + e(err.message) + '</div>';
  }
}
