/**
 * CLAUDE.md ↔ generateRulesContent drift detector
 * ─────────────────────────────────────────────────
 * This file is a Layer 1 drift guard, analogous to
 * tests/orchestrator/completion-signals-parity.test.ts.
 *
 * It maintains a curated allowlist of anchors that MUST be present in BOTH:
 *   (a) the root CLAUDE.md (source of truth for humans reading the repo), and
 *   (b) the output of generateRulesContent() (source of truth for the
 *       generated .claude/rules/gossipcat.md that every Claude Code session
 *       reads on startup).
 *
 * When the two drift — e.g. a protocol section is added to CLAUDE.md but
 * never wired into the generator, or the generator is refactored and a
 * section silently drops — this test fails at CI time before users are
 * affected.
 *
 * ── How to extend ────────────────────────────────────────────────────────
 *
 * When you add a new mandatory protocol section:
 *
 *   (1) Update CLAUDE.md — add or update the section in the root CLAUDE.md
 *       file. This is the human-readable contract.
 *
 *   (2) Update generateRulesContent in apps/cli/src/rules-content.ts — wire
 *       the same section into the generator so installed copies also receive
 *       it. The generator output is what Claude Code actually reads per session.
 *
 *   (3) Append an anchor entry to MANDATORY_CLAUDE_ANCHORS below — add a
 *       `{ anchor, note }` object whose `anchor` is a stable substring
 *       present in both CLAUDE.md and the generator output. The `note` string
 *       becomes the `it()` description and should explain WHY the anchor
 *       matters (what protocol break it would catch).
 *
 * ── Design notes ─────────────────────────────────────────────────────────
 *
 * Anchors are human-curated, NOT auto-discovered from markdown. Auto-
 * discovery is brittle: formatting changes produce false failures, and
 * section headings are too coarse to guard specific protocol invariants.
 * A curated allowlist is an explicit contract: reviewers can see exactly
 * what is considered mandatory and why.
 *
 * Use the most specific stable substring that is unlikely to appear
 * accidentally in unrelated text. Prefer function-call fragments
 * (e.g. `gossip_skills(action`) over section headings alone.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { generateRulesContent } from '../../apps/cli/src/rules-content';

// ── Anchor registry ───────────────────────────────────────────────────────

interface Anchor {
  /** Substring that must be present in both CLAUDE.md and generator output. */
  anchor: string;
  /**
   * Human-readable description of what protocol invariant this anchor guards.
   * Becomes the `it()` label.
   */
  note: string;
}

/**
 * The committed set of mandatory anchors.
 *
 * Each entry represents a protocol invariant that MUST be present in both
 * the root CLAUDE.md and the generated rules file. A missing anchor on
 * either side indicates drift that can silently degrade session behaviour.
 *
 * See top-of-file block comment for the 3-step extension process.
 */
const MANDATORY_CLAUDE_ANCHORS: readonly Anchor[] = [
  {
    anchor: 'gossip_verify_memory',
    note: 'backlog memory verification protocol is present on both sides',
  },
  {
    anchor: 'finding_id',
    note: 'finding_id mandatory signal field is documented on both sides',
  },
  {
    anchor: 'ToolSearch(query:',
    note: 'STEP 0 deferred-tool bootstrap call is present on both sides',
  },
  {
    anchor: '## Your Role',
    note: 'orchestrator role heading is published on both sides',
  },
  {
    anchor: 'gossip_skills(action',
    note: 'skill development workflow call is present on both sides',
  },
  {
    anchor: 'status: open',
    note: 'memory hygiene status field convention is present on both sides',
  },
  {
    anchor: '┌─ gossipcat dispatch',
    note: 'dispatch summary box format is present on both sides',
  },
] as const;

// ── Setup ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(__dirname, '..', '..');

/** Stable sample agent list — kept minimal; content doesn't affect anchor tests. */
const SAMPLE_AGENT_LIST =
  '- sonnet-reviewer: anthropic/claude-sonnet-4-6 (reviewer) — native\n' +
  '- gemini-tester: google/gemini-2.5-pro (tester)';

let claudeMdContent: string;
let generatorOutput: string;

beforeAll(() => {
  claudeMdContent = readFileSync(resolve(PROJECT_ROOT, 'CLAUDE.md'), 'utf-8');
  generatorOutput = generateRulesContent(SAMPLE_AGENT_LIST);
});

// ── Dual-side anchor assertions ───────────────────────────────────────────

describe('CLAUDE.md ↔ generateRulesContent drift detector', () => {
  for (const { anchor, note } of MANDATORY_CLAUDE_ANCHORS) {
    // Each anchor gets two sub-assertions: one per side. Using a single it()
    // per anchor keeps the failure message readable — you see exactly which
    // anchor failed and on which side.
    it(note, () => {
      expect(claudeMdContent).toContain(anchor);
      expect(generatorOutput).toContain(anchor);
    });
  }
});

// ── Generator smoke test ──────────────────────────────────────────────────

describe('generateRulesContent — baseline contract', () => {
  it('returns a non-empty string', () => {
    expect(generatorOutput.length).toBeGreaterThan(0);
  });

  it('injects the agent list verbatim', () => {
    expect(generatorOutput).toContain('sonnet-reviewer');
    expect(generatorOutput).toContain('gemini-tester');
  });

  it('handles empty agent list without throwing', () => {
    expect(() => generateRulesContent('')).not.toThrow();
  });
});
