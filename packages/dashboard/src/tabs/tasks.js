// packages/dashboard/src/tabs/tasks.js

async function renderTasks() {
  const container = document.getElementById('tab-tasks');
  container.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const data = await window._dash.api('tasks');

    if (data.tasks.length === 0) {
      container.innerHTML = '<div class="empty-state">No tasks yet. Dispatch agents to generate task history.</div>';
      return;
    }

    container.innerHTML = `
      <div class="panel" style="margin-bottom:1rem">
        <div class="panel-title">Task History (${data.total} total, showing last ${data.tasks.length})</div>
        <div class="tasks-list">
          ${data.tasks.map(t => {
            const time = new Date(t.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const dur = t.duration > 0 ? `${(t.duration / 1000).toFixed(1)}s` : '—';
            const statusCls = t.status === 'completed' ? 'confirmed' : t.status === 'failed' ? 'disputed' : 'unverified';
            return `
              <div class="task-row">
                <span class="task-status ${statusCls}">${t.status}</span>
                <span class="task-agent">${escapeHtml(t.agentId)}</span>
                <span class="task-dur">${dur}</span>
                <span class="task-time">${time}</span>
                <span class="task-desc">${escapeHtml(t.task)}</span>
              </div>`;
          }).join('')}
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}
