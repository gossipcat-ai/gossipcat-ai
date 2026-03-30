// packages/dashboard/src/hub/knowledge.js — 2-column: agent memory chips + recent learnings

function renderKnowledgeSection(agents) {
  const { escapeHtml: e, navigate, agentInitials, agentColor, makeSection } = window._dash;
  const section = makeSection('Knowledge', null, 'browse →', '#/knowledge/_project');

  const grid = document.createElement('div');
  grid.className = 'know-grid';

  // ── Left: Agent memory chips ───────────────────
  const memPanel = document.createElement('div');
  memPanel.className = 'panel';
  memPanel.innerHTML = '<div class="panel-head"><span class="panel-title">Agent Memory</span></div>';

  const chips = document.createElement('div');
  chips.className = 'know-agents';

  // _project shared first
  const projectChip = document.createElement('button');
  projectChip.className = 'ka';
  projectChip.addEventListener('click', () => navigate('#/knowledge/_project'));
  projectChip.innerHTML =
    '<div class="ka-avatar" style="background:rgba(167,139,250,0.1);color:var(--accent)">P</div>' +
    '<div class="ka-info"><div class="ka-name">_project (shared)</div><div class="ka-stats">shared context</div></div>';
  chips.appendChild(projectChip);

  for (const agent of agents) {
    const color = agentColor(agent);
    const chip = document.createElement('button');
    chip.className = 'ka';
    if (!agent.online && (agent.scores?.signals || 0) === 0) chip.style.opacity = '0.6';
    chip.addEventListener('click', () => navigate('#/knowledge/' + encodeURIComponent(agent.id)));
    chip.innerHTML =
      '<div class="ka-avatar" style="background:' + color.replace('var(--', 'rgba(').replace(')', ',0.1)') + ';color:' + color + '">' + agentInitials(agent.id) + '</div>' +
      '<div class="ka-info"><div class="ka-name">' + e(agent.id) + '</div><div class="ka-stats">' + (agent.scores?.signals || 0) + ' signals</div></div>';
    chips.appendChild(chip);
  }

  memPanel.appendChild(chips);
  grid.appendChild(memPanel);

  // ── Right: Recent learnings ──────────────────────
  const learnPanel = document.createElement('div');
  learnPanel.className = 'panel';
  learnPanel.innerHTML = '<div class="panel-head"><span class="panel-title">Recent Learnings</span></div>';

  const learnBody = document.createElement('div');
  learnBody.className = 'panel-body';
  learnBody.innerHTML = '<div class="empty-state">Loading...</div>';
  learnPanel.appendChild(learnBody);
  grid.appendChild(learnPanel);

  // Fetch learnings async — don't block hub render
  window._dash.api('learnings').then(data => {
    const items = (data.learnings || []);
    if (items.length === 0) {
      learnBody.innerHTML = '<div class="empty-state">No learnings yet</div>';
      return;
    }
    learnBody.innerHTML = '';
    for (const item of items) {
      const color = agentColor(agents.find(a => a.id === item.agentId) || { provider: '', online: false, scores: {} });
      const row = document.createElement('div');
      row.className = 'learn-row';
      row.addEventListener('click', () => navigate('#/knowledge/' + encodeURIComponent(item.agentId)));
      row.innerHTML =
        '<div class="learn-avatar" style="background:' + color.replace('var(--', 'rgba(').replace(')', ',0.1)') + ';color:' + color + '">' + agentInitials(item.agentId) + '</div>' +
        '<span class="learn-text">' + e(item.description).slice(0, 60) + '</span>' +
        '<span class="learn-type">' + e(item.type) + '</span>';
      learnBody.appendChild(row);
    }
  }).catch(() => {
    learnBody.innerHTML = '<div class="empty-state">Failed to load learnings</div>';
  });

  section.appendChild(grid);
  return section;
}
