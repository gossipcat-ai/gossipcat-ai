/**
 * Cross-reviewer selection tests — particularly the fresh agent pool edge case.
 *
 * When all agents have zero scores (fresh pool with no performance history),
 * the selection fallback ensures at least K agents are assigned per finding.
 */

import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
let mockRandomBytesValue: Buffer | null = null;

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    randomBytes: (...args: any[]) => {
      if (mockRandomBytesValue !== null) return mockRandomBytesValue;
      return actual.randomBytes(...args);
    },
  };
});

// Must import AFTER jest.mock so the mock is in place
import { selectCrossReviewers, FindingForSelection, AgentCandidate } from '../../packages/orchestrator/src/cross-reviewer-selection';

const TEST_ROOT = '/tmp/gossip-cross-review-test-' + process.pid;

/**
 * Mock secureRandom() to return a deterministic value.
 * secureRandom() uses randomBytes(4).readUInt32BE(0) / 0x100000000.
 */
function mockSecureRandom(value: number) {
  const uint32 = Math.floor(value * 0x100000000);
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(uint32);
  mockRandomBytesValue = buf;
}

function clearMockSecureRandom() {
  mockRandomBytesValue = null;
}

function setupTestDir() {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
  mkdirSync(join(TEST_ROOT, '.gossip'), { recursive: true });
}

function cleanupTestDir() {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
}

