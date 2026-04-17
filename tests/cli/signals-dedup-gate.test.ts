// tests/cli/signals-dedup-gate.test.ts
//
// Cross-round dedup integration test. Exercises the same logic the
// gossip_signals handler runs at apps/cli/src/mcp-server-sdk.ts:
//   1. Load prior signals from agent-performance.jsonl.
//   2. Build Map<dedupeKey, finding_id>.
//   3. Reject incoming signals whose computeDedupeKey() matches a prior key.
//
// Testing the full MCP handler requires a heavy server harness; this test
// instead validates the Map construction + incoming-signal rejection
// directly so the business logic is covered without server spin-up.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeDedupeKey } from '@gossip/orchestrator';

type PriorSignal = {
  type: string;
  agentId: string;
  findingId?: string;
  finding?: string;
  evidence?: string;
  category?: string;
};

function buildDedupeMap(lines: string[]): {
  existingKeyToFindingId: Map<string, string>;
  existingFindingIds: Set<string>;
} {
  const existingKeyToFindingId = new Map<string, string>();
  const existingFindingIds = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as PriorSignal;
      if (rec.findingId) existingFindingIds.add(rec.findingId);
      if (rec.type === 'consensus' && rec.agentId) {
        const key = computeDedupeKey({
          agentId: rec.agentId,
          content: rec.finding,
          evidence: rec.evidence,
          category: rec.category,
        });
        if (key && !existingKeyToFindingId.has(key)) {
          existingKeyToFindingId.set(key, rec.findingId ?? '');
        }
      }
    } catch {
      /* skip */
    }
  }
  return { existingKeyToFindingId, existingFindingIds };
}

describe('signals dedup gate (cross-round)', () => {
  let tmpDir: string;
  let perfPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signals-dedup-'));
    fs.mkdirSync(path.join(tmpDir, '.gossip'), { recursive: true });
    perfPath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a second signal with the same content-anchored key across rounds', () => {
    const prior = {
      type: 'consensus',
      taskId: 'round-1-task',
      consensusId: 'aaaa1111-bbbb2222',
      signal: 'agreement',
      agentId: 'sonnet-reviewer',
      findingId: 'aaaa1111-bbbb2222:sonnet-reviewer:f3',
      evidence:
        'Missing bounds check at packages/orchestrator/src/foo.ts:42 causes integer overflow risk',
      category: 'input_validation',
      timestamp: '2026-04-16T10:00:00Z',
    };
    fs.writeFileSync(perfPath, JSON.stringify(prior) + '\n');

    const lines = fs.readFileSync(perfPath, 'utf-8').split('\n');
    const { existingKeyToFindingId } = buildDedupeMap(lines);
    expect(existingKeyToFindingId.size).toBe(1);

    // Incoming signal: same bug, new round. Different finding_id (new
    // consensusId), different line number, whitespace noise.
    const incomingKey = computeDedupeKey({
      agentId: 'sonnet-reviewer',
      content:
        'Missing   bounds check at packages/orchestrator/src/foo.ts:55 causes integer overflow risk',
      category: 'input_validation',
    });
    expect(incomingKey).not.toBeNull();
    expect(existingKeyToFindingId.has(incomingKey!)).toBe(true);
    expect(existingKeyToFindingId.get(incomingKey!)).toBe(
      'aaaa1111-bbbb2222:sonnet-reviewer:f3',
    );
  });

  it('preserves exact-findingId dedup path for signals whose key cannot be computed', () => {
    // Prior signal with short content (no citation, no dedup key).
    const prior = {
      type: 'consensus',
      taskId: 'round-1-task',
      signal: 'agreement',
      agentId: 'sonnet-reviewer',
      findingId: 'zzzzzzzz-yyyyyyyy:sonnet-reviewer:f1',
      evidence: 'short',
      timestamp: '2026-04-16T10:00:00Z',
    };
    fs.writeFileSync(perfPath, JSON.stringify(prior) + '\n');

    const lines = fs.readFileSync(perfPath, 'utf-8').split('\n');
    const { existingKeyToFindingId, existingFindingIds } = buildDedupeMap(lines);
    expect(existingKeyToFindingId.size).toBe(0); // short content → null key
    expect(existingFindingIds.has('zzzzzzzz-yyyyyyyy:sonnet-reviewer:f1')).toBe(true);
  });

  it('legacy signal missing category dedups using empty-string category', () => {
    const prior = {
      type: 'consensus',
      agentId: 'sonnet-reviewer',
      findingId: 'legacy-round:sonnet-reviewer:f1',
      evidence:
        'Race condition at packages/orchestrator/src/race.ts:12 allows concurrent mutation of shared state',
      // no `category` field — legacy record
    };
    fs.writeFileSync(perfPath, JSON.stringify(prior) + '\n');

    const lines = fs.readFileSync(perfPath, 'utf-8').split('\n');
    const { existingKeyToFindingId } = buildDedupeMap(lines);

    const incomingKey = computeDedupeKey({
      agentId: 'sonnet-reviewer',
      content:
        'Race condition at packages/orchestrator/src/race.ts:18 allows concurrent mutation of shared state',
      // incoming also omits category → both hash with empty string
    });
    expect(incomingKey).not.toBeNull();
    expect(existingKeyToFindingId.has(incomingKey!)).toBe(true);
  });

  it('distinct content does NOT collide (no false-positive dedup)', () => {
    const prior = {
      type: 'consensus',
      agentId: 'sonnet-reviewer',
      findingId: 'r1:sonnet-reviewer:f1',
      evidence:
        'Missing bounds check at packages/orchestrator/src/foo.ts:42 overflow on large inputs here',
      category: 'input_validation',
    };
    fs.writeFileSync(perfPath, JSON.stringify(prior) + '\n');

    const { existingKeyToFindingId } = buildDedupeMap(
      fs.readFileSync(perfPath, 'utf-8').split('\n'),
    );
    const incomingKey = computeDedupeKey({
      agentId: 'sonnet-reviewer',
      content:
        'Null pointer dereference at packages/orchestrator/src/foo.ts:99 when input list is undefined somehow',
      category: 'input_validation',
    });
    expect(incomingKey).not.toBeNull();
    expect(existingKeyToFindingId.has(incomingKey!)).toBe(false);
  });
});
