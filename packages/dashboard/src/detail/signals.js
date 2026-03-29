// packages/dashboard/src/detail/signals.js — Full signal feed with type/agent filters

async function renderSignalsDetail(app) {
  const { api, escapeHtml: e, makeSection } = window._dash;
  app.innerHTML = '<div class="loading">Loading signals...</div>';

  try {
    const data = await api('signals');
    app.innerHTML = '';

    const section = makeSection('Signals', data.total + ' total');

    // Type filters
    const filters = document.createElement('div');
    filters.className = 'filters';
    const types = ['all', 'agreement', 'disagreement', 'unique', 'hallucination'];
    let activeType = 'all';

    for (const t of types) {
      const btn = document.createElement('button');
      btn.className = 'filter-btn' + (t === 'all' ? ' active' : '');
      btn.textContent = t === 'hallucination' ? 'halluc.' : t;
      btn.addEventListener('click', () => {
        activeType = t;
        filters.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderRows();
      });
      filters.appendChild(btn);
    }
    section.appendChild(filters);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = '<div class="panel-body" style="max-height:600px"></div>';
    const body = panel.querySelector('.panel-body');
    section.appendChild(panel);

    function renderRows() {
      body.innerHTML = '';
      const filtered = (data.signals || []).filter(s => {
        if (activeType === 'all') return true;
        return (s.signal || '').includes(activeType);
      });

      if (filtered.length === 0) {
        body.innerHTML = '<div class="empty-state">No matching signals</div>';
        return;
      }

      for (const s of filtered) {
        const typeClass = (s.signal || '').includes('agreement') ? 'agreement'
          : (s.signal || '').includes('hallucination') ? 'hallucination'
          : (s.signal || '').includes('unique') ? 'unique'
          : (s.signal || '').includes('disagree') ? 'disagreement' : 'unique';
        const typeLabel = (s.signal || '').replace(/_/g, ' ').replace(/caught$/, '').trim();
        const finding = e((s.evidence || s.finding || '').slice(0, 120));
        const arrow = s.counterpartId ? '<span class="sig-arrow">→</span><span class="sig-agent">' + e(s.counterpartId) + '</span>' : '';
        const time = s.timestamp ? new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

        const row = document.createElement('div');
        row.className = 'sig-row';
        row.innerHTML =
          '<span class="fr-time">' + time + '</span>' +
          '<span class="sig-type ' + typeClass + '">' + e(typeLabel) + '</span>' +
          '<span class="sig-agent">' + e(s.agentId || '') + '</span>' +
          arrow +
          '<span class="sig-finding">' + finding + '</span>';
        body.appendChild(row);
      }
    }

    renderRows();
    app.appendChild(section);
  } catch (err) {
    app.innerHTML = '<div class="empty-state">Failed to load signals: ' + e(err.message) + '</div>';
  }
}
