/**
 * Append-only JSONL audit trail for force-bypassed skill-develop cooldowns.
 *
 * Written whenever gossip_skills(action: "develop", force: true) is called
 * while a cooldown would otherwise block the request. Parallel to
 * .gossip/forced-saves.jsonl used by gossip_session_save.
 *
 * Schema: {timestamp, agent_id, category, bound_at_before, status_before}
 */
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface ForcedSkillDevelopEntry {
  timestamp: string;
  agent_id: string;
  category: string;
  bound_at_before: string | null | undefined;
  status_before: string | null | undefined;
}

const FORCED_DEVELOPS_FILE = 'forced-skill-develops.jsonl';

/**
 * Append one forced-develop entry to .gossip/forced-skill-develops.jsonl.
 * Best-effort: silently swallows write errors so the main develop path
 * is never blocked by an audit-log failure.
 */
export function appendForcedSkillDevelop(entry: ForcedSkillDevelopEntry): void {
  try {
    const gossipDir = join(process.cwd(), '.gossip');
    mkdirSync(gossipDir, { recursive: true });
    appendFileSync(
      join(gossipDir, FORCED_DEVELOPS_FILE),
      JSON.stringify(entry) + '\n',
    );
  } catch {
    /* best-effort audit — never block the develop path */
  }
}
