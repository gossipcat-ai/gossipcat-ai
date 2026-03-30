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
    if (c.agreement) pills.push('<span class="pill pill-g">' + c.agreement + ' confirmed</span>');
    if (c.disagreement || c.hallucination) pills.push('<span class="pill pill-r">' + ((c.disagreement || 0) + (c.hallucination || 0)) + ' disputed</span>');
    if (c.unverified) pills.push('<span class="pill pill-y">' + c.unverified + ' unverified</span>');
    if (c.unique) pills.push('<span class="pill pill-b">' + c.unique + ' unique</span>');

    const agentChips = run.agents.slice(0, 4).map(a =>
      '<span class="run-agent-chip">' + agentInitials(a) + '</span>'
    ).join('');
    const moreAgents = run.agents.length > 4 ? '<span class="run-agent-more">+' + (run.agents.length - 4) + '</span>' : '';

    const header = document.createElement('div');
    header.className = 'run-header';
    header.innerHTML =
      '<div class="run-top">' +
        '<span class="run-expand">&#9654;</span>' +
        '<span class="run-title">' + total + ' findings</span>' +
        '<span class="run-agents">' + agentChips + moreAgents + '</span>' +
        '<span class="run-time">' + timeAgo(run.timestamp) + '</span>' +
      '</div>' +
      '<div class="run-pills">' + pills.join('') + '</div>';

    const findings = document.createElement('div');
    findings.className = 'run-findings';
    findings.hidden = true;

    for (const sig of run.signals) {
      if (sig.signal === 'signal_retracted') continue;
      let tag = '', tagClass = '';
      if (sig.signal === 'agreement' || sig.signal === 'unique_confirmed') { tag = 'CONFIRMED'; tagClass = 'tag-g'; }
      else if (sig.signal === 'disagreement' || sig.signal === 'hallucination_caught') { tag = 'DISPUTED'; tagClass = 'tag-r'; }
      else if (sig.signal === 'unverified' || sig.signal === 'unique_unconfirmed') { tag = 'UNVERIFIED'; tagClass = 'tag-y'; }
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

    header.addEventListener('click', () => {
      const isOpen = !findings.hidden;
      findings.hidden = isOpen;
      header.querySelector('.run-expand').innerHTML = isOpen ? '&#9654;' : '&#9660;';
      card.classList.toggle('run-open', !isOpen);
    });

    card.appendChild(header);
    card.appendChild(findings);
    list.appendChild(card);
  }

  section.appendChild(list);
  return section;
}
