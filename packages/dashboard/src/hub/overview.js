// packages/dashboard/src/hub/overview.js — Metric cards with icons

function renderOverviewSection(overview) {
  const { escapeHtml: e, makeSection } = window._dash;
  const section = makeSection('Overview');

  const grid = document.createElement('div');
  grid.className = 'metric-grid';

  const totalTasks = overview.tasksCompleted + overview.tasksFailed;
  const successPct = totalTasks > 0 ? Math.round(overview.tasksCompleted / totalTasks * 100) : 0;
  const agreePct = overview.totalSignals > 0 ? Math.round(overview.confirmedFindings / overview.totalSignals * 100) : 0;

  const cards = [
    {
      label: 'Agents', value: overview.agentsOnline,
      detail: '<strong style="color:var(--green)">' + overview.nativeCount + '</strong> native &middot; ' + overview.relayCount + ' relay',
      iconBg: 'rgba(167,139,250,0.08)', iconColor: 'var(--accent)',
      icon: '<rect x="6" y="4" width="12" height="9" rx="2"/><circle cx="9.5" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="9" r="1" fill="currentColor" stroke="none"/><path d="M9 16v2a2 2 0 002 2h2a2 2 0 002-2v-2"/><path d="M12 2v2"/>',
    },
    {
      label: 'Tasks', value: totalTasks,
      detail: totalTasks > 0
        ? '<strong style="color:var(--green)">' + successPct + '%</strong> success' + (overview.avgDurationMs > 0 ? ' &middot; ' + (overview.avgDurationMs / 1000).toFixed(1) + 's avg' : '')
        : 'No tasks yet',
      iconBg: 'rgba(52,211,153,0.08)', iconColor: 'var(--green)',
      icon: '<path d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12l2 2 4-4"/>',
    },
    {
      label: 'Consensus', value: overview.consensusRuns,
      detail: '<strong style="color:var(--green)">' + overview.confirmedFindings + '</strong> confirmed &middot; ' + (overview.totalFindings - overview.confirmedFindings) + ' other',
      iconBg: 'rgba(96,165,250,0.08)', iconColor: 'var(--blue)',
      icon: '<path d="M12 3v1"/><path d="M5 8l7-4 7 4"/><path d="M5 8v2a3 3 0 003 3"/><path d="M19 8v2a3 3 0 01-3 3"/><circle cx="8" cy="14.5" r="1.5"/><circle cx="16" cy="14.5" r="1.5"/><path d="M8 16v3h8v-3"/><path d="M12 13v6"/>',
    },
    {
      label: 'Signals', value: overview.totalSignals,
      detail: overview.totalSignals > 0
        ? '<strong style="color:var(--accent)">' + agreePct + '%</strong> agreement rate'
        : 'No signals yet',
      iconBg: 'rgba(167,139,250,0.08)', iconColor: 'var(--accent)',
      icon: '<path d="M2 12h3l3-9 4 18 3-9h3"/><circle cx="20" cy="12" r="1" fill="currentColor" stroke="none"/>',
    },
  ];

  for (const card of cards) {
    const mc = document.createElement('div');
    mc.className = 'mc';
    mc.innerHTML =
      '<div class="mc-row"><div>' +
        '<div class="mc-label">' + e(card.label) + '</div>' +
        '<div class="mc-val">' + card.value + '</div>' +
        '<div class="mc-detail">' + card.detail + '</div>' +
      '</div>' +
      '<div class="mc-icon" style="background:' + card.iconBg + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="' + card.iconColor + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + card.icon + '</svg>' +
      '</div></div>';
    grid.appendChild(mc);
  }

  section.appendChild(grid);
  return section;
}
