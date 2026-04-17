#!/usr/bin/env npx tsx
/**
 * One-shot migration: backfill `bound_at` on pending skill files whose
 * bound_at was reset to the develop-call timestamp instead of the original
 * bind timestamp.
 *
 * Context — invariant #6 (skill-engine.ts:165) states bound_at is set at
 * first-bind and is immutable thereafter. PR #149 shipped preservation logic
 * at packages/orchestrator/src/skill-engine.ts:172 for the `pending` case.
 * Skills developed BEFORE that PR had their bound_at clobbered each redevelop,
 * causing 0/10 skills to graduate (MIN_EVIDENCE window never elapsed).
 *
 * This script recovers the earliest category-matching evidence signal
 * timestamp from .gossip/agent-performance.jsonl and writes it back as
 * bound_at — the only documented exception to invariant #6.
 *
 * Only the `bound_at` scalar line is mutated; all other frontmatter fields
 * and body content are preserved byte-for-byte.
 *
 * Usage:
 *   npx tsx scripts/backfill-skill-bound-at.ts --dry-run
 *   npx tsx scripts/backfill-skill-bound-at.ts --apply
 *   npx tsx scripts/backfill-skill-bound-at.ts --dry-run --agent sonnet-reviewer
 *   npx tsx scripts/backfill-skill-bound-at.ts --apply --include-non-pending
 *
 * --dry-run (default):   print proposed changes, do not write
 * --apply:               write changes; original backed up as <path>.bak-<iso>
 * --agent <id>:          filter to one agent
 * --include-non-pending: also touch insufficient_evidence and silent_skill
 */

import { readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join } from 'path';
import { normalizeSkillName } from '../packages/orchestrator/src/skill-name';

// ── CLI ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const apply = args.includes('--apply');
const includeNonPending = args.includes('--include-non-pending');

const agentFlagIdx = args.indexOf('--agent');
const agentFilter: string | null = agentFlagIdx !== -1 ? (args[agentFlagIdx + 1] ?? null) : null;

if (!dryRun && !apply) {
  console.error('Usage: backfill-skill-bound-at.ts --dry-run | --apply [--agent <id>] [--include-non-pending]');
  process.exit(1);
}

// ── Types ─────────────────────────────────────────────────────────────────

interface SkillFile {
  agentId: string;
  skillName: string;   // filename stem (hyphen-form)
  category: string;    // normalized (hyphen-form, same as normalizeSkillName output)
  filePath: string;
  status: string | null;
  boundAt: string | null;
  rawContent: string;
}

interface SignalRow {
  agent_id: string;
  category: string;
  signal: string;
  ts: number;          // ms epoch, resolved from `timestamp` or `ts`
}

interface PlanRow {
  skill: SkillFile;
  earliestTs: string;
  matchedSignals: number;
  skipReason: 'already-earliest' | null;
}

type SkipReason = 'no-status' | 'terminal' | 'wrong-status' | 'no-matching-signals' | 'already-earliest';

// ── Constants ─────────────────────────────────────────────────────────────

/** Evidence signal types — mirrors getCountersSince switch in performance-reader.ts:291 */
const EVIDENCE_SIGNALS = new Set([
  'agreement',
  'category_confirmed',
  'consensus_verified',
  'unique_confirmed',
  'disagreement',
  'hallucination_caught',
]);

/** Terminal statuses — NEVER touch, they are archived */
const TERMINAL_STATUSES = new Set(['passed', 'failed']);

/** Default allow-list */
const DEFAULT_ALLOWED = new Set(['pending']);
/** Extended allow-list when --include-non-pending */
const EXTENDED_ALLOWED = new Set(['pending', 'insufficient_evidence', 'silent_skill']);

// ── Frontmatter helpers ───────────────────────────────────────────────────

/**
 * Extract a single scalar field from raw YAML frontmatter.
 * Same pattern as skill-freshness.ts:extractFrontmatterField.
 */
function extractFrontmatterField(content: string, field: string): string | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const lines = fmMatch[1].split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key !== field) continue;
    const value = line.slice(colonIdx + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Rewrite a single scalar frontmatter field in raw file content.
 * Only mutates the matching `key: value` line; all other bytes preserved.
 * Returns null if the field line is not found (caller should skip write).
 */
function rewriteFrontmatterField(content: string, field: string, newValue: string): string | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fmBody = fmMatch[1];
  const lines = fmBody.split('\n');
  let replaced = false;
  const newLines = lines.map(line => {
    if (replaced) return line;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return line;
    const key = line.slice(0, colonIdx).trim();
    if (key !== field) return line;
    replaced = true;
    return `${field}: ${newValue}`;
  });

  if (!replaced) return null;

  const newFmBody = newLines.join('\n');
  return content.slice(0, fmMatch.index!) + `---\n${newFmBody}\n---` +
    content.slice(fmMatch.index! + fmMatch[0].length);
}

