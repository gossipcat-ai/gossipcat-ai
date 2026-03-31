// packages/dashboard/src/hub/knowledge.js — Agent knowledge overview cards

function renderKnowledgeSection(agents, knowledgeData) {
  const { escapeHtml: e, navigate, makeSection, timeAgo } = window._dash;
  const section = makeSection('Knowledge', agents.length + ' agents');

  const grid = document.createElement('div');
  grid.className = 'know-grid';

  // Project shared memory first
  const projCard = document.createElement('button');
  projCard.className = 'know-card';
  projCard.addEventListener('click', () => navigate('#/knowledge/_project'));
  projCard.innerHTML =
    '<div class="know-card-icon">&#128218;</div>' +
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
    const accuracy = agent.scores?.accuracy ?? 0.5;
    const preset = agent.preset || '';

    card.innerHTML =
      '<div class="know-card-icon">' + (signals > 0 ? '&#129302;' : '&#128564;') + '</div>' +
      '<span class="know-card-name">' + e(agent.id) + '</span>' +
      '<span class="know-card-desc">' + e(preset) + (signals > 0 ? ' &middot; ' + signals + ' signals' : ' &middot; no activity') + '</span>';
    grid.appendChild(card);
  }

  section.appendChild(grid);
  return section;
}
