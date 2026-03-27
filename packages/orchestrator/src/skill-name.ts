export function normalizeSkillName(name: string): string {
  return name.toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
}