// ── Skill discovery ───────────────────────────────────────────────────────

function discoverSkills(projectRoot: string): SkillFile[] {
  const agentsDir = join(projectRoot, '.gossip', 'agents');
  if (!existsSync(agentsDir)) return [];

  const skills: SkillFile[] = [];
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  if (agentFilter) {
    agentDirs = agentDirs.filter(d => d === agentFilter);
    if (agentDirs.length === 0) {
      console.error(`[error] agent not found: ${agentFilter}`);
      process.exit(1);
    }
  }

  for (const agentId of agentDirs) {
    const skillsDir = join(agentsDir, agentId, 'skills');
    if (!existsSync(skillsDir)) continue;

    let files: string[];
    try {
      files = readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(skillsDir, file);
      const skillName = file.replace(/\.md$/, '');
      const category = normalizeSkillName(skillName); // idempotent for hyphen-form

      let rawContent: string;
      try {
        rawContent = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const status = extractFrontmatterField(rawContent, 'status');
      const boundAt = extractFrontmatterField(rawContent, 'bound_at');

      skills.push({ agentId, skillName, category, filePath, status, boundAt, rawContent });
    }
  }

  return skills;
}

// ── Signal indexing ───────────────────────────────────────────────────────

/**
 * Build a map of (normalizedAgentId, normalizedCategory) → sorted evidence timestamps.
 * Reads .gossip/agent-performance.jsonl directly.
 * Timestamp resolution: `timestamp` field (ISO string) preferred, `ts` field (ms number) fallback.
 */
function buildSignalIndex(projectRoot: string): Map<string, number[]> {
  const filePath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  if (!existsSync(filePath)) return new Map();

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return new Map();
  }

  const index = new Map<string, number[]>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line); } catch { continue; }

    if (rec['type'] !== 'consensus') continue;

    const agentId = rec['agent_id'] ?? rec['agentId'];
    if (typeof agentId !== 'string' || !agentId) continue;

    const rawCategory = rec['category'];
    if (typeof rawCategory !== 'string' || !rawCategory.trim()) continue;

    const signal = rec['signal'];
    if (typeof signal !== 'string' || !EVIDENCE_SIGNALS.has(signal)) continue;

    // Resolve timestamp: prefer `timestamp` ISO string, fall back to `ts` ms number
    let tsMs: number;
    const tsField = rec['timestamp'];
    const tsRaw = rec['ts'];
    if (typeof tsField === 'string' && tsField) {
      tsMs = new Date(tsField).getTime();
    } else if (typeof tsRaw === 'number' && tsRaw > 0) {
      tsMs = tsRaw;
    } else if (typeof tsRaw === 'string' && tsRaw) {
      tsMs = new Date(tsRaw).getTime();
    } else {
      continue;
    }

    if (!isFinite(tsMs) || tsMs <= 0) continue;

    const normalizedAgent = normalizeSkillName(agentId);
    const normalizedCategory = normalizeSkillName(rawCategory);
    const key = `${normalizedAgent}::${normalizedCategory}`;

    const arr = index.get(key);
    if (arr) {
      arr.push(tsMs);
    } else {
      index.set(key, [tsMs]);
    }
  }

  // Sort each bucket ascending so [0] is the earliest
  for (const arr of index.values()) {
    arr.sort((a, b) => a - b);
  }

  return index;
}

// ── Per-skill planning ────────────────────────────────────────────────────

interface PlanResult {
  plans: PlanRow[];
  skipped: Map<SkipReason, number>;
}

function planSkills(skills: SkillFile[], signalIndex: Map<string, number[]>): PlanResult {
  const allowedStatuses = includeNonPending ? EXTENDED_ALLOWED : DEFAULT_ALLOWED;
  const plans: PlanRow[] = [];
  const skipped = new Map<SkipReason, number>();

  const bump = (r: SkipReason) => skipped.set(r, (skipped.get(r) ?? 0) + 1);

  for (const skill of skills) {
    if (skill.status === null) {
      console.warn(`[warn] ${skill.agentId}/${skill.skillName}: no status (pre-schema), skipping`);
      bump('no-status');
      continue;
    }

    if (TERMINAL_STATUSES.has(skill.status)) {
      bump('terminal');
      continue;
    }

    if (!allowedStatuses.has(skill.status)) {
      bump('wrong-status');
      continue;
    }

    const normalizedAgent = normalizeSkillName(skill.agentId);
    const key = `${normalizedAgent}::${skill.category}`;
    const timestamps = signalIndex.get(key);

    if (!timestamps || timestamps.length === 0) {
      console.warn(`[warn] no signals for ${skill.agentId}/${skill.skillName}: skipping`);
      bump('no-matching-signals');
      continue;
    }

    const earliestMs = timestamps[0];
    const earliestTs = new Date(earliestMs).toISOString();

    // Idempotency: if bound_at already equals the earliest signal ts, skip
    if (skill.boundAt === earliestTs) {
      bump('already-earliest');
      continue;
    }

    plans.push({
      skill,
      earliestTs,
      matchedSignals: timestamps.length,
      skipReason: null,
    });
  }

  return { plans, skipped };
}

