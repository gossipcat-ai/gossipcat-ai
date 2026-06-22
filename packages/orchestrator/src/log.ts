/** Centralized timestamped logger — all MCP stderr output goes through here. */

function ts(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  // Include the date so midnight crossings aren't ambiguous in long-running
  // MCP server logs (UTC; trailing 'Z' marks the zone).
  return `${yyyy}-${mo}-${dd} ${hh}:${mm}:${ss}.${ms}Z`;
}

/** Tag → emoji prefix for visual scanning in mcp.log. Null-prototype to avoid __proto__ traversal. */
const TAG_EMOJI: Record<string, string> = Object.assign(Object.create(null), {
  gossipcat:     '🐱',
  consensus:     '🤝',
  worker:        '⚙️',
  dispatch:      '📡',
  'skill-loader':'📦',
  'tool-router': '🔧',
  MainAgent:     '🧠',
  Gemini:        '🔮',
  GeminiProvider:'🔮',
  google:        '🔮',
});

function emojiFor(tag: string): string {
  // Direct match
  if (TAG_EMOJI[tag]) return TAG_EMOJI[tag];
  // Prefix match (e.g. "worker:gemini-reviewer" → worker)
  const prefix = tag.split(':')[0];
  if (TAG_EMOJI[prefix]) return TAG_EMOJI[prefix];
  return '▪️';
}

export function log(tag: string, msg: string): void {
  process.stderr.write(`${ts()} ${emojiFor(tag)} [${tag}] ${msg}\n`);
}

export function gossipLog(msg: string): void {
  log('gossipcat', msg);
}
