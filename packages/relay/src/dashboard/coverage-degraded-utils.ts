/**
 * Local relay-package copy of the coverage_degraded build/parse pair.
 * The canonical implementation and tests live in packages/orchestrator/src/coverage-degraded.ts.
 * This copy exists because the relay package's tsc cannot import from
 * @gossip/orchestrator when built in a git worktree without a local npm
 * workspace install (the worktree shares the root node_modules which points
 * to the master-branch orchestrator dist, not the worktree's).
 *
 * IMPORTANT: keep this in sync with packages/orchestrator/src/coverage-degraded.ts.
 * The integration test in tests/relay/coverage-degraded-flow.test.ts imports
 * directly from the orchestrator source (via root tsconfig.json path mappings),
 * so any drift between the two copies will fail CI.
 */

export interface CoverageDegradedParams {
  received: number;
  expected: number;
  droppedAgents: string[];
}

/** Build the canonical coverage_degraded warning message. */
export function buildCoverageDegradedMessage(params: CoverageDegradedParams): string {
  const { received, expected, droppedAgents } = params;
  return `Coverage degraded: ${received}/${expected} agents returned content (dropped: ${droppedAgents.join(', ')})`;
}

/** Parse a coverage_degraded warning message back into structured params. Returns undefined on mismatch, never throws. */
export function parseCoverageDegradedMessage(message: string): CoverageDegradedParams | undefined {
  const headerMatch = message.match(/^Coverage degraded:\s*(\d+)\/(\d+)\s*agents returned content/i);
  if (!headerMatch) return undefined;
  const received = parseInt(headerMatch[1], 10);
  const expected = parseInt(headerMatch[2], 10);

  const droppedPrefix = ' (dropped: ';
  const lastDroppedIdx = message.lastIndexOf(droppedPrefix);
  let droppedAgents: string[] = [];
  if (lastDroppedIdx !== -1) {
    const afterPrefix = message.slice(lastDroppedIdx + droppedPrefix.length);
    const lastParen = afterPrefix.lastIndexOf(')');
    const droppedRaw = lastParen !== -1 ? afterPrefix.slice(0, lastParen) : afterPrefix;
    droppedAgents = droppedRaw.split(',').map(s => s.trim()).filter(Boolean);
  }

  return { received, expected, droppedAgents };
}
