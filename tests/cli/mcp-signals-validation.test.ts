/**
 * Tests for gossip_signals handler validation and gap pipeline logic.
 *
 * Because the handler is tightly coupled to boot() context, we test the
 * underlying libraries directly: PerformanceWriter (signal validation/formatting)
 * and SkillGapTracker (hallucination → gap suggestion pipeline).
 *
 * The gap pipeline logic (lines 1382-1403 in mcp-server-sdk.ts) is replicated
 * inline so we can exercise the keyword matching → appendSuggestion flow without
 * spinning up the full MCP server.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PerformanceWriter, SkillGapTracker, DEFAULT_KEYWORDS } from '@gossip/orchestrator';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `gossip-signals-val-${label}-`));
}

function readGapLog(dir: string): Array<Record<string, unknown>> {
  const path = join(dir, '.gossip', 'skill-gaps.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

/**
 * Replicates the hallucination → gap pipeline from mcp-server-sdk.ts:1382-1403.
 * Returns the category selected (or '' if nothing matched).
 */
function runGapPipeline(
  gapTracker: SkillGapTracker,
  signal: { agentId: string; evidence?: string; taskId: string },
): string {
  const text = `${signal.evidence || ''} ${signal.agentId || ''}`.toLowerCase();
  let bestCategory = '';
  let bestHits = 0;
  for (const [category, keywords] of Object.entries(DEFAULT_KEYWORDS)) {
    const hits = keywords.filter(kw => text.includes(kw)).length;
    if (hits > bestHits) {
      bestHits = hits;
      bestCategory = category;
    }
  }
  if (bestCategory && bestHits >= 1) {
    gapTracker.appendSuggestion({
      type: 'suggestion',
      skill: bestCategory.replace(/_/g, '-'),
      reason: `Auto: hallucination_caught — ${(signal.evidence || '').slice(0, 120)}`,
      agent: signal.agentId,
      task_context: signal.taskId,
      timestamp: new Date().toISOString(),
    });
  }
  return bestCategory;
}

// ── 1. Punitive signals require evidence ─────────────────────────────────────

describe('gossip_signals validation — punitive signals require evidence', () => {
  const PUNITIVE_SIGNALS = new Set(['hallucination_caught', 'disagreement']);
  const COUNTERPART_REQUIRED = new Set(['agreement', 'disagreement']);

  function validateSignals(
    signals: Array<{ signal: string; agent_id: string; evidence?: string; counterpart_id?: string }>,
  ): string | null {
    for (const s of signals) {
      if (PUNITIVE_SIGNALS.has(s.signal) && (!s.evidence || s.evidence.trim().length === 0)) {
        return `Error: ${s.signal} signals require non-empty evidence for audit trail. Agent: ${s.agent_id}`;
      }
      if (COUNTERPART_REQUIRED.has(s.signal) && (!s.counterpart_id || s.counterpart_id.trim().length === 0)) {
        return `Error: ${s.signal} signals require counterpart_id. Agent: ${s.agent_id}`;
      }
    }
    return null;
  }

  it('rejects hallucination_caught with empty evidence', () => {
    const err = validateSignals([{
      signal: 'hallucination_caught',
      agent_id: 'haiku-researcher',
      evidence: '',
    }]);
    expect(err).not.toBeNull();
    expect(err).toContain('hallucination_caught');
    expect(err).toContain('evidence');
    expect(err).toContain('haiku-researcher');
  });

  it('rejects hallucination_caught with whitespace-only evidence', () => {
    const err = validateSignals([{
      signal: 'hallucination_caught',
      agent_id: 'haiku-researcher',
      evidence: '   ',
    }]);
    expect(err).not.toBeNull();
    expect(err).toContain('hallucination_caught');
  });

  it('rejects disagreement with empty evidence', () => {
    const err = validateSignals([{
      signal: 'disagreement',
      agent_id: 'gemini-reviewer',
      counterpart_id: 'sonnet-reviewer',
      evidence: '',
    }]);
    expect(err).not.toBeNull();
    expect(err).toContain('disagreement');
    expect(err).toContain('evidence');
  });

  it('accepts hallucination_caught when evidence is provided', () => {
    const err = validateSignals([{
      signal: 'hallucination_caught',
      agent_id: 'haiku-researcher',
      evidence: 'Agent claimed ScopeTracker persists to disk — it does not.',
    }]);
    expect(err).toBeNull();
  });

  it('accepts disagreement when evidence and counterpart_id are provided', () => {
    const err = validateSignals([{
      signal: 'disagreement',
      agent_id: 'gemini-reviewer',
      counterpart_id: 'sonnet-reviewer',
      evidence: 'gemini flagged real race condition, sonnet dismissed it.',
    }]);
    expect(err).toBeNull();
  });

  it('rejects the first failing signal in a batch and stops', () => {
    const err = validateSignals([
      { signal: 'unique_confirmed', agent_id: 'a1' }, // fine
      { signal: 'hallucination_caught', agent_id: 'a2', evidence: '' }, // fails
      { signal: 'hallucination_caught', agent_id: 'a3', evidence: '' }, // never reached
    ]);
    expect(err).not.toBeNull();
    expect(err).toContain('a2');
    expect(err).not.toContain('a3');
  });
});