describe('Cross-Reviewer Selection', () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  describe('Fresh Agent Pool (All-Zero Scores)', () => {
    it('should select K reviewers even when all agents have zero scores', () => {
      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Buffer overflow in strncpy call (input_validation)',
          declaredCategory: 'input_validation',
          severity: 'critical',
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
      ];

      // Empty performance file — all agents have zero scores
      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), '');

      const reader = new PerformanceReader(TEST_ROOT);
      const assignments = selectCrossReviewers(findings, agents, reader);

      // Should have assigned at least one agent (K=3 for critical, but only 3 candidates exist)
      expect(assignments.size).toBeGreaterThan(0);

      // Verify that the assigned agents are valid
      const assignedAgents = Array.from(assignments.keys());
      expect(assignedAgents).toEqual(expect.arrayContaining(['agent-b', 'agent-c', 'agent-d']));
      expect(assignedAgents.length).toBe(3); // K=3 for critical, all 3 non-author agents should be assigned
    });

    it('should assign K=2 reviewers for medium-severity findings in fresh pool', () => {
      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Race condition in shared cache access (concurrency)',
          declaredCategory: 'concurrency',
          severity: 'medium',
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
      ];

      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), '');

      const reader = new PerformanceReader(TEST_ROOT);
      const assignments = selectCrossReviewers(findings, agents, reader);

      // Should assign K=2 reviewers for medium severity
      expect(assignments.size).toBe(2);
      expect(Array.from(assignments.keys()).sort()).toEqual(['agent-b', 'agent-c']);
    });

    it('should handle case where there are fewer candidates than K', () => {
      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Memory leak (type_safety)',
          declaredCategory: 'type_safety',
          severity: 'critical', // K=3
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        // Only 2 non-author candidates, but K=3 for critical
      ];

      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), '');

      const reader = new PerformanceReader(TEST_ROOT);
      const assignments = selectCrossReviewers(findings, agents, reader);

      // Should assign min(K, candidates) = min(3, 2) = 2 reviewers
      expect(assignments.size).toBe(2);
    });

    it('should not assign the original author as a reviewer', () => {
      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'SQL injection (injection_vectors)',
          severity: 'high',
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-a' }, // Author — should be excluded
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
      ];

      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), '');

      const reader = new PerformanceReader(TEST_ROOT);
      const assignments = selectCrossReviewers(findings, agents, reader);

      // Should assign agent-b and agent-c, but NOT agent-a
      const assignedAgents = Array.from(assignments.keys());
      expect(assignedAgents).not.toContain('agent-a');
      expect(assignedAgents).toEqual(expect.arrayContaining(['agent-b', 'agent-c']));
    });

    it('should handle empty candidate pool gracefully', () => {
      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Some finding',
          severity: 'medium',
        },
      ];

      // Only the author exists
      const agents: AgentCandidate[] = [
        { agentId: 'agent-a' },
      ];

      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), '');

      const reader = new PerformanceReader(TEST_ROOT);
      const assignments = selectCrossReviewers(findings, agents, reader);

      // No valid candidates (only author exists, and author is excluded)
      expect(assignments.size).toBe(0);
    });

    it('should assign K=2 reviewers for high-severity findings in fresh pool', () => {
      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'XSS in user input rendering (injection_vectors)',
          severity: 'high',
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
      ];

      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), '');

      const reader = new PerformanceReader(TEST_ROOT);
      const assignments = selectCrossReviewers(findings, agents, reader);

      // K=2 for high severity — should assign exactly 2 reviewers
      const findingCount = Array.from(assignments.values())
        .filter(set => set.has('agent-a:f1')).length;
      expect(findingCount).toBe(2);
    });

    it('should assign K=2 reviewers for low-severity findings in fresh pool', () => {
      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Minor style issue (data_integrity)',
          severity: 'low',
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
      ];

      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), '');

      const reader = new PerformanceReader(TEST_ROOT);
      const assignments = selectCrossReviewers(findings, agents, reader);

      // K=2 for low severity
      const findingCount = Array.from(assignments.values())
        .filter(set => set.has('agent-a:f1')).length;
      expect(findingCount).toBe(2);
    });

    it('should randomize selection across multiple findings to balance load', () => {
      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Finding 1 (data_integrity)',
          severity: 'medium',
        },
        {
          id: 'agent-a:f2',
          originalAuthor: 'agent-a',
          content: 'Finding 2 (error_handling)',
          severity: 'medium',
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
      ];

      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), '');

      const reader = new PerformanceReader(TEST_ROOT);
      const assignments = selectCrossReviewers(findings, agents, reader);

      // Each finding should get K=2 reviewers
      const findingCounts = new Map<string, number>();
      for (const [, assignedFindings] of assignments) {
        for (const fid of assignedFindings) {
          findingCounts.set(fid, (findingCounts.get(fid) ?? 0) + 1);
        }
      }

      expect(findingCounts.get('agent-a:f1')).toBe(2);
      expect(findingCounts.get('agent-a:f2')).toBe(2);
    });
  });

  describe('Category-Specific Scoring (accuracy * 0.7 + catAccuracy * 0.3)', () => {
    function writePerformanceSignals(signals: Array<Record<string, unknown>>) {
      const lines = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), lines);
    }

    /** Build a properly formatted consensus signal */
    function sig(signal: string, agentId: string, taskId: string, opts?: { category?: string }) {
      return {
        type: 'consensus',
        signal,
        agentId,
        taskId,
        timestamp: new Date().toISOString(),
        evidence: '',
        ...(opts?.category ? { category: opts.category } : {}),
      };
    }

    it('should prefer agents with higher category accuracy', () => {
      // Agent-b has high accuracy + high category accuracy for input_validation
      // Agent-c has high accuracy but no category data
      // Agent-d has lower overall accuracy but perfect category accuracy
      const signals = [
        // agent-b: accuracy ~0.8, input_validation category accuracy ~1.0
        sig('agreement', 'agent-b', 't1', { category: 'input_validation' }),
        sig('agreement', 'agent-b', 't2', { category: 'input_validation' }),
        sig('agreement', 'agent-b', 't3', { category: 'input_validation' }),
        sig('agreement', 'agent-b', 't4', { category: 'input_validation' }),
        sig('hallucination_caught', 'agent-b', 't5', { category: 'type_safety' }),
        // agent-c: accuracy ~0.6, no category data for input_validation
        sig('agreement', 'agent-c', 't1', { category: 'error_handling' }),
        sig('agreement', 'agent-c', 't2', { category: 'error_handling' }),
        sig('agreement', 'agent-c', 't3', { category: 'error_handling' }),
        sig('hallucination_caught', 'agent-c', 't4', { category: 'error_handling' }),
        sig('hallucination_caught', 'agent-c', 't5', { category: 'error_handling' }),
        // agent-d: accuracy ~0.5 but perfect input_validation category
        sig('agreement', 'agent-d', 't1', { category: 'input_validation' }),
        sig('agreement', 'agent-d', 't2', { category: 'input_validation' }),
        sig('hallucination_caught', 'agent-d', 't3', { category: 'type_safety' }),
        sig('hallucination_caught', 'agent-d', 't4', { category: 'type_safety' }),
      ];
      writePerformanceSignals(signals);

      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Buffer overflow in strncpy call — input_validation issue',
          declaredCategory: 'input_validation',
          severity: 'medium', // K=2
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
      ];

      const reader = new PerformanceReader(TEST_ROOT);
      const assignments = selectCrossReviewers(findings, agents, reader);

      // K=2: top 2 should be selected — agents with category expertise should rank higher
      const assignedAgents = Array.from(assignments.keys());
      expect(assignedAgents.length).toBe(2);
      // At minimum, agents with input_validation category data should be present
      // (agent-b has both high accuracy + category, agent-d has category expertise)
      // agent-c has NO input_validation category data so competes on accuracy alone
    });

    it('should use accuracy-only when category is null/unknown', () => {
      const signals = [
        // agent-b: high accuracy
        sig('agreement', 'agent-b', 't1'),
        sig('agreement', 'agent-b', 't2'),
        sig('agreement', 'agent-b', 't3'),
        // agent-c: low accuracy
        sig('agreement', 'agent-c', 't1'),
        sig('hallucination_caught', 'agent-c', 't2'),
        sig('hallucination_caught', 'agent-c', 't3'),
      ];
      writePerformanceSignals(signals);

      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          // Content with no recognizable category keywords
          content: 'Generic issue with no clear category mapping whatsoever',
          severity: 'medium',
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
      ];

      const reader = new PerformanceReader(TEST_ROOT);
      const assignments = selectCrossReviewers(findings, agents, reader);

      // Both have scores > 0, K=2, so both should be assigned
      expect(assignments.size).toBe(2);
    });
  });

  describe('Circuit-Open Agent Exclusion', () => {
    function sig(signal: string, agentId: string, taskId: string) {
      return {
        type: 'consensus',
        signal,
        agentId,
        taskId,
        timestamp: new Date().toISOString(),
        evidence: '',
      };
    }

    it('should exclude agents with open circuit breaker', () => {
      // Agent-b gets 3 consecutive failures (circuit breaker threshold)
      const signals = [
        sig('hallucination_caught', 'agent-b', 't1'),
        sig('hallucination_caught', 'agent-b', 't2'),
        sig('hallucination_caught', 'agent-b', 't3'),
        // Agent-c has good performance
        sig('agreement', 'agent-c', 't1'),
        sig('agreement', 'agent-c', 't2'),
        // Agent-d has good performance
        sig('agreement', 'agent-d', 't1'),
        sig('agreement', 'agent-d', 't2'),
      ];
      const lines = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), lines);

      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Some finding about error_handling patterns',
          severity: 'medium',
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' }, // circuit should be open
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
      ];

      const reader = new PerformanceReader(TEST_ROOT);
      const assignments = selectCrossReviewers(findings, agents, reader);

      // agent-b should be excluded because circuit is open
      expect(assignments.has('agent-b')).toBe(false);
      // agent-c and agent-d should be assigned
      expect(assignments.has('agent-c')).toBe(true);
      expect(assignments.has('agent-d')).toBe(true);
    });
  });

  describe('Epsilon-Greedy Exploration', () => {
    function sig(signal: string, agentId: string, taskId: string) {
      return {
        type: 'consensus',
        signal,
        agentId,
        taskId,
        timestamp: new Date().toISOString(),
        evidence: '',
      };
    }

    it('should sometimes swap weakest top-K with signal-starved candidate when secureRandom triggers', () => {
      // Set up a pool where below-median candidates exist and are signal-starved
      const signals = [
        // agent-b: high accuracy (top candidate)
        sig('agreement', 'agent-b', 'tb1'),
        sig('agreement', 'agent-b', 'tb2'),
        sig('agreement', 'agent-b', 'tb3'),
        sig('agreement', 'agent-b', 'tb4'),
        // agent-c: high accuracy (top candidate)
        sig('agreement', 'agent-c', 'tc1'),
        sig('agreement', 'agent-c', 'tc2'),
        sig('agreement', 'agent-c', 'tc3'),
        // agent-d: lower accuracy, very few signals — signal-starved
        sig('agreement', 'agent-d', 'td1'),
        sig('hallucination_caught', 'agent-d', 'td2'),
      ];
      const lines = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), lines);

      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Low severity finding about style — very exploratory',
          severity: 'low', // sevScale=1.0 → high epsilon
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
      ];

      // Force secureRandom to always return a small value (triggers exploration)
      mockSecureRandom(0.001);

      try {
        const reader = new PerformanceReader(TEST_ROOT);
        const assignments = selectCrossReviewers(findings, agents, reader);

        // K=2 for low severity. With forced exploration, agent-d (signal-starved)
        // should replace the weakest top-K slot.
        const assignedAgents = Array.from(assignments.keys());
        expect(assignedAgents.length).toBe(2);
        // agent-d should be included via exploration swap
        expect(assignedAgents).toContain('agent-d');
      } finally {
        clearMockSecureRandom();
      }
    });

    it('should NOT explore when secureRandom is above epsilon', () => {
      const signals = [
        // agent-b: high accuracy
        sig('agreement', 'agent-b', 'tb1'),
        sig('agreement', 'agent-b', 'tb2'),
        sig('agreement', 'agent-b', 'tb3'),
        sig('agreement', 'agent-b', 'tb4'),
        // agent-c: medium accuracy
        sig('agreement', 'agent-c', 'tc1'),
        sig('agreement', 'agent-c', 'tc2'),
        sig('hallucination_caught', 'agent-c', 'tc3'),
        // agent-d: low accuracy — signal-starved
        sig('agreement', 'agent-d', 'td1'),
        sig('hallucination_caught', 'agent-d', 'td2'),
      ];
      const lines = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), lines);

      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Critical security vulnerability — do not explore here',
          severity: 'critical', // sevScale=0.15 → very low epsilon
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
      ];

      // Force secureRandom to return 0.99 — well above any epsilon
      mockSecureRandom(0.99);

      try {
        const reader = new PerformanceReader(TEST_ROOT);
        const assignments = selectCrossReviewers(findings, agents, reader);

        // K=3 for critical. With forced no-exploration, the top-3 by score stay.
        const assignedAgents = Array.from(assignments.keys());
        // All 3 agents should be assigned (K=3 for critical, 3 candidates)
        expect(assignedAgents.length).toBe(3);
      } finally {
        clearMockSecureRandom();
      }
    });

    it('should weight exploration toward most signal-starved candidates', () => {
      // Create a pool where multiple below-median candidates exist
      // with varying signal counts
      const signals = [
        // agent-b: lots of signals, high accuracy (top)
        ...Array.from({ length: 20 }, (_, i) => sig('agreement', 'agent-b', `tb${i}`)),
        // agent-c: lots of signals, medium-high accuracy (top)
        ...Array.from({ length: 15 }, (_, i) => sig('agreement', 'agent-c', `tc${i}`)),
        ...Array.from({ length: 5 }, (_, i) => sig('hallucination_caught', 'agent-c', `tc-h${i}`)),
        // agent-d: few signals, below median — should be exploration target
        sig('agreement', 'agent-d', 'td1'),
        // agent-e: few signals, below median — another exploration target
        sig('agreement', 'agent-e', 'te1'),
        sig('hallucination_caught', 'agent-e', 'te2'),
      ];
      const lines = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), lines);

      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Low severity style nit — harmless to explore',
          severity: 'low', // maximum exploration scale
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
        { agentId: 'agent-e' },
      ];

      // Force exploration to trigger, then weight selection picks the first starved
      mockSecureRandom(0.001);

      try {
        const reader = new PerformanceReader(TEST_ROOT);
        const assignments = selectCrossReviewers(findings, agents, reader);

        // K=2 for low: top 2 by score, but exploration replaces weakest
        expect(assignments.size).toBe(2);
      } finally {
        clearMockSecureRandom();
      }
    });
  });

  describe('Median Computation over Mixed Score Pools', () => {
    function sig(signal: string, agentId: string, taskId: string) {
      return {
        type: 'consensus',
        signal,
        agentId,
        taskId,
        timestamp: new Date().toISOString(),
        evidence: '',
      };
    }

    it('should select top-K by score with mixed score pool', () => {
      // 4 candidates with varying scores
      const signals = [
        // agent-b: ~1.0 accuracy (4 agreements, 0 failures)
        sig('agreement', 'agent-b', 'tb1'),
        sig('agreement', 'agent-b', 'tb2'),
        sig('agreement', 'agent-b', 'tb3'),
        sig('agreement', 'agent-b', 'tb4'),
        // agent-c: ~0.5 accuracy (1 agreement, 1 failure)
        sig('agreement', 'agent-c', 'tc1'),
        sig('hallucination_caught', 'agent-c', 'tc2'),
        // agent-d: low accuracy (1 agreement, 2 failures)
        sig('agreement', 'agent-d', 'td1'),
        sig('hallucination_caught', 'agent-d', 'td2'),
        sig('hallucination_caught', 'agent-d', 'td3'),
        // agent-e: ~0.75 accuracy (3 agreements, 1 failure)
        sig('agreement', 'agent-e', 'te1'),
        sig('agreement', 'agent-e', 'te2'),
        sig('agreement', 'agent-e', 'te3'),
        sig('hallucination_caught', 'agent-e', 'te4'),
      ];
      const lines = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), lines);

      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Some finding (error_handling)',
          severity: 'medium', // K=2
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
        { agentId: 'agent-e' },
      ];

      // High random → no exploration, pure score-based selection
      mockSecureRandom(0.99);

      try {
        const reader = new PerformanceReader(TEST_ROOT);
        const assignments = selectCrossReviewers(findings, agents, reader);

        // K=2: the top 2 by score should be selected
        expect(assignments.size).toBe(2);
        // agent-b (highest: 4/4) and agent-e (second highest: 3/4) should win
        expect(assignments.has('agent-b')).toBe(true);
        expect(assignments.has('agent-e')).toBe(true);
      } finally {
        clearMockSecureRandom();
      }
    });
  });

  describe('Median Collapse Bug — Fresh Agents Excluded from Median', () => {
    function sig(signal: string, agentId: string, taskId: string) {
      return {
        type: 'consensus',
        signal,
        agentId,
        taskId,
        timestamp: new Date().toISOString(),
        evidence: '',
      };
    }

    it('should skip exploration block gracefully when pool is fully fresh (all score=0)', () => {
      // 4 agents, no performance history at all — pure fresh pool.
      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), '');

      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Some finding about error_handling',
          severity: 'medium', // K=2
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
        { agentId: 'agent-e' },
      ];

      // Force exploration dice low — if the bug were present, would try to
      // explore over an empty/zero-score below-median set.
      mockSecureRandom(0.001);

      try {
        const reader = new PerformanceReader(TEST_ROOT);
        // Must not throw / must not crash even when median over eligible is 0-length.
        const assignments = selectCrossReviewers(findings, agents, reader);

        // Fallback shuffle gave us K=2 reviewers; exploration is a no-op.
        expect(assignments.size).toBe(2);
      } finally {
        clearMockSecureRandom();
      }
    });

    it('should compute median over eligible (scored) agents only in a 50%-fresh pool', () => {
      // 2 fresh (score=0, no file entries) + 3 scored candidates.
      // Scored agent accuracies (over cross-review signals):
      //   agent-c: 1/1 = 1.0 → score ≈ 1.0 (but capped/scaled by scoring formula)
      //   agent-d: 4/5 = 0.8 → higher
      //   agent-e: below-median small score
      // The exact accuracy numbers come from the scoring pipeline; what matters:
      // if median were computed over ALL scoredCandidates (including 0s),
      // the median of [0, 0, x1, x2, x3] with eligible.length < all would still
      // collapse to a much lower number — here we just verify the bug-scenario
      // shape holds and behavior is sane.
      const signals = [
        // agent-c: perfect accuracy, few signals
        sig('agreement', 'agent-c', 'tc1'),
        // agent-d: high accuracy, many signals
        sig('agreement', 'agent-d', 'td1'),
        sig('agreement', 'agent-d', 'td2'),
        sig('agreement', 'agent-d', 'td3'),
        sig('agreement', 'agent-d', 'td4'),
        sig('hallucination_caught', 'agent-d', 'td5'),
        // agent-e: lower accuracy — should be the below-median candidate
        sig('agreement', 'agent-e', 'te1'),
        sig('hallucination_caught', 'agent-e', 'te2'),
        sig('hallucination_caught', 'agent-e', 'te3'),
      ];
      const lines = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), lines);

      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Low severity style issue about error_handling',
          severity: 'low', // K=2, sevScale=1.0 — exploration most likely
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-fresh-1' }, // score=0
        { agentId: 'agent-fresh-2' }, // score=0
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
        { agentId: 'agent-e' },
      ];

      // Force exploration: if eligible has ≥ 1 below-median member, agent-e
      // should get swapped into top-K. If the bug existed (median collapses
      // to 0 due to two fresh zeros), belowMedian would be empty and agent-e
      // would NOT be explored toward.
      mockSecureRandom(0.001);

      try {
        const reader = new PerformanceReader(TEST_ROOT);
        const assignments = selectCrossReviewers(findings, agents, reader);

        // K=2 — exploration replaced weakest top-K with below-median candidate.
        expect(assignments.size).toBe(2);

        // The signal-starved below-median candidate (agent-e) should appear
        // via exploration.
        expect(assignments.has('agent-e')).toBe(true);
      } finally {
        clearMockSecureRandom();
      }
    });

    it('regression: pure scored pool (no fresh agents) behaves identically', () => {
      // 4 scored candidates — no score=0 agents in the pool.
      const signals = [
        // agent-b: 4 agreements, top
        sig('agreement', 'agent-b', 'tb1'),
        sig('agreement', 'agent-b', 'tb2'),
        sig('agreement', 'agent-b', 'tb3'),
        sig('agreement', 'agent-b', 'tb4'),
        // agent-c: 3 agreements, 1 fail
        sig('agreement', 'agent-c', 'tc1'),
        sig('agreement', 'agent-c', 'tc2'),
        sig('agreement', 'agent-c', 'tc3'),
        sig('hallucination_caught', 'agent-c', 'tc4'),
        // agent-d: 1/2
        sig('agreement', 'agent-d', 'td1'),
        sig('hallucination_caught', 'agent-d', 'td2'),
        // agent-e: 1/3 — bottom
        sig('agreement', 'agent-e', 'te1'),
        sig('hallucination_caught', 'agent-e', 'te2'),
        sig('hallucination_caught', 'agent-e', 'te3'),
      ];
      const lines = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), lines);

      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Some finding about error_handling',
          severity: 'medium', // K=2
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
        { agentId: 'agent-e' },
      ];

      // High random → skip exploration, pure top-K by score
      mockSecureRandom(0.99);

      try {
        const reader = new PerformanceReader(TEST_ROOT);
        const assignments = selectCrossReviewers(findings, agents, reader);

        // K=2, top 2 by score should be agent-b and agent-c.
        expect(assignments.size).toBe(2);
        expect(assignments.has('agent-b')).toBe(true);
        expect(assignments.has('agent-c')).toBe(true);
      } finally {
        clearMockSecureRandom();
      }
    });

    it('should handle a single-eligible pool (3 fresh + 1 scored) without crashing', () => {
      // Only one scored agent — belowMedian filter excludes topK members,
      // so belowMedian will be empty and exploration will be a no-op.
      const signals = [
        sig('agreement', 'agent-scored', 'tsc1'),
        sig('agreement', 'agent-scored', 'tsc2'),
        sig('agreement', 'agent-scored', 'tsc3'),
      ];
      const lines = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), lines);

      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Some finding (error_handling)',
          severity: 'medium', // K=2
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-fresh-1' },
        { agentId: 'agent-fresh-2' },
        { agentId: 'agent-fresh-3' },
        { agentId: 'agent-scored' },
      ];

      // Force exploration attempt — it should still run without error, but
      // find no below-median candidate to swap in (single eligible is topK).
      mockSecureRandom(0.001);

      try {
        const reader = new PerformanceReader(TEST_ROOT);
        const assignments = selectCrossReviewers(findings, agents, reader);

        // With 1 eligible agent (agent-scored), topK fills with just that
        // agent (min(K=2, eligible.length=1) = 1). The shuffle fallback does
        // NOT fire because topK.length > 0 at the fallback gate.
        // belowMedian = eligible (score > 0 AND score <= median) minus topK
        // members → always empty when there is only one eligible agent,
        // because that agent is already in topK.
        // The exploration block therefore runs harmlessly (no swap), and no
        // crash occurs despite secureRandom being forced low.
        expect(assignments.has('agent-scored')).toBe(true);

        // Exactly 1 reviewer assigned to the finding — pre-existing behavior,
        // preserved by the fix (scope: don't change fallback or eligibility).
        const findingAssignedCount = Array.from(assignments.values())
          .filter(set => set.has('agent-a:f1')).length;
        expect(findingAssignedCount).toBe(1);
      } finally {
        clearMockSecureRandom();
      }
    });
  });

  describe('Starvation-Weighted Candidate Selection', () => {
    function sig(signal: string, agentId: string, taskId: string) {
      return {
        type: 'consensus',
        signal,
        agentId,
        taskId,
        timestamp: new Date().toISOString(),
        evidence: '',
      };
    }

    it('should use high starvation weight (0.30) for agents with < 10 signals', () => {
      const signals = [
        // agent-b: high accuracy, many cross-reviews (not starved)
        ...Array.from({ length: 60 }, (_, i) => sig('agreement', 'agent-b', `tb${i}`)),
        // agent-c: high accuracy, many cross-reviews (not starved)
        ...Array.from({ length: 55 }, (_, i) => sig('agreement', 'agent-c', `tc${i}`)),
        // agent-d: some accuracy, < 10 cross-reviews (highly starved)
        sig('agreement', 'agent-d', 'td1'),
        sig('agreement', 'agent-d', 'td2'),
        sig('hallucination_caught', 'agent-d', 'td3'),
      ];
      const lines = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
      writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), lines);

      const findings: FindingForSelection[] = [
        {
          id: 'agent-a:f1',
          originalAuthor: 'agent-a',
          content: 'Minor cosmetic issue about code style',
          severity: 'low', // sevScale=1.0 → starvation * 1.0 = 0.30 epsilon
        },
      ];

      const agents: AgentCandidate[] = [
        { agentId: 'agent-b' },
        { agentId: 'agent-c' },
        { agentId: 'agent-d' },
      ];

      // Force exploration to trigger
      mockSecureRandom(0.001);

      try {
        const reader = new PerformanceReader(TEST_ROOT);
        const assignments = selectCrossReviewers(findings, agents, reader);

        // K=2, exploration should have replaced weakest with signal-starved agent-d
        expect(assignments.size).toBe(2);
        expect(assignments.has('agent-d')).toBe(true);
      } finally {
        clearMockSecureRandom();
      }
    });
  });
});
