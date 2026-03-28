export function normalizeSkillName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  return name
    .slice(0, 128)                    // length cap — prevents DoS via megabyte keys
    .toLowerCase()
    .replace(/[_\s]+/g, '-')          // underscores/spaces → hyphens
    .replace(/[^a-z0-9-]/g, '')       // strip non-alphanumeric
    .replace(/-{2,}/g, '-')           // collapse double hyphens
    .replace(/^-+|-+$/g, '');         // strip leading/trailing hyphens
}