// ── 2. Counterpart-required signals need counterpart_id ───────────────────────

describe('gossip_signals validation — counterpart_id required', () => {
  const PUNITIVE_SIGNALS = new Set(['hallucination_caught', 'disagreement']);
  const COUNTERPART_REQUIRED = new Set(['agreement', 'disagreement']);

  function validateSignals(
    signals: Array<{ signal: string; agent_id: string; evidence?: string; counterpart_id?: string }>,
  ): string | null {
    for (const s of signals) {
      if (PUNITIVE_SIGNALS.has(s.signal) && (!s.evidence || s.evidence.trim().length === 0)) {
        return `Error: ${s.signal} signals require non-empty evidence for audit trail. Agent: ${s.agent_id}`;
      }
      if (COUNTERPART_REQUIRED.has(s.signal) && (!s.counterpart_id || s.counterpart_id.trim().length === 0)) {
        return `Error: ${s.signal} signals require counterpart_id. Agent: ${s.agent_id}`;
      }
    }
    return null;
  }

  it('rejects agreement without counterpart_id', () => {
    const err = validateSignals([{
      signal: 'agreement',
      agent_id: 'agent-a',
      // counterpart_id omitted
    }]);
    expect(err).not.toBeNull();
    expect(err).toContain('agreement');
    expect(err).toContain('counterpart_id');
  });

  it('rejects agreement with empty string counterpart_id', () => {
    const err = validateSignals([{
      signal: 'agreement',
      agent_id: 'agent-a',
      counterpart_id: '',
    }]);
    expect(err).not.toBeNull();
    expect(err).toContain('counterpart_id');
  });

  it('rejects disagreement without counterpart_id (even with evidence)', () => {
    const err = validateSignals([{
      signal: 'disagreement',
      agent_id: 'agent-a',
      evidence: 'agent-a found real bug, agent-b missed it',
      // counterpart_id omitted
    }]);
    expect(err).not.toBeNull();
    expect(err).toContain('counterpart_id');
  });

  it('accepts agreement with valid counterpart_id', () => {
    const err = validateSignals([{
      signal: 'agreement',
      agent_id: 'agent-a',
      counterpart_id: 'agent-b',
    }]);
    expect(err).toBeNull();
  });

  it('unique_confirmed does not require counterpart_id', () => {
    const err = validateSignals([{
      signal: 'unique_confirmed',
      agent_id: 'gemini-reviewer',
      // no counterpart_id
    }]);
    expect(err).toBeNull();
  });

  it('new_finding does not require counterpart_id', () => {
    const err = validateSignals([{
      signal: 'new_finding',
      agent_id: 'sonnet-reviewer',
    }]);
    expect(err).toBeNull();
  });
});

// ── 3. Hallucination signal triggers gap suggestion ───────────────────────────

