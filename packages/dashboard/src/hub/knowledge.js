// packages/dashboard/src/hub/knowledge.js — Agent knowledge overview cards

function renderKnowledgeSection(agents, knowledgeData) {
  const { escapeHtml: e, navigate, makeSection, timeAgo, agentInitials } = window._dash;
  const section = makeSection('Knowledge', agents.length + ' agents');

  const grid = document.createElement('div');
  grid.className = 'know-grid';

  // Project shared memory first
  const projCard = document.createElement('button');
  projCard.className = 'know-card';
  projCard.addEventListener('click', () => navigate('#/knowledge/_project'));
  projCard.innerHTML =
    '<div class="know-card-initials" style="color:var(--accent)">P</div>' +
    '<span class="know-card-name">_project</span>' +
    '<span class="know-card-desc">Shared team memory</span>';
  grid.appendChild(projCard);

  const sorted = [...agents].sort((a, b) =>
    (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0)
  );

  for (const agent of sorted) {
    const card = document.createElement('button');
    card.className = 'know-card';
    card.addEventListener('click', () => navigate('#/knowledge/' + encodeURIComponent(agent.id)));

    const signals = agent.scores?.signals ?? 0;
    const w = agent.scores?.dispatchWeight ?? 1;
    const preset = agent.preset || '';
    const color = signals === 0 ? 'var(--text-3)'
      : w >= 1.5 ? 'var(--green)'
      : w >= 0.8 ? 'var(--amber)'
      : 'var(--red)';

    card.innerHTML =
      '<div class="know-card-initials" style="color:' + color + '">' + agentInitials(agent.id) + '</div>' +
      '<span class="know-card-name">' + e(agent.id) + '</span>' +
      '<span class="know-card-desc">' + e(preset) + (signals > 0 ? ' &middot; ' + signals + ' signals' : '') + '</span>';
    grid.appendChild(card);
  }

  section.appendChild(grid);
  return section;
}
