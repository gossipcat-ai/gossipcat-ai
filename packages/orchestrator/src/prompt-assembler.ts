import * as path from 'path';

const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst']);
const SPEC_PATH_PATTERN = /(?:docs\/|specs\/|[\w-]+-(?:design|spec)\.md)/;
const FILE_REF_PATTERN = /(?:`([^`]+\.[a-z]{1,6})`|([a-zA-Z][\w/.@-]+\.[a-z]{1,6})(?::\d+)?)/g;

/**
 * Extract spec/doc file references from task text and optional spec content.
 */
export function extractSpecReferences(taskText: string, specContent?: string): string[] {
  const refs = new Set<string>();

  // Extract spec-like paths from task text
  const taskMatches = taskText.match(FILE_REF_PATTERN);
  if (taskMatches) {
    for (const raw of taskMatches) {
      // Strip backticks and trailing :line
      const cleaned = raw.replace(/^`|`$/g, '').replace(/:\d+$/, '');
      if (cleaned.includes('..')) continue;
      const ext = path.extname(cleaned);
      if (!DOC_EXTENSIONS.has(ext)) continue;
      if (SPEC_PATH_PATTERN.test(cleaned)) {
        refs.add(cleaned);
      }
    }
  }

  // Extract file references from spec content
  if (specContent) {
    let match: RegExpExecArray | null;
    const re = new RegExp(FILE_REF_PATTERN.source, FILE_REF_PATTERN.flags);
    while ((match = re.exec(specContent)) !== null) {
      const filePath = match[1] || match[2];
      if (!filePath) continue;
      const cleaned = filePath.replace(/:\d+$/, '');
      if (cleaned.includes('..')) continue;
      refs.add(cleaned);
    }
  }

  return [...refs];
}

/**
 * Build a cross-reference instruction block for spec-aware review.
 */
export function buildSpecReviewEnrichment(implementationFiles: string[]): string | null {
  if (!implementationFiles.length) return null;

  const fileList = implementationFiles.map((f) => `- ${f}`).join('\n');
  return `IMPORTANT: This task references a spec document.
Before completing:
1. Verify described flows match the implementation
2. Check backwards-compatibility constraints
3. Confirm referenced functions/methods exist

Implementation files to cross-reference:
${fileList}`;
}

/**
 * Assemble memory, lens, skills, context, and gossip into a single prompt string.
 * Order: CHAIN CONTEXT → SESSION CONTEXT → MEMORY → LENS → SKILLS → context
 * Each block is only included if content is provided.
 */
export function assemblePrompt(parts: {
  memory?: string;
  memoryDir?: string;
  lens?: string;
  skills?: string;
  context?: string;
  sessionContext?: string;
  chainContext?: string;
  consensusSummary?: boolean;
  specReviewContext?: string;
  projectStructure?: string;
}): string {
  const blocks: string[] = [];

  if (parts.projectStructure) {
    blocks.push(`\n\n--- PROJECT ---\n${parts.projectStructure}\n--- END PROJECT ---`);
  }

  if (parts.chainContext) {
    blocks.push(`\n\n${parts.chainContext}`);
  }

  if (parts.sessionContext) {
    blocks.push(`\n\n${parts.sessionContext}`);
  }

  if (parts.memory) {
    blocks.push(`\n\n--- MEMORY ---\n${parts.memory}\n--- END MEMORY ---`);
  }

  if (parts.memoryDir) {
    blocks.push(`\n\n--- AGENT MEMORY ---
Your persistent memory directory: ${parts.memoryDir}
Save important learnings using file_write to this directory.
What to save: technology choices, file structure, key patterns, architectural decisions, gotchas.
Use descriptive filenames like: tech-stack.md, project-structure.md, patterns.md
Keep entries concise (5-10 lines each). Update existing files rather than creating new ones.
--- END AGENT MEMORY ---`);
  }

  if (parts.lens) {
    blocks.push(`\n\n--- LENS ---\n${parts.lens}\n--- END LENS ---`);
  }

  if (parts.consensusSummary) {
    blocks.push(`\n\n--- CONSENSUS OUTPUT FORMAT ---
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
Attributes can appear in any order. Do NOT include confirmations.

This section will be used for cross-review with peer agents.
--- END CONSENSUS OUTPUT FORMAT ---`);
  }

  if (parts.skills) {
    blocks.push(`\n\n--- SKILLS ---\n${parts.skills}\n--- END SKILLS ---`);
  }

  if (parts.context) {
    blocks.push(`\n\nContext:\n${parts.context}`);
  }

  if (parts.specReviewContext) {
    blocks.push(`\n\n--- SPEC REVIEW ---\n${parts.specReviewContext}\n--- END SPEC REVIEW ---`);
  }

  let assembled = blocks.join('');

  // Cap total prompt size to prevent context window overflow.
  // ~30K chars ≈ ~8K tokens — leaves room for system prompt + task + tool results.
  const MAX_PROMPT_CHARS = 30_000;
  if (assembled.length > MAX_PROMPT_CHARS) {
    assembled = assembled.slice(0, MAX_PROMPT_CHARS) + '\n\n[Context truncated to fit budget]';
  }

  return assembled;
}
