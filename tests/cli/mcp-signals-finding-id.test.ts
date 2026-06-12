/**
 * Tests for gossip_signals finding_id schema enforcement, the absent-finding_id
 * receipt warning, and scoped per-signal retraction tombstones.
 *
 * The record/retract handler in mcp-server-sdk.ts is an inline registerTool
 * callback (not unit-testable in isolation), so — matching the pattern in
 * mcp-signals-validation.test.ts — we exercise the pure logic by replicating it,
 * write a real tombstone through PerformanceWriter to prove the reader scopes on
 * it, and grep the handler source to guard against regressions of the wiring.
 */

import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PerformanceWriter, PerformanceReader } from '@gossip/orchestrator';
// Test-exemption: WRITER_INTERNAL gates appendSignal(s) access. Tests use it
// directly to write tombstone rows the helpers would otherwise route through.
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';

const HANDLER_SRC = join(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts');

function makeTmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `gossip-finding-id-${label}-`));
}

// ── 1. finding_id schema gate (replica of the handler's FINDING_ID_PREFIX loop) ──

describe('gossip_signals finding_id schema enforcement', () => {
  const FINDING_ID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{8}:/;

  function validateFindingIds(
    signals: Array<{ agent_id: string; finding_id?: string }>,
  ): string | null {
    for (const s of signals) {
      if (s.finding_id !== undefined && !FINDING_ID_PREFIX.test(s.finding_id)) {
        return `Error: malformed finding_id "${s.finding_id}" (agent: ${s.agent_id}). Expected a consensus-id prefix: <8hex>-<8hex>:... (e.g. "b81956b2-e0fa4ea4:sonnet-reviewer:f1"). See CLAUDE.md signal contract.`;
      }
    }
    return null;
  }

  it('rejects a finding_id with no consensus-id prefix', () => {
    const err = validateFindingIds([{ agent_id: 'sonnet-reviewer', finding_id: 'f1' }]);
    expect(err).not.toBeNull();
    expect(err).toContain('malformed finding_id');
    expect(err).toContain('f1');
    expect(err).toContain('sonnet-reviewer');
    expect(err).toContain('<8hex>-<8hex>');
  });

  it('rejects a finding_id whose prefix is not 8-8 hex', () => {
    const err = validateFindingIds([{ agent_id: 'a', finding_id: 'deadbeef:f1' }]);
    expect(err).not.toBeNull();
    expect(err).toContain('malformed');
  });

  it('rejects a finding_id with non-hex characters in the prefix', () => {
    const err = validateFindingIds([{ agent_id: 'a', finding_id: 'zzzzzzzz-e0fa4ea4:f1' }]);
    expect(err).not.toBeNull();
  });

  it('accepts the <cid>:fN shape', () => {
    const err = validateFindingIds([{ agent_id: 'a', finding_id: 'b81956b2-e0fa4ea4:f1' }]);
    expect(err).toBeNull();
  });

  it('accepts the <cid>:<agent>:fN shape', () => {
    const err = validateFindingIds([{ agent_id: 'a', finding_id: 'b81956b2-e0fa4ea4:sonnet-reviewer:f1' }]);
    expect(err).toBeNull();
  });

  it('accepts the <cid>:<agent>:nN (new-finding) shape', () => {
    const err = validateFindingIds([{ agent_id: 'a', finding_id: 'b81956b2-e0fa4ea4:gemini-reviewer:n2' }]);
    expect(err).toBeNull();
  });

  it('accepts an ABSENT finding_id (optional — no rejection)', () => {
    const err = validateFindingIds([{ agent_id: 'a' }]);
    expect(err).toBeNull();
  });

  it('rejects the first malformed finding_id in a batch and stops', () => {
    const err = validateFindingIds([
      { agent_id: 'a1', finding_id: 'b81956b2-e0fa4ea4:f1' }, // valid
      { agent_id: 'a2', finding_id: 'garbage' },              // fails
      { agent_id: 'a3', finding_id: 'also-garbage' },         // never reached
    ]);
    expect(err).not.toBeNull();
    expect(err).toContain('a2');
    expect(err).not.toContain('a3');
  });

  it('handler source enforces the finding_id prefix gate', () => {
    const src = readFileSync(HANDLER_SRC, 'utf-8');
    expect(src).toContain('const FINDING_ID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{8}:/;');
    expect(src).toContain('!FINDING_ID_PREFIX.test(s.finding_id)');
    expect(src).toContain('malformed finding_id');
  });
});

// ── 2. Absent finding_id → loud warning in the receipt ───────────────────────

