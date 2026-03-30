// packages/dashboard/src/hub/team.js — Agent cards (3 + overflow)

function renderTeamSection(agents) {
  const { escapeHtml: e, navigate, formatTokens, agentInitials, agentColor, makeSection } = window._dash;
  const section = makeSection('Team', agents.length + ' agents', 'manage →', '#/team');

  if (agents.length === 0) {
    section.innerHTML += '<div class="empty-state">No agents configured. Run gossip_setup to create your team.</div>';
    return section;
  }

  const grid = document.createElement('div');
  grid.className = 'agent-grid';

  // Sort by dispatch weight descending, show top 3
  const sorted = [...agents].sort((a, b) => (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0));
  const shown = sorted.slice(0, 3);
  const overflow = sorted.slice(3);

  for (const agent of shown) {
    const s = agent.scores || {};
    const isIdle = !agent.online && s.signals === 0;
    const color = agentColor(agent);

    const card = document.createElement('button');
    card.className = 'ag' + (isIdle ? ' idle' : '');
    card.style.setProperty('--card-color', color);
    card.setAttribute('role', 'link');
    card.setAttribute('aria-label', 'View ' + agent.id);
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
      '</div>' +
      '<div class="ag-status" style="color:' + statusColor + '">' +
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

  // Overflow card
  if (overflow.length > 0) {
    const more = document.createElement('button');
    more.className = 'ag-more';
    more.setAttribute('role', 'link');
    more.setAttribute('aria-label', 'View all agents');
    more.addEventListener('click', () => navigate('#/team'));

    const avatars = overflow.slice(0, 4).map(a => {
      const c = agentColor(a);
      return '<div class="ag-more-pip" style="background:' + c.replace('var(--', 'rgba(').replace(')', ',0.12)') + ';color:' + c + '">' + agentInitials(a.id) + '</div>';
    }).join('');

    const names = overflow.map(a => {
      return '<div class="ag-more-name">' + e(a.id) + '</div>';
    }).join('');

    more.innerHTML =
      '<div class="ag-more-avatars">' + avatars + '</div>' +
      '<div class="ag-more-names">' + names + '</div>' +
      '<div class="ag-more-count">+' + overflow.length + '</div>' +
      '<div class="ag-more-label">more agents</div>';

    grid.appendChild(more);
  }

  section.appendChild(grid);
  return section;
}
