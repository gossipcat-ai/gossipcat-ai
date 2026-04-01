// packages/dashboard/src/detail/consensus.js — Single consensus run detail

const CONSENSUS_GRID = '110px 1fr 140px 140px';

function consensusTagClass(signal) {
  const s = signal || '';
  if (s === 'agreement' || s === 'unique_confirmed') return 'tag-g';
  if (s === 'disagreement' || s === 'hallucination_caught') return 'tag-r';
  if (s === 'unique_unconfirmed') return 'tag-u';
  if (s === 'unverified') return 'tag-y';
  return 'tag-b';
}

function consensusTagLabel(signal) {
  const labels = {
    agreement:           'CONFIRMED',
    unique_confirmed:    'CONFIRMED',
    disagreement:        'DISPUTED',
    hallucination_caught:'DISPUTED',
    unverified:          'UNVERIFIED',
    unique_unconfirmed:  'UNIQUE',
    new_finding:         'NEW',
  };
  return labels[signal] || (signal || '').replace(/_/g, ' ').toUpperCase();
}

function consensusDisplayCategory(signal) {
  const s = signal || '';
  if (s === 'agreement' || s === 'unique_confirmed') return 'CONFIRMED';
  if (s === 'disagreement' || s === 'hallucination_caught') return 'DISPUTED';
  if (s === 'unverified') return 'UNVERIFIED';
  if (s === 'unique_unconfirmed') return 'UNIQUE';
  if (s === 'new_finding') return 'NEW';
  return 'OTHER';
}

