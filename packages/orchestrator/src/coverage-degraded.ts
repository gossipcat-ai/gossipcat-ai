/**
 * Shared build/parse pair for the `coverage_degraded` warning message.
 *
 * The canonical format is:
 *   Coverage degraded: <received>/<expected> agents returned content (dropped: a, b)
 *
 * Three sites must agree on this format:
 *   - Producer: consensus-engine.ts (emits via appendReportWarning)
 *   - Legacy synthesizer: relay/src/dashboard/routes.ts (back-compat read of old
 *     report.coverageDegraded trio for reports written before PR-C)
 *   - Parser: relay/src/dashboard/api-consensus-flow.ts (parses warning message
 *     back into a structured object for the dashboard CoverageDegradedChip)
 *
 * Keeping them in sync via this module means a template change is a one-file edit
 * that fails CI via the round-trip test below (tests/orchestrator/coverage-degraded.test.ts).
 *
 * AGENT-ID ESCAPING NOTE: agent IDs containing a comma or ')' are parsed
 * defensively — the dropped list is extracted from the LAST '(' to the LAST ')'
 * in the string, so an agent id containing ',' (which would look like a list
 * separator) is passed through intact. An agent id containing ')' would
 * truncate the dropped list at the first ')' — document: do not use ')' in
 * agent IDs.
 */

export interface CoverageDegradedParams {
  received: number;
  expected: number;
  droppedAgents: string[];
}

/**
 * Build the canonical `coverage_degraded` warning message.
 * The message always includes the dropped-agent list in the parenthesised
 * suffix, even when the list is empty, so the parser never has to branch on
 * the suffix's presence.
 */
export function buildCoverageDegradedMessage(params: CoverageDegradedParams): string {
  const { received, expected, droppedAgents } = params;
  return `Coverage degraded: ${received}/${expected} agents returned content (dropped: ${droppedAgents.join(', ')})`;
}

/**
 * Parse a `coverage_degraded` warning message back into the structured params.
 * Returns `undefined` on any mismatch — never throws.
 *
 * The dropped list is extracted from the LAST occurrence of ' (dropped: ' to
 * the LAST ')' in the message. This is greedy on the suffix so that an agent
 * id containing a comma is preserved as a single entry when the caller already
 * knows how many agents were dropped (received/expected arithmetic). The tradeoff:
 * an agent id that contains ')' would truncate the list at that point. Such IDs
 * are outside our validated naming scheme.
 */
export function parseCoverageDegradedMessage(message: string): CoverageDegradedParams | undefined {
  // Match "Coverage degraded: <received>/<expected> agents returned content"
  // then capture the suffix (dropped: ...) from the last '(' to the last ')'.
  const headerMatch = message.match(/^Coverage degraded:\s*(\d+)\/(\d+)\s*agents returned content/i);
  if (!headerMatch) return undefined;
  const received = parseInt(headerMatch[1], 10);
  const expected = parseInt(headerMatch[2], 10);

  // Find the last '(dropped: ...' to handle agent ids with nested parentheses
  // or commas in earlier parts of the string.
  const droppedPrefix = ' (dropped: ';
  const lastDroppedIdx = message.lastIndexOf(droppedPrefix);
  let droppedAgents: string[] = [];
  if (lastDroppedIdx !== -1) {
    const afterPrefix = message.slice(lastDroppedIdx + droppedPrefix.length);
    // Trim at the LAST ')' to be greedy about the dropped list content.
    const lastParen = afterPrefix.lastIndexOf(')');
    const droppedRaw = lastParen !== -1 ? afterPrefix.slice(0, lastParen) : afterPrefix;
    droppedAgents = droppedRaw.split(',').map(s => s.trim()).filter(Boolean);
  }

  return { received, expected, droppedAgents };
}
