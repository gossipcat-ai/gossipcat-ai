/**
 * generateRulesContent — pure function, no module-scope side effects.
 *
 * Extracted from mcp-server-sdk.ts so test files can import this without
 * triggering the shebang + stderr-redirect + mkdirSync code at the top of
 * mcp-server-sdk.ts.
 *
 * Content is loaded from docs/RULES.md (single source of truth, tracked in
 * git, also inlined by gossip_status via a similar fallback chain). The
 * `{{AGENT_LIST}}` placeholder in the markdown is substituted with the
 * caller-supplied agent list. Mirrors the HANDBOOK.md auto-load pattern in
 * mcp-server-sdk.ts (see the `handbookCandidates` fallback chain there).
 *
 * Fallback chain for resolving docs/RULES.md:
 *   (a) `${cwd}/docs/RULES.md`                — dev-repo cwd
 *   (b) `${__dirname}/../docs/RULES.md`       — npm-install layout (dist-mcp sibling)
 *   (c) `${__dirname}/docs/RULES.md`          — defensive
 *
 * If the file cannot be found at any fallback, this throws. We intentionally
 * do NOT fall back to an empty or minimal string: a silent empty rules file
 * would let `gossip_setup` ship a broken `.claude/rules/gossipcat.md` without
 * operator visibility, which is exactly the install-drift class of bug this
 * refactor is meant to prevent.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { detectNativeHost, type NativeHost } from './native-host-bridge';

/** Placeholder token in docs/RULES.md that gets replaced with the agent list.
 *  Double-braces so it's unambiguous vs any literal `${...}` in markdown. */
const AGENT_LIST_PLACEHOLDER = '{{AGENT_LIST}}';

/**
 * Resolve the docs/RULES.md path via the same fallback chain used for
 * docs/HANDBOOK.md in `gossip_status`. Returns the first path that exists, or
 * `null` if none do.
 */
function resolveRulesPath(host: NativeHost = detectNativeHost()): string | null {
  const fileName = host === 'cursor' ? 'CURSOR_RULES.md' : 'RULES.md';
  const candidates = [
    join(process.cwd(), 'docs', fileName),
    join(__dirname, '..', 'docs', fileName),
    join(__dirname, 'docs', fileName),
    // Fallback: bundled RULES.md when CURSOR_RULES.md not yet shipped
    ...(host === 'cursor' ? [
      join(process.cwd(), 'docs', 'RULES.md'),
      join(__dirname, '..', 'docs', 'RULES.md'),
    ] : []),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Generate the rules file content written to `.claude/rules/gossipcat.md` by
 * `gossip_setup`. Reads the static content from `docs/RULES.md` (tracked in
 * git) and substitutes the `{{AGENT_LIST}}` placeholder with `agentList`.
 *
 * @param agentList Markdown-formatted bullet list of configured agents. The
 *                  substring is injected verbatim; caller is responsible for
 *                  formatting (one bullet per line).
 * @returns The complete rules file body.
 * @throws If `docs/RULES.md` cannot be located in any of the fallback paths.
 *         Callers should surface this error — silent fallback would let a
 *         broken install pass `gossip_setup`.
 */
/**
 * @param host Explicit host from detectEnvironment() — avoids env-var bleed between
 *             Claude Code and Cursor when generating rules at gossip_setup time.
 */
export function generateRulesContent(agentList: string, host?: NativeHost): string {
  const resolvedHost = host ?? detectNativeHost();
  const rulesPath = resolveRulesPath(resolvedHost);
  if (!rulesPath) {
    throw new Error(
      `[gossipcat] generateRulesContent: docs/RULES.md not found for host=${resolvedHost} ` +
        `(cwd=${process.cwd()}, dirname=${__dirname}). ` +
        'Expected docs/RULES.md or docs/CURSOR_RULES.md tracked in the gossipcat repo or shipped alongside the MCP bundle.',
    );
  }
  let template = readFileSync(rulesPath, 'utf-8');
  if (resolvedHost === 'cursor' && rulesPath.endsWith('RULES.md')) {
    template = template
      .replace(/Agent\(\)/g, 'Task()')
      .replace(/Agent\(/g, 'Task(')
      .replace(/Claude Code/g, 'Cursor');
  }
  // Use split/join rather than String.prototype.replace so a `$` in agentList
  // isn't interpreted as a replacement pattern.
  return template.split(AGENT_LIST_PLACEHOLDER).join(agentList);
}
