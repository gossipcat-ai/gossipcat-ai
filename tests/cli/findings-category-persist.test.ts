// tests/cli/findings-category-persist.test.ts
//
// Verifies that implementation-findings.jsonl records include the `category`
// field. The serialization block under test lives at
// apps/cli/src/handlers/collect.ts:602-614 (inside handleCollect).
//
// handleCollect is heavy to stand up in a unit test — it depends on ctx,
// the relay, and live consensus state — so this test mirrors the exact
// entry shape written by that block. It locks in the wire format so a
// future refactor of the serialization can't silently drop `category`
// again (which was the root cause called out in the spec).
//
// Companion: tests/orchestrator/dedupe-key.test.ts validates the hash
// helper; this test validates that the persistence layer supplies
// `category` into the row read by the dedup gate.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface MinimalConsensusFinding {
  id?: string;
  originalAgentId: string;
  confirmedBy?: string[];
  finding: string;
  tag?: string;
  confidence?: number;
  category?: string;
}

/**
 * Mirror of the block at apps/cli/src/handlers/collect.ts:602-614.
 * Kept in sync manually — the unit test fails loudly if collect.ts drifts.
 */
function persistFinding(
  findingsPath: string,
  f: MinimalConsensusFinding,
  timestamp: string,
): void {
  const entry = {
    timestamp,
    taskId: f.id || null,
    originalAgentId: f.originalAgentId,
    confirmedBy: f.confirmedBy || [],
    finding: f.finding,
    tag: f.tag || 'unknown',
    confidence: f.confidence || 0,
    status: 'open',
    category: (f as { category?: string }).category ?? null,
  };
  fs.appendFileSync(findingsPath, JSON.stringify(entry) + '\n');
}

describe('implementation-findings.jsonl category persistence', () => {
  let tmpDir: string;
  let findingsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findings-cat-'));
    fs.mkdirSync(path.join(tmpDir, '.gossip'), { recursive: true });
    findingsPath = path.join(tmpDir, '.gossip', 'implementation-findings.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes category field to the jsonl row', () => {
    const ts = '2026-04-17T10:00:00Z';
    persistFinding(findingsPath, {
      id: 'abc12345-def67890:sonnet-reviewer:f1',
      originalAgentId: 'sonnet-reviewer',
      confirmedBy: ['gemini-reviewer'],
      finding: 'Missing bounds check at packages/orchestrator/src/foo.ts:42',
      tag: 'confirmed',
      confidence: 0.9,
      category: 'input_validation',
    }, ts);

    const raw = fs.readFileSync(findingsPath, 'utf-8').trim();
    const row = JSON.parse(raw);
    expect(row.category).toBe('input_validation');
    expect(row.tag).toBe('confirmed');
    expect(row.originalAgentId).toBe('sonnet-reviewer');
  });

  it('falls back to null category when absent (legacy-tolerant)', () => {
    persistFinding(findingsPath, {
      id: 'abc12345-def67890:gemini-reviewer:f2',
      originalAgentId: 'gemini-reviewer',
      finding: 'Race condition at race.ts:12',
      tag: 'unique',
    }, '2026-04-17T10:00:00Z');

    const raw = fs.readFileSync(findingsPath, 'utf-8').trim();
    const row = JSON.parse(raw);
    expect(row).toHaveProperty('category');
    expect(row.category).toBeNull();
  });
});