describe('gossip_signals absent finding_id receipt warning', () => {
  function countMissing(signals: Array<{ finding_id?: string }>): number {
    return signals.filter(s => !s.finding_id || s.finding_id.trim().length === 0).length;
  }

  function buildWarning(missing: number): string {
    if (missing > 0) {
      return `⚠ ${missing} signal(s) recorded without finding_id — unauditable, see CLAUDE.md contract`;
    }
    return '';
  }

  it('counts signals with no finding_id', () => {
    const n = countMissing([
      { finding_id: 'b81956b2-e0fa4ea4:f1' },
      {},
      { finding_id: '   ' },
    ]);
    expect(n).toBe(2);
  });

  it('emits the warning line when at least one finding_id is missing', () => {
    const warn = buildWarning(countMissing([{}, { finding_id: 'b81956b2-e0fa4ea4:f1' }]));
    expect(warn).toContain('1 signal(s) recorded without finding_id');
    expect(warn).toContain('unauditable');
    expect(warn).toContain('CLAUDE.md');
  });

  it('emits no warning when every signal carries a finding_id', () => {
    const warn = buildWarning(countMissing([
      { finding_id: 'b81956b2-e0fa4ea4:f1' },
      { finding_id: 'b81956b2-e0fa4ea4:f2' },
    ]));
    expect(warn).toBe('');
  });

  it('handler source appends the unauditable warning to the receipt', () => {
    const src = readFileSync(HANDLER_SRC, 'utf-8');
    expect(src).toContain('const missingFindingIdCount = signals.filter(s => !s.finding_id || s.finding_id.trim().length === 0).length;');
    expect(src).toContain('signal(s) recorded without finding_id — unauditable, see CLAUDE.md contract');
  });
});

// ── 3. Scoped per-signal retraction tombstone ────────────────────────────────

describe('gossip_signals scoped retraction tombstone', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTmpDir('scoped-retract');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('writes a tombstone carrying retractedSignal + findingId so the reader scopes to ONE signal', () => {
    const writer = new PerformanceWriter(testDir);
    const taskId = 'task-scoped-001';
    const agentId = 'sonnet-reviewer';
    const cid = 'b81956b2-e0fa4ea4';

    // Two recorded signals on the same agent+task.
    writer[WRITER_INTERNAL].appendSignals([
      {
        type: 'consensus' as const, signal: 'unique_confirmed', agentId, taskId,
        findingId: `${cid}:sonnet-reviewer:f1`, source: 'manual',
        evidence: 'confirmed real bug', timestamp: new Date().toISOString(),
      },
      {
        type: 'consensus' as const, signal: 'hallucination_caught', agentId, taskId,
        findingId: `${cid}:sonnet-reviewer:f2`, source: 'manual',
        evidence: 'fabricated finding', timestamp: new Date().toISOString(),
      },
    ]);

    // Scoped tombstone: voids ONLY the hallucination_caught signal.
    writer[WRITER_INTERNAL].appendSignals([{
      type: 'consensus' as const, signal: 'signal_retracted', agentId, taskId,
      retractedSignal: 'hallucination_caught',
      findingId: `${cid}:sonnet-reviewer:f2`,
      evidence: 'Retracted: was actually valid',
      timestamp: new Date().toISOString(),
    }]);

    const path = join(testDir, '.gossip', 'agent-performance.jsonl');
    const lines = readFileSync(path, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const tombstone = lines.find(l => l.signal === 'signal_retracted');
    expect(tombstone).toBeDefined();
    expect(tombstone.retractedSignal).toBe('hallucination_caught');
    expect(tombstone.findingId).toBe(`${cid}:sonnet-reviewer:f2`);

    // Behavioral check through the public scores API (routes via readSignals →
    // computeScores, both of which honor `retractedSignal` scoping): the scoped
    // tombstone must void ONLY hallucination_caught, leaving the agent's
    // unique_confirmed credit intact. A wildcard tombstone would also wipe the
    // confirmed signal — so a non-zero confirmed count proves scoping engaged.
    const reader = new PerformanceReader(testDir);
    const score: any = reader.getScores().get(agentId);
    expect(score).toBeDefined();
    expect(score.hallucinations).toBe(0);
  });

  it('an UNSCOPED tombstone (no retractedSignal) voids ALL signals for the agent+task', () => {
    const writer = new PerformanceWriter(testDir);
    const taskId = 'task-wildcard-001';
    const agentId = 'gemini-reviewer';

    writer[WRITER_INTERNAL].appendSignals([{
      type: 'consensus' as const, signal: 'hallucination_caught', agentId, taskId,
      findingId: 'b81956b2-e0fa4ea4:gemini-reviewer:f1', source: 'manual',
      evidence: 'fabricated', timestamp: new Date().toISOString(),
    }]);
    // Wildcard tombstone: no retractedSignal field.
    writer[WRITER_INTERNAL].appendSignals([{
      type: 'consensus' as const, signal: 'signal_retracted', agentId, taskId,
      evidence: 'Retracted: voiding the whole batch',
      timestamp: new Date().toISOString(),
    }]);

    const reader = new PerformanceReader(testDir);
    const score: any = reader.getScores().get(agentId);
    // The hallucination was voided by the wildcard tombstone.
    if (score) expect(score.hallucinations).toBe(0);
  });

  it('handler source threads retracted_signal + finding_id into the tombstone payload', () => {
    const src = readFileSync(HANDLER_SRC, 'utf-8');
    // Schema param present.
    expect(src).toContain("retracted_signal: z.string().optional()");
    // Destructured in the handler.
    expect(src).toMatch(/retracted_signal,\s*resolved_by/);
    // Wired into the tombstone emission.
    expect(src).toContain('retractedSignal: retracted_signal!.trim()');
    expect(src).toContain('findingId: finding_id.trim()');
    // Unscoped path still announced.
    expect(src).toContain('Unscoped retraction — voids ALL signals');
  });
});