async function renderConsensusDetail(app, taskId) {
  const { api, escapeHtml: e, makeSection } = window._dash;
  const { createDataView, createDataRow, createExpansionManager,
          createEmptyState, createErrorState } = window._dataRows;

  app.innerHTML = '<div class="loading">Loading consensus run...</div>';

  let run;
  try {
    const data = await api('consensus');
    run = (data.runs || []).find(r => r.taskId === taskId);
  } catch (err) {
    app.innerHTML = '';
    const section = makeSection('Consensus Run', '');
    section.appendChild(createErrorState(() => renderConsensusDetail(app, taskId)));
    app.appendChild(section);
    return;
  }

  if (!run) {
    app.innerHTML = '<div class="empty-state">Consensus run not found: ' + e(taskId) + '</div>';
    return;
  }

  app.innerHTML = '';
  const agentCount = (run.agents || []).length;
  const section = makeSection('Consensus Run', agentCount + ' agents');

  // ── Summary pills ──────────────────────────────────────────────────────
  const c = run.counts || {};

  // Tally from signals to compute per-category counts matching the display categories
  const signals = run.signals || [];
  const tally = { CONFIRMED: 0, DISPUTED: 0, UNVERIFIED: 0, UNIQUE: 0, NEW: 0 };
  for (const s of signals) {
    const cat = consensusDisplayCategory(s.signal);
    if (tally[cat] != null) tally[cat]++;
  }

  const pillDefs = [
    { label: 'Confirmed',  value: tally.CONFIRMED,  cls: 'pill-g' },
    { label: 'Disputed',   value: tally.DISPUTED,   cls: 'pill-r' },
    { label: 'Unverified', value: tally.UNVERIFIED, cls: 'pill-y' },
    { label: 'Unique',     value: tally.UNIQUE,     cls: 'pill-u' },
    { label: 'New',        value: tally.NEW,        cls: 'pill-b' },
  ];

  const pills = document.createElement('div');
  pills.style.cssText = 'display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap';
  for (const p of pillDefs) {
    if (!p.value) continue;
    const pill = document.createElement('span');
    pill.className = 'pill ' + p.cls;
    pill.textContent = p.value + ' ' + p.label;
    pills.appendChild(pill);
  }
  section.appendChild(pills);

  // ── Data grid ──────────────────────────────────────────────────────────
  const columns = [
    { key: 'tag',       label: 'Tag',        sortable: false },
    { key: 'finding',   label: 'Finding',    sortable: false },
    { key: 'foundBy',   label: 'Found By',   sortable: false },
    { key: 'verifiedBy',label: 'Verified By',sortable: false },
  ];

  const expansion = createExpansionManager();

  const dataView = createDataView({
    columns,
    gridTemplateColumns: CONSENSUS_GRID,
  });

  section.appendChild(dataView);

  if (signals.length === 0) {
    dataView._dataView.rows.appendChild(createEmptyState('No signals recorded for this run'));
  } else {
    for (const s of signals) {
      const tc = consensusTagClass(s.signal);
      const typeLabel = consensusTagLabel(s.signal);
      const category = consensusDisplayCategory(s.signal);
      const evidenceSnippet = e((s.evidence || s.finding || '').slice(0, 140));
      const foundBy = e(s.agentId || '—');
      const verifiedBy = e(s.counterpartId || '—');

      const cells = [
        { content: '<span class="finding-tag ' + tc + '">' + e(typeLabel) + '</span>' },
        { content: evidenceSnippet },
        { content: foundBy, className: 'data-cell--mono' },
        { content: verifiedBy, className: 'data-cell--mono' },
      ];

      const row = createDataRow(cells, (rowEl) => {
        const isExpanded = rowEl.classList.contains('data-row--expanded');

        expansion.expand(rowEl);

        if (isExpanded) {
          rowEl.classList.remove('data-row--expanded');
          const panel = rowEl.nextElementSibling;
          if (panel && panel.classList.contains('data-expand')) panel.remove();
          return;
        }

        rowEl.classList.add('data-row--expanded');

        const expand = document.createElement('div');
        expand.className = 'data-expand';

        if (category === 'DISPUTED') {
          // Two-column side-by-side: claim vs counterargument
          const twoCol = document.createElement('div');
          twoCol.className = 'two-col';

          const leftBlock = document.createElement('div');
          leftBlock.innerHTML =
            '<div style="font-size:11px;font-weight:600;color:var(--text-3);margin-bottom:6px">Claim (' + e(s.agentId || '') + ')</div>' +
            '<pre style="font-size:12px;color:var(--text-2);white-space:pre-wrap;margin:0">' + e(s.evidence || s.finding || '') + '</pre>';

          const counter = s.reason || s.counterEvidence || 'No counterargument recorded';
          const rightBlock = document.createElement('div');
          rightBlock.innerHTML =
            '<div style="font-size:11px;font-weight:600;color:var(--text-3);margin-bottom:6px">Counter (' + e(s.counterpartId || '') + ')</div>' +
            '<pre style="font-size:12px;color:var(--text-2);white-space:pre-wrap;margin:0">' + e(counter) + '</pre>';

          twoCol.appendChild(leftBlock);
          twoCol.appendChild(rightBlock);
          expand.appendChild(twoCol);

        } else if (category === 'UNVERIFIED') {
          const block = document.createElement('div');
          block.innerHTML =
            '<pre style="font-size:12px;color:var(--text-2);white-space:pre-wrap;margin:0 0 8px">' + e(s.evidence || s.finding || '') + '</pre>' +
            '<div style="font-size:11px;color:var(--text-3);font-style:italic">Not verified by peers</div>';
          expand.appendChild(block);

        } else if (category === 'CONFIRMED') {
          const block = document.createElement('div');
          block.innerHTML =
            '<pre style="font-size:12px;color:var(--text-2);white-space:pre-wrap;margin:0 0 8px">' + e(s.evidence || s.finding || '') + '</pre>' +
            '<div style="font-size:11px;color:var(--text-3)">Confirmed by: ' + e(s.counterpartId || '—') + '</div>';
          expand.appendChild(block);

        } else {
          // NEW, UNIQUE, or OTHER — show full evidence
          const evidenceFull = s.evidence || s.finding || '';
          if (evidenceFull) {
            const block = document.createElement('div');
            block.innerHTML =
              '<pre style="font-size:12px;color:var(--text-2);white-space:pre-wrap;margin:0">' + e(evidenceFull) + '</pre>';
            expand.appendChild(block);
          }
        }

        rowEl.insertAdjacentElement('afterend', expand);
      }, CONSENSUS_GRID);

      dataView._dataView.rows.appendChild(row);
    }
  }

  app.appendChild(section);
}
