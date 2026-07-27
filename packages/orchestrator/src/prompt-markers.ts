/**
 * Single source of truth for the prompt's STRUCTURAL BLOCK MARKERS, and the
 * one sanitizer that neutralises them inside untrusted content (issue #680).
 *
 * ── Why this module exists ────────────────────────────────────────────────
 * Issue #679 hardened ONE path: skill file content was scrubbed of
 * `--- SKILLS ---` / `--- END SKILLS ---` before being framed by
 * `wrapSkillsBlock`. Every other untrusted-content path — agent memory
 * (MEMORY.md, cognitive knowledge files, calibration), prefetched consensus
 * findings, prior-correction snippets, lesson cards, and the LLM-generated
 * LENS — had no equivalent guard, despite carrying the same class of input:
 * LLM-authored text written verbatim to disk and later interpolated into a
 * prompt. Three fable-reviewer memory files in this repo were already
 * contaminated with a literal `--- END SKILLS ---` (written benignly while
 * documenting #679).
 *
 * ── The list decision (operator, issue #680 discussion) ───────────────────
 * The list below is ALL structural markers the prompt assembler and the
 * lesson injector emit — NOT just SKILLS. The alternative considered was a
 * SKILLS-only list, on the reasoning that memory is assembled into the suffix
 * (prompt-assembler.ts, priority-3 block) AFTER the SKILLS block has already
 * closed, so an injected terminator cannot truncate SKILLS today. That
 * reasoning was rejected: the ordering guarantee is POSITIONAL, not enforced,
 * and a forged marker of any kind makes `countClose(assembled) === 1`-style
 * structural checks unreliable. Sanitizing every marker costs one alternation
 * branch each and removes the need to re-audit block ordering whenever the
 * assembler changes.
 *
 * Every entry here is verified present in the emitting code:
 *   AGENT MEMORY, MEMORY, SKILLS, LENS, PROJECT, SPEC REVIEW,
 *   FINDING TAG SCHEMA, CONSENSUS OUTPUT FORMAT  → prompt-assembler.ts
 *   RECALLED LESSONS                             → lesson-injector.ts
 *
 * Deliberately NOT in the list: the `---SYSTEM---` / `---USER---` / `---END---`
 * cross-review prompt-delivery envelope (apps/cli/src/handlers/collect.ts).
 * That is a different structural family with a different producer, and a bare
 * `--- END ---` is plausible benign prose that this sanitizer would mangle.
 * Adding it needs its own scoped change.
 */

/**
 * Structural block names, WITHOUT the surrounding dashes and without the
 * `END ` prefix (the pattern derives both forms).
 *
 * Order matters for one pair only: `AGENT MEMORY` must precede `MEMORY` for
 * readability of intent. It is not load-bearing — the alternation is anchored
 * at a fixed offset after the dashes, so `MEMORY` cannot match the `AGENT`
 * text of `--- AGENT MEMORY ---` regardless of order.
 */
export const PROTECTED_PROMPT_MARKERS: readonly string[] = [
  'AGENT MEMORY',
  'MEMORY',
  'SKILLS',
  'LENS',
  'PROJECT',
  'SPEC REVIEW',
  'RECALLED LESSONS',
  'FINDING TAG SCHEMA',
  'CONSENSUS OUTPUT FORMAT',
];

/** Default replacement token. Contains no dash — see `assertDashFree`. */
export const MARKER_REDACTION = '[content: delimiter removed]';

/**
 * The marker pattern, built FROM the list so the list is genuinely the single
 * source of truth — no second hand-maintained regex can drift from it.
 *
 * Bounds are inherited from the #679 analysis and are each load-bearing:
 *
 *  * `-{3,}` not `-{2,}`: `-- END SKILLS --` is not a delimiter any consumer
 *    reads, so rewriting it would be over-sanitization. `{3,}` rather than
 *    exactly 3 is still required — `---- END SKILLS ----` DOES contain a live
 *    3-dash marker.
 *  * `END\s+` not `END[\s_-]*`: `END_SKILLS` / `END-SKILLS` are not
 *    delimiters. Matching them would also make the pass non-idempotent against
 *    its own historical output.
 *  * a bare `---` never matches (a marker name is required), so YAML
 *    frontmatter fences, the `\n\n---\n\n` inter-skill separator in
 *    skill-loader.ts, and the `\n\n---\n\nTask:` separator in
 *    prompt-assembler.ts are all untouched.
 *  * interior spaces become `\s+`, so a newline-folded `--- AGENT\nMEMORY ---`
 *    is caught too.
 *
 * Module-level and global: `String.prototype.replace` resets `lastIndex` on a
 * global regex before and after the call, so sharing one compiled instance
 * across calls is safe. Do NOT call `.test()` on it — that WOULD carry
 * `lastIndex` between calls.
 */
const PROTECTED_MARKER_RE = new RegExp(
  `-{3,}\\s*(?:END\\s+)?(?:${PROTECTED_PROMPT_MARKERS.map(m => m.split(' ').join('\\s+')).join('|')})\\s*-{3,}`,
  'gi',
);

/**
 * The replacement must contribute no dash, or the sanitizer can re-form the
 * very marker it just consumed. This is the exact bug #679 fixed: the previous
 * replacement `'--- END-SKILLS ---'` ended in `---`, re-supplying the dashes
 * the match had taken, so `--- END SKILLS --- END SKILLS ---` left one live
 * terminator behind. Fail-closed rather than silently accept a caller that
 * reintroduces it.
 */
function assertDashFree(replacement: string): void {
  if (replacement.includes('-')) {
    throw new Error(
      `sanitizePromptMarkers: replacement must contain no "-" (got ${JSON.stringify(replacement)}) — `
      + 'a dash-bearing replacement can re-form a live delimiter.',
    );
  }
}

/**
 * Strip every protected structural marker from untrusted content.
 *
 * INJECTION-TIME transformation only. Never write the result back to the
 * source file: `.gossip/` is operational state, and the contaminated memory
 * files are the real-world regression fixtures.
 *
 * Invariant: for ANY input, the output contains zero substrings matching
 * `/-{3,}\s*(?:END\s+)?<any protected marker>\s*-{3,}/i`. This holds because
 * every marker-shaped substring is itself matched by the pattern, and the
 * replacement contains no character of the marker alphabet, so no surviving
 * match can span it. Consequently the function is also idempotent.
 *
 * @param content     untrusted text (memory body, lesson excerpt, lens, skill file)
 * @param replacement token substituted for each marker; must contain no `-`.
 *                    Pass `''` where the marker is expected benign generator
 *                    output that should vanish rather than leave noise.
 */
export function sanitizePromptMarkers(
  content: string,
  replacement: string = MARKER_REDACTION,
): string {
  assertDashFree(replacement);
  return content.replace(PROTECTED_MARKER_RE, replacement);
}
