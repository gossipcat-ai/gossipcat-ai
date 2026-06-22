/**
 * Tests for the docs/RULES.md-backed generateRulesContent() refactor.
 *
 * This covers the contract introduced when rules-content.ts was flipped from
 * a TS template literal to a readFileSync of docs/RULES.md (mirrors the
 * HANDBOOK.md auto-load pattern):
 *
 *   1. Happy path — output contains `## Available Agents` and the agent list
 *      substring is injected verbatim.
 *   2. Placeholder is fully replaced — no leftover `{{AGENT_LIST}}` or stray
 *      `{{` in the output.
 *   3. Missing docs/RULES.md throws a clear error (we do NOT silently fall
 *      back to empty content — that would ship a broken rules file).
 *   4. Regression guard — the `### Implementer naming convention` paragraph
 *      added in PR #237 is present in the output.
 *
 * Complementary tests:
 *   - rules-generation-drift.test.ts: dual-side anchor parity with CLAUDE.md.
 *   - mcp-server-rules-generation.test.ts: mandatory protocol markers.
 */

import * as fs from 'fs';
import * as path from 'path';
import { generateRulesContent } from '../../apps/cli/src/rules-content';

const SAMPLE_AGENT_LIST =
  '- sonnet-reviewer: anthropic/claude-sonnet-4-6 (reviewer) — native\n' +
  '- gemini-tester: google/gemini-2.5-pro (tester)';

describe('generateRulesContent — docs/RULES.md backing file', () => {
  it('returns content containing the Available Agents heading and the agent list verbatim', () => {
    const out = generateRulesContent(SAMPLE_AGENT_LIST);
    expect(out).toContain('## Available Agents');
    expect(out).toContain('sonnet-reviewer');
    expect(out).toContain('gemini-tester');
  });

  it('fully replaces the {{AGENT_LIST}} placeholder — no leftover braces', () => {
    const out = generateRulesContent(SAMPLE_AGENT_LIST);
    // Placeholder must not survive substitution.
    expect(out).not.toContain('{{AGENT_LIST}}');
    // And no stray `{{` pair should be present — if a future edit adds another
    // double-brace token and we forget to substitute it, this catches it.
    // Allow markdown that happens to contain `{{` in code fences only if
    // intentional; today RULES.md has zero `{{` outside the placeholder.
    expect(out.match(/\{\{/g)).toBeNull();
  });

  it('is resilient to `$` in the agent list (no regexp replacement semantics)', () => {
    // split/join is used intentionally so `$&`, `$1`, `$$` etc. in agentList
    // are not interpreted as String.prototype.replace patterns.
    const tricky = '- weird$agent: provider/model ($name placeholder)';
    const out = generateRulesContent(tricky);
    expect(out).toContain(tricky);
  });

  it('throws a clear error when docs/RULES.md cannot be resolved', () => {
    // Temporarily hide the real docs/RULES.md so every fallback candidate
    // fails. We move the file aside and restore it in a finally block.
    const repoRoot = path.resolve(__dirname, '..', '..');
    const real = path.join(repoRoot, 'docs', 'RULES.md');
    const stashed = path.join(repoRoot, 'docs', 'RULES.md.stashed-for-test');
    const origCwd = process.cwd();

    if (!fs.existsSync(real)) {
      throw new Error(
        'Test precondition failed: docs/RULES.md should exist before this test runs.',
      );
    }
    fs.renameSync(real, stashed);
    // Also chdir to a throwaway dir so the `cwd` candidate in the fallback
    // chain can't resolve to a sibling docs/RULES.md.
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rules-test-'));
    try {
      process.chdir(tmp);
      expect(() => generateRulesContent(SAMPLE_AGENT_LIST)).toThrow(/docs\/RULES\.md not found/);
    } finally {
      process.chdir(origCwd);
      fs.renameSync(stashed, real);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('preserves the PR #237 "Implementer naming convention" paragraph', () => {
    const out = generateRulesContent(SAMPLE_AGENT_LIST);
    expect(out).toContain('### Implementer naming convention');
    expect(out).toContain('-implementer');
    expect(out).toContain('verify-the-premise');
  });
});
