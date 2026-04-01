// packages/dashboard/src/hub/overview.js — Status bar

function renderOverviewSection(data) {
  var timeAgo = window._dash.timeAgo;
  var section = document.createElement('div');
  section.className = 'section status-bar';

  var connected = data.relayConnected || 0;
  var native = data.nativeCount || 0;
  var actionable = data.actionableFindings || 0;

  var lastRun = data.lastConsensusTimestamp;
  var lastRunText = lastRun ? timeAgo(lastRun) : 'never';

  var totalTasks = data.totalTasks != null ? data.totalTasks : null;
  var confirmedFindings = data.confirmedFindings != null ? data.confirmedFindings : null;
  var totalFindings = data.totalFindings != null ? data.totalFindings : null;
  var consensusRate = (confirmedFindings != null && totalFindings != null && totalFindings > 0)
    ? Math.round((confirmedFindings / totalFindings) * 100) + '%'
    : null;

  // LEFT: actionable info first
  var leftHtml;
  if (actionable > 0) {
    leftHtml = '<span class="sb-action">' + actionable + ' findings need attention</span>';
  } else {
    leftHtml = '<span class="sb-dot online"></span><span class="sb-clear">ALL CLEAR</span>';
  }

  // RIGHT: system stats
  var rightParts = [
    '<span class="sb-stat">' + data.nativeCount + ' native &middot; ' + data.relayCount + ' relay</span>',
    '<span class="sb-sep">&middot;</span>',
    '<span class="sb-stat">last run ' + lastRunText + '</span>',
  ];
  if (totalTasks != null) {
    rightParts.push('<span class="sb-sep">&middot;</span><span class="sb-stat">' + totalTasks + ' tasks</span>');
  }
  if (consensusRate != null) {
    rightParts.push('<span class="sb-sep">&middot;</span><span class="sb-stat">' + consensusRate + ' consensus</span>');
  }

  section.innerHTML =
    '<div class="sb-left">' + leftHtml + '</div>' +
    '<div class="sb-right">' + rightParts.join('') + '</div>';

  return section;
}
