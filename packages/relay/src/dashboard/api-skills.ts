import { SkillIndex, SkillIndexData } from '@gossip/orchestrator/skill-index';

export interface SkillsGetResponse { index: SkillIndexData; suggestions: string[]; }
export interface SkillsBindRequest { agent_id: string; skill: string; enabled: boolean; }
export interface SkillsBindResponse { success: boolean; error?: string; }

const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export async function skillsGetHandler(projectRoot: string): Promise<SkillsGetResponse> {
  const index = new SkillIndex(projectRoot);
  return { index: index.getIndex(), suggestions: [] };
}

export async function skillsBindHandler(projectRoot: string, body: SkillsBindRequest): Promise<SkillsBindResponse> {
  if (!body.agent_id || !AGENT_ID_RE.test(body.agent_id)) return { success: false, error: 'Invalid agent_id' };
  if (!body.skill || typeof body.skill !== 'string') return { success: false, error: 'Invalid skill name' };
  try {
    const index = new SkillIndex(projectRoot);
    const changed = body.enabled ? index.enable(body.agent_id, body.skill) : index.disable(body.agent_id, body.skill);
    if (!changed) return { success: false, error: 'Skill not bound to agent' };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
