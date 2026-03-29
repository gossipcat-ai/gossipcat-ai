// packages/dashboard/src/tabs/agents.js

async function renderAgents() {
  const container = document.getElementById('tab-agents');
  container.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const agents = await window._dash.api('agents');

    if (agents.length === 0) {
      container.innerHTML = '<div class="empty-state">No agents configured. Run gossip_setup to create your team.</div>';
      return;
    }

    container.innerHTML = `<div class="agent-cards">${agents.map(renderAgentCard).join('')}</div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderAgentCard(agent) {
  const s = agent.scores;
  const totalTasks = s.agreements + s.disagreements + s.hallucinations;

  return `
    <div class="agent-detail-card">
      <div class="agent-header">
        <div>
          <div class="agent-title">
            <strong>${escapeHtml(agent.id)}</strong>
            ${agent.native ? '<span class="agent-badge">native</span>' : '<span class="agent-badge relay">relay</span>'}
          </div>
          <div class="agent-meta">${escapeHtml(agent.provider)} / ${escapeHtml(agent.model)}${agent.preset ? ` &middot; ${escapeHtml(agent.preset)}` : ''}</div>
        </div>
        <div class="weight-badge lg">${s.dispatchWeight.toFixed(2)}</div>
      </div>

      <div class="agent-metrics-grid">
        <div class="agent-metric-card">
          <div class="agent-metric-ring accuracy" style="--pct:${(s.accuracy * 100).toFixed(0)}">
            <span>${(s.accuracy * 100).toFixed(0)}%</span>
          </div>
          <div class="agent-metric-label">Accuracy</div>
        </div>
        <div class="agent-metric-card">
          <div class="agent-metric-ring uniqueness" style="--pct:${(s.uniqueness * 100).toFixed(0)}">
            <span>${(s.uniqueness * 100).toFixed(0)}%</span>
          </div>
          <div class="agent-metric-label">Uniqueness</div>
        </div>
        <div class="agent-metric-card">
          <div class="agent-metric-ring reliability" style="--pct:${(s.reliability * 100).toFixed(0)}">
            <span>${(s.reliability * 100).toFixed(0)}%</span>
          </div>
          <div class="agent-metric-label">Reliability</div>
        </div>
      </div>

      <div class="agent-signal-row">
        <div class="agent-signal"><span class="signal-num">${s.signals}</span> signals</div>
        <div class="agent-signal good"><span class="signal-num">${s.agreements}</span> agrees</div>
        <div class="agent-signal bad"><span class="signal-num">${s.disagreements}</span> disagrees</div>
        <div class="agent-signal ${s.hallucinations > 0 ? 'warn' : ''}"><span class="signal-num">${s.hallucinations}</span> halluc.</div>
      </div>

      ${agent.skills.length > 0 ? `
        <div class="agent-skills-row">
          ${agent.skills.map(sk => `<span class="agent-badge skill">${escapeHtml(sk)}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}
