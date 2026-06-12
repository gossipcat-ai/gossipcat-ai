/**
 * Integration test: consensusFlowHandler correctly parses coverage_degraded
 * warnings from a PR-C style report (no legacy coverageDegraded field, only
 * the warnings array) and from a legacy report (coverageDegraded field only).
 *
 * Purpose: end-to-end round-trip — any template change in
 * buildCoverageDegradedMessage that the consensusFlowHandler parser can't
 * read breaks this test before it breaks the dashboard CoverageDegradedChip.
 * (Both sides now import from @gossip/orchestrator — the relay-local copy
 * was deleted once worktree-build constraints no longer applied.)
 *
 * consensus 1f50d89d-c28f49c4:fable-reviewer:f2
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { consensusFlowHandler } from '../../packages/relay/src/dashboard/api-consensus-flow';
import { buildCoverageDegradedMessage } from '../../packages/orchestrator/src/coverage-degraded';

function makeProjectRoot(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'cf-test-'));
  mkdirSync(join(tmp, '.gossip', 'consensus-reports'), { recursive: true });
  return tmp;
}

function writeReport(root: string, consensusId: string, report: object): void {
  writeFileSync(
    join(root, '.gossip', 'consensus-reports', `${consensusId}.json`),
    JSON.stringify(report),
  );
}

const VALID_ID = 'aabbccdd-11223344';

describe('consensusFlowHandler — coverage_degraded parsing from warning message (PR-C path)', () => {
  let root: string;
  beforeEach(() => { root = makeProjectRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('parses coverageDegraded from the warnings channel when legacy field is absent', () => {
    const droppedAgents = ['gemini-tester'];
    const msg = buildCoverageDegradedMessage({ received: 2, expected: 3, droppedAgents });
    writeReport(root, VALID_ID, {
      consensusId: VALID_ID,
      timestamp: '2026-06-11T00:00:00.000Z',
      agentCount: 3,
      confirmed: [],
      disputed: [],
      unverified: [],
      unique: [],
      newFindings: [],
      warnings: [{ code: 'coverage_degraded', message: msg }],
    });

    const result = consensusFlowHandler(root, new URLSearchParams({ consensusId: VALID_ID }));
    expect('error' in result).toBe(false);
    const response = result as Exclude<typeof result, { error: string }>;
    expect(response.coverageDegraded).toEqual({ received: 2, expected: 3, droppedAgents });
  });

  it('reads coverageDegraded directly from legacy field when no warnings array', () => {
    const legacyCd = { expected: 3, received: 1, droppedAgents: ['a', 'b'] };
    writeReport(root, VALID_ID, {
      consensusId: VALID_ID,
      timestamp: '2026-06-11T00:00:00.000Z',
      agentCount: 3,
      confirmed: [],
      disputed: [],
      unverified: [],
      unique: [],
      newFindings: [],
      coverageDegraded: legacyCd,
    });

    const result = consensusFlowHandler(root, new URLSearchParams({ consensusId: VALID_ID }));
    const response = result as Exclude<typeof result, { error: string }>;
    expect(response.coverageDegraded).toEqual(legacyCd);
  });

  it('returns no coverageDegraded when neither field nor warning is present', () => {
    writeReport(root, VALID_ID, {
      consensusId: VALID_ID,
      timestamp: '2026-06-11T00:00:00.000Z',
      agentCount: 2,
      confirmed: [],
      disputed: [],
      unverified: [],
      unique: [],
      newFindings: [],
      warnings: [{ code: 'roots_rejected', message: 'x' }],
    });

    const result = consensusFlowHandler(root, new URLSearchParams({ consensusId: VALID_ID }));
    const response = result as Exclude<typeof result, { error: string }>;
    expect(response.coverageDegraded).toBeUndefined();
  });

  it('round-trips a coverage_degraded warning with a comma-containing agent id', () => {
    // Agents with commas in IDs are outside our naming scheme, but parse must
    // not throw — it just splits on comma, which is acceptable behavior.
    const msg = buildCoverageDegradedMessage({ received: 1, expected: 2, droppedAgents: ['agent-with,comma'] });
    writeReport(root, VALID_ID, {
      consensusId: VALID_ID,
      timestamp: '2026-06-11T00:00:00.000Z',
      agentCount: 2,
      confirmed: [],
      disputed: [],
      unverified: [],
      unique: [],
      newFindings: [],
      warnings: [{ code: 'coverage_degraded', message: msg }],
    });

    const result = consensusFlowHandler(root, new URLSearchParams({ consensusId: VALID_ID }));
    expect('error' in result).toBe(false);
    const response = result as Exclude<typeof result, { error: string }>;
    // Comma in agent id splits — coverageDegraded is still populated (no crash).
    expect(response.coverageDegraded).toBeDefined();
    expect(response.coverageDegraded!.received).toBe(1);
    expect(response.coverageDegraded!.expected).toBe(2);
  });
});
