import { parseSkillFrontmatter } from '@gossip/orchestrator';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

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

    it('backfills description from name and warns exactly once when only description is missing', () => {
      // Generated agent-local skills (e.g. .gossip/agents/<id>/skills/
      // resource-exhaustion.md) routinely omit `description`. Preserve the
      // skill with a humanized stand-in instead of dropping it.
      const md = `---\nname: resource-exhaustion\nkeywords: [dos]\nstatus: active\n---\nBody`;
      const result = parseSkillFrontmatter(md, 'resource-exhaustion.md');

      expect(result).not.toBeNull();
      expect(result!.description).toBe('resource exhaustion');
      expect(result!.status).toBe('active');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const [message] = stderrSpy.mock.calls[0];
      expect(message).toContain('[skill-parser]');
      expect(message).toContain('backfilled');
      expect(message).toContain('description');
      expect(message).toContain('resource-exhaustion.md');
    });

    it('backfills status to active and warns once when only status is missing', () => {
      const md = `---\nname: t\ndescription: d\nkeywords: [k]\n---\nBody`;
      const result = parseSkillFrontmatter(md, 'no-status.md');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('active');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const [message] = stderrSpy.mock.calls[0];
      expect(message).toContain('backfilled');
      expect(message).toContain('status');
    });

    it('backfills BOTH description and status in a single joined warning when both are missing', () => {
      const md = `---\nname: resource-exhaustion\nkeywords: [dos]\n---\nBody`;
      const result = parseSkillFrontmatter(md, 'both-missing.md');

      expect(result).not.toBeNull();
      expect(result!.description).toBe('resource exhaustion');
      expect(result!.status).toBe('active');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const [message] = stderrSpy.mock.calls[0];
      expect(message).toContain('backfilled missing field(s): description, status');
    });

    it('rejects a quoted-whitespace name (trims after quote-strip) rather than backfilling from empty', () => {
      // `name: "   "` must not slip the `!name` guard as three truthy spaces
      // (consensus 41d9d4d9). The post-strip trim collapses it to '' → dropped.
      const md = `---\nname: "   "\ndescription: d\nstatus: active\n---\nBody`;
      const result = parseSkillFrontmatter(md, 'whitespace-name.md');

      expect(result).toBeNull();
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0][0]).toContain('missing required field(s): name');
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

  // Regression: every SHIPPED default skill that carries a frontmatter block
  // must satisfy the required-field contract, or the loud warnParseFailure path
  // spams stderr on every install/dispatch and the skill's metadata is dropped.
  // A missing `status:` on memory-retrieval.md reached users in v0.6.10 — this
  // guards the whole default-skills dir so it can't recur.
  describe('bundled default skills parse cleanly', () => {
    const defaultSkillsDir = resolve(__dirname, '../../packages/orchestrator/src/default-skills');
    const frontmatterSkills = readdirSync(defaultSkillsDir)
      .filter(f => f.endsWith('.md'))
      .filter(f => readFileSync(join(defaultSkillsDir, f), 'utf8').startsWith('---\n'));

    it('has at least one frontmatter-bearing default skill to check', () => {
      expect(frontmatterSkills.length).toBeGreaterThan(0);
    });

    it.each(frontmatterSkills)('%s parses non-null with name/description/status and no warning', (file) => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const content = readFileSync(join(defaultSkillsDir, file), 'utf8');
        const result = parseSkillFrontmatter(content, file);
        expect(result).not.toBeNull();
        expect(result!.name).toBeTruthy();
        expect(result!.description).toBeTruthy();
        expect(result!.status).toBeTruthy();
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});
