// CommonJS library for scripts/audit-memories.mjs.
// Pure functions only — no I/O at import time. Kept as .cjs so both the ESM
// CLI wrapper and ts-jest tests can load it without needing Jest's
// experimental ESM mode.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CODENAMES = ['crab-language', 'gossip-v2'];

const HELP = `audit-memories — triage Claude Code auto-memory files.

Usage:
  node scripts/audit-memories.mjs [options]

Options:
  --dir <path>          Override the default memory dir.
  --json                Emit JSON array instead of an ASCII table.
  --candidates-only     Hide rows whose proposed_target is DROP.
  --codenames a,b,c     Extra codename strings to count as provenance.
  --help                Show this message and exit.

Default dir is derived from process.cwd():
  ~/.claude/projects/<cwd-with-slashes-as-dashes>/memory/
The leading dash from an absolute path is dropped.

This tool is read-only — it never writes to memory files.`;

function parseArgs(argv) {
  const out = {
    dir: null,
    json: false,
    candidatesOnly: false,
    codenames: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--candidates-only') out.candidatesOnly = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a.startsWith('--dir=')) out.dir = a.slice('--dir='.length);
    else if (a === '--codenames') out.codenames = (argv[++i] || '').split(',').filter(Boolean);
    else if (a.startsWith('--codenames=')) out.codenames = a.slice('--codenames='.length).split(',').filter(Boolean);
  }
  return out;
}

function defaultMemoryDir(cwd, home) {
  let encoded = cwd.replace(/\//g, '-');
  if (encoded.startsWith('-')) encoded = encoded.slice(1);
  return path.join(home, '.claude', 'projects', encoded, 'memory');
}

function scoreRubric(body) {
  let score = 0;
  const dates = body.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || [];
  const distinctDates = new Set(dates);
  if (distinctDates.size >= 2 || body.includes('originSessionId')) score += 1;
  if (/\b(STOP|MUST|ALWAYS|NEVER)\b/.test(body)) score += 1;
  if (/lost|silently|wrong|bypass|security/i.test(body)) score += 1;
  return score;
}

function classify(body) {
  const modelHit = /(gemini|sonnet|haiku|opus|claude)/i.test(body);
  const failHit = /(hallucinat|fabricat|consistent|always)/i.test(body);
  if (modelHit && failHit) return 'MODEL_INTRINSIC';

  const protoToolMatch = /(gossip_\w+|mcp__gossipcat__\w+)/.test(body);
  const projectPathMatch = /(packages|apps|\.gossip)\//.test(body);

  let identifierNearKeyword = false;
  const identRegex = /`[^`\n]+`/g;
  let m;
  while ((m = identRegex.exec(body)) !== null) {
    const start = Math.max(0, m.index - 80);
    const end = Math.min(body.length, m.index + m[0].length + 80);
    const window = body.slice(start, end);
    if (/\b(must|required|cannot)\b/i.test(window)) {
      identifierNearKeyword = true;
      break;
    }
  }

  if (protoToolMatch || projectPathMatch || identifierNearKeyword) return 'PROTOCOL_BOUND';
  return 'USER_SPECIFIC';
}

function provenanceHits(body, extraCodenames) {
  const codenames = DEFAULT_CODENAMES.concat(extraCodenames || []);

  const prMatches = body.match(/(?:PR\s*#?\d+|#\d+)/gi) || [];
  const prCount = prMatches.length;

  const prDigitRuns = new Set();
  for (const pr of prMatches) {
    const digits = pr.match(/\d+/);
    if (digits) prDigitRuns.add(digits[0]);
  }

  const commitMatches = body.match(/\b[0-9a-f]{7,}\b/g) || [];
  const commitCount = commitMatches.filter((h) => !prDigitRuns.has(h)).length;

  const dateMatches = body.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || [];
  const distinctDates = new Set(dateMatches).size;

  let codenameCount = 0;
  for (const cn of codenames) {
    if (!cn) continue;
    const re = new RegExp(cn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const hits = body.match(re);
    if (hits) codenameCount += hits.length;
  }

  return prCount + commitCount + distinctDates + codenameCount;
}

function proposeTarget(rubric, bucket) {
  if (rubric === 3 && bucket === 'MODEL_INTRINSIC') return 'model-skill';
  if (rubric === 3 && bucket === 'PROTOCOL_BOUND') return 'HANDBOOK';
  return 'DROP';
}

function auditBody(file, body, extraCodenames) {
  const rubric = scoreRubric(body);
  const bucket = classify(body);
  const hits = provenanceHits(body, extraCodenames);
  const target = proposeTarget(rubric, bucket);
  return {
    file,
    bucket,
    rubric_score: rubric,
    provenance_hits: hits,
    strip_needed: hits > 0,
    proposed_target: target,
  };
}

const TARGET_ORDER = { HANDBOOK: 0, 'model-skill': 1, DROP: 2 };

function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    const t = TARGET_ORDER[a.proposed_target] - TARGET_ORDER[b.proposed_target];
    if (t !== 0) return t;
    if (b.rubric_score !== a.rubric_score) return b.rubric_score - a.rubric_score;
    return a.file.localeCompare(b.file);
  });
}

function renderTable(rows) {
  const header = ['file', 'bucket', 'rubric_score', 'provenance_hits', 'strip_needed', 'proposed_target'];
  const data = rows.map((r) => [
    r.file,
    r.bucket,
    String(r.rubric_score),
    String(r.provenance_hits),
    String(r.strip_needed),
    r.proposed_target,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length))
  );
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmt(header), sep].concat(data.map(fmt)).join('\n');
}

function auditDir(dir, opts) {
  opts = opts || {};
  const codenames = opts.codenames || [];
  const warnings = [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    const e = new Error(`memory dir not readable: ${dir}`);
    e.cause = err;
    e.resolvedDir = dir;
    throw e;
  }
  const rows = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.md')) continue;
    if (name === 'MEMORY.md') continue;
    const full = path.join(dir, name);
    let body;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      body = fs.readFileSync(full, 'utf8');
    } catch (err) {
      warnings.push(`warn: skipping unreadable file ${name}: ${err.message}`);
      continue;
    }
    rows.push(auditBody(name, body, codenames));
  }
  return { rows: sortRows(rows), warnings, dir };
}

module.exports = {
  HELP,
  DEFAULT_CODENAMES,
  parseArgs,
  defaultMemoryDir,
  scoreRubric,
  classify,
  provenanceHits,
  proposeTarget,
  auditBody,
  sortRows,
  renderTable,
  auditDir,
};
