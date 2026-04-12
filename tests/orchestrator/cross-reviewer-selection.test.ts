/**
 * Cross-reviewer selection tests — particularly the fresh agent pool edge case.
 *
 * When all agents have zero scores (fresh pool with no performance history),
 * the selection fallback ensures at least K agents are assigned per finding.
 */

import { selectCrossReviewers, FindingForSelection, AgentCandidate } from '../../packages/orchestrator/src/cross-reviewer-selection';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

const TEST_ROOT = '/tmp/gossip-cross-review-test-' + process.pid;

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
});
