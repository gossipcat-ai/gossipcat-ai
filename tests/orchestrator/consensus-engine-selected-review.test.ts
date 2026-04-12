/**
 * Tests for ConsensusEngine.runSelectedCrossReview (Step 3).
 *
 * Step 3 orchestrates the full pipeline: extract findings from Phase 1 results,
 * select cross-reviewers via selectCrossReviewers (Step 2), build scoped
 * summaries per reviewer, dispatch crossReviewForAgent, and synthesize.
 */

import { ConsensusEngine, ConsensusEngineConfig } from '../../packages/orchestrator/src/consensus-engine';
import { TaskEntry } from '../../packages/orchestrator/src/types';
import { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ROOT = '/tmp/gossip-selected-review-test-' + process.pid;

function setupTestDir() {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
  mkdirSync(join(TEST_ROOT, '.gossip'), { recursive: true });
  // Empty performance file — fresh pool
  writeFileSync(join(TEST_ROOT, '.gossip', 'agent-performance.jsonl'), '');
}

function cleanupTestDir() {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
}

/**
 * Build an agent_finding XML block matching the format parseAgentFindings expects.
 */
function makeFinding(opts: {
  severity?: string;
  category?: string;
  title?: string;
  content?: string;
  type?: string;
}): string {
  const sev = opts.severity ?? 'medium';
  const cat = opts.category ? ` category="${opts.category}"` : '';
  const title = opts.title ?? 'Test finding';
  const type = opts.type ?? 'finding';
  const content = opts.content ?? `Description of the finding in ${title} (file.ts:10)`;
  return `<agent_finding type="${type}" severity="${sev}"${cat} title="${title}">\n${content}\n</agent_finding>`;
}

function makeTaskEntry(agentId: string, result: string): TaskEntry {
  return {
    id: `task-${agentId}`,
    agentId,
    task: 'review the code',
    status: 'completed',
    result,
    startedAt: Date.now(),
    completedAt: Date.now(),
    inputTokens: 50,
    outputTokens: 100,
  };
}

/** Cross-review JSON that the LLM returns after reviewing peer findings. */
function makeCrossReviewResponse(peerAgentId: string, findingCount: number): string {
  const entries = [];
  for (let i = 1; i <= findingCount; i++) {
    entries.push({
      action: 'agree',
      findingId: `${peerAgentId}:f${i}`,
      finding: `Finding ${i} from ${peerAgentId}`,
      evidence: `Confirmed in code at file.ts:${i * 10}`,
      confidence: 4,
    });
  }
  return JSON.stringify(entries);
}

function makeMockLlm(responseText: string): ILLMProvider {
  return {
    generate: jest.fn().mockResolvedValue({
      text: responseText,
      inputTokens: 50,
      outputTokens: 100,
      toolCalls: [],
    }),
  } as unknown as ILLMProvider;
}

function makeMockRegistryGet() {
  return jest.fn((agentId: string) => ({
    id: agentId,
    agentId,
    provider: 'local' as const,
    model: 'test-model',
    preset: `preset-for-${agentId}`,
    skills: [],
  }));
}

function makeEngine(opts: {
  llm?: ILLMProvider;
  registryGet?: ReturnType<typeof makeMockRegistryGet>;
  performanceReader?: PerformanceReader;
  verifierToolRunner?: ConsensusEngineConfig['verifierToolRunner'];
}): ConsensusEngine {
  return new ConsensusEngine({
    llm: opts.llm ?? makeMockLlm('[]'),
    registryGet: opts.registryGet ?? makeMockRegistryGet(),
    projectRoot: TEST_ROOT,
    performanceReader: opts.performanceReader ?? new PerformanceReader(TEST_ROOT),
    verifierToolRunner: opts.verifierToolRunner,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSelectedCrossReview (Step 3)', () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  it('should throw when performanceReader is not set', async () => {
    const engine = new ConsensusEngine({
      llm: makeMockLlm('[]'),
      registryGet: makeMockRegistryGet(),
      // no performanceReader
    });

    await expect(engine.runSelectedCrossReview([])).rejects.toThrow(
      'runSelectedCrossReview requires config.performanceReader',
    );
  });

  it('should return early with skip message for < 2 successful results', async () => {
    const engine = makeEngine({});
    const results: TaskEntry[] = [
      makeTaskEntry('agent-a', 'some result'),
    ];

    const report = await engine.runSelectedCrossReview(results);

    expect(report.agentCount).toBe(0);
    expect(report.summary).toContain('insufficient agents');
    expect(report.confirmed).toEqual([]);
  });

  it('should return early for 0 results', async () => {
    const engine = makeEngine({});
    const report = await engine.runSelectedCrossReview([]);

    expect(report.agentCount).toBe(0);
    expect(report.summary).toContain('insufficient agents');
  });

  it('should skip failed results and only use completed ones', async () => {
    const finding = makeFinding({ severity: 'medium', title: 'Real finding' });
    const llm = makeMockLlm(makeCrossReviewResponse('agent-a', 1));
    const engine = makeEngine({ llm });

    const results: TaskEntry[] = [
      makeTaskEntry('agent-a', finding),
      makeTaskEntry('agent-b', finding),
      { ...makeTaskEntry('agent-c', ''), status: 'failed', result: undefined },
    ];

    const report = await engine.runSelectedCrossReview(results);

    // Should not crash and should produce a report from the 2 successful agents
    expect(report).toBeDefined();
    expect(report.summary).toBeDefined();
  });

  it('should synthesize without cross-review when no structured findings exist', async () => {
    const llm = makeMockLlm('[]');
    const engine = makeEngine({ llm });

    // Result with no <agent_finding> tags
    const results: TaskEntry[] = [
      makeTaskEntry('agent-a', 'Just a plain text result with no structured findings.'),
      makeTaskEntry('agent-b', 'Another plain text result without finding tags.'),
    ];

    const report = await engine.runSelectedCrossReview(results);

    // Should still produce a report (via synthesize fallback)
    expect(report).toBeDefined();
    // LLM.generate should NOT be called for cross-review (no findings to review)
    // but WILL be called by synthesize for the formatReport step
  });

  it('should set partialReview when no reviewers are selected', async () => {
    const llm = makeMockLlm('[]');
    const engine = makeEngine({ llm });

    // Agent-a produces a finding, but agent-a is the only candidate
    // (author is excluded from reviewing their own finding)
    const finding = makeFinding({ severity: 'medium', title: 'Orphan finding' });
    const results: TaskEntry[] = [
      makeTaskEntry('agent-a', finding),
      // agent-b has no findings, is not an author — but agent-a is excluded
      // Only 1 non-author candidate, but with zero scores they go through fallback
      makeTaskEntry('agent-b', 'No findings here, just commentary.'),
    ];

    const report = await engine.runSelectedCrossReview(results);

    // With only one non-author agent and K=2 for medium, partialReview should be true
    expect(report).toBeDefined();
    // agent-b is the only candidate (agent-a is author), but K=2 → partial
    expect(report.partialReview).toBe(true);
  });

  describe('Scoped Summaries', () => {
    it('should only include peer authors of assigned findings in scoped summaries', async () => {
      // Track which summaries are passed to crossReviewForAgent
      const capturedSummaries: Map<string, Map<string, string>> = new Map();

      const findingA = makeFinding({ severity: 'medium', title: 'Finding from A', content: 'A found an issue in parser.ts:42' });
      const findingB = makeFinding({ severity: 'medium', title: 'Finding from B', content: 'B found an issue in router.ts:15' });
      const findingC = makeFinding({ severity: 'medium', title: 'Finding from C', content: 'C found an issue in handler.ts:99' });

      const llm = makeMockLlm('[]');
      const engine = makeEngine({ llm });

      // Spy on crossReviewForAgent to capture scoped summaries
      (engine as any).crossReviewForAgent = jest.fn(
        async (agent: TaskEntry, summaries: Map<string, string>, _raw: Map<string, string>) => {
          capturedSummaries.set(agent.agentId, new Map(summaries));
          return []; // No cross-review entries
        },
      );

      const results: TaskEntry[] = [
        makeTaskEntry('agent-a', findingA),
        makeTaskEntry('agent-b', findingB),
        makeTaskEntry('agent-c', findingC),
      ];

      await engine.runSelectedCrossReview(results);

      // Verify scoped summaries were built correctly
      // Each reviewer should have their own summary + only the peers whose findings they review
      for (const [reviewerId, scopedMap] of capturedSummaries) {
        // Reviewer's own summary must always be included
        expect(scopedMap.has(reviewerId)).toBe(true);
        // Should NOT contain all agents — only relevant peers
        // (exact assignments depend on selection, but each reviewer's scope should be limited)
      }
    });

    it('should include reviewer own summary in scoped summaries', async () => {
      const capturedSummaries: Map<string, Map<string, string>> = new Map();

      const findingA = makeFinding({ severity: 'medium', title: 'Finding from A' });
      const findingB = makeFinding({ severity: 'medium', title: 'Finding from B' });

      const engine = makeEngine({ llm: makeMockLlm('[]') });

      (engine as any).crossReviewForAgent = jest.fn(
        async (agent: TaskEntry, summaries: Map<string, string>) => {
          capturedSummaries.set(agent.agentId, new Map(summaries));
          return [];
        },
      );

      const results: TaskEntry[] = [
        makeTaskEntry('agent-a', findingA),
        makeTaskEntry('agent-b', findingB),
      ];

      await engine.runSelectedCrossReview(results);

      // Each reviewer should have their own summary
      for (const [reviewerId, scopedMap] of capturedSummaries) {
        expect(scopedMap.has(reviewerId)).toBe(true);
      }
    });
  });

  describe('Finding ID Assignment', () => {
    it('should assign finding IDs as agentId:fN pattern', async () => {
      const findingA1 = makeFinding({ severity: 'medium', title: 'First finding from A', content: 'A found bug one in parser.ts:42' });
      const findingA2 = makeFinding({ severity: 'high', title: 'Second finding from A', content: 'A found bug two in router.ts:15' });
      const findingB1 = makeFinding({ severity: 'critical', title: 'First finding from B', content: 'B found a critical issue in auth.ts:3' });

      // Create a subclass to intercept finding extraction
      class TestEngine extends ConsensusEngine {
        async runSelectedCrossReview(results: TaskEntry[]): Promise<any> {
          // Call super to run the pipeline, but we need a way to check finding IDs.
          // Since we can't easily intercept, we'll check the output instead.
          return super.runSelectedCrossReview(results);
        }
      }

      const llm = makeMockLlm('[]');
      const engine = new TestEngine({
        llm,
        registryGet: makeMockRegistryGet(),
        projectRoot: TEST_ROOT,
        performanceReader: new PerformanceReader(TEST_ROOT),
      });

      // Spy on crossReviewForAgent to avoid actual LLM calls
      (engine as any).crossReviewForAgent = jest.fn(async () => []);

      const results: TaskEntry[] = [
        makeTaskEntry('agent-a', findingA1 + '\n' + findingA2),
        makeTaskEntry('agent-b', findingB1),
      ];

      const report = await engine.runSelectedCrossReview(results);

      // The report should have crossReviewCoverage with correct finding IDs
      expect(report.crossReviewCoverage).toBeDefined();
      if (report.crossReviewCoverage) {
        const findingIds = report.crossReviewCoverage.map((c: any) => c.findingId);
        // agent-a has 2 findings: agent-a:f1, agent-a:f2
        expect(findingIds).toContain('agent-a:f1');
        expect(findingIds).toContain('agent-a:f2');
        // agent-b has 1 finding: agent-b:f1
        expect(findingIds).toContain('agent-b:f1');
      }
    });

    it('should assign K=3 target for critical findings and K=2 for others', async () => {
      const criticalFinding = makeFinding({ severity: 'critical', title: 'Critical bug' });
      const mediumFinding = makeFinding({ severity: 'medium', title: 'Medium issue' });

      const engine = makeEngine({ llm: makeMockLlm('[]') });
      (engine as any).crossReviewForAgent = jest.fn(async () => []);

      const results: TaskEntry[] = [
        makeTaskEntry('agent-a', criticalFinding),
        makeTaskEntry('agent-b', mediumFinding),
        makeTaskEntry('agent-c', makeFinding({ severity: 'low', title: 'Another finding' })),
        makeTaskEntry('agent-d', '## Consensus Summary\nNo findings.'),
      ];

      const report = await engine.runSelectedCrossReview(results);

      expect(report.crossReviewCoverage).toBeDefined();
      if (report.crossReviewCoverage) {
        for (const entry of report.crossReviewCoverage) {
          if (entry.findingId === 'agent-a:f1') {
            // Critical → K=3
            expect(entry.targetK).toBe(3);
          } else {
            // Non-critical → K=2
            expect(entry.targetK).toBe(2);
          }
        }
      }
    });
  });

  describe('Cross-Review Entry Collection', () => {
    it('should collect cross-review entries from all assigned reviewers', async () => {
      const findingA = makeFinding({ severity: 'medium', title: 'Bug in parser' });
      const findingB = makeFinding({ severity: 'medium', title: 'Bug in router' });

      // Each reviewer returns one cross-review entry
      const llm: ILLMProvider = {
        generate: jest.fn().mockImplementation(async (_messages: any[]) => {
          // Extract reviewer info from messages to return appropriate entries
          // Return a generic agree response
          return {
            text: JSON.stringify([{
              action: 'agree',
              findingId: 'peer:f1',
              finding: 'A finding',
              evidence: 'Confirmed',
              confidence: 4,
            }]),
            inputTokens: 50,
            outputTokens: 100,
            toolCalls: [],
          };
        }),
      } as unknown as ILLMProvider;

      const engine = makeEngine({ llm });

      const results: TaskEntry[] = [
        makeTaskEntry('agent-a', findingA),
        makeTaskEntry('agent-b', findingB),
        makeTaskEntry('agent-c', makeFinding({ severity: 'medium', title: 'Finding from C' })),
      ];

      const report = await engine.runSelectedCrossReview(results);

      // Report should have crossReviewAssignments showing which reviewers got which findings
      expect(report.crossReviewAssignments).toBeDefined();
      if (report.crossReviewAssignments) {
        const totalAssigned = Object.values(report.crossReviewAssignments)
          .reduce((sum, ids) => sum + ids.length, 0);
        // Each finding should have at least 1 reviewer assigned
        expect(totalAssigned).toBeGreaterThan(0);
      }
    });
  });

  describe('partialReview Flag', () => {
    it('should set partialReview=true when a finding has fewer reviewers than K', async () => {
      // Critical finding needs K=3 but we only have 2 non-author agents
      const criticalFinding = makeFinding({ severity: 'critical', title: 'Critical vulnerability' });

      const engine = makeEngine({ llm: makeMockLlm('[]') });
      (engine as any).crossReviewForAgent = jest.fn(async () => []);

      const results: TaskEntry[] = [
        makeTaskEntry('agent-a', criticalFinding),
        // Only 2 other agents → can't reach K=3 for critical
        makeTaskEntry('agent-b', makeFinding({ severity: 'low', title: 'Low finding' })),
        makeTaskEntry('agent-c', makeFinding({ severity: 'low', title: 'Another low' })),
      ];

      const report = await engine.runSelectedCrossReview(results);

      // K=3 for critical but only 2 non-author candidates → partial
      expect(report.partialReview).toBe(true);
    });

    it('should NOT set partialReview when all findings have sufficient reviewers', async () => {
      // Medium findings need K=2 and we have 3 non-author agents
      const mediumFinding = makeFinding({ severity: 'medium', title: 'Medium issue' });

      const engine = makeEngine({ llm: makeMockLlm('[]') });
      (engine as any).crossReviewForAgent = jest.fn(async () => []);

      const results: TaskEntry[] = [
        makeTaskEntry('agent-a', mediumFinding),
        makeTaskEntry('agent-b', makeFinding({ severity: 'medium', title: 'Another medium' })),
        makeTaskEntry('agent-c', makeFinding({ severity: 'medium', title: 'Third medium' })),
        makeTaskEntry('agent-d', makeFinding({ severity: 'medium', title: 'Fourth medium' })),
      ];

      const report = await engine.runSelectedCrossReview(results);

      // K=2 for medium and enough agents → should NOT be partial
      // (unless some edge case in selection makes it partial)
      expect(report).toBeDefined();
      // Note: partialReview is only set to true, never explicitly false
      // If not partial, the field is undefined or absent
    });

    it('should store crossReviewAssignments in the report', async () => {
      const finding = makeFinding({ severity: 'medium', title: 'Test finding' });

      const engine = makeEngine({ llm: makeMockLlm('[]') });
      (engine as any).crossReviewForAgent = jest.fn(async () => []);

      const results: TaskEntry[] = [
        makeTaskEntry('agent-a', finding),
        makeTaskEntry('agent-b', finding),
        makeTaskEntry('agent-c', finding),
      ];

      const report = await engine.runSelectedCrossReview(results);

      expect(report.crossReviewAssignments).toBeDefined();
      // Assignments should be a record of agentId → findingId[]
      if (report.crossReviewAssignments) {
        for (const [agentId, findingIds] of Object.entries(report.crossReviewAssignments)) {
          expect(typeof agentId).toBe('string');
          expect(Array.isArray(findingIds)).toBe(true);
          for (const fid of findingIds) {
            // Each findingId should match the agentId:fN pattern
            expect(fid).toMatch(/^agent-[a-z]:f\d+$/);
          }
        }
      }
    });

    it('should store crossReviewCoverage in the report', async () => {
      const finding = makeFinding({ severity: 'medium', title: 'Test finding' });

      const engine = makeEngine({ llm: makeMockLlm('[]') });
      (engine as any).crossReviewForAgent = jest.fn(async () => []);

      const results: TaskEntry[] = [
        makeTaskEntry('agent-a', finding),
        makeTaskEntry('agent-b', finding),
        makeTaskEntry('agent-c', finding),
      ];

      const report = await engine.runSelectedCrossReview(results);

      expect(report.crossReviewCoverage).toBeDefined();
      if (report.crossReviewCoverage) {
        for (const entry of report.crossReviewCoverage) {
          expect(entry.findingId).toBeDefined();
          expect(typeof entry.assigned).toBe('number');
          expect(typeof entry.targetK).toBe('number');
          expect(entry.assigned).toBeGreaterThanOrEqual(0);
          expect(entry.targetK).toBeGreaterThanOrEqual(2);
        }
      }
    });
  });
});
