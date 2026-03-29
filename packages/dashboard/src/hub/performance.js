// packages/dashboard/src/hub/performance.js — SVG charts (task volume + agent accuracy)

function renderPerformanceSection(tasksData, agents) {
  const { makeSection } = window._dash;
  const section = makeSection('Performance', 'last 7 days');

  const grid = document.createElement('div');
  grid.className = 'chart-grid';

  // ── Task Volume (area chart) ───────────────────
  const volCard = document.createElement('div');
  volCard.className = 'chart-card';

  // Bucket tasks by day
  const dayBuckets = {};
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toDateString();
    dayBuckets[key] = { label: d.toLocaleDateString([], { weekday: 'short' }), value: 0, failed: 0 };
  }

  for (const t of (tasksData.tasks || [])) {
    if (!t.timestamp) continue;
    const key = new Date(t.timestamp).toDateString();
    if (dayBuckets[key]) {
      if (t.status === 'completed') dayBuckets[key].value++;
      else if (t.status === 'failed') dayBuckets[key].failed++;
    }
  }

  const chartData = Object.values(dayBuckets);
  // Replace today's label
  if (chartData.length > 0) chartData[chartData.length - 1].label = 'Today';

  volCard.innerHTML =
    '<div class="chart-head">' +
      '<span class="chart-title">Task Volume</span>' +
      '<div class="chart-legend">' +
        '<span><span class="lg-dot" style="background:var(--green)"></span>OK</span>' +
        '<span><span class="lg-dot" style="background:var(--red)"></span>Failed</span>' +
      '</div>' +
    '</div>' + renderAreaChart(chartData);

  grid.appendChild(volCard);

  // ── Agent Accuracy (bar chart) ─────────────────
  const accCard = document.createElement('div');
  accCard.className = 'chart-card';

  const activeAgents = agents
    .filter(a => a.scores && a.scores.signals > 0)
    .sort((a, b) => b.scores.accuracy - a.scores.accuracy)
    .slice(0, 6);

  const barData = activeAgents.map(a => ({
    label: a.id.length > 12 ? a.id.slice(0, 11) + '.' : a.id,
    value: Math.round(a.scores.accuracy * 100),
    secondary: Math.round(a.scores.uniqueness * 100),
  }));

  accCard.innerHTML =
    '<div class="chart-head">' +
      '<span class="chart-title">Agent Accuracy</span>' +
      '<div class="chart-legend">' +
        '<span><span class="lg-dot" style="background:var(--accent)"></span>Accuracy</span>' +
        '<span><span class="lg-dot" style="background:var(--blue);opacity:0.5"></span>Unique</span>' +
      '</div>' +
    '</div>' + (barData.length > 0 ? renderBarChart(barData) : '<div class="empty-state">No agent data yet</div>');

  grid.appendChild(accCard);

  section.appendChild(grid);
  return section;
}
