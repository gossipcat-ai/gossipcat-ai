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
    if (!agent.online && (agent.scores?.signals || 0) === 0) chip.style.opacity = '0.4';
    chip.addEventListener('click', () => navigate('#/knowledge/' + encodeURIComponent(agent.id)));
    chip.innerHTML =
      '<div class="ka-avatar" style="background:' + color.replace('var(--', 'rgba(').replace(')', ',0.1)') + ';color:' + color + '">' + agentInitials(agent.id) + '</div>' +
      '<div class="ka-info"><div class="ka-name">' + e(agent.id) + '</div><div class="ka-stats">' + (agent.scores?.signals || 0) + ' signals</div></div>';
    chips.appendChild(chip);
  }

  memPanel.appendChild(chips);
  grid.appendChild(memPanel);

  // ── Right: Recent learnings (placeholder — requires per-agent memory API calls) ──
  const learnPanel = document.createElement('div');
  learnPanel.className = 'panel';
  learnPanel.innerHTML = '<div class="panel-head"><span class="panel-title">Recent Learnings</span></div>';

  const learnBody = document.createElement('div');
  learnBody.className = 'panel-body';
  learnBody.innerHTML = '<div class="empty-state">Click an agent to browse their memory</div>';

  learnPanel.appendChild(learnBody);
  grid.appendChild(learnPanel);

  section.appendChild(grid);
  return section;
}
