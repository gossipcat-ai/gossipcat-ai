// packages/dashboard/src/lib/chart.js — Pure SVG chart generators

/**
 * Generate an area chart SVG string.
 * @param {Array<{label: string, value: number, failed?: number}>} data
 * @param {{width?: number, height?: number, color?: string, failedColor?: string}} opts
 * @returns {string} SVG markup
 */
function renderAreaChart(data, opts = {}) {
  const W = opts.width || 480;
  const H = opts.height || 120;
  const color = opts.color || 'var(--green)';
  const failedColor = opts.failedColor || 'var(--red)';
  const pad = { left: 40, right: 10, top: 10, bottom: 25 };

  if (!data || data.length === 0) return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-svg"></svg>';

  const maxVal = Math.max(...data.map(d => d.value), ...data.map(d => d.failed || 0), 1);
  const yMax = Math.ceil(maxVal / 10) * 10 || 10;
  const xStep = (W - pad.left - pad.right) / Math.max(data.length - 1, 1);

  function y(v) { return pad.top + (1 - v / yMax) * (H - pad.top - pad.bottom); }
  function x(i) { return pad.left + i * xStep; }

  // Grid lines
  const gridCount = 4;
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-svg">';

  // Gradient def
  svg += '<defs><linearGradient id="acg" x1="0" y1="0" x2="0" y2="1">';
  svg += '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.1"/>';
  svg += '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>';
  svg += '</linearGradient></defs>';

  for (let i = 0; i < gridCount; i++) {
    const gy = pad.top + i * (H - pad.top - pad.bottom) / (gridCount - 1);
    const label = Math.round(yMax - (yMax * i / (gridCount - 1)));
    svg += '<line x1="' + pad.left + '" y1="' + gy + '" x2="' + (W - pad.right) + '" y2="' + gy + '" class="grid-ln"/>';
    svg += '<text x="' + (pad.left - 4) + '" y="' + (gy + 4) + '" class="ax-txt" text-anchor="end">' + label + '</text>';
  }

  // X-axis labels
  for (let i = 0; i < data.length; i++) {
    svg += '<text x="' + x(i) + '" y="' + (H - 4) + '" class="ax-txt" text-anchor="middle">' + data[i].label + '</text>';
  }

  // Area fill
  const points = data.map((d, i) => x(i) + ',' + y(d.value)).join(' ');
  const areaPath = 'M' + x(0) + ',' + y(data[0].value) + ' ' +
    data.slice(1).map((d, i) => 'L' + x(i + 1) + ',' + y(d.value)).join(' ') +
    ' L' + x(data.length - 1) + ',' + y(0) + ' L' + x(0) + ',' + y(0) + 'Z';
  svg += '<path d="' + areaPath + '" fill="url(#acg)"/>';
  svg += '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';

  // Failed line (dashed)
  if (data.some(d => d.failed > 0)) {
    const failedPts = data.map((d, i) => x(i) + ',' + y(d.failed || 0)).join(' ');
    svg += '<polyline points="' + failedPts + '" fill="none" stroke="' + failedColor + '" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="4,4" opacity="0.6"/>';
    svg += '<circle cx="' + x(data.length - 1) + '" cy="' + y(data[data.length - 1].failed || 0) + '" r="2.5" fill="' + failedColor + '" opacity="0.6"/>';
  }

  // Endpoint dot
  svg += '<circle cx="' + x(data.length - 1) + '" cy="' + y(data[data.length - 1].value) + '" r="3" fill="' + color + '"/>';
  svg += '</svg>';
  return svg;
}

/**
 * Generate a horizontal bar chart SVG string.
 * @param {Array<{label: string, value: number, secondary?: number}>} data
 * @param {{width?: number, height?: number, color?: string, secondaryColor?: string}} opts
 * @returns {string} SVG markup
 */
function renderBarChart(data, opts = {}) {
  const W = opts.width || 480;
  const color = opts.color || 'var(--accent)';
  const secColor = opts.secondaryColor || 'var(--blue)';
  const labelWidth = 120;
  const barStart = labelWidth + 5;
  const barMaxWidth = W - barStart - 50;
  const rowHeight = 24;
  const H = Math.max(data.length * rowHeight + 30, 60);

  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-svg">';

  for (let i = 0; i < data.length; i++) {
    const yy = i * rowHeight + 6;
    const barW = (data[i].value / 100) * barMaxWidth;
    const secW = data[i].secondary != null ? (data[i].secondary / 100) * barMaxWidth : 0;

    svg += '<text x="' + (labelWidth - 5) + '" y="' + (yy + 14) + '" class="ax-txt" text-anchor="end" style="font-size:10px;fill:var(--text-2)">' + data[i].label + '</text>';
    svg += '<rect x="' + barStart + '" y="' + (yy + 4) + '" width="' + barW + '" height="10" rx="3" fill="' + color + '" opacity="0.6"/>';
    if (secW > 0) {
      svg += '<rect x="' + barStart + '" y="' + (yy + 4) + '" width="' + secW + '" height="10" rx="3" fill="' + secColor + '" opacity="0.2"/>';
    }
    svg += '<text x="' + (barStart + barW + 6) + '" y="' + (yy + 14) + '" class="ax-txt" style="fill:' + color + ';font-weight:600">' + data[i].value + '%</text>';
  }

  // Scale
  const scaleY = data.length * rowHeight + 10;
  svg += '<text x="' + barStart + '" y="' + scaleY + '" class="ax-txt" text-anchor="middle">0%</text>';
  svg += '<text x="' + (barStart + barMaxWidth / 2) + '" y="' + scaleY + '" class="ax-txt" text-anchor="middle">50%</text>';
  svg += '<text x="' + (barStart + barMaxWidth) + '" y="' + scaleY + '" class="ax-txt" text-anchor="middle">100%</text>';

  svg += '</svg>';
  return svg;
}
