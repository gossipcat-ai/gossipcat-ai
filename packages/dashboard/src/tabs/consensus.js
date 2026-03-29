// packages/dashboard/src/tabs/consensus.js

async function renderConsensus() {
  const container = document.getElementById('tab-consensus');
  container.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const data = await window._dash.api('consensus');

    if (data.runs.length === 0) {
      container.innerHTML = '<div class="empty-state">No consensus runs yet. Run gossip_dispatch_consensus to generate data.</div>';
      return;
    }

    container.innerHTML = `
      <div class="stat-cards" style="margin-bottom:1.5rem">
        <div class="stat-card">
          <div class="label">Runs</div>
          <div class="value">${data.runs.length}</div>
        </div>
        <div class="stat-card">
          <div class="label">Signals</div>
          <div class="value">${data.totalSignals}</div>
        </div>
      </div>
      <div class="consensus-runs">${data.runs.map(renderConsensusRun).join('')}</div>
    `;

    container.querySelectorAll('.consensus-run-header').forEach(header => {
      header.addEventListener('click', () => {
        const body = header.nextElementSibling;
        body.hidden = !body.hidden;
        header.querySelector('.expand-icon').textContent = body.hidden ? '+' : '-';
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderConsensusRun(run) {
  const c = run.counts;
  const time = new Date(run.timestamp).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const total = c.agreement + c.disagreement + c.unverified + c.unique + c.hallucination + c.new;

  const signalRows = run.signals.map(s => {
    const colorClass = {
      agreement: 'confirmed', disagreement: 'disputed',
      unverified: 'unverified', unique_confirmed: 'confirmed',
      unique_unconfirmed: 'unique', hallucination_caught: 'disputed',
      new_finding: 'new', consensus_verified: 'confirmed',
      category_confirmed: 'confirmed',
    }[s.signal] || 'unique';

    return `
      <div class="consensus-signal">
        <span class="consensus-tag ${colorClass}">${escapeHtml(s.signal.replace(/_/g, ' '))}</span>
        <span class="consensus-agent">${escapeHtml(s.agentId)}</span>
        ${s.counterpartId ? `<span class="consensus-arrow">&rarr;</span><span class="consensus-agent">${escapeHtml(s.counterpartId)}</span>` : ''}
        ${s.evidence ? `<div class="consensus-evidence">${escapeHtml(s.evidence.slice(0, 200))}${s.evidence.length > 200 ? '...' : ''}</div>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="consensus-run">
      <div class="consensus-run-header">
        <span class="expand-icon">+</span>
        <div class="consensus-run-info">
          <span class="consensus-task-id">${escapeHtml(run.taskId)}</span>
          <span class="consensus-meta">${run.agents.length} agents &middot; ${total} signals &middot; ${time}</span>
        </div>
        <div class="consensus-counts">
          ${c.agreement ? `<span class="consensus-tag confirmed">${c.agreement}</span>` : ''}
          ${c.disagreement ? `<span class="consensus-tag disputed">${c.disagreement}</span>` : ''}
          ${c.unverified ? `<span class="consensus-tag unverified">${c.unverified}</span>` : ''}
          ${c.hallucination ? `<span class="consensus-tag disputed">${c.hallucination} H</span>` : ''}
        </div>
      </div>
      <div class="consensus-run-body" hidden>${signalRows}</div>
    </div>`;
}
