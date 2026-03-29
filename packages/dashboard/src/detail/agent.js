// packages/dashboard/src/detail/agent.js — Agent detail view

async function renderAgentDetail(app, agentId) {
  const { api, escapeHtml: e, formatTokens, agentInitials, agentColor, navigate, makeSection } = window._dash;
  app.innerHTML = '<div class="loading">Loading agent...</div>';

  try {
    const [agents, memData] = await Promise.all([api('agents'), api('memory/' + encodeURIComponent(agentId))]);
    const agent = agents.find(a => a.id === agentId);
    if (!agent) { app.innerHTML = '<div class="empty-state">Agent not found: ' + e(agentId) + '</div>'; return; }

    const s = agent.scores || {};
    const color = agentColor(agent);
    app.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'detail-header';
    header.innerHTML =
      '<div class="detail-avatar" style="background:' + color.replace('var(--', 'rgba(').replace(')', ',0.12)') + ';color:' + color + '">' + agentInitials(agentId) + '</div>' +
      '<div><div class="detail-title">' + e(agentId) + '</div>' +
      '<div class="detail-subtitle">' + e(agent.provider || '') + ' &middot; ' + e(agent.model || '') + (agent.preset ? ' &middot; ' + e(agent.preset) : '') + '</div></div>';
    app.appendChild(header);

    // Stats
    const stats = document.createElement('div');
    stats.className = 'detail-stats';
    const metrics = [
      { label: 'Accuracy', value: Math.round(s.accuracy * 100) + '%', color: 'var(--accent)' },
      { label: 'Uniqueness', value: Math.round(s.uniqueness * 100) + '%', color: 'var(--blue)' },
      { label: 'Signals', value: String(s.signals || 0) },
      { label: 'Tokens', value: formatTokens(agent.totalTokens), color: 'var(--green)' },
      { label: 'Weight', value: (s.dispatchWeight || 1).toFixed(2) },
    ];
    for (const m of metrics) {
      const stat = document.createElement('div');
      stat.className = 'detail-stat';
      stat.innerHTML = '<div class="detail-stat-val"' + (m.color ? ' style="color:' + m.color + '"' : '') + '>' + m.value + '</div><div class="detail-stat-lbl">' + m.label + '</div>';
      stats.appendChild(stat);
    }
    app.appendChild(stats);

    // Memory section
    if (memData.knowledge && memData.knowledge.length > 0) {
      const memSection = makeSection('Knowledge', memData.fileCount + ' files');
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.innerHTML = '<div class="panel-head"><span class="panel-title">Knowledge Files</span></div>';
      const body = document.createElement('div');
      body.className = 'panel-body';
      for (const k of memData.knowledge.slice(0, 20)) {
        const isCognitive = (k.frontmatter && k.frontmatter.type === 'cognitive') || (k.content || '').includes('You reviewed');
        const desc = e((k.frontmatter && (k.frontmatter.description || k.frontmatter.name)) || k.filename);
        const row = document.createElement('div');
        row.className = 'memory-file' + (isCognitive ? ' cognitive' : '');
        row.innerHTML =
          '<div class="memory-file-header" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">' +
          '<span style="font-family:monospace;color:var(--text-3);width:1rem;text-align:center">+</span>' +
          '<span class="memory-filename">' + e(k.filename) + '</span>' +
          '<span class="memory-desc">' + desc + '</span></div>' +
          '<pre class="memory-file-content" hidden>' + e(k.content) + '</pre>';
        body.appendChild(row);
      }
      panel.appendChild(body);
      memSection.appendChild(panel);
      app.appendChild(memSection);
    }

  } catch (err) {
    app.innerHTML = '<div class="empty-state">Failed to load agent: ' + e(err.message) + '</div>';
  }
}
