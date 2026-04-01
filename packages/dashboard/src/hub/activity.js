// packages/dashboard/src/hub/activity.js — Consensus run timeline with expandable findings

function renderActivitySection(consensusData) {
  const { escapeHtml: e, navigate, makeSection, timeAgo, agentInitials } = window._dash;
  // Handle both old signature (3 args) and new (1 arg)
  if (arguments.length === 3) consensusData = arguments[1];

  const runs = consensusData.runs || [];
  const section = makeSection('Recent Runs', runs.length + ' runs', 'all signals →', '#/signals');

  const list = document.createElement('div');
  list.className = 'run-list';

  if (runs.length === 0) {
    list.innerHTML = '<div class="empty-state">No consensus runs yet. Dispatch agents with gossip_dispatch_consensus.</div>';
    section.appendChild(list);
    return section;
  }

  for (const run of runs.slice(0, 10)) {
    const card = document.createElement('div');
    card.className = 'run-card';

    const c = run.counts || {};
    const total = (c.agreement || 0) + (c.disagreement || 0) + (c.hallucination || 0) + (c.unverified || 0) + (c.unique || 0) + (c.new || 0);

    const pills = [];
    if (c.agreement) pills.push('<span class="pill pill-g pill-filter" data-filter="confirmed">' + c.agreement + ' confirmed</span>');
    if (c.disagreement || c.hallucination) pills.push('<span class="pill pill-r pill-filter" data-filter="disputed">' + ((c.disagreement || 0) + (c.hallucination || 0)) + ' disputed</span>');
    if (c.unverified) pills.push('<span class="pill pill-y pill-filter" data-filter="unverified">' + c.unverified + ' unverified</span>');
    if (c.unique) pills.push('<span class="pill pill-b pill-filter" data-filter="unique">' + c.unique + ' unique</span>');
    if (c.new > 0) pills.push('<span class="pill pill-b pill-filter" data-filter="new">' + c.new + ' new</span>');

    const segments = [];
    if (total > 0) {
      if (c.agreement) segments.push('<div class="bar-seg bar-seg-g" style="width:' + ((c.agreement / total) * 100) + '%"></div>');
      if (c.disagreement || c.hallucination) segments.push('<div class="bar-seg bar-seg-r" style="width:' + (((c.disagreement || 0) + (c.hallucination || 0)) / total * 100) + '%"></div>');
      if (c.unverified) segments.push('<div class="bar-seg bar-seg-y" style="width:' + ((c.unverified / total) * 100) + '%"></div>');
      if (c.unique) segments.push('<div class="bar-seg bar-seg-b" style="width:' + ((c.unique / total) * 100) + '%"></div>');
      if (c.new) segments.push('<div class="bar-seg bar-seg-b" style="width:' + ((c.new / total) * 100) + '%"></div>');
    }
    const barHtml = segments.length > 0 ? '<div class="run-bar">' + segments.join('') + '</div>' : '';

    const agentChips = run.agents.slice(0, 4).map(a =>
      '<span class="run-agent-chip">' + agentInitials(a) + '</span>'
    ).join('');
    const moreAgents = run.agents.length > 4 ? '<span class="run-agent-more">+' + (run.agents.length - 4) + '</span>' : '';

    const header = document.createElement('div');
    header.className = 'run-header';
    header.innerHTML =
      '<div class="run-top">' +
        '<span class="run-expand">&#8250;</span>' +
        '<span class="run-title">' + total + ' findings</span>' +
        '<span class="run-agents">' + agentChips + moreAgents + '</span>' +
        '<span class="run-time">' + timeAgo(run.timestamp) + '</span>' +
      '</div>' +
      '<div class="run-pills">' + pills.join('') + '</div>' +
      barHtml;

    const findings = document.createElement('div');
    findings.className = 'run-findings';
    findings.hidden = true;

    for (const sig of run.signals) {
      if (sig.signal === 'signal_retracted') continue;
      let tag = '', tagClass = '';
      if (sig.signal === 'agreement' || sig.signal === 'consensus_verified') { tag = 'CONFIRMED'; tagClass = 'tag-g'; }
      else if (sig.signal === 'disagreement' || sig.signal === 'hallucination_caught') { tag = 'DISPUTED'; tagClass = 'tag-r'; }
      else if (sig.signal === 'unverified') { tag = 'UNVERIFIED'; tagClass = 'tag-y'; }
      else if (sig.signal === 'unique_confirmed') { tag = 'UNIQUE'; tagClass = 'tag-u'; }
      else if (sig.signal === 'unique_unconfirmed') { tag = 'UNIQUE'; tagClass = 'tag-u'; }
      else if (sig.signal === 'new_finding') { tag = 'NEW'; tagClass = 'tag-b'; }
      else continue;

      const evidence = e((sig.evidence || '').slice(0, 200));
      const attribution = sig.counterpartId
        ? e(sig.agentId) + ' & ' + e(sig.counterpartId)
        : e(sig.agentId);

      const row = document.createElement('div');
      row.className = 'finding-row';
      row.innerHTML =
        '<span class="finding-tag ' + tagClass + '">' + tag + '</span>' +
        '<div class="finding-body">' +
          '<div class="finding-text">' + evidence + '</div>' +
          '<div class="finding-attr">' + attribution + '</div>' +
        '</div>';
      findings.appendChild(row);
    }

    header.addEventListener('click', (evt) => {
      // If clicking a filter pill, filter findings instead of toggling
      const filterPill = evt.target.closest('.pill-filter');
      if (filterPill) {
        evt.stopPropagation();
        const filterType = filterPill.dataset.filter;
        // Ensure findings are visible
        findings.hidden = false;
        header.querySelector('.run-expand').innerHTML = '&#8964;';
        card.classList.add('run-open');
        // Toggle: if same filter clicked again, show all
        const isActive = filterPill.classList.contains('pill-active');
        card.querySelectorAll('.pill-filter').forEach(p => p.classList.remove('pill-active'));
        if (isActive) {
          // Show all
          findings.querySelectorAll('.finding-row').forEach(r => { r.hidden = false; });
        } else {
          filterPill.classList.add('pill-active');
          findings.querySelectorAll('.finding-row').forEach(r => {
            const tag = r.querySelector('.finding-tag');
            if (!tag) { r.hidden = true; return; }
            const tagText = tag.textContent.toLowerCase();
            r.hidden = !tagText.includes(filterType);
          });
        }
        return;
      }
      const isOpen = !findings.hidden;
      findings.hidden = isOpen;
      header.querySelector('.run-expand').innerHTML = isOpen ? '&#8250;' : '&#8964;';
      card.classList.toggle('run-open', !isOpen);
    });

    card.appendChild(header);
    card.appendChild(findings);
    list.appendChild(card);
  }

  section.appendChild(list);
  return section;
}
