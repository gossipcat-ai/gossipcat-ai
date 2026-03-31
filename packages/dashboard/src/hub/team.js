// packages/dashboard/src/hub/team.js — Trust ring agent cards

function renderTeamSection(agents) {
  const { escapeHtml: e, navigate, makeSection, timeAgo, agentInitials } = window._dash;
  const section = makeSection('Team', agents.length + ' agents', 'all agents →', '#/team');

  const grid = document.createElement('div');
  grid.className = 'agent-grid';

  // Sort by dispatch weight descending
  const sorted = [...agents].sort((a, b) =>
    (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0)
  );

  const show = sorted.slice(0, 6);
  const rest = sorted.length - show.length;

  for (const agent of show) {
    const btn = document.createElement('button');
    btn.className = 'ag';
    btn.addEventListener('click', () => navigate('#/team/' + encodeURIComponent(agent.id)));

    const w = agent.scores?.dispatchWeight ?? 1;
    const signals = agent.scores?.signals ?? 0;
    const accuracy = agent.scores?.accuracy ?? 0.5;
    const reliability = agent.scores?.reliability ?? 0.5;
    const uniqueness = agent.scores?.uniqueness ?? 0.5;
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
      '<div class="ag-stats">' +
        '<div class="ag-stat"><span class="ag-stat-label">acc</span><div class="ag-stat-bar"><div class="ag-stat-fill" style="width:' + (accuracy * 100) + '%;background:' + ringColor + '"></div></div></div>' +
        '<div class="ag-stat"><span class="ag-stat-label">rel</span><div class="ag-stat-bar"><div class="ag-stat-fill" style="width:' + (reliability * 100) + '%;background:' + ringColor + '"></div></div></div>' +
        '<div class="ag-stat"><span class="ag-stat-label">uniq</span><div class="ag-stat-bar"><div class="ag-stat-fill" style="width:' + (uniqueness * 100) + '%;background:' + ringColor + '"></div></div></div>' +
      '</div>' +
      '<span class="ag-last">' + lastText +
        (lastTime ? ' <span class="ag-time">' + lastTime + '</span>' : '') +
      '</span>';

    grid.appendChild(btn);
  }

  if (rest > 0) {
    const more = document.createElement('button');
    more.className = 'ag ag-overflow';
    more.addEventListener('click', () => navigate('#/team'));
    more.innerHTML = '<span class="ag-more-count">+' + rest + '</span><span class="ag-more-label">more</span>';
    grid.appendChild(more);
  }

  section.appendChild(grid);
  return section;
}
