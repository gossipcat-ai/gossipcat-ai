import { SkillIndex, SkillIndexData } from '@gossip/orchestrator/skill-index';
import { existsSync } from 'fs';
import { join } from 'path';

export interface SkillsGetResponse { index: SkillIndexData; suggestions: string[]; }
export interface SkillsBindRequest { agent_id: string; skill: string; enabled: boolean; }
export interface SkillsBindResponse { success: boolean; error?: string; }

const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function isCorrupt(projectRoot: string, index: SkillIndex): boolean {
  return existsSync(join(projectRoot, '.gossip', 'skill-index.json')) && !index.exists();
}

export async function skillsGetHandler(projectRoot: string): Promise<SkillsGetResponse> {
  try {
    const index = new SkillIndex(projectRoot);
    return { index: index.getIndex(), suggestions: [] };
  } catch {
    return { index: {}, suggestions: [] };
  }
}

export async function skillsBindHandler(projectRoot: string, body: SkillsBindRequest): Promise<SkillsBindResponse> {
  if (!body.agent_id || !AGENT_ID_RE.test(body.agent_id)) return { success: false, error: 'Invalid agent_id' };
  if (!body.skill || typeof body.skill !== 'string' || !AGENT_ID_RE.test(body.skill)) return { success: false, error: 'Invalid skill name' };
  try {
    const index = new SkillIndex(projectRoot);
    if (isCorrupt(projectRoot, index)) {
      return { success: false, error: 'Could not parse skill-index.json' };
    }
    if (body.enabled) {
      index.bind(body.agent_id, body.skill, { enabled: true, source: 'manual' });
    } else {
      const changed = index.disable(body.agent_id, body.skill);
      if (!changed) return { success: false, error: 'Skill not bound to agent' };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
