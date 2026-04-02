import { PerformanceReader, extractCategories, DispatchDifferentiator, PerformanceWriter } from '@gossip/orchestrator';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ATI v3 — full loop integration', () => {
  const testDir = join(tmpdir(), 'gossip-ati-integration-' + Date.now());
  let writer: PerformanceWriter;
  const differ = new DispatchDifferentiator();

  beforeAll(() => {
    mkdirSync(join(testDir, '.gossip'), { recursive: true });
    writer = new PerformanceWriter(testDir);
  });

  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  test('consensus → category extraction → score update → differentiation', () => {
    // 1. Simulate confirmed findings with categories for two agents
    const findingsA = ['Prompt injection via unsanitized input', 'Authentication bypass on relay'];
    const findingsB = ['Race condition in scope validation', 'Unbounded memory allocation'];

    for (const f of findingsA) {
      for (const cat of extractCategories(f)) {
        writer.appendSignal({ type: 'consensus', signal: 'category_confirmed', agentId: 'agent-a', taskId: 'review-1', category: cat, evidence: f, timestamp: new Date().toISOString() });
      }
    }
    for (const f of findingsB) {
      for (const cat of extractCategories(f)) {
        writer.appendSignal({ type: 'consensus', signal: 'category_confirmed', agentId: 'agent-b', taskId: 'review-1', category: cat, evidence: f, timestamp: new Date().toISOString() });
      }
    }

    // 2. Read scores
    const reader = new PerformanceReader(testDir);
    const scoreA = reader.getAgentScore('agent-a');
    const scoreB = reader.getAgentScore('agent-b');
    expect(scoreA).not.toBeNull();
    expect(scoreB).not.toBeNull();

    // agent-a should be strong in injection/trust, agent-b in concurrency/resource
    expect(scoreA!.categoryStrengths['injection_vectors']).toBeGreaterThan(0);
    expect(scoreA!.categoryStrengths['trust_boundaries']).toBeGreaterThan(0);
    expect(scoreB!.categoryStrengths['concurrency']).toBeGreaterThan(0);
    expect(scoreB!.categoryStrengths['resource_exhaustion']).toBeGreaterThan(0);

    // 3. Differentiate
    const diffMap = differ.differentiate([scoreA!, scoreB!], 'security review');
    // Both agents have strengths so differentiation should work
    if (diffMap.size === 2) {
      const promptA = diffMap.get('agent-a')!;
      const promptB = diffMap.get('agent-b')!;
      expect(promptA).toBeDefined();
      expect(promptB).toBeDefined();

      // 4. Privacy check — no peer names in prompts
      expect(promptA).not.toContain('agent-b');
      expect(promptB).not.toContain('agent-a');
    }
  });

  test('impl signals tracked via getImplScore', () => {
    // Add impl signals
    for (let i = 0; i < 3; i++) {
      writer.appendSignal({ type: 'impl', signal: 'impl_test_pass', agentId: 'agent-a', taskId: `impl-${i}`, timestamp: new Date().toISOString() });
    }
    writer.appendSignal({ type: 'impl', signal: 'impl_test_fail', agentId: 'agent-a', taskId: 'impl-3', timestamp: new Date().toISOString() });

    const reader = new PerformanceReader(testDir);
    const implScore = reader.getImplScore('agent-a');
    expect(implScore).not.toBeNull();
    expect(implScore!.passRate).toBeCloseTo(0.75, 1); // 3 pass / 4 total
  });

  test('dispatch weight is bounded', () => {
    const reader = new PerformanceReader(testDir);
    const weight = reader.getDispatchWeight('agent-a');
    expect(weight).toBeGreaterThanOrEqual(0.3);
    expect(weight).toBeLessThanOrEqual(2.0);
  });
});
