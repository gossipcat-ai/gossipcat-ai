/**
 * Tests for generateRulesContent() — verifies all mandatory markers present
 * in the generated CLAUDE.md / rules file so install-drift regressions are
 * caught at CI time.
 *
 * generateRulesContent is exported from rules-content.ts (side-effect-free
 * module) so no mocking is required — the function is a pure string builder.
 */

import { generateRulesContent } from '../../apps/cli/src/rules-content';

// ── Helper ────────────────────────────────────────────────────────────────
function makeContent(): string {
  return generateRulesContent(
    '- sonnet-reviewer: anthropic/claude-sonnet-4-6 (reviewer) — native\n- gemini-tester: google/gemini-2.5-pro (tester)'
  );
}

// ── Mandatory marker tests ─────────────────────────────────────────────────
describe('generateRulesContent — mandatory markers', () => {
  let content: string;
  beforeAll(() => { content = makeContent(); });

  it('contains STEP 0 ToolSearch call for gossip_status', () => {
    expect(content).toContain('ToolSearch(query:');
    expect(content).toContain('select:mcp__gossipcat__gossip_status');
  });

  it('contains ## Your Role orchestrator preamble', () => {
    expect(content).toContain('## Your Role');
  });

  it('contains gossip_verify_memory protocol', () => {
    expect(content).toContain('gossip_verify_memory');
  });

  it('contains finding_id in signal example', () => {
    expect(content).toContain('finding_id');
  });

  it('contains gossip_skills develop call for agent accuracy', () => {
    expect(content).toContain('gossip_skills(action: "develop"');
  });

  it('contains memory hygiene status: open field', () => {
    expect(content).toContain('status: open');
  });

  it('contains dispatch summary box table header', () => {
    expect(content).toContain('┌─ gossipcat dispatch');
  });
});

describe('generateRulesContent — agent list injection', () => {
  it('injects agent list into output', () => {
    const result = generateRulesContent('- my-agent: openai/gpt-4o (custom)');
    expect(result).toContain('my-agent');
  });

  it('handles empty agent list without throwing', () => {
    expect(() => generateRulesContent('')).not.toThrow();
  });
});
