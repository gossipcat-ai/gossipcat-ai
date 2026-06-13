export function normalizeSkillName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  // NOTE on the empty-string return: a non-empty input that strips to '' (fully
  // non-ASCII, all-separator) intentionally yields ''. Callers such as
  // SkillIndex.bind() use `if (!name) throw 'Invalid skill name'` as a
  // fail-closed validation gate (skill-index.ts) — so '' is the correct signal
  // to REJECT a garbage skill name, NOT a hazard to paper over. (Resolver-pass
  // findings 674baf54:f2/f5/f6 + 9ed8c12f:f5 mischaracterised this; only the
  // cap-ordering below, f3/f4, was a real bug.)
  return name
    .slice(0, 512)                    // cheap pre-slice to bound regex work on huge inputs
    .toLowerCase()
    .replace(/[_\s]+/g, '-')          // underscores/spaces → hyphens
    .replace(/[^a-z0-9-]/g, '')       // strip non-ASCII and non-alphanumeric
    .replace(/-{2,}/g, '-')           // collapse double hyphens
    .replace(/^-+|-+$/g, '')          // strip leading/trailing hyphens
    .slice(0, 128);                   // final cap on the NORMALIZED form (fix f3/f4: was applied to the raw input)
}