describe('hallucination → gap pipeline — concurrency evidence creates suggestion', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTmpDir('gap-concurrency');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates a concurrency gap suggestion for race condition evidence', () => {
    const gapTracker = new SkillGapTracker(testDir);
    const category = runGapPipeline(gapTracker, {
      agentId: 'haiku-researcher',
      evidence: 'Agent missed the race condition in the async Map mutation.',
      taskId: 'task-race-001',
    });

    expect(category).toBe('concurrency');

    const entries = readGapLog(testDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('suggestion');
    expect(entries[0].skill).toBe('concurrency');
    expect(entries[0].agent).toBe('haiku-researcher');
    expect(entries[0].task_context).toBe('task-race-001');
    expect((entries[0].reason as string)).toContain('hallucination_caught');
  });

  it('creates a resource_exhaustion gap for unbounded growth evidence', () => {
    const gapTracker = new SkillGapTracker(testDir);
    const category = runGapPipeline(gapTracker, {
      agentId: 'gemini-reviewer',
      evidence: 'Agent missed the unbounded growth in the cache — no limit or cap was suggested.',
      taskId: 'task-mem-002',
    });

    expect(category).toBe('resource_exhaustion');

    const entries = readGapLog(testDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].skill).toBe('resource-exhaustion');
  });

  it('truncates long evidence in the reason field to 120 chars', () => {
    const gapTracker = new SkillGapTracker(testDir);
    const longEvidence = 'race condition '.repeat(30); // well over 120 chars
    runGapPipeline(gapTracker, {
      agentId: 'haiku-researcher',
      evidence: longEvidence,
      taskId: 'task-trunc-003',
    });

    const entries = readGapLog(testDir);
    expect(entries).toHaveLength(1);
    const reason = entries[0].reason as string;
    // reason = "Auto: hallucination_caught — <evidence[:120]>"
    const evidencePart = reason.replace('Auto: hallucination_caught — ', '');
    expect(evidencePart.length).toBeLessThanOrEqual(120);
  });

  it('writes a valid ISO timestamp to the suggestion', () => {
    const gapTracker = new SkillGapTracker(testDir);
    runGapPipeline(gapTracker, {
      agentId: 'sonnet-reviewer',
      evidence: 'Hallucinated about lock semantics — deadlock was not possible here.',
      taskId: 'task-ts-004',
    });

    const entries = readGapLog(testDir);
    expect(entries).toHaveLength(1);
    const ts = entries[0].timestamp as string;
    expect(isFinite(new Date(ts).getTime())).toBe(true);
  });
});

// ── 4. No keyword match → no gap suggestion ───────────────────────────────────

describe('hallucination → gap pipeline — no keyword match skips suggestion', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTmpDir('gap-nomatch');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('does not write a gap entry when evidence has no category keywords', () => {
    const gapTracker = new SkillGapTracker(testDir);
    const category = runGapPipeline(gapTracker, {
      agentId: 'sonnet-reviewer',
      evidence: 'The finding was completely fabricated with no recognizable pattern.',
      taskId: 'task-none-001',
    });

    // 'pattern' and 'fabricated' are not in DEFAULT_KEYWORDS
    expect(category).toBe('');
    const entries = readGapLog(testDir);
    expect(entries).toHaveLength(0);
  });

  it('does not write a gap entry when evidence is an empty string', () => {
    const gapTracker = new SkillGapTracker(testDir);
    const category = runGapPipeline(gapTracker, {
      agentId: 'haiku-researcher',
      evidence: '',
      taskId: 'task-empty-002',
    });

    expect(category).toBe('');
    expect(readGapLog(testDir)).toHaveLength(0);
  });

  it('picks the category with the most keyword hits when multiple match', () => {
    const gapTracker = new SkillGapTracker(testDir);
    // concurrency: 'race condition', 'concurrent'  (2 hits)
    // resource_exhaustion: 'timeout' (1 hit)
    const category = runGapPipeline(gapTracker, {
      agentId: 'agent-x',
      evidence: 'There is a race condition in the concurrent map mutation, and a timeout was not set.',
      taskId: 'task-best-003',
    });

    expect(category).toBe('concurrency');
  });
});

// ── 5. Signal formatting ──────────────────────────────────────────────────────

