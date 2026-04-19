// CommonJS library for scripts/audit-memories.mjs.
// Pure functions only — no I/O at import time. Kept as .cjs so both the ESM
// CLI wrapper and ts-jest tests can load it without needing Jest's
// experimental ESM mode.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const DEFAULT_CODENAMES = ['crab-language', 'gossip-v2'];

const VALID_TYPES = ['user', 'feedback', 'project', 'reference'];
const VALID_STATUSES = ['open', 'shipped', 'closed'];
const REQUIRED_FIELDS = ['name', 'description', 'type'];

const HELP = `audit-memories — triage Claude Code auto-memory files.

Usage:
  node scripts/audit-memories.mjs [options]

Options:
  --dir <path>          Override the default memory dir.
  --json                Emit JSON array instead of an ASCII table.
  --candidates-only     Hide rows whose proposed_target is DROP.
  --codenames a,b,c     Extra codename strings to count as provenance.
  --include-shipped     Include files with status:shipped or status:closed
                        (default: those files are forced to DROP).
  --hygiene             Read-only frontmatter hygiene scan. Validates required
                        fields (name, description, type), valid type/status
                        enum, and flags missing status/originSessionId.
                        Different output; ignores triage flags.
  --clean-only          With --hygiene: show only files with no issues.
  --issues-only         With --hygiene: show only files with at least one issue.
  --help                Show this message and exit.

Default dir is derived from the main project root (first success wins):
  1. git rev-parse --show-superproject-working-tree
  2. git rev-parse --git-common-dir  →  parent dir
  3. git rev-parse --show-toplevel
  4. process.cwd() fallback
  Encoded as ~/.claude/projects/<path-with-slashes-as-dashes>/memory/
  The leading dash from an absolute path is dropped.
  Running from a worktree resolves to the main project root, not the worktree.

This tool is read-only — it never writes to memory files.`;

function parseArgs(argv) {
  const out = {
    dir: null,
    json: false,
    candidatesOnly: false,
    codenames: [],
    includeShipped: false,
    hygiene: false,
    cleanOnly: false,
    issuesOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--candidates-only') out.candidatesOnly = true;
    else if (a === '--include-shipped') out.includeShipped = true;
    else if (a === '--hygiene') out.hygiene = true;
    else if (a === '--clean-only') out.cleanOnly = true;
    else if (a === '--issues-only') out.issuesOnly = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a.startsWith('--dir=')) out.dir = a.slice('--dir='.length);
    else if (a === '--codenames') out.codenames = (argv[++i] || '').split(',').filter(Boolean);
    else if (a.startsWith('--codenames=')) out.codenames = a.slice('--codenames='.length).split(',').filter(Boolean);
  }
  return out;
}

function resolveProjectRoot(cwd, _execSync) {
  const exec = _execSync || execSync;
  const run = (cmd) => exec(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    const superproject = run('git rev-parse --show-superproject-working-tree');
    if (superproject) return superproject;
  } catch (_) {}
  try {
    const commonDir = run('git rev-parse --git-common-dir');
    // commonDir is either an absolute path or relative (e.g. ".git" or
    // "/path/to/.git/worktrees/agent-XXXX/../../.."); resolve then go up one.
    const resolved = path.isAbsolute(commonDir)
      ? path.dirname(commonDir)
      : path.dirname(path.resolve(cwd, commonDir));
    if (resolved) return resolved;
  } catch (_) {}
  try {
    const toplevel = run('git rev-parse --show-toplevel');
    if (toplevel) return toplevel;
  } catch (_) {}
  return cwd;
}

