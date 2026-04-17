/**
 * Consensus-round retraction tests.
 *
 * Covers the 14 spec scenarios in
 * docs/specs/2026-04-17-consensus-round-retraction.md.
 */

import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PerformanceWriter, PerformanceReader } from '@gossip/orchestrator';
import type { PerformanceSignal, ConsensusSignal } from '@gossip/orchestrator/consensus-types';
import { z } from 'zod';

// Mirrors the mcp-server-sdk.ts zod constraints on the retract payload. If
// the handler constraint drifts, these tests catch it — keep in sync.
const consensusIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{8}$/);
const reasonSchema = z.string().min(1).max(1024);

function makeTmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `gossip-round-retract-${label}-`));
}

function readJsonl(dir: string): any[] {
  const path = join(dir, '.gossip', 'agent-performance.jsonl');
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

const VALID_CID = '1537efbb-2b44492d';
const VALID_CID_2 = 'abcd0123-deadbeef';

describe('consensus-round retraction', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir('basic'); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  // 1. retract appends tombstone and succeeds
  it('appends a tombstone row with agentId="_system"', () => {
    const writer = new PerformanceWriter(dir);
    writer.recordConsensusRoundRetraction(VALID_CID, 'wrong branch reviewed');

    const rows = readJsonl(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'consensus',
      signal: 'consensus_round_retracted',
      agentId: '_system',
      consensus_id: VALID_CID,
      reason: 'wrong branch reviewed',
    });
    expect(typeof rows[0].retracted_at).toBe('string');
    expect(typeof rows[0].timestamp).toBe('string');
  });

  // 14. performance-writer accepts the sentinel without throwing
  it('writer accepts agentId="_system" without validation failure', () => {
    const writer = new PerformanceWriter(dir);
    expect(() => writer.recordConsensusRoundRetraction(VALID_CID, 'r')).not.toThrow();
  });

  // 2/3/4/5. zod validation at the MCP boundary
  describe('zod validation', () => {
    it('rejects consensus_id that fails the 8-8 hex regex', () => {
      expect(() => consensusIdSchema.parse('notahex')).toThrow();
      expect(() => consensusIdSchema.parse('1537efbb2b44492d')).toThrow(); // no dash
      expect(() => consensusIdSchema.parse('1537efbb-2b44492')).toThrow(); // short
      expect(() => consensusIdSchema.parse('1537EFBB-2B44492D')).toThrow(); // uppercase
      expect(() => consensusIdSchema.parse(`${VALID_CID} extra`)).toThrow(); // trailing
      expect(consensusIdSchema.parse(VALID_CID)).toBe(VALID_CID);
    });

    it('rejects empty reason', () => {
      expect(() => reasonSchema.parse('')).toThrow();
    });

    it('rejects reason longer than 1024 chars', () => {
      expect(() => reasonSchema.parse('x'.repeat(1025))).toThrow();
      expect(reasonSchema.parse('x'.repeat(1024))).toHaveLength(1024);
    });

    it('accepts valid 8-8 hex consensus_id', () => {
      expect(consensusIdSchema.parse('abcdef01-deadbeef')).toBe('abcdef01-deadbeef');
    });
  });

  // 6. signals whose findingId starts with retracted cid + ':' are dropped at read
  it('filters signals whose findingId starts with retracted cid + ":"', () => {
    const writer = new PerformanceWriter(dir);
    const now = new Date().toISOString();
    writer.appendSignals([
      // In-scope signal (bulk_from_consensus shape: <cid>:fN)
      {
        type: 'consensus', taskId: 't1', signal: 'agreement',
        agentId: 'a1', counterpartId: 'a2',
        findingId: `${VALID_CID}:f1`,
        evidence: 'e', timestamp: now,
      } as ConsensusSignal,
      // In-scope signal (manual shape: <cid>:<agent>:fN)
      {
        type: 'consensus', taskId: 't2', signal: 'unique_confirmed',
        agentId: 'a1', findingId: `${VALID_CID}:a1:f7`,
        evidence: 'e', timestamp: now,
      } as ConsensusSignal,
      // Different round — should NOT be filtered
      {
        type: 'consensus', taskId: 't3', signal: 'agreement',
        agentId: 'a1', counterpartId: 'a2',
        findingId: `${VALID_CID_2}:f1`,
        evidence: 'e', timestamp: now,
      } as ConsensusSignal,
    ]);
    writer.recordConsensusRoundRetraction(VALID_CID, 'r');

    const reader = new PerformanceReader(dir);
    const score = reader.getAgentScore('a1');
    // Only the VALID_CID_2 agreement should have contributed.
    expect(score?.agreements).toBe(1);
  });

  // 7. impl_* signals (no findingId) unaffected
  it('impl signals without findingId are unaffected by round retraction', () => {
    const writer = new PerformanceWriter(dir);
    const now = new Date().toISOString();
    writer.appendSignals([
      {
        type: 'impl', signal: 'impl_test_pass',
        agentId: 'a1', taskId: 't1', timestamp: now,
      } as PerformanceSignal,
      {
        type: 'impl', signal: 'impl_test_pass',
        agentId: 'a1', taskId: 't2', timestamp: now,
      } as PerformanceSignal,
    ]);
    writer.recordConsensusRoundRetraction(VALID_CID, 'r');

    const reader = new PerformanceReader(dir);
    const impl = reader.getImplScore('a1');
    expect(impl).not.toBeNull();
    expect(impl!.passRate).toBe(1);
  });

  // 8. Non-consensus signals with a synthetic findingId are NOT filtered
  it('does not filter non-consensus signals (type !== "consensus") by findingId', () => {
    // Meta signals carry no findingId structurally but test the type gate:
    // write a row that looks impl-typed yet somehow has a findingId-shaped
    // prefix — reader must not drop it because the filter is scoped to
    // type === 'consensus'. Constructed via JSON append so we sidestep
    // validation (simulates a future signal variant).
    const writer = new PerformanceWriter(dir);
    writer.recordConsensusRoundRetraction(VALID_CID, 'r');
    // Append a raw impl-typed row with an odd findingId to prove the scope guard:
    const path = join(dir, '.gossip', 'agent-performance.jsonl');
    const now = new Date().toISOString();
    const row = {
      type: 'impl',
      signal: 'impl_test_pass',
      agentId: 'a1',
      taskId: 't1',
      findingId: `${VALID_CID}:synthetic`,
      timestamp: now,
    };
    require('fs').appendFileSync(path, JSON.stringify(row) + '\n');

    const reader = new PerformanceReader(dir);
    const impl = reader.getImplScore('a1');
    // The impl signal must survive the consensus-scoped filter.
    expect(impl).not.toBeNull();
    expect(impl!.passRate).toBe(1);
  });

  // 9/10. Duplicate retractions → reader dedupes via Set; audit preserves both
  it('duplicate retractions append extra rows; reader dedupes via Set', () => {
    const writer = new PerformanceWriter(dir);
    writer.recordConsensusRoundRetraction(VALID_CID, 'first reason');
    writer.recordConsensusRoundRetraction(VALID_CID, 'second reason');

    const rows = readJsonl(dir);
    expect(rows).toHaveLength(2);
    expect(rows[0].reason).toBe('first reason');
    expect(rows[1].reason).toBe('second reason');

    const reader = new PerformanceReader(dir);
    const ids = reader.getRetractedConsensusIds();
    expect(ids.size).toBe(1);
    expect(ids.has(VALID_CID)).toBe(true);

    const all = reader.getRoundRetractions();
    expect(all).toHaveLength(2);
    const reasons = all.map(r => r.reason).sort();
    expect(reasons).toEqual(['first reason', 'second reason']);
  });

  // 11. Dashboard overview excludes tombstones from totalSignals. (asserted via data-layer filter — exercise api-overview.ts directly.)
  it('api-overview totalSignals excludes consensus_round_retracted rows and _system sentinel', async () => {
    const { overviewHandler } = await import('@gossip/relay/dashboard/api-overview');
    const writer = new PerformanceWriter(dir);
    const now = new Date().toISOString();
    writer.appendSignals([
      {
        type: 'consensus', taskId: 't1', signal: 'agreement',
        agentId: 'a1', counterpartId: 'a2',
        evidence: 'e', timestamp: now,
      } as ConsensusSignal,
    ]);
    writer.recordConsensusRoundRetraction(VALID_CID, 'r');

    const overview = await overviewHandler(dir, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
    expect(overview.totalSignals).toBe(1); // tombstone not counted
  });

  // Reader exposes retractedConsensusIds for dashboard banner
  it('getRetractedConsensusIds returns the set of retracted round IDs', () => {
    const writer = new PerformanceWriter(dir);
    writer.recordConsensusRoundRetraction(VALID_CID, 'r1');
    writer.recordConsensusRoundRetraction(VALID_CID_2, 'r2');

    const reader = new PerformanceReader(dir);
    const ids = reader.getRetractedConsensusIds();
    expect(ids.has(VALID_CID)).toBe(true);
    expect(ids.has(VALID_CID_2)).toBe(true);
    expect(ids.size).toBe(2);
  });

  // 13. bulk_from_consensus on a retracted round: signals recorded but dropped at read
  it('signals recorded for a retracted round are filtered out at read time', () => {
    const writer = new PerformanceWriter(dir);
    writer.recordConsensusRoundRetraction(VALID_CID, 'premise invalid');
    const now = new Date().toISOString();
    // Simulate bulk_from_consensus recording signals for the retracted round.
    writer.appendSignals([
      {
        type: 'consensus', taskId: 'bulk-t', signal: 'agreement',
        agentId: 'a1', counterpartId: 'a2',
        findingId: `${VALID_CID}:f1`,
        evidence: 'e', timestamp: now,
      } as ConsensusSignal,
      {
        type: 'consensus', taskId: 'bulk-t', signal: 'unique_confirmed',
        agentId: 'a1', findingId: `${VALID_CID}:f2`,
        evidence: 'e', timestamp: now,
      } as ConsensusSignal,
    ]);

    const reader = new PerformanceReader(dir);
    const score = reader.getAgentScore('a1');
    // Both signals dropped → agent has no record.
    expect(score?.agreements ?? 0).toBe(0);
    expect(score?.uniqueFindings ?? 0).toBe(0);
  });

  // Mutual-exclusivity guard (handler-level XOR)
  describe('mutual-exclusivity guard', () => {
    // Mirrors the handler logic at apps/cli/src/mcp-server-sdk.ts in the
    // retract branch. Kept inline because the handler is registerTool-
    // coupled and not directly unit-testable.
    function handlerGuard(p: {
      consensus_id?: string;
      agent_id?: string;
      task_id?: string;
      reason?: string;
    }): string | null {
      const hasRound = !!(p.consensus_id && p.consensus_id.trim().length > 0);
      const hasPerSignal = !!((p.agent_id && p.agent_id.trim().length > 0) || (p.task_id && p.task_id.trim().length > 0));
      if (hasRound && hasPerSignal) return 'Error: mutually exclusive';
      if (!hasRound && !hasPerSignal) return 'Error: supply either';
      if (!p.reason || p.reason.trim().length === 0) return 'Error: reason';
      return null;
    }

    it('rejects round + per-signal combination', () => {
      const err = handlerGuard({
        consensus_id: VALID_CID, agent_id: 'a1', task_id: 't1', reason: 'r',
      });
      expect(err).toMatch(/mutually exclusive/);
    });

    it('rejects neither form supplied', () => {
      const err = handlerGuard({ reason: 'r' });
      expect(err).toMatch(/supply either/);
    });

    it('accepts round form', () => {
      const err = handlerGuard({ consensus_id: VALID_CID, reason: 'r' });
      expect(err).toBeNull();
    });

    it('accepts per-signal form', () => {
      const err = handlerGuard({ agent_id: 'a1', task_id: 't1', reason: 'r' });
      expect(err).toBeNull();
    });

    it('rejects empty reason on round form', () => {
      const err = handlerGuard({ consensus_id: VALID_CID, reason: '' });
      expect(err).toMatch(/reason/);
    });
  });

  // Source-level guard: zod regex + reason cap still present in the handler
  it('mcp-server-sdk.ts retains the strict consensus_id regex + reason cap', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
      'utf-8',
    );
    expect(src).toMatch(/\/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{8\}\$\//);
    expect(src).toMatch(/reason:.*z\.string\(\)\.min\(1\)\.max\(1024\)/);
    // Handler XOR guard present
    expect(src).toMatch(/consensus_id and agent_id\+task_id are mutually exclusive/);
  });
});
