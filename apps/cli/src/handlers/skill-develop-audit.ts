/**
 * Append-only JSONL audit trail for every skill-develop call.
 *
 * Replaces the former `forced-skill-develops.ts` which only logged `force: true`
 * bypasses. This module logs EVERY develop invocation (gate-pass, gate-block,
 * force-bypass, auto-collect) so churn patterns are visible in the dashboard.
 *
 * Canonical path: `.gossip/skill-develop-audit.jsonl`
 * Legacy alias  : `.gossip/forced-skill-develops.jsonl` (dual-write for one release)
 *
 * Schema per entry:
 *   { timestamp, agent_id, category, bound_at_before, status_before,
 *     gated, gate_reason, forced, source }
 *
 * Field semantics:
 *   gated: true           — gate fired and blocked (rejection path)
 *   gated: false, forced: false — gate passed normally
 *   gated: false, forced: true  — user bypassed via force: true
 *   source: "mcp"         — explicit gossip_skills(action: "develop") call
 *   source: "auto_collect" — auto-develop loop in collect.ts
 */
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface SkillDevelopAuditEntry {
  timestamp: string;
  agent_id: string;
  category: string;
  bound_at_before: string | null | undefined;
  status_before: string | null | undefined;
  gated: boolean;
  gate_reason: string | null;
  forced: boolean;
  source: 'mcp' | 'auto_collect';
}

const AUDIT_FILE = 'skill-develop-audit.jsonl';
/** Legacy alias — written for one release so dashboards reading the old path still work. */
const LEGACY_FILE = 'forced-skill-develops.jsonl';

/**
 * Append one audit entry to `.gossip/skill-develop-audit.jsonl`.
 *
 * Also writes to `.gossip/forced-skill-develops.jsonl` for one-release backwards
 * compatibility. Best-effort: silently swallows write errors so the main develop
 * path is never blocked by an audit-log failure.
 */
export function appendSkillDevelopAudit(entry: SkillDevelopAuditEntry): void {
  try {
    const gossipDir = join(process.cwd(), '.gossip');
    mkdirSync(gossipDir, { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(join(gossipDir, AUDIT_FILE), line);
    // Legacy dual-write — remove after one release
    appendFileSync(join(gossipDir, LEGACY_FILE), line);
  } catch {
    /* best-effort audit — never block the develop path */
  }
}
