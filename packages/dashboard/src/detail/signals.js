// packages/dashboard/src/detail/signals.js — Full signal feed with type/agent filters

async function renderSignalsDetail(app) {
  const { api, escapeHtml: e, makeSection, timeAgo } = window._dash;
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

    // Sparkline: group by day, show positive vs negative trend
    const byDay = new Map();
    for (const s of (data.signals || [])) {
      const day = (s.timestamp || '').slice(0, 10);
      if (!day) continue;
      const d = byDay.get(day) || { pos: 0, neg: 0 };
      if (['agreement', 'unique_confirmed', 'new_finding', 'consensus_verified'].includes(s.signal)) d.pos++;
      else if (['disagreement', 'hallucination_caught'].includes(s.signal)) d.neg++;
      byDay.set(day, d);
    }

    if (byDay.size > 1) {
      const spark = document.createElement('div');
      spark.className = 'signal-sparkline';
      const maxCount = Math.max(...[...byDay.values()].map(d => d.pos + d.neg), 1);
      let sparkHtml = '';
      for (const [day, counts] of [...byDay.entries()].sort().slice(-14)) {
        const posH = (counts.pos / maxCount) * 24;
        const negH = (counts.neg / maxCount) * 24;
        sparkHtml += '<div class="spark-col" title="' + day + ': +' + counts.pos + ' -' + counts.neg + '">' +
          '<div class="spark-pos" style="height:' + posH + 'px"></div>' +
          '<div class="spark-neg" style="height:' + negH + 'px"></div>' +
        '</div>';
      }
      spark.innerHTML = sparkHtml;
      section.appendChild(spark);
    }

    const list = document.createElement('div');
    list.className = 'run-list';
    section.appendChild(list);

    function tagClass(signal) {
      if ((signal || '').includes('agreement')) return 'tag-g';
      if ((signal || '').includes('hallucination')) return 'tag-r';
      if ((signal || '').includes('disagree')) return 'tag-r';
      if ((signal || '').includes('unique')) return 'tag-b';
      return 'tag-b';
    }

    function renderRows() {
      list.innerHTML = '';
      const filtered = (data.signals || []).filter(s => {
        if (activeType === 'all') return true;
        return (s.signal || '').includes(activeType);
      });

      if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state">No matching signals</div>';
        return;
      }

      const panel = document.createElement('div');
      panel.className = 'panel';
      const body = document.createElement('div');
      body.className = 'panel-body run-findings';
      body.style.maxHeight = '600px';

      for (const s of filtered) {
        const typeLabel = (s.signal || '').replace(/_/g, ' ').replace(/caught$/, '').trim().toUpperCase();
        const tc = tagClass(s.signal);
        const finding = e((s.evidence || s.finding || '').slice(0, 160));
        const agentPart = e(s.agentId || '');
        const counterPart = s.counterpartId ? ' → ' + e(s.counterpartId) : '';
        const time = s.timestamp ? timeAgo(s.timestamp) : '';
        const attrText = agentPart + counterPart + (time ? ' · ' + time : '');

        const row = document.createElement('div');
        row.className = 'finding-row';
        row.innerHTML =
          '<span class="finding-tag ' + tc + '">' + e(typeLabel) + '</span>' +
          '<div class="finding-body">' +
            '<div class="finding-text">' + finding + '</div>' +
            '<div class="finding-attr">' + attrText + '</div>' +
          '</div>';
        body.appendChild(row);
      }

      panel.appendChild(body);
      list.appendChild(panel);
    }

    renderRows();
    app.appendChild(section);
  } catch (err) {
    app.innerHTML = '<div class="empty-state">Failed to load signals: ' + e(err.message) + '</div>';
  }
}
