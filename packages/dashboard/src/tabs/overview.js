// packages/dashboard/src/tabs/overview.js

let _overviewEventHandler = null;

async function renderOverview() {
  if (_overviewEventHandler) {
    window._dash.offDashboardEvent(_overviewEventHandler);
    _overviewEventHandler = null;
  }

  const container = document.getElementById('tab-overview');
  container.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const [overview, agents, tasksData] = await Promise.all([
      window._dash.api('overview'),
      window._dash.api('agents'),
      window._dash.api('tasks'),
    ]);

    const successRate = overview.tasksCompleted + overview.tasksFailed > 0
      ? ((overview.tasksCompleted / (overview.tasksCompleted + overview.tasksFailed)) * 100).toFixed(0)
      : '—';

    container.innerHTML = `
      <div class="stat-cards">
        <div class="stat-card">
          <div class="label">Team</div>
          <div class="value">${overview.agentsOnline}</div>
          <div class="detail">${overview.relayCount} relay, ${overview.nativeCount} native</div>
        </div>
        <div class="stat-card">
          <div class="label">Tasks</div>
          <div class="value">${overview.tasksCompleted + overview.tasksFailed}</div>
          <div class="detail">${successRate}% success${overview.avgDurationMs > 0 ? ', ' + (overview.avgDurationMs / 1000).toFixed(1) + 's avg' : ''}</div>
        </div>
        <div class="stat-card">
          <div class="label">Consensus</div>
          <div class="value">${overview.totalSignals}</div>
          <div class="detail">${overview.consensusRuns} runs, ${overview.confirmedFindings} confirmed</div>
        </div>
      </div>

      <div class="panels">
        <div class="panel">
          <div class="panel-title">Agent Performance</div>
          <div id="agent-scores">
            ${agents.length === 0 ? '<div class="empty-state">No agents configured</div>' :
              agents
                .sort((a, b) => b.scores.dispatchWeight - a.scores.dispatchWeight)
                .map(a => {
                  const s = a.scores;
                  return `
                  <div class="agent-score-card">
                    <div class="agent-score-header">
                      <span class="agent-score-name">
                        ${escapeHtml(a.id)}
                        ${a.native ? '<span class="agent-badge">native</span>' : ''}
                      </span>
                      <span class="weight-badge">${s.dispatchWeight.toFixed(2)}</span>
                    </div>
                    <div class="agent-score-metrics">
                      <div class="metric">
                        <div class="metric-bar"><div class="bar-fill accuracy" style="width:${(s.accuracy * 100).toFixed(0)}%"></div></div>
                        <span class="metric-val">${(s.accuracy * 100).toFixed(0)}%</span>
                        <span class="metric-lbl">accuracy</span>
                      </div>
                      <div class="metric">
                        <div class="metric-bar"><div class="bar-fill uniqueness" style="width:${(s.uniqueness * 100).toFixed(0)}%"></div></div>
                        <span class="metric-val">${(s.uniqueness * 100).toFixed(0)}%</span>
                        <span class="metric-lbl">unique</span>
                      </div>
                    </div>
                    <div class="agent-score-stats">
                      <span>${s.signals} signals</span>
                      <span>${s.agreements} agrees</span>
                      <span>${s.disagreements} disagrees</span>
                      ${s.hallucinations > 0 ? `<span class="halluc">${s.hallucinations} halluc.</span>` : ''}
                    </div>
                  </div>`;
                }).join('')}
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">Recent Activity</div>
          <div id="activity-timeline" class="timeline">
            ${tasksData.tasks.length === 0
              ? '<div class="empty-state">No tasks yet</div>'
              : tasksData.tasks.slice(0, 20).map(t => {
                  const time = new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                  const color = t.status === 'completed' ? 'green' : t.status === 'failed' ? 'red' : 'purple';
                  const dur = t.duration > 0 ? ` (${(t.duration / 1000).toFixed(1)}s)` : '';
                  // Extract first sentence or truncate cleanly
                  const desc = t.task.replace(/\n.*/s, '').slice(0, 60);
                  return `<div class="timeline-entry">
                    <div class="timeline-dot ${color}"></div>
                    <div class="timeline-time">${time}</div>
                    <div class="timeline-text"><span class="timeline-agent">${escapeHtml(t.agentId)}</span>${dur} — ${escapeHtml(desc)}</div>
                  </div>`;
                }).join('')}
          </div>
        </div>
      </div>
    `;

    // Wire up live WebSocket events
    const timeline = document.getElementById('activity-timeline');
    _overviewEventHandler = (event) => {
      const colors = {
        task_completed: 'green', consensus_complete: 'green',
        task_dispatched: 'purple', agent_connected: 'purple', agent_disconnected: 'purple',
        skill_changed: 'yellow', consensus_started: 'yellow',
        task_failed: 'red',
      };
      const time = new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const color = colors[event.type] || 'purple';
      const text = formatEvent(event);
      const entry = document.createElement('div');
      entry.className = 'timeline-entry';
      entry.innerHTML = `
        <div class="timeline-dot ${color}"></div>
        <div class="timeline-time">${time}</div>
        <div class="timeline-text"></div>
      `;
      entry.querySelector('.timeline-text').textContent = text;
      // Remove "No tasks yet" placeholder
      const placeholder = timeline.querySelector('.empty-state');
      if (placeholder) placeholder.remove();
      timeline.prepend(entry);
      while (timeline.children.length > 100) timeline.removeChild(timeline.lastChild);
    };
    window._dash.onDashboardEvent(_overviewEventHandler);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function formatEvent(event) {
  const d = event.data || {};
  switch (event.type) {
    case 'task_dispatched': return `Task dispatched to ${d.agentId || '?'}`;
    case 'task_completed': return `Task completed by ${d.agentId || '?'}`;
    case 'task_failed': return `Task failed on ${d.agentId || '?'}`;
    case 'consensus_started': return `Consensus started (${d.agentCount || '?'} agents)`;
    case 'consensus_complete': return `Consensus complete — ${d.confirmed || 0} confirmed`;
    case 'agent_connected': return `${d.agentId || '?'} connected`;
    case 'agent_disconnected': return `${d.agentId || '?'} disconnected`;
    case 'skill_changed': return `Skill ${d.skill || '?'} toggled for ${d.agentId || '?'}`;
    default: return event.type;
  }
}
