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

  it('strips surrounding double quotes from scalar values', () => {
    const md = `---\nname: t\ndescription: d\nkeywords: [k]\nstatus: "pending"\n---\nBody`;
    const result = parseSkillFrontmatter(md);
    expect(result?.status).toBe('pending');
  });

  it('strips surrounding single quotes from scalar values', () => {
    const md = `---\nname: t\ndescription: d\nkeywords: [k]\nstatus: 'pending'\n---\nBody`;
    const result = parseSkillFrontmatter(md);
    expect(result?.status).toBe('pending');
  });

  it('round-trips regressed_from_passed_at when set by drift detector', () => {
    const md = `---\nname: t\ndescription: d\nkeywords: [k]\nstatus: inconclusive\nregressed_from_passed_at: "2026-05-14T10:00:00.000Z"\n---\nBody`;
    const result = parseSkillFrontmatter(md);
    expect(result?.regressed_from_passed_at).toBe('2026-05-14T10:00:00.000Z');
  });

  it('leaves regressed_from_passed_at undefined for organically-inconclusive skills', () => {
    const md = `---\nname: t\ndescription: d\nkeywords: [k]\nstatus: inconclusive\n---\nBody`;
    const result = parseSkillFrontmatter(md);
    expect(result?.regressed_from_passed_at).toBeUndefined();
  });

  describe('block-sequence YAML lists', () => {
    it('parses keywords as a block sequence equal to the inline equivalent', () => {
      const inline = `---\nname: t\ndescription: d\nkeywords: [injection, sanitize]\nstatus: active\n---\nBody`;
      const block = `---\nname: t\ndescription: d\nkeywords:\n  - injection\n  - sanitize\nstatus: active\n---\nBody`;

      const inlineResult = parseSkillFrontmatter(inline);
      const blockResult = parseSkillFrontmatter(block);

      expect(blockResult?.keywords).toEqual(['injection', 'sanitize']);
      expect(blockResult?.keywords).toEqual(inlineResult?.keywords);
    });

    it('parses scope as a block sequence', () => {
      const md = `---\nname: t\ndescription: d\nkeywords: [k]\nstatus: active\nscope:\n  - review\n  - research\n---\nBody`;
      const result = parseSkillFrontmatter(md);
      expect(result?.scope).toEqual(['review', 'research']);
    });

    it('handles mixed inline and block-sequence fields on the same file', () => {
      const md = `---\nname: t\ndescription: d\nstatus: active\nscope: [review]\nkeywords:\n  - injection\n  - sanitize\n---\nBody`;
      const result = parseSkillFrontmatter(md);
      expect(result?.scope).toEqual(['review']);
      expect(result?.keywords).toEqual(['injection', 'sanitize']);
    });

    it('applies per-item quote stripping and 100-char cap to block-sequence items', () => {
      const longItem = 'x'.repeat(150);
      const md = `---\nname: t\ndescription: d\nstatus: active\nkeywords:\n  - "quoted"\n  - '${longItem}'\n---\nBody`;
      const result = parseSkillFrontmatter(md);
      expect(result?.keywords).toEqual(['quoted', longItem.slice(0, 100)]);
    });

    it('leaves existing inline-array behavior unchanged (regression)', () => {
      const md = `---\nname: t\ndescription: d\nkeywords: [dos, "rate-limit", 'payload']\nstatus: active\n---\nBody`;
      const result = parseSkillFrontmatter(md);
      expect(result?.keywords).toEqual(['dos', 'rate-limit', 'payload']);
    });

    it('parses zero-indent block sequence items equal to their indented and inline equivalents', () => {
      const inline = `---\nname: t\ndescription: d\nkeywords: [injection, sanitize]\nstatus: active\n---\nBody`;
      const indented = `---\nname: t\ndescription: d\nkeywords:\n  - injection\n  - sanitize\nstatus: active\n---\nBody`;
      // Zero-indent sequence items at column 0 under their key — valid YAML,
      // and common LLM-authoring style.
      const zeroIndent = `---\nname: t\ndescription: d\nkeywords:\n- injection\n- sanitize\nstatus: active\n---\nBody`;

      const inlineResult = parseSkillFrontmatter(inline);
      const indentedResult = parseSkillFrontmatter(indented);
      const zeroIndentResult = parseSkillFrontmatter(zeroIndent);

      expect(zeroIndentResult?.keywords).toEqual(['injection', 'sanitize']);
      expect(zeroIndentResult?.keywords).toEqual(indentedResult?.keywords);
      expect(zeroIndentResult?.keywords).toEqual(inlineResult?.keywords);
    });

    it('does NOT treat `-item` (no space after dash) as a block-sequence item', () => {
      // Pinned behavior: YAML requires a space after `-` for a sequence
      // item. `-item` fails the match, ends the block-sequence context, and
      // (since it has no colon) is skipped entirely rather than collected.
      const md = `---\nname: t\ndescription: d\nkeywords:\n-item\nstatus: active\n---\nBody`;
      const result = parseSkillFrontmatter(md);
      expect(result?.keywords).toEqual([]);
    });
  });

  describe('parse-failure warnings', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
      stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it('returns null and warns to stderr when a required field is missing', () => {
      const md = `---\ndescription: d\nkeywords: [k]\nstatus: active\n---\nBody`;
      const result = parseSkillFrontmatter(md, 'missing-name.md');

      expect(result).toBeNull();
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const [message] = stderrSpy.mock.calls[0];
      expect(message).toContain('[skill-parser]');
      expect(message).toContain('missing required field');
      expect(message).toContain('name');
      expect(message).toContain('missing-name.md');
    });

    it('returns null and does NOT warn when no frontmatter block is present (supported format)', () => {
      const md = `# Just a title\n\nSome content`;
      const result = parseSkillFrontmatter(md, 'no-frontmatter.md');

      expect(result).toBeNull();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('does not warn when parsing succeeds', () => {
      const md = `---\nname: t\ndescription: d\nkeywords: [k]\nstatus: active\n---\nBody`;
      const result = parseSkillFrontmatter(md, 'ok.md');

      expect(result).not.toBeNull();
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });
});
