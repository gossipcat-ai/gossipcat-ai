import * as path from 'path';
import { FINDING_TAG_SCHEMA, CONSENSUS_OUTPUT_FORMAT } from './finding-tag-schema';

// Re-exported so existing import sites (`@gossip/orchestrator`) keep working.
export { FINDING_TAG_SCHEMA, CONSENSUS_OUTPUT_FORMAT };

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
 * Valid lifecycle states for a spec document.
 * Declared via `status:` field in YAML front-matter.
 */
export type SpecStatus = 'proposal' | 'implemented' | 'retired';

/**
 * Parse minimal YAML front-matter from a spec document. Only extracts the
 * `status` field — a full YAML parse would pull in a dependency and we only
 * need this one value. Returns undefined when no front-matter or no status.
 *
 * Recognizes:
 *   ---
 *   status: proposal
 *   ---
 *
 * Accepts optional quoting and trailing whitespace/comments. Invalid values
 * (anything outside the SpecStatus union) return undefined.
 */
export function parseSpecFrontMatter(content: string): { status?: SpecStatus } {
  // Front matter must start at the very beginning of the file
  if (!content.startsWith('---')) return {};
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return {};
  const body = match[1];
  const statusMatch = body.match(/^\s*status\s*:\s*["']?([a-z_-]+)["']?\s*(?:#.*)?$/m);
  if (!statusMatch) return {};
  const raw = statusMatch[1].toLowerCase();
  if (raw === 'proposal' || raw === 'implemented' || raw === 'retired') {
    return { status: raw };
  }
  return {};
}

/**
 * Build a cross-reference instruction block for spec-aware review.
 *
 * When `status` is provided, the enrichment branches on the spec lifecycle
 * state to give the reviewer explicit framing guidance — this prevents the
 * "NOT IMPLEMENTED" framing drift where agents audit code state against a
 * proposal as if it were a completion report. See consensus round
 * 4ee3xxxx (2026-04-08) and project_task_framing_drift.md for context.
 */
export function buildSpecReviewEnrichment(
  implementationFiles: string[],
  status?: SpecStatus,
): string | null {
  if (!implementationFiles.length && !status) return null;

  const fileList = implementationFiles.length
    ? `\n\nImplementation files to cross-reference:\n${implementationFiles.map((f) => `- ${f}`).join('\n')}`
    : '';

  if (status === 'proposal') {
    return `IMPORTANT: This task references a PROPOSAL spec.
Your job is to find GAPS and ARCHITECTURAL ISSUES in the design, not to audit
current code state. Do NOT generate "NOT IMPLEMENTED" / "does not exist" /
"file not changed" findings — the spec describes INTENDED changes, not current
state. Test the proposal's LOGIC against the code (does the design account for
existing invariants, is the plan consistent, are edge cases handled), not the
code against the proposal.${fileList}`;
  }

  if (status === 'retired') {
    return `IMPORTANT: This task references a RETIRED spec.
Do not apply its claims to current code — the spec is historical and may
describe a design that was superseded or abandoned. Use it only as context
for understanding why the current code looks the way it does.${fileList}`;
  }

  // implemented (default): existing behavior — verify code matches spec
  return `IMPORTANT: This task references a spec document.
Before completing:
1. Verify described flows match the implementation
2. Check backwards-compatibility constraints
3. Confirm referenced functions/methods exist${fileList}`;
}

/**
 * Assemble memory, lens, skills, context, and gossip into a single prompt string.
 *
 * Block order (truncation-aware):
 *   PREFIX (truncatable):  IDENTITY → PROJECT → CHAIN CONTEXT → INSTRUCTIONS → SKILLS
 *   SUFFIX (preserved):    [CONSENSUS FORMAT | FINDING SCHEMA] → [LENS] →
 *                          [SPEC REVIEW] → MEMORY → AGENT MEMORY → SESSION →
 *                          context → TASK
 *
 * Bracketed items are optional — only present when relevant to the task.
 *
 * The slim FINDING TAG SCHEMA is injected for non-consensus dispatches that
 * carry any meaningful content, so the agent's <agent_finding> tags parse
 * correctly when surfaced retroactively by tools like gossip_dispatch.
 *
 * Skills are behavioral methodology (iron laws, methodology, quality gates) —
 * they define HOW the agent thinks. They go in the truncatable prefix on the
 * theory that they are large but also the most expendable single block: we'd
 * rather truncate skills than lose the output schema or the task.
 *
 * The `task` and schema blocks are in the always-preserved suffix because if
 * they are severed the agent cannot do its job — with no task it has nothing
 * to do, and without the schema it emits prose that the consensus parser
 * silently drops.
 */
export function assemblePrompt(parts: {
  /** Identity block (## Identity ...) — placed first, truncatable under memory pressure. */
  identity?: string;
  /** Raw instructions text (agent role/system prompt body). Placed after SKILLS in the truncatable prefix. */
  instructions?: string;
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
  /** Pre-fetched consensus finding snippets to inject under MEMORY block. */
  consensusFindings?: string[];
  /** The actual task to perform — placed last, always preserved under truncation. */
  task?: string;
}): string {
  const prefix: string[] = [];
  const suffix: string[] = [];

  // ── PREFIX (truncatable) ───────────────────────────────────────────────
  if (parts.identity) {
    // Identity block is already self-delimited with "## Identity" heading.
    prefix.push(parts.identity);
  }

  if (parts.projectStructure) {
    prefix.push(`\n\n--- PROJECT ---\n${parts.projectStructure}\n--- END PROJECT ---`);
  }

  if (parts.chainContext) {
    prefix.push(`\n\n${parts.chainContext}`);
  }

  if (parts.instructions) {
    // Instructions are raw prose (agent role / system prompt body). Kept raw
    // to avoid breaking tests that match on existing instruction substrings.
    prefix.push(`\n\n${parts.instructions}`);
  }

  // BEHAVIORAL — skills define how the agent thinks
  if (parts.skills) {
    prefix.push(`\n\n--- SKILLS ---\n${parts.skills}\n--- END SKILLS ---`);
  }

  // ── SUFFIX (preserved under truncation) ────────────────────────────────
  if (parts.consensusSummary) {
    // Consensus dispatches need the full cross-review framing.
    suffix.push(`\n\n--- CONSENSUS OUTPUT FORMAT ---\n${CONSENSUS_OUTPUT_FORMAT}\n\nThis section will be used for cross-review with peer agents.\n--- END CONSENSUS OUTPUT FORMAT ---`);
  } else {
    // Non-consensus dispatches still need the type enum + anti-invention rule
    // so agent output is parseable when the dashboard retroactively shows it.
    // Slim block — no cross-review framing.
    //
    // Skip entirely when no other content is present (e.g. assemblePrompt({}))
    // so tests + callers that deliberately ask for an empty prompt still get one.
    const hasAnyMeaningfulPart = !!(
      parts.identity || parts.instructions ||
      parts.memory || parts.memoryDir || parts.lens || parts.skills ||
      parts.context || parts.sessionContext || parts.chainContext ||
      parts.specReviewContext || parts.projectStructure ||
      parts.task ||
      (parts.consensusFindings && parts.consensusFindings.length > 0)
    );
    if (hasAnyMeaningfulPart) {
      suffix.push(`\n\n--- FINDING TAG SCHEMA ---\n${FINDING_TAG_SCHEMA}\n--- END FINDING TAG SCHEMA ---`);
    }
  }

  if (parts.lens) {
    suffix.push(`\n\n--- LENS ---\n${parts.lens}\n--- END LENS ---`);
  }

  if (parts.specReviewContext) {
    suffix.push(`\n\n--- SPEC REVIEW ---\n${parts.specReviewContext}\n--- END SPEC REVIEW ---`);
  }

  if (parts.memory || (parts.consensusFindings && parts.consensusFindings.length > 0)) {
    const memParts: string[] = [];
    if (parts.memory) memParts.push(parts.memory);
    if (parts.consensusFindings && parts.consensusFindings.length > 0) {
      // Total budget: ~600 chars (3 × 200), injected as a subsection so agents
      // can distinguish these from their own knowledge files.
      const findingsBlock =
        '### Recent Consensus Findings\n' +
        parts.consensusFindings.map((f, i) => `${i + 1}. ${f}`).join('\n');
      memParts.push(findingsBlock);
    }
    suffix.push(`\n\n--- MEMORY ---\n${memParts.join('\n\n')}\n--- END MEMORY ---`);
  }

  if (parts.memoryDir) {
    suffix.push(`\n\n--- AGENT MEMORY ---
Your persistent memory directory: ${parts.memoryDir}
Save important learnings using file_write to this directory.
What to save: technology choices, file structure, key patterns, architectural decisions, gotchas.
Use descriptive filenames like: tech-stack.md, project-structure.md, patterns.md
Keep entries concise (5-10 lines each). Update existing files rather than creating new ones.
--- END AGENT MEMORY ---`);
  }

  if (parts.sessionContext) {
    suffix.push(`\n\n${parts.sessionContext}`);
  }

  if (parts.context) {
    suffix.push(`\n\nContext:\n${parts.context}`);
  }

  // TASK last — the most important surviving element.
  if (parts.task) {
    suffix.push(`\n\n---\n\nTask: ${parts.task}`);
  }

  // Cap total prompt size to prevent context window overflow.
  // ~30K chars ≈ ~8K tokens — leaves room for system prompt + tool results.
  // Truncate only the prefix so the suffix (schema + task) always survives.
  // See consensus finding 12827629-fa9a4660:f8 (native consensus block-order
  // regression) — concatenating then truncating could sever CONSENSUS OUTPUT
  // FORMAT, causing silent consensus degradation.
  const MAX_PROMPT_CHARS = 30_000;
  const suffixStr = suffix.join('');
  let prefixStr = prefix.join('');
  const budget = Math.max(0, MAX_PROMPT_CHARS - suffixStr.length);
  if (prefixStr.length > budget) {
    prefixStr = prefixStr.slice(0, budget) + '\n\n[Context truncated to fit budget]';
  }
  return prefixStr + suffixStr;
}