describe('gossip_signals formatting — taskId synthesis, evidence truncation, timestamp', () => {
  const MAX_EVIDENCE_LENGTH = 2000;

  function formatSignals(
    signals: Array<{
      signal: string;
      agent_id: string;
      finding?: string;
      evidence?: string;
      counterpart_id?: string;
      finding_id?: string;
      severity?: string;
    }>,
    task_id?: string,
  ) {
    const timestamp = new Date().toISOString();
    return signals.map((s, i) => ({
      type: 'consensus' as const,
      taskId: task_id || `manual-${timestamp.replace(/[:.]/g, '')}-${i}`,
      signal: s.signal,
      agentId: s.agent_id,
      counterpartId: s.counterpart_id,
      findingId: s.finding_id,
      severity: s.severity,
      source: 'manual' as const,
      evidence: ((s.evidence || s.finding) ?? '').slice(0, MAX_EVIDENCE_LENGTH),
      timestamp,
    }));
  }

  it('uses provided task_id in formatted signal', () => {
    const formatted = formatSignals([{
      signal: 'agreement',
      agent_id: 'agent-a',
      counterpart_id: 'agent-b',
      evidence: 'Both agree on the race condition.',
    }], 'explicit-task-id');

    expect(formatted[0].taskId).toBe('explicit-task-id');
  });

  it('synthesises a taskId when none is provided', () => {
    const formatted = formatSignals([{
      signal: 'unique_confirmed',
      agent_id: 'agent-a',
      evidence: 'Confirmed unbounded growth.',
    }]);

    expect(formatted[0].taskId).toMatch(/^manual-/);
    // Colons and dots should be stripped from the timestamp portion
    expect(formatted[0].taskId).not.toMatch(/[:.]/);
  });

  it('each signal in a batch gets a unique index suffix in synthetic taskId', () => {
    const formatted = formatSignals([
      { signal: 'unique_confirmed', agent_id: 'a1', evidence: 'e1' },
      { signal: 'unique_confirmed', agent_id: 'a2', evidence: 'e2' },
    ]);

    expect(formatted[0].taskId).toMatch(/-0$/);
    expect(formatted[1].taskId).toMatch(/-1$/);
  });

  it('truncates evidence to 2000 chars', () => {
    const longEvidence = 'x'.repeat(5000);
    const formatted = formatSignals([{
      signal: 'unique_confirmed',
      agent_id: 'agent-a',
      evidence: longEvidence,
    }]);

    expect(formatted[0].evidence.length).toBe(MAX_EVIDENCE_LENGTH);
  });

  it('falls back to finding when evidence is absent', () => {
    const formatted = formatSignals([{
      signal: 'unique_confirmed',
      agent_id: 'agent-a',
      finding: 'Race condition in dispatch loop',
      // no evidence field
    }]);

    expect(formatted[0].evidence).toBe('Race condition in dispatch loop');
  });

  it('produces an empty string when both evidence and finding are absent', () => {
    const formatted = formatSignals([{
      signal: 'unique_confirmed',
      agent_id: 'agent-a',
    }]);

    expect(formatted[0].evidence).toBe('');
  });

  it('all signals in a batch share the same timestamp', () => {
    const formatted = formatSignals([
      { signal: 'agreement', agent_id: 'a1', counterpart_id: 'a2' },
      { signal: 'agreement', agent_id: 'a2', counterpart_id: 'a1' },
    ], 'shared-task');

    expect(formatted[0].timestamp).toBe(formatted[1].timestamp);
  });

  it('PerformanceWriter accepts the formatted signal objects', () => {
    const testDir = makeTmpDir('format-write');
    try {
      const writer = new PerformanceWriter(testDir);
      const formatted = formatSignals([{
        signal: 'unique_confirmed',
        agent_id: 'gemini-reviewer',
        evidence: 'Confirmed unbounded file growth.',
      }], 'write-task-001');

      // Cast to PerformanceSignal[] — the formatSignals helper widens signal to string
      // for test flexibility; PerformanceWriter validates the actual value at runtime.
      expect(() => writer.appendSignals(formatted as any)).not.toThrow();

      const path = join(testDir, '.gossip', 'agent-performance.jsonl');
      const line = JSON.parse(readFileSync(path, 'utf-8').trim());
      expect(line.agentId).toBe('gemini-reviewer');
      expect(line.signal).toBe('unique_confirmed');
      expect(line.taskId).toBe('write-task-001');
      // Regression: source='manual' must persist so gossip_status pending-signals
      // detector (mcp-server-sdk.ts filters sig.source !== 'manual') sees coverage.
      expect(line.source).toBe('manual');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Regression guards for the real handler in mcp-server-sdk.ts — the handler is
  // not unit-testable (inline registerTool callback), so we grep the source to
  // ensure both write sites set source:'manual'. If either regresses, the
  // pending-signals detector silently stops clearing after signal recording.
  it('handler sets source:"manual" in the record-consensus branch', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
      'utf-8',
    );
    // Match the consensus-type return object in the record handler (not the IMPL branch)
    const consensusReturn = src.match(
      /return \{\s*type: 'consensus',[\s\S]{0,600}?timestamp: ts,\s*\};/,
    );
    expect(consensusReturn).not.toBeNull();
    expect(consensusReturn![0]).toContain("source: 'manual'");
  });

  it('handler sets source:"manual" in the bulk_from_consensus branch', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
      'utf-8',
    );
    const bulkPush = src.match(
      /toRecord\.push\(\{\s*type: 'consensus',[\s\S]{0,600}?timestamp: batchTs,\s*\}/,
    );
    expect(bulkPush).not.toBeNull();
    expect(bulkPush![0]).toContain("source: 'manual'");
  });
});