function defaultMemoryDir(cwd, home, _execSync) {
  const root = resolveProjectRoot(cwd, _execSync);
  let encoded = root.replace(/\//g, '-');
  if (encoded.startsWith('-')) encoded = encoded.slice(1);
  return path.join(home, '.claude', 'projects', encoded, 'memory');
}

function parseFrontmatterStatus(body) {
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = m[1];
  const statusMatch = fm.match(/^status:\s*(\w+)\s*$/m);
  return statusMatch ? statusMatch[1] : null;
}

function auditHygiene(body) {
  const report = {
    has_frontmatter: false,
    missing_fields: [],
    invalid_type: null,
    invalid_status: null,
    missing_status: false,
    missing_origin: false,
    malformed: null,
  };
  if (!body.startsWith('---')) return report;
  const firstLineEnd = body.indexOf('\n');
  const firstLine = body.slice(0, firstLineEnd).replace(/\s+$/, '');
  if (firstLine !== '---') return report;
  const rest = body.slice(firstLineEnd + 1);
  const closeMatch = rest.match(/\r?\n---\s*(?:\r?\n|$)/);
  if (!closeMatch) {
    report.has_frontmatter = false;
    report.malformed = 'missing closing delimiter';
    return report;
  }
  const fm = rest.slice(0, closeMatch.index);
  report.has_frontmatter = true;
  if (!fm.trim()) {
    report.malformed = 'empty frontmatter';
    return report;
  }
  const fields = {};
  const lineRe = /^(\w+):[ \t]*(.*?)\s*$/gm;
  let m;
  while ((m = lineRe.exec(fm)) !== null) {
    fields[m[1]] = m[2];
  }
  for (const f of REQUIRED_FIELDS) {
    if (!(f in fields) || fields[f].length === 0) report.missing_fields.push(f);
  }
  if ('type' in fields && !VALID_TYPES.includes(fields.type)) {
    report.invalid_type = fields.type;
  }
  if ('status' in fields && !VALID_STATUSES.includes(fields.status)) {
    report.invalid_status = fields.status;
  }
  const hasType = 'type' in fields && fields.type.length > 0;
  if (hasType) {
    report.missing_status = !('status' in fields);
    report.missing_origin = !('originSessionId' in fields);
  }
  return report;
}

function hygieneHasIssues(report) {
  if (!report.has_frontmatter) return true;
  if (report.malformed) return true;
  if (report.missing_fields.length > 0) return true;
  if (report.invalid_type) return true;
  if (report.invalid_status) return true;
  if (report.missing_status) return true;
  if (report.missing_origin) return true;
  return false;
}

function summarizeHygiene(report) {
  const parts = [];
  if (!report.has_frontmatter) parts.push('no frontmatter');
  if (report.malformed) parts.push(report.malformed);
  if (report.missing_fields.length > 0) parts.push(`missing: ${report.missing_fields.join(',')}`);
  if (report.invalid_type) parts.push(`invalid_type=${report.invalid_type}`);
  if (report.invalid_status) parts.push(`invalid_status=${report.invalid_status}`);
  if (report.missing_status) parts.push('missing_status');
  if (report.missing_origin) parts.push('missing_origin');
  return parts.length ? parts.join('; ') : '—';
}

function parseFrontmatterField(body, field) {
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const re = new RegExp('^' + field + ':[ \\t]*(.*?)\\s*$', 'm');
  const match = m[1].match(re);
  return match ? match[1] : null;
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

function auditBody(file, body, extraCodenames, opts) {
  opts = opts || {};
  const includeShipped = !!opts.includeShipped;
  const rubric = scoreRubric(body);
  const bucket = classify(body);
  const hits = provenanceHits(body, extraCodenames);
  const status = parseFrontmatterStatus(body);
  const rubricTarget = proposeTarget(rubric, bucket);

  let proposed_target = rubricTarget;
  let drop_reason;

  if (rubricTarget === 'DROP') {
    drop_reason = 'low_rubric';
  }

  if (!includeShipped && (status === 'shipped' || status === 'closed')) {
    proposed_target = 'DROP';
    drop_reason = status === 'shipped' ? 'status_shipped' : 'status_closed';
  }

  return {
    file,
    bucket,
    status: status || null,
    rubric_score: rubric,
    provenance_hits: hits,
    strip_needed: hits > 0,
    proposed_target,
    drop_reason,
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
  const header = ['file', 'bucket', 'status', 'rubric_score', 'provenance_hits', 'strip_needed', 'proposed_target'];
  const data = rows.map((r) => [
    r.file,
    r.bucket,
    r.status || '—',
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
  const includeShipped = opts.includeShipped || false;
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
    rows.push(auditBody(name, body, codenames, { includeShipped }));
  }
  return { rows: sortRows(rows), warnings, dir };
}

function hygieneDir(dir) {
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
    const report = auditHygiene(body);
    rows.push({
      file: name,
      type: parseFrontmatterField(body, 'type'),
      status: parseFrontmatterField(body, 'status'),
      ...report,
      has_issues: hygieneHasIssues(report),
    });
  }
  rows.sort((a, b) => {
    if (a.has_issues !== b.has_issues) return a.has_issues ? -1 : 1;
    return a.file.localeCompare(b.file);
  });
  return { rows, warnings, dir };
}

function renderHygieneTable(rows) {
  const header = ['file', 'type', 'status', 'has_frontmatter', 'issues'];
  const data = rows.map((r) => [
    r.file,
    r.type || '—',
    r.status || '—',
    String(r.has_frontmatter),
    summarizeHygiene(r),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length))
  );
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmt(header), sep].concat(data.map(fmt)).join('\n');
}

module.exports = {
  HELP,
  DEFAULT_CODENAMES,
  VALID_TYPES,
  VALID_STATUSES,
  REQUIRED_FIELDS,
  parseArgs,
  resolveProjectRoot,
  defaultMemoryDir,
  parseFrontmatterStatus,
  parseFrontmatterField,
  auditHygiene,
  hygieneHasIssues,
  summarizeHygiene,
  scoreRubric,
  classify,
  provenanceHits,
  proposeTarget,
  auditBody,
  sortRows,
  renderTable,
  auditDir,
  hygieneDir,
  renderHygieneTable,
};
