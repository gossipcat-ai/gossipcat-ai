/** Centralized timestamped logger — all MCP stderr output goes through here. */

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Tag → emoji prefix for visual scanning in mcp.log */
const TAG_EMOJI: Record<string, string> = {
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
};

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