// ── 5b. bulk_from_consensus category assignment ───────────────────────────────

/**
 * The bulk_from_consensus addSignal helper must call bulkInferCategory on the
 * finding text so signals get a category field. Signals without category are
 * invisible to getCountersSince() — they count toward signal volume but not
 * toward skill accuracy. We test the inferCategory logic directly (same
 * DEFAULT_KEYWORDS table) and assert structural presence in the source.
 */

function bulkInferCategory(text: string): string | undefined {
  if (!text.trim()) return undefined;
  let bestCategory = '';
  let bestHits = 0;
  for (const [category, keywords] of Object.entries(DEFAULT_KEYWORDS)) {
    const hits = (keywords as string[]).filter(kw => text.includes(kw)).length;
    if (hits > bestHits) { bestHits = hits; bestCategory = category; }
  }
  return bestHits >= 1 ? bestCategory : undefined;
}

describe('bulk_from_consensus — category assignment via bulkInferCategory', () => {
  it('returns a category when finding text contains a keyword match', () => {
    // "race condition" is a concurrency keyword
    const category = bulkInferCategory('race condition in the dispatch loop at dispatcher.ts:42');
    expect(category).toBeDefined();
    expect(category).toBe('concurrency');
  });

  it('returns undefined when finding text has no keyword matches', () => {
    const category = bulkInferCategory('this finding has no recognizable category keywords xyz');
    expect(category).toBeUndefined();
  });

  it('returns undefined for empty finding text', () => {
    expect(bulkInferCategory('')).toBeUndefined();
    expect(bulkInferCategory('   ')).toBeUndefined();
  });

  it('signal with undefined category is still persisted to PerformanceWriter (no drop gate)', () => {
    const testDir = makeTmpDir('bulk-no-category');
    try {
      const writer = new PerformanceWriter(testDir);
      // Simulate what addSignal does when category is undefined
      writer.appendSignals([{
        type: 'consensus' as const,
        signal: 'agreement',
        agentId: 'agent-a',
        taskId: 'bulk-test-001',
        findingId: 'cid-1234:agent-a:f1',
        source: 'manual',
        evidence: 'this finding has no category keywords xyz',
        timestamp: new Date().toISOString(),
        // category intentionally omitted — mirrors undefined path
      }]);
      const path = join(testDir, '.gossip', 'agent-performance.jsonl');
      const line = JSON.parse(readFileSync(path, 'utf-8').trim());
      // Signal must be persisted regardless of missing category
      expect(line.signal).toBe('agreement');
      expect(line.agentId).toBe('agent-a');
      expect(line.category).toBeUndefined();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('receipt includes "Categorized M/N" substring in the bulk_from_consensus handler', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
      'utf-8',
    );
    expect(src).toContain('Categorized ${categorizedCount}/${totalRecorded}');
  });

  it('handler assigns category field in the toRecord.push call', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
      'utf-8',
    );
    const bulkPush = src.match(
      /toRecord\.push\(\{[\s\S]{0,800}?timestamp: batchTs,\s*\}/,
    );
    expect(bulkPush).not.toBeNull();
    expect(bulkPush![0]).toContain('category');
  });
});

