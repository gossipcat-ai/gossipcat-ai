'use strict';
// Pure logic for scripts/migrate-skill-index-modes.mjs (issue #675 stage 3).
//
// Migrates `.gossip/skill-index.json` auto-bound slots that are still recorded
// as `mode: "permanent"` over to `mode: "contextual"` — but ONLY when the
// agent-local skill file BOTH declares `mode: contextual` in its frontmatter
// AND has a measured effectiveness verdict (`status` is not `pending` and not
// `insufficient_evidence`). Slots still accumulating evidence keep their
// permanent binding so the measurement window is not disturbed.
//
// The migration edits `mode` in place. It deliberately does NOT go through
// SkillIndex.bind(), which rotates `boundAt` — `boundAt` anchors the skill
// effectiveness windows (HANDBOOK invariant #6) and must survive byte-for-byte.
//
// CommonJS so ts-jest can require it without Jest's experimental ESM mode.

const fs = require('node:fs');
const path = require('node:path');

const HELP = `migrate-skill-index-modes — flip measured auto-bound skills to contextual mode

Usage:
  node scripts/migrate-skill-index-modes.mjs [--root <path>] [--dry-run] [--json] [--help]

Options:
  --root <path>   Project root containing .gossip/ (default: process.cwd())
  --dry-run       Print the flip/keep plan without writing the index
  --json          Emit the plan as JSON instead of a text report
  --help          Show this message

A slot is flipped only when ALL of the following hold:
  * slot.source === "auto" and slot.mode === "permanent"
  * .gossip/agents/<agent>/skills/<skill>.md declares mode: contextual
  * that file's status is neither "pending" nor "insufficient_evidence"

Flipped slots keep their original boundAt and get version + 1. Everything
else is left untouched and reported by category. Re-running is a no-op.`;

/** Statuses that mean "still accumulating evidence" — never flip these. */
const STARVED_STATUSES = new Set(['pending', 'insufficient_evidence']);

/**
 * Path components are read from a persisted JSON file, so they are untrusted
 * input for the purposes of building a filesystem path. Fail closed: a key
 * that does not match is reported as `unsafe_name` and never joined.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeName(value) {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    SAFE_NAME.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

function parseArgs(argv) {
  const args = { help: false, dryRun: false, json: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--root') args.root = argv[++i] ?? null;
    else if (a.startsWith('--root=')) args.root = a.slice('--root='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/**
 * Minimal leading-`---` frontmatter reader for the two scalar fields this
 * migration cares about. Returns null when the file has no frontmatter block.
 */
function parseFrontmatterFields(content) {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key !== 'mode' && key !== 'status') continue;
    fields[key] = stripQuotes(line.slice(colon + 1).trim());
  }
  return { mode: fields.mode ?? null, status: fields.status ?? null };
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

function indexPath(root) {
  return path.join(root, '.gossip', 'skill-index.json');
}

function skillFilePath(root, agentId, skill) {
  return path.join(root, '.gossip', 'agents', agentId, 'skills', `${skill}.md`);
}

function readIndex(root) {
  const file = indexPath(root);
  if (!fs.existsSync(file)) {
    throw new Error(`skill index not found: ${file}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`skill index is not valid JSON (${file}): ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`skill index must be an object of agent → skill → slot (${file})`);
  }
  return parsed;
}

/**
 * Classify a single slot. Returns one of:
 *   flip | starved | not_declared_contextual | no_frontmatter | no_file
 *   | already_contextual | not_auto | unsafe_name | malformed
 */