// ── Output table ──────────────────────────────────────────────────────────

function printTable(plans: PlanRow[]): void {
  if (plans.length === 0) {
    console.log('\nNo skills to update.');
    return;
  }

  const colAgent = 'agent/skill';
  const colOld = 'old bound_at';
  const colNew = 'new bound_at';
  const colCount = 'matched_signals';
  const colEarliest = 'earliest_ts';

  // Compute column widths
  let wAgent = colAgent.length;
  let wOld = colOld.length;
  let wNew = colNew.length;
  let wCount = colCount.length;

  for (const p of plans) {
    const label = `${p.skill.agentId}/${p.skill.skillName}`;
    wAgent = Math.max(wAgent, label.length);
    wOld = Math.max(wOld, (p.skill.boundAt ?? 'none').length);
    wNew = Math.max(wNew, p.earliestTs.length);
    wCount = Math.max(wCount, String(p.matchedSignals).length);
  }

  const pad = (s: string, w: number) => s.padEnd(w);

  const header = [
    pad(colAgent, wAgent),
    pad(colOld, wOld),
    pad(colNew, wNew),
    pad(colCount, wCount),
    colEarliest,
  ].join(' | ');

  const separator = '-'.repeat(header.length);
  console.log('\n' + header);
  console.log(separator);

  for (const p of plans) {
    const label = `${p.skill.agentId}/${p.skill.skillName}`;
    const row = [
      pad(label, wAgent),
      pad(p.skill.boundAt ?? 'none', wOld),
      pad(p.earliestTs, wNew),
      pad(String(p.matchedSignals), wCount),
      p.earliestTs,
    ].join(' | ');
    console.log(row);
  }
}

// ── Write with backup ─────────────────────────────────────────────────────

function applyPlan(plans: PlanRow[]): { written: number; errors: number } {
  let written = 0;
  let errors = 0;
  const isoNow = new Date().toISOString().replace(/[:.]/g, '-');

  for (const p of plans) {
    const { skill, earliestTs } = p;

    // Backup
    const backupPath = `${skill.filePath}.bak-${isoNow}`;
    try {
      copyFileSync(skill.filePath, backupPath);
    } catch (e) {
      console.error(`[error] backup failed for ${skill.filePath}: ${e}`);
      errors++;
      continue;
    }

    // Rewrite bound_at line only
    const newContent = rewriteFrontmatterField(skill.rawContent, 'bound_at', earliestTs);
    if (newContent === null) {
      console.error(`[error] bound_at field not found in frontmatter: ${skill.filePath}`);
      errors++;
      continue;
    }

    try {
      writeFileSync(skill.filePath, newContent, 'utf-8');
      written++;
    } catch (e) {
      console.error(`[error] write failed for ${skill.filePath}: ${e}`);
      errors++;
    }
  }

  return { written, errors };
}

// ── Summary ───────────────────────────────────────────────────────────────

function printSummary(
  totalScanned: number,
  updated: number,
  skipped: Map<SkipReason, number>,
): void {
  const totalSkipped = [...skipped.values()].reduce((a, b) => a + b, 0);
  const noStatus = skipped.get('no-status') ?? 0;
  const alreadyEarliest = skipped.get('already-earliest') ?? 0;
  const noSignals = skipped.get('no-matching-signals') ?? 0;
  const terminal = skipped.get('terminal') ?? 0;
  const wrongStatus = skipped.get('wrong-status') ?? 0;

  console.log('\nSummary:');
  console.log(`  Scanned: ${totalScanned}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${totalSkipped} (no-status=${noStatus}, already-earliest=${alreadyEarliest}, no-matching-signals=${noSignals}, terminal=${terminal}, wrong-status=${wrongStatus})`);
}

// ── Main ──────────────────────────────────────────────────────────────────

function main(): void {
  const projectRoot = process.cwd();

  const skills = discoverSkills(projectRoot);
  const signalIndex = buildSignalIndex(projectRoot);
  const { plans, skipped } = planSkills(skills, signalIndex);

  printTable(plans);

  if (dryRun) {
    console.log('\n[dry-run] no files written.');
    printSummary(skills.length, 0, skipped);
    return;
  }

  const { written, errors } = applyPlan(plans);
  if (errors > 0) {
    console.error(`\n[error] ${errors} file(s) failed to write.`);
  }

  printSummary(skills.length, written, skipped);
}

main();