// ── 6. Retraction validation ──────────────────────────────────────────────────

describe('gossip_signals retraction validation', () => {
  function validateRetract(params: { agent_id?: string; task_id?: string; reason?: string }): string | null {
    if (!params.agent_id || params.agent_id.trim().length === 0) {
      return 'Error: agent_id is required for retraction.';
    }
    if (!params.task_id || params.task_id.trim().length === 0) {
      return 'Error: task_id is required for retraction. Use the task ID from the original signal.';
    }
    if (!params.reason || params.reason.trim().length === 0) {
      return 'Error: reason is required for retraction.';
    }
    return null;
  }

  it('rejects retraction without agent_id', () => {
    const err = validateRetract({ task_id: 'task-1', reason: 'Wrong finding' });
    expect(err).not.toBeNull();
    expect(err).toContain('agent_id');
    expect(err).toContain('required');
  });

  it('rejects retraction with empty agent_id', () => {
    const err = validateRetract({ agent_id: '', task_id: 'task-1', reason: 'Wrong finding' });
    expect(err).not.toBeNull();
    expect(err).toContain('agent_id');
  });

  it('rejects retraction without task_id', () => {
    const err = validateRetract({ agent_id: 'agent-a', reason: 'Wrong finding' });
    expect(err).not.toBeNull();
    expect(err).toContain('task_id');
    expect(err).toContain('required');
  });

  it('rejects retraction with empty task_id', () => {
    const err = validateRetract({ agent_id: 'agent-a', task_id: '   ', reason: 'Wrong finding' });
    expect(err).not.toBeNull();
    expect(err).toContain('task_id');
  });

  it('rejects retraction without reason', () => {
    const err = validateRetract({ agent_id: 'agent-a', task_id: 'task-1' });
    expect(err).not.toBeNull();
    expect(err).toContain('reason');
    expect(err).toContain('required');
  });

  it('rejects retraction with whitespace-only reason', () => {
    const err = validateRetract({ agent_id: 'agent-a', task_id: 'task-1', reason: '  ' });
    expect(err).not.toBeNull();
    expect(err).toContain('reason');
  });

  it('accepts retraction with all required fields present', () => {
    const err = validateRetract({
      agent_id: 'haiku-researcher',
      task_id: 'task-abc',
      reason: 'The finding was verified as incorrect — code does not persist to disk.',
    });
    expect(err).toBeNull();
  });

  it('retraction signal is written to PerformanceWriter as signal_retracted', () => {
    const testDir = makeTmpDir('retract-write');
    try {
      const writer = new PerformanceWriter(testDir);
      const task_id = 'task-retract-001';
      const agent_id = 'haiku-researcher';
      const reason = 'Verified the finding was fabricated.';

      writer.appendSignals([{
        type: 'consensus' as const,
        taskId: task_id,
        signal: 'signal_retracted',
        agentId: agent_id,
        evidence: `Retracted: ${reason}`,
        timestamp: new Date().toISOString(),
      }]);

      const path = join(testDir, '.gossip', 'agent-performance.jsonl');
      const line = JSON.parse(readFileSync(path, 'utf-8').trim());
      expect(line.signal).toBe('signal_retracted');
      expect(line.agentId).toBe('haiku-researcher');
      expect(line.evidence).toContain('Retracted:');
      expect(line.evidence).toContain(reason);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ── Timestamp resolution & validation (signal-timestamp-from-task-time spec) ──
//
// Replicates the resolution + validation logic from mcp-server-sdk.ts so we can
// exercise it without spinning up the full server. Mirrors the production code:
// per-signal `timestamp` (highest precedence) → `task_start_time` (batch) →
// wall-clock + i ms fallback. Caller-provided timestamps are clamped to a sane
// 30-day-back / 1-hour-forward window to prevent score manipulation.

describe('gossip_signals timestamp resolution + spoofing rejection', () => {
  function resolveTimestamps(opts: {
    taskStartTime?: string;
    signals: Array<{ timestamp?: string }>;
    nowMs: number;
  }): { error?: string; timestamps?: string[] } {
    const wallClockMs = opts.nowMs;
    const MIN_TS_MS = wallClockMs - 30 * 24 * 60 * 60 * 1000;
    const MAX_TS_MS = wallClockMs + 60 * 60 * 1000;
    const validateTimestamp = (ts: string | undefined, label: string): string | null => {
      if (!ts) return null;
      const parsed = new Date(ts).getTime();
      if (!Number.isFinite(parsed)) return `Error: ${label} is not a valid ISO-8601 date: ${ts}`;
      if (parsed < MIN_TS_MS) return `Error: ${label} is more than 30 days in the past (${ts}). Rejecting to prevent score manipulation.`;
      if (parsed > MAX_TS_MS) return `Error: ${label} is more than 1 hour in the future (${ts}). Rejecting to prevent score manipulation.`;
      return null;
    };
    const tstErr = validateTimestamp(opts.taskStartTime, 'task_start_time');
    if (tstErr) return { error: tstErr };
    for (let i = 0; i < opts.signals.length; i++) {
      const err = validateTimestamp(opts.signals[i].timestamp, `signal[${i}].timestamp`);
      if (err) return { error: err };
    }
    const timestamps = opts.signals.map((s, i) => {
      if (s.timestamp) return s.timestamp;
      if (opts.taskStartTime) return new Date(new Date(opts.taskStartTime).getTime() + i).toISOString();
      return new Date(wallClockMs + i).toISOString();
    });
    return { timestamps };
  }

  const NOW_MS = new Date('2026-04-08T12:00:00.000Z').getTime();

  it('per-signal timestamps win over task_start_time', () => {
    const r = resolveTimestamps({
      taskStartTime: '2026-04-01T00:00:00.000Z',
      signals: [
        { timestamp: '2026-04-05T10:00:00.000Z' },
        { timestamp: '2026-04-06T10:00:00.000Z' },
      ],
      nowMs: NOW_MS,
    });
    expect(r.error).toBeUndefined();
    expect(r.timestamps).toEqual([
      '2026-04-05T10:00:00.000Z',
      '2026-04-06T10:00:00.000Z',
    ]);
  });

  it('task_start_time used as fallback when per-signal omitted, with +i ms offsets', () => {
    const r = resolveTimestamps({
      taskStartTime: '2026-04-04T14:08:13.631Z',
      signals: [{}, {}, {}],
      nowMs: NOW_MS,
    });
    expect(r.error).toBeUndefined();
    expect(r.timestamps).toEqual([
      '2026-04-04T14:08:13.631Z',
      '2026-04-04T14:08:13.632Z',
      '2026-04-04T14:08:13.633Z',
    ]);
  });

  it('wall-clock fallback when both omitted, distinct per signal', () => {
    const r = resolveTimestamps({
      signals: [{}, {}, {}],
      nowMs: NOW_MS,
    });
    expect(r.error).toBeUndefined();
    expect(r.timestamps).toEqual([
      '2026-04-08T12:00:00.000Z',
      '2026-04-08T12:00:00.001Z',
      '2026-04-08T12:00:00.002Z',
    ]);
    // Critical: distinct so the reader's chronological sort is meaningful.
    expect(new Set(r.timestamps).size).toBe(r.timestamps!.length);
  });

  it('rejects task_start_time more than 1 hour in the future', () => {
    const r = resolveTimestamps({
      taskStartTime: '3026-01-01T00:00:00.000Z',
      signals: [{}],
      nowMs: NOW_MS,
    });
    expect(r.error).toMatch(/more than 1 hour in the future/);
    expect(r.error).toMatch(/task_start_time/);
  });

  it('rejects task_start_time more than 30 days in the past', () => {
    const r = resolveTimestamps({
      taskStartTime: '1970-01-01T00:00:00.000Z',
      signals: [{}],
      nowMs: NOW_MS,
    });
    expect(r.error).toMatch(/more than 30 days in the past/);
  });

  it('rejects per-signal timestamp far in the future', () => {
    const r = resolveTimestamps({
      signals: [{ timestamp: '3026-01-01T00:00:00.000Z' }],
      nowMs: NOW_MS,
    });
    expect(r.error).toMatch(/more than 1 hour in the future/);
    expect(r.error).toMatch(/signal\[0\]/);
  });

  it('rejects garbage timestamp', () => {
    const r = resolveTimestamps({
      taskStartTime: 'not a date',
      signals: [{}],
      nowMs: NOW_MS,
    });
    expect(r.error).toMatch(/not a valid ISO-8601 date/);
  });

  it('accepts task_start_time exactly 1 hour in the future (boundary)', () => {
    const r = resolveTimestamps({
      taskStartTime: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
      signals: [{}],
      nowMs: NOW_MS,
    });
    expect(r.error).toBeUndefined();
  });
});

// ── 8. Weak-category trigger sparse-data gate ────────────────────────────────

describe('gossip_signals weak-category trigger — sparse-data gate', () => {
  const MIN_CATEGORY_N_FOR_TRIGGER = 5;

  // Replica of the trigger filter at apps/cli/src/mcp-server-sdk.ts:2353-2370.
  // If the handler changes, keep this in sync; also see the source-grep guard below.
  function pickWeakestCategory(score: {
    categoryStrengths?: Record<string, number>;
    categoryCorrect?: Record<string, number>;
    categoryHallucinated?: Record<string, number>;
  }): { category: string; value: number } | null {
    const cats = score.categoryStrengths;
    const correctCounts = score.categoryCorrect || {};
    const hallucinatedCounts = score.categoryHallucinated || {};
    let weakestCategory: string | null = null;
    let weakestValue = Infinity;
    if (cats && typeof cats === 'object') {
      for (const [k, v] of Object.entries(cats)) {
        const val = v as number;
        const n = (correctCounts[k] ?? 0) + (hallucinatedCounts[k] ?? 0);
        if (n < MIN_CATEGORY_N_FOR_TRIGGER) continue;
        if (val < 0.3 && val < weakestValue) {
          weakestValue = val;
          weakestCategory = k;
        }
      }
    }
    return weakestCategory ? { category: weakestCategory, value: weakestValue } : null;
  }

  it('fires when category has ≥5 classified signals and low strength', () => {
    const r = pickWeakestCategory({
      categoryStrengths: { trust_boundaries: 0.15 },
      categoryCorrect: { trust_boundaries: 4 },
      categoryHallucinated: { trust_boundaries: 2 }, // n = 6
    });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('trust_boundaries');
    expect(r!.value).toBeCloseTo(0.15);
  });

  it('stays silent when category has <5 classified signals (the sparse-data false positive we are fixing)', () => {
    // Reproduces the sonnet-reviewer citation_grounding case: one old decayed
    // agreement gives strength ≈ 0.002 which displays "0.00", but the total
    // classified signals (c + h) is only 1 — not enough to flag.
    const r = pickWeakestCategory({
      categoryStrengths: { citation_grounding: 0.002 },
      categoryCorrect: { citation_grounding: 1 }, // n = 1, below gate
      categoryHallucinated: {},
    });
    expect(r).toBeNull();
  });

  it('does not fire when category is strong (regression guard)', () => {
    const r = pickWeakestCategory({
      categoryStrengths: { data_integrity: 1.2 },
      categoryCorrect: { data_integrity: 12 },
      categoryHallucinated: { data_integrity: 1 },
    });
    expect(r).toBeNull();
  });

  it('picks the lowest-strength category among multiple eligible weak ones', () => {
    const r = pickWeakestCategory({
      categoryStrengths: { error_handling: 0.25, type_safety: 0.10, concurrency: 0.20 },
      categoryCorrect: { error_handling: 10, type_safety: 8, concurrency: 6 },
      categoryHallucinated: {},
    });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('type_safety');
  });

  it('regression guard: handler source at mcp-server-sdk.ts keeps the MIN_CATEGORY_N gate', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
      'utf-8',
    );
    // Locate the trigger block and assert it preconditions on (correct + hallucinated) >= N
    expect(src).toMatch(/MIN_CATEGORY_N_FOR_TRIGGER/);
    expect(src).toMatch(/const n = \(correctCounts\[k\] \?\? 0\) \+ \(hallucinatedCounts\[k\] \?\? 0\);/);
    expect(src).toMatch(/if \(n < MIN_CATEGORY_N_FOR_TRIGGER\) continue;/);
  });
});
