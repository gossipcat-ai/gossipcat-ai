import { parseSkillFrontmatter } from '@gossip/orchestrator';

describe('parseSkillFrontmatter', () => {
  it('parses valid frontmatter with all fields', () => {
    const md = `---
name: dos-resilience
description: Review code for DoS vectors.
keywords: [dos, rate-limit, payload]
generated_by: orchestrator
sources: 3 suggestions from sonnet-reviewer
status: active
---

# DoS Resilience

## Approach
Check endpoints.`;

    const result = parseSkillFrontmatter(md);
    expect(result).toEqual({
      name: 'dos-resilience',
      description: 'Review code for DoS vectors.',
      keywords: ['dos', 'rate-limit', 'payload'],
      generated_by: 'orchestrator',
      sources: '3 suggestions from sonnet-reviewer',
      status: 'active',
      // task_type coerces to 'any' when omitted — see skill-parser.ts ternary.
      task_type: 'any',
      // category/mode remain undefined but are surfaced as own properties.
      category: undefined,
      mode: undefined,
    });
  });

  it('returns null for content with no frontmatter', () => {
    const md = `# Just a title\n\nSome content`;
    expect(parseSkillFrontmatter(md)).toBeNull();
  });

  it('returns null for malformed frontmatter', () => {
    const md = `---\ninvalid yaml: [broken\n---\nContent`;
    expect(parseSkillFrontmatter(md)).toBeNull();
  });

  it('handles missing optional fields', () => {
    const md = `---\nname: test-skill\ndescription: A test.\nkeywords: [test]\nstatus: draft\n---\nBody`;
    const result = parseSkillFrontmatter(md);
    expect(result?.name).toBe('test-skill');
    expect(result?.generated_by).toBeUndefined();
    expect(result?.sources).toBeUndefined();
  });

  it('handles keywords as comma-separated string', () => {
    const md = `---\nname: test\ndescription: desc\nkeywords: dos, rate-limit, payload\nstatus: active\n---\nBody`;
    const result = parseSkillFrontmatter(md);
    expect(result?.keywords).toEqual(['dos', 'rate-limit', 'payload']);
  });

  it('normalizes skill name in frontmatter', () => {
    const md = `---\nname: DoS_Resilience\ndescription: desc\nkeywords: [dos]\nstatus: active\n---\nBody`;
    const result = parseSkillFrontmatter(md);
    expect(result?.name).toBe('dos-resilience');
  });
});
