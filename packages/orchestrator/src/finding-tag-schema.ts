/**
 * Single source of truth for the FINDING TAG SCHEMA injected into agent prompts.
 *
 * The consensus parser only accepts `type="finding|suggestion|insight"` —
 * any other value (e.g. "approval", "concern", "risk", "recommendation",
 * "confirmed", "issue", "bug", "warning") is silently dropped by
 * `parseAgentFindingsStrict()`. Skills and prompts must reference THIS
 * schema rather than inventing their own output formats; otherwise findings
 * vanish from the dashboard, scores, and signals.
 *
 * `FINDING_TAG_SCHEMA` is the slim block injected into every dispatch.
 * `CONSENSUS_OUTPUT_FORMAT` extends it with cross-review framing and is
 * injected only when `parts.consensusSummary` is set on assemblePrompt().
 */

export const FINDING_TAG_SCHEMA = `FINDING TAG SCHEMA (output parsing requires this):
- Wrap each verifiable claim in <agent_finding type="..." severity="...">...</agent_finding>
- type MUST be one of: finding | suggestion | insight (any other value is silently DROPPED)
- severity (findings only): critical | high | medium | low
- Do NOT invent new types (e.g., "approval", "concern", "risk", "recommendation", "confirmed", "issue", "bug", "warning") — they will not appear in any dashboard, score, or signal.
- Cite source files inline: <cite tag="file">path:line</cite>`;

export const CONSENSUS_OUTPUT_FORMAT = `⚠ UNKNOWN TYPES ARE SILENTLY DROPPED — only type="finding", type="suggestion", type="insight" are accepted. Any other type value (e.g. approval, concern, risk, recommendation, confirmed) will NOT appear in the dashboard, scores, or signals.

${FINDING_TAG_SCHEMA}

⚠ CRITICAL — OUTPUT PARSING:
Your output is parsed by regex looking for <agent_finding> tags. Findings written as prose, numbered lists, or bullet points will NOT appear correctly in the consensus dashboard, will NOT match peer cross-review, and will NOT count as findings. EVERY finding you want recorded MUST be wrapped in an <agent_finding> tag. This is not optional. The format is shown below.

End your response with a section titled "## Consensus Summary".

SOURCE FILES:
- Always cite original source files, NOT compiled/bundled build output (dist/, build/, out/, *.min.js)
- Build artifacts have different line numbers than source — citing them causes false verification failures
- When in doubt, look for the file with the original extension (.ts, .tsx, .py, .go) not the compiled one (.js, .d.ts)

CITATION RULES:
- Use <cite> tags to reference code. The system resolves these for cross-reviewers automatically.
  Two modes:
    <cite tag="file">auth.ts:38</cite>  — file:line citation, system fetches code snippet
    <cite tag="fn">timingSafeEqual</cite>  — function/variable name, system searches codebase
  Use both when possible: <cite tag="fn">timingSafeEqual</cite> at <cite tag="file">auth.ts:38</cite>
- Claims without <cite> tags receive LOW confidence and will likely be marked UNVERIFIED
- Do NOT fabricate file paths or line numbers — broken citations are worse than no citation

FINDING FORMAT:
Wrap each finding in an <agent_finding> tag. Do NOT use bullet points for findings.

<agent_finding type="finding" severity="high">
Missing Secure cookie flag <cite tag="file">routes.ts:126</cite>
</agent_finding>

<agent_finding type="finding" severity="medium">
<cite tag="fn">authAttempts</cite> map is unbounded <cite tag="file">routes.ts:34</cite>
</agent_finding>

<agent_finding type="suggestion">
Consider changing SameSite=Lax to SameSite=Strict
</agent_finding>

<agent_finding type="insight">
Session tokens use 256-bit entropy — sufficient for production
</agent_finding>

Types: finding (factual, verifiable), suggestion (recommendation), insight (observation)
Severity (for findings only): critical, high, medium, low
Attributes can appear in any order. Do NOT include confirmations.`;
