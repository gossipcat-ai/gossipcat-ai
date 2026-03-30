// packages/dashboard/src/hub/overview.js — Status bar (replaces metric cards)

function renderOverviewSection(data) {
  const { timeAgo } = window._dash;
  const section = document.createElement('div');
  section.className = 'section status-bar';

  const connected = data.relayConnected || 0;
  const native = data.nativeCount || 0;
  const totalOnline = connected + native;

  const lastRun = data.lastConsensusTimestamp;
  const lastRunText = lastRun ? timeAgo(lastRun) : 'never';

  const unverified = data.unverifiedFindings || 0;

  const dot = '<span class="sb-dot' + (totalOnline > 0 ? ' online' : '') + '"></span>';

  section.innerHTML =
    '<div class="sb-left">' +
      dot +
      '<span class="sb-stat">' + totalOnline + ' connected</span>' +
      '<span class="sb-sep">&middot;</span>' +
      '<span class="sb-stat">last run ' + lastRunText + '</span>' +
    '</div>' +
    '<div class="sb-right">' +
      (unverified > 0
        ? '<span class="sb-action">' + unverified + ' findings to review</span>'
        : '<span class="sb-clear">all clear</span>') +
    '</div>';

  return section;
}
