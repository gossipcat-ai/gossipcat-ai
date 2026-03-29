// packages/dashboard/src/detail/knowledge.js — Memory browser with markdown rendering

async function renderKnowledgeDetail(app, agentId) {
  const { api, escapeHtml: e, agentInitials, agentColor, makeSection } = window._dash;
  app.innerHTML = '<div class="loading">Loading memory...</div>';

  try {
    const data = await api('memory/' + encodeURIComponent(agentId));
    app.innerHTML = '';

    const section = makeSection(agentId + ' Memory', (data.fileCount || data.knowledge?.length || 0) + ' files');

    // MEMORY.md index
    if (data.index) {
      const indexPanel = document.createElement('div');
      indexPanel.className = 'panel';
      indexPanel.innerHTML =
        '<div class="panel-head"><span class="panel-title">MEMORY.md</span></div>' +
        '<div class="panel-body"><div class="memory-md">' + renderMarkdown(data.index) + '</div></div>';
      section.appendChild(indexPanel);
    }

    // Knowledge files
    if (data.knowledge && data.knowledge.length > 0) {
      const filesPanel = document.createElement('div');
      filesPanel.className = 'panel';
      filesPanel.style.marginTop = '10px';
      filesPanel.innerHTML =
        '<div class="panel-head"><span class="panel-title">Knowledge Files (' + data.knowledge.length + ')</span></div>';

      const filesBody = document.createElement('div');
      filesBody.className = 'panel-body';
      filesBody.style.maxHeight = '500px';

      for (const k of data.knowledge) {
        const isCognitive = (k.frontmatter && k.frontmatter.type === 'cognitive') || (k.content || '').includes('You reviewed') || (k.content || '').includes('## What I Learned');
        const desc = e((k.frontmatter && (k.frontmatter.description || k.frontmatter.name)) || k.filename);

        const file = document.createElement('div');
        file.className = 'memory-file' + (isCognitive ? ' cognitive' : '');
        file.innerHTML =
          '<div class="memory-file-header" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">' +
          '<span style="font-family:var(--mono);color:var(--text-3);width:1rem;text-align:center">+</span>' +
          '<span class="memory-filename">' + e(k.filename) + '</span>' +
          '<span class="memory-desc">' + desc + '</span>' +
          (isCognitive ? '<span style="font-size:9px;font-family:var(--mono);color:var(--accent);margin-left:auto">cognitive</span>' : '') +
          '</div>' +
          '<pre class="memory-file-content" hidden>' + e(k.content) + '</pre>';
        filesBody.appendChild(file);
      }

      filesPanel.appendChild(filesBody);
      section.appendChild(filesPanel);
    }

    // Task history
    if (data.tasks && data.tasks.length > 0) {
      const taskPanel = document.createElement('div');
      taskPanel.className = 'panel';
      taskPanel.style.marginTop = '10px';
      taskPanel.innerHTML =
        '<div class="panel-head"><span class="panel-title">Task History (' + data.tasks.length + ')</span></div>';

      const taskBody = document.createElement('div');
      taskBody.className = 'panel-body';
      taskBody.style.maxHeight = '300px';

      for (const t of data.tasks.slice(-50).reverse()) {
        const row = document.createElement('div');
        row.className = 'fr';
        row.innerHTML =
          '<span class="fr-time" style="min-width:70px">' + (t.timestamp ? new Date(t.timestamp).toLocaleDateString() : '—') + '</span>' +
          '<span style="color:var(--text-2);flex:1">' + e(String(t.task || t.result || '—').slice(0, 120)) + '</span>';
        taskBody.appendChild(row);
      }

      taskPanel.appendChild(taskBody);
      section.appendChild(taskPanel);
    }

    if (!data.index && (!data.knowledge || data.knowledge.length === 0)) {
      section.innerHTML += '<div class="empty-state">No memory data for this agent.</div>';
    }

    app.appendChild(section);
  } catch (err) {
    app.innerHTML = '<div class="empty-state">Failed to load memory: ' + e(err.message) + '</div>';
  }
}

// All agents view (team detail)
async function renderAllAgents(app) {
  const { api, escapeHtml: e, navigate, formatTokens, agentInitials, agentColor, makeSection } = window._dash;
  app.innerHTML = '<div class="loading">Loading agents...</div>';

  try {
    const agents = await api('agents');
    app.innerHTML = '';
    const section = makeSection('All Agents', agents.length + ' total');

    if (agents.length === 0) {
      section.innerHTML += '<div class="empty-state">No agents configured.</div>';
      app.appendChild(section);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'agent-grid';
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(260px, 1fr))';

    const sorted = [...agents].sort((a, b) => (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0));
    for (const agent of sorted) {
      const s = agent.scores || {};
      const isIdle = !agent.online && s.signals === 0;
      const color = agentColor(agent);

      const card = document.createElement('button');
      card.className = 'ag' + (isIdle ? ' idle' : '');
      card.style.setProperty('--card-color', color);
      card.addEventListener('click', () => navigate('#/team/' + encodeURIComponent(agent.id)));

      const statusColor = agent.online ? 'var(--green)' : 'var(--text-3)';
      const statusText = agent.online ? 'online' : 'idle';
      const dotStyle = agent.online ? 'background:var(--green);box-shadow:0 0 6px rgba(52,211,153,0.4)' : 'background:var(--text-3)';
      const provider = (agent.provider || '').replace(/^anthropic$/, 'Anthropic').replace(/^google$/, 'Google');
      const preset = (agent.preset || '').charAt(0).toUpperCase() + (agent.preset || '').slice(1);

      card.innerHTML =
        '<div class="ag-top"><div>' +
          '<div class="ag-name">' + e(agent.id) + '</div>' +
          '<div class="ag-role">' + e(provider) + ' &middot; ' + e(preset) + '</div>' +
        '</div><div class="ag-status" style="color:' + statusColor + '">' +
          '<span class="ag-dot" style="' + dotStyle + '"></span>' + statusText +
        '</div></div>' +
        '<div class="ag-metrics">' +
          '<div class="ag-m"><div class="ag-m-val" style="color:var(--accent)">' + (isIdle ? '&mdash;' : Math.round(s.accuracy * 100) + '%') + '</div><div class="ag-m-lbl">Accuracy</div></div>' +
          '<div class="ag-m"><div class="ag-m-val" style="color:var(--blue)">' + (isIdle ? '&mdash;' : Math.round(s.uniqueness * 100) + '%') + '</div><div class="ag-m-lbl">Unique</div></div>' +
          '<div class="ag-m"><div class="ag-m-val">' + (s.signals || 0) + '</div><div class="ag-m-lbl">Signals</div></div>' +
          '<div class="ag-m"><div class="ag-m-val" style="color:var(--green)">' + formatTokens(agent.totalTokens) + '</div><div class="ag-m-lbl">Tokens</div></div>' +
        '</div>';

      grid.appendChild(card);
    }

    section.appendChild(grid);
    app.appendChild(section);
  } catch (err) {
    app.innerHTML = '<div class="empty-state">Failed to load agents: ' + e(err.message) + '</div>';
  }
}