function classifySlot(root, agentId, skillKey, slot) {
  const base = { agent: agentId, skill: skillKey };
  if (!slot || typeof slot !== 'object') {
    return { ...base, action: 'malformed', reason: 'slot is not an object' };
  }
  if (!isSafeName(agentId) || !isSafeName(skillKey)) {
    return { ...base, action: 'unsafe_name', reason: 'agent or skill key is not a safe path segment' };
  }
  if (slot.source !== 'auto') {
    return { ...base, action: 'not_auto', reason: `source=${String(slot.source)}` };
  }
  if (slot.mode === 'contextual') {
    return { ...base, action: 'already_contextual', reason: 'mode is already contextual' };
  }
  if (slot.mode !== 'permanent') {
    return { ...base, action: 'malformed', reason: `unexpected mode=${String(slot.mode)}` };
  }

  const file = skillFilePath(root, agentId, skillKey);
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ...base, action: 'no_file', reason: `unreadable: ${err.code ?? err.message}` };
  }

  const fm = parseFrontmatterFields(content);
  if (!fm) {
    return { ...base, action: 'no_frontmatter', reason: 'skill file has no frontmatter block' };
  }
  if (fm.mode !== 'contextual') {
    return { ...base, action: 'not_declared_contextual', reason: `declared mode=${fm.mode ?? 'absent'}` };
  }
  if (fm.status === null || STARVED_STATUSES.has(fm.status)) {
    return { ...base, action: 'starved', reason: `status=${fm.status ?? 'absent'}` };
  }
  return { ...base, action: 'flip', reason: `declared contextual, status=${fm.status}` };
}

/**
 * Build the full migration plan by classifying every slot from disk.
 * Returns `{ data, rows, flips, counts }` — `data` is the parsed index,
 * unmodified.
 */
function planMigration(root) {
  const data = readIndex(root);
  const rows = [];
  for (const agentId of Object.keys(data)) {
    const slots = data[agentId];
    if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
      rows.push({ agent: agentId, skill: '*', action: 'malformed', reason: 'agent entry is not an object' });
      continue;
    }
    for (const skillKey of Object.keys(slots)) {
      rows.push(classifySlot(root, agentId, skillKey, slots[skillKey]));
    }
  }
  const counts = {};
  for (const row of rows) counts[row.action] = (counts[row.action] ?? 0) + 1;
  return { data, rows, flips: rows.filter((r) => r.action === 'flip'), counts };
}

/**
 * Apply the plan's flips to `plan.data` in memory. Mutates `mode` and
 * `version` only; `boundAt` and every other field are untouched.
 * Returns the number of slots changed.
 */
function applyFlips(plan) {
  for (const row of plan.flips) {
    const slot = plan.data[row.agent][row.skill];
    slot.mode = 'contextual';
    slot.version = typeof slot.version === 'number' ? slot.version + 1 : 1;
  }
  return plan.flips.length;
}

/** Write the index atomically: temp file in the same directory, then rename. */
function writeIndex(root, data) {
  const file = indexPath(root);
  const tmp = path.join(path.dirname(file), `.skill-index.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

const ACTION_ORDER = [
  'flip',
  'starved',
  'not_declared_contextual',
  'no_frontmatter',
  'no_file',
  'already_contextual',
  'not_auto',
  'unsafe_name',
  'malformed',
];

function renderReport(plan, { dryRun }) {
  const lines = [];
  lines.push(`# migrate-skill-index-modes — ${plan.rows.length} slot(s) inspected`);
  lines.push(dryRun ? '# mode: DRY RUN (no write)' : '# mode: APPLY');
  lines.push('');
  for (const action of ACTION_ORDER) {
    const rows = plan.rows.filter((r) => r.action === action);
    if (rows.length === 0) continue;
    lines.push(`## ${action} (${rows.length})`);
    for (const r of rows) lines.push(`  ${r.agent}/${r.skill} — ${r.reason}`);
    lines.push('');
  }
  lines.push(`flips: ${plan.flips.length}`);
  return lines.join('\n');
}

module.exports = {
  HELP,
  STARVED_STATUSES,
  applyFlips,
  classifySlot,
  indexPath,
  isSafeName,
  parseArgs,
  parseFrontmatterFields,
  planMigration,
  readIndex,
  renderReport,
  skillFilePath,
  writeIndex,
};
