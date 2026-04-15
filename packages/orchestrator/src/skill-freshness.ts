/**
 * skill-freshness.ts — cooldown gate utilities for gossip_skills(action: "develop").
 *
 * Reads skill frontmatter DIRECTLY via raw YAML regex — no SkillEngine imports.
 * Invariant: migrateIfNeeded() in skill-engine.ts:550-553 can mutate bound_at
 * mid-session. Any SkillEngine indirection defeats the throttle.
 *
 * Called BEFORE buildPrompt() in the develop handler. The moment saveFromRaw →
 * injectSnapshotFields runs (skill-engine.ts:293,306), bound_at is rewritten to
 * now, so reading after that call always sees a fresh timestamp.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { normalizeSkillName } from './skill-name';

// ── Types ─────────────────────────────────────────────────────────────────

export interface SkillFreshnessResult {
  /** ISO timestamp from frontmatter, or null if absent/unparseable */
  boundAt: string | null;
  /** Effectiveness verdict status from frontmatter, or null if absent */
  status: string | null;
  /** Resolved filesystem path for the skill file */
  path: string;
}

/**
 * Discriminated union returned by computeCooldown.
 *
 * - `pre_schema`  — file has no status field; no cooldown applies (first-develop or legacy file).
 * - `no_cooldown` — status is known but maps to 0ms (e.g. "pending" — evidence still accumulating).
 * - `cooldown`    — a positive cooldown applies; caller checks ageMs vs cooldownMs.
 *
 * Pattern-match on `kind` — the old numeric return is gone. The pre_schema vs pending split
 * is now explicit so callers and the audit log can distinguish them correctly.
 */
export type CooldownDecision =
  | { kind: 'pre_schema' }
  | { kind: 'no_cooldown'; status: string }
  | { kind: 'cooldown'; status: string; cooldownMs: number };

// ── Constants ─────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Millisecond cooldowns per verdict status. Infinity = hard-block. */
const COOLDOWN_MS: Record<string, number> = {
  pending: 0,
  silent_skill: 30 * DAY_MS,
  insufficient_evidence: 30 * DAY_MS,
  inconclusive: 60 * DAY_MS,
  passed: Infinity,
  failed: Infinity,
};

// ── Core helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the canonical path for a skill file given agentId and category.
 * Mirrors the logic in skill-engine.ts private resolveSkillPath().
 */
function resolveSkillFilePath(agentId: string, category: string, skillRoot: string): string {
  const skillName = normalizeSkillName(category);
  return join(skillRoot, '.gossip', 'agents', agentId, 'skills', `${skillName}.md`);
}

/**
 * Extract a single scalar field from raw YAML frontmatter.
 * Returns null when the field is absent, blank, or the content has no frontmatter block.
 * Does NOT recurse into YAML objects/lists — only scalar key: value lines.
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

// ── Exports ───────────────────────────────────────────────────────────────

/**
 * Read a skill file's freshness metadata from its frontmatter.
 *
 * - Uses raw regex frontmatter parsing — never imports SkillEngine.
 * - Returns {boundAt: null, status: null} when the file does not exist.
 * - Returns {boundAt: null, status: <value>} when bound_at is absent but status is present
 *   (pre-schema file, or a file written without the snapshot fields).
 *
 * Callers MUST check `boundAt !== null` before computing age — a null boundAt
 * means "no cooldown active" regardless of status.
 */
export function readSkillFreshness(
  agentId: string,
  category: string,
  skillRoot: string,
): SkillFreshnessResult {
  const path = resolveSkillFilePath(agentId, category, skillRoot);

  if (!existsSync(path)) {
    return { boundAt: null, status: null, path };
  }

  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return { boundAt: null, status: null, path };
  }

  const boundAt = extractFrontmatterField(content, 'bound_at');
  const status = extractFrontmatterField(content, 'status');

  return { boundAt, status, path };
}

/**
 * Return a CooldownDecision for a given verdict status.
 *
 * - `null` / absent → `{kind: 'pre_schema'}` (no cooldown; pre-schema or first-develop).
 * - `pending`       → `{kind: 'no_cooldown', status: 'pending'}` (evidence accumulating, allow).
 * - `silent_skill` | `insufficient_evidence` → `{kind: 'cooldown', cooldownMs: 30d}`.
 * - `inconclusive`  → `{kind: 'cooldown', cooldownMs: 60d}` (preserves strike rotation window).
 * - `passed` | `failed` → `{kind: 'cooldown', cooldownMs: Infinity}` (terminal hard-block).
 * - unknown status  → `{kind: 'no_cooldown', status}` (forward-compatible: new statuses skip gate).
 */
export function computeCooldown(status: string | null): CooldownDecision {
  if (!status) return { kind: 'pre_schema' };
  const ms = COOLDOWN_MS[status];
  if (ms === undefined) return { kind: 'no_cooldown', status };
  if (ms === 0) return { kind: 'no_cooldown', status };
  return { kind: 'cooldown', status, cooldownMs: ms };
}

/**
 * Build a user-facing rejection message for the cooldown gate.
 * Includes: agent_id, category, current bound_at, status, remaining
 * days/hours, and an override instruction.
 */
export function formatCooldownMessage(
  agentId: string,
  category: string,
  boundAt: string,
  status: string | null,
  remainingMs: number,
): string {
  const remainingDays = remainingMs / DAY_MS;
  let durationStr: string;
  if (remainingDays >= 1) {
    durationStr = `${Math.ceil(remainingDays)} day(s)`;
  } else {
    const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1_000));
    durationStr = `${remainingHours} hour(s)`;
  }

  const statusLabel = status ?? 'unknown';
  const isTerminal = status === 'passed' || status === 'failed';
  const overrideNote = isTerminal
    ? `Status "${statusLabel}" is a terminal state. Use force: true only if you have reset the skill file manually.`
    : `To override: gossip_skills(action: "develop", agent_id: "${agentId}", category: "${category}", force: true)`;

  return [
    `Skill develop cooldown active — too soon to regenerate.`,
    ``,
    `  agent_id : ${agentId}`,
    `  category : ${category}`,
    `  bound_at : ${boundAt}`,
    `  status   : ${statusLabel}`,
    `  remaining: ${durationStr}`,
    ``,
    overrideNote,
  ].join('\n');
}
