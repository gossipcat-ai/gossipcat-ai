import { normalizeSkillName } from './skill-name';

export interface SkillFrontmatter {
  name: string;
  description: string;
  keywords: string[];
  generated_by?: string;
  sources?: string;
  status: 'active' | 'draft' | 'disabled';
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
      keywords = raw.slice(1, -1).split(',').map(k => k.trim()).filter(Boolean);
    } else {
      keywords = raw.split(',').map(k => k.trim()).filter(Boolean);
    }
  }

  return {
    name: normalizeSkillName(fields.name),
    description: fields.description,
    keywords,
    generated_by: fields.generated_by,
    sources: fields.sources,
    status: fields.status as 'active' | 'draft' | 'disabled',
  };
}
