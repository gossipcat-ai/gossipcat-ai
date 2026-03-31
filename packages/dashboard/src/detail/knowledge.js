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

      const knowledgeSorted = [...data.knowledge].reverse();
      for (const k of knowledgeSorted) {
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
          '<div class="memory-file-content memory-md" hidden>' + renderMarkdown(k.content || '') + '</div>';
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
        const date = t.timestamp ? new Date(t.timestamp) : null;
        const dateStr = date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
        const timeStr = date ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
        const taskText = String(t.task || t.result || '—').replace(/\n.*/s, '').slice(0, 140);
        const row = document.createElement('div');
        row.className = 'task-history-row';
        row.innerHTML =
          '<span class="task-history-date">' + e(dateStr) + '</span>' +
          '<span class="task-history-time">' + e(timeStr) + '</span>' +
          '<span class="task-history-desc">' + e(taskText) + '</span>';
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
  const { api, escapeHtml: e, navigate, agentInitials, makeSection, timeAgo } = window._dash;
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

    const sorted = [...agents].sort((a, b) => (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0));
    for (const agent of sorted) {
      const btn = document.createElement('button');
      btn.className = 'ag';
      btn.addEventListener('click', () => navigate('#/team/' + encodeURIComponent(agent.id)));

      const w = agent.scores?.dispatchWeight ?? 1;
      const signals = agent.scores?.signals ?? 0;
      const accuracy = agent.scores?.accuracy ?? 0.5;
      const ringColor = signals === 0 ? 'var(--text-3)'
        : w >= 1.5 ? 'var(--green)'
        : w >= 0.8 ? 'var(--amber)'
        : 'var(--red)';
      const ringOpacity = signals === 0 ? '0.35' : '1';
      const arcLength = 132 * Math.min(1, accuracy);

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
              ' stroke-dasharray="' + arcLength + ' 132"' +
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

    section.appendChild(grid);
    app.appendChild(section);
  } catch (err) {
    app.innerHTML = '<div class="empty-state">Failed to load agents: ' + e(err.message) + '</div>';
  }
}
