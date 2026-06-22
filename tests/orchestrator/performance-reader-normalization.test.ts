/**
 * Tests for category name normalization in PerformanceReader.getCountersSince().
 *
 * Signals on disk use underscore category names (e.g. `data_integrity`) because
 * that's how gossip_signals records them. Skill files use hyphenated names
 * (e.g. `data-integrity.md`) because normalizeSkillName converts underscores to
 * hyphens. check-effectiveness-runner.ts passes the hyphenated form to
 * getCountersSince. Without normalization on both sides, the counter always
 * returns 0 for any multi-word category, so the z-test never fires.
 */
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(__dirname, '..', '..', '.test-perf-norm');

function writeSignals(signals: object[]): void {
  mkdirSync(join(TEST_DIR, '.gossip'), { recursive: true });
  const data = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
  writeFileSync(join(TEST_DIR, '.gossip', 'agent-performance.jsonl'), data);
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

const NOW = new Date().toISOString();

describe('getCountersSince — category normalization', () => {
  it('matches underscore signal category when queried with hyphen form', () => {
    // Stored with underscore (canonical producer form)
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'agent-1', category: 'data_integrity', taskId: 't1', timestamp: NOW },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'agent-1', category: 'data_integrity', taskId: 't2', timestamp: NOW },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    // Query with hyphen form (as check-effectiveness-runner does)
    const counters = reader.getCountersSince('agent-1', 'data-integrity', 0);
    expect(counters).toEqual({ correct: 1, hallucinated: 1 });
  });

  it('matches hyphen signal category when queried with underscore form', () => {
    writeSignals([
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'agent-1', category: 'error-handling', taskId: 't1', timestamp: NOW },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const counters = reader.getCountersSince('agent-1', 'error_handling', 0);
    expect(counters).toEqual({ correct: 1, hallucinated: 0 });
  });

  it('normalizes all 9 multi-word categories with underscores', () => {
    const categories = [
      'data_integrity',
      'error_handling',
      'injection_vectors',
      'input_validation',
      'resource_exhaustion',
      'trust_boundaries',
      'citation_grounding',
      'type_safety',
    ];
    for (const cat of categories) {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
      mkdirSync(TEST_DIR, { recursive: true });

      writeSignals([
        { type: 'consensus', signal: 'agreement', agentId: 'a', category: cat, taskId: 't1', timestamp: NOW },
      ]);
      const reader = new PerformanceReader(TEST_DIR);
      const hyphenForm = cat.replace(/_/g, '-');
      const counters = reader.getCountersSince('a', hyphenForm, 0);
      expect(counters.correct).toBe(1);
      expect(counters.hallucinated).toBe(0);
    }
  });

  it('single-word category concurrency matches unchanged', () => {
    writeSignals([
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'a', category: 'concurrency', taskId: 't1', timestamp: NOW },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const counters = reader.getCountersSince('a', 'concurrency', 0);
    expect(counters).toEqual({ correct: 0, hallucinated: 1 });
  });

  it('does not mutate signals on disk — normalization is read-time only', () => {
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'a', category: 'type_safety', taskId: 't1', timestamp: NOW },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    reader.getCountersSince('a', 'type-safety', 0);

    // Re-read raw file and verify original underscore form is preserved
    const raw = require('fs').readFileSync(join(TEST_DIR, '.gossip', 'agent-performance.jsonl'), 'utf-8');
    const parsed = JSON.parse(raw.trim());
    expect(parsed.category).toBe('type_safety');
  });

  it('empty category in signal does not match non-empty query', () => {
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'a', taskId: 't1', timestamp: NOW },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const counters = reader.getCountersSince('a', 'data-integrity', 0);
    expect(counters).toEqual({ correct: 0, hallucinated: 0 });
  });
});
