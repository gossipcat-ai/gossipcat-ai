import { normalizeSkillName } from './skill-name';

/** Status values written by the skill lifecycle: both the authoring-time values
 * ('active', 'draft', 'disabled') and the effectiveness verdict values written
 * by checkEffectiveness() ('passed', 'failed', 'pending', 'flagged_for_manual_review',
 * 'silent_skill', 'insufficient_evidence'). Loader filters on these at dispatch time.
 */
export type SkillStatus =
  | 'active'
  | 'draft'
  | 'disabled'
  | 'passed'
  | 'failed'
  | 'pending'
  | 'flagged_for_manual_review'
  | 'silent_skill'
  | 'insufficient_evidence';

export interface SkillFrontmatter {
  name: string;
  description: string;
  keywords: string[];
  category?: string;
  mode?: 'permanent' | 'contextual';
  generated_by?: string;
  sources?: string;
  status: SkillStatus;
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const lines = match[1].split('\n');
  const fields: Record<string, string> = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields[key] = value;
  }

  if (!fields.name || !fields.description || !fields.status) return null;

  let keywords: string[] = [];
  if (fields.keywords) {
    const raw = fields.keywords;
    if (raw.startsWith('[') && raw.endsWith(']')) {
      keywords = raw.slice(1, -1).split(',').map(k => k.trim().replace(/^['"]|['"]$/g, '').slice(0, 100)).filter(Boolean);
    } else {
      keywords = raw.split(',').map(k => k.trim().slice(0, 100)).filter(Boolean);
    }
  }

  return {
    name: normalizeSkillName(fields.name),
    description: fields.description,
    keywords,
    category: fields.category || undefined,
    mode: (fields.mode === 'contextual' ? 'contextual' : fields.mode === 'permanent' ? 'permanent' : undefined),
    generated_by: fields.generated_by,
    sources: fields.sources,
    status: fields.status as SkillStatus,
  };
}
