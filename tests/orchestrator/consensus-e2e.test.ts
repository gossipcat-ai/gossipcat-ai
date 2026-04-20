/**
 * End-to-end consensus protocol test using real LLM calls.
 * Verifies: dispatch with consensus → collect with consensus → report + signals.
 *
 * Run: npx jest tests/orchestrator/consensus-e2e.test.ts --testTimeout=600000
 */
import { createProvider } from '../../packages/orchestrator/src/llm-client';
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const PROJECT_ROOT = process.cwd();
// Use a temp directory for performance signals to avoid destroying production data
// PerformanceWriter(root) writes to root/.gossip/agent-performance.jsonl
const TEST_PERF_ROOT = '/tmp/gossip-e2e-test-' + process.pid;
const PERF_FILE = join(TEST_PERF_ROOT, '.gossip', 'agent-performance.jsonl');

function loadConfig() {
  const configPath = join(PROJECT_ROOT, '.gossip', 'config.json');
  if (!existsSync(configPath)) throw new Error('No .gossip/config.json found');
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

function getKeyFromKeychain(provider: string): string {
  // Try keychain first, then env vars
  try {
    return execFileSync('security', [
      'find-generic-password', '-s', 'gossip-mesh', '-a', provider, '-w'
    ], { stdio: 'pipe' }).toString().trim();
  } catch {
    const envKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (envKey) return envKey;
    throw new Error(`No API key for ${provider} in keychain or env`);
  }
}

describe('Consensus Protocol E2E', () => {
  let config: any;

  beforeAll(async () => {
    config = loadConfig();
  });

  afterAll(() => {
    // Clean up temp perf directory
    try { require('fs').rmSync(TEST_PERF_ROOT, { recursive: true, force: true }); } catch {}
  });

  it('should run consensus cross-review on mock agent results', async () => {
    // Create temp directory for test signals (avoid destroying production data)
    mkdirSync(join(TEST_PERF_ROOT, '.gossip'), { recursive: true });
    if (existsSync(PERF_FILE)) unlinkSync(PERF_FILE);

    // Instead of dispatching to real agents (which need relay), we'll test
    // the consensus engine directly with synthetic Phase 1 results
    const { ConsensusEngine } = await import('../../packages/orchestrator/src/consensus-engine');
    const { PerformanceWriter } = await import('../../packages/orchestrator/src/performance-writer');
    const { WRITER_INTERNAL } = await import('../../packages/orchestrator/src/_writer-internal');

    // Use google provider for cross-review (same as agents)
    const apiKey = getKeyFromKeychain('google');
    const llm = createProvider('google', 'gemini-2.5-pro', apiKey);

    const agents = config.agents || {};
    const registryGet = (id: string) => {
      const ac = agents[id];
      if (!ac) return undefined;
      return { id, provider: ac.provider, model: ac.model, preset: ac.preset, skills: ac.skills || [] };
    };

    const engine = new ConsensusEngine({ llm, registryGet });

    // Synthetic Phase 1 results — 4 agents reviewing consensus-engine.ts
    const mockResults = [
      {
        id: 'task-1', agentId: 'gemini-reviewer', task: 'security review', status: 'completed' as const,
        startedAt: Date.now() - 30000, completedAt: Date.now(),
        result: `Security review complete.

## Consensus Summary
- Prompt injection via unsanitized peer summaries interpolated into cross-review prompt (consensus-engine.ts:113)
- No rate limiting on consensus LLM calls allows cost amplification (consensus-engine.ts:88)
- extractSummary fallback truncation may cut mid-word losing context (consensus-engine.ts:46)`,
      },
      {
        id: 'task-2', agentId: 'gemini-tester', task: 'security review', status: 'completed' as const,
        startedAt: Date.now() - 30000, completedAt: Date.now(),
        result: `Testing review complete.

## Consensus Summary
- Prompt injection risk in crossReviewForAgent where peer output is directly embedded (consensus-engine.ts:113)
- parseCrossReviewResponse trusts LLM-provided agentId field allowing impersonation (consensus-engine.ts:498)
- findMatchingFinding word overlap matching could be exploited with adversarial strings (consensus-engine.ts:376)`,
      },
      {
        id: 'task-3', agentId: 'gemini-implementer', task: 'security review', status: 'completed' as const,
        startedAt: Date.now() - 30000, completedAt: Date.now(),
        result: `Implementation review complete.

## Consensus Summary
- Direct string interpolation of agent summaries into LLM prompt enables injection (consensus-engine.ts:119)
- MAX_SUMMARY_LENGTH of 3000 chars may be too generous for cross-review context (consensus-engine.ts:16)
- detectHallucination uses simple string matching that could be bypassed (consensus-engine.ts:321)`,
      },
      {
        id: 'task-4', agentId: 'gemini-researcher', task: 'security review', status: 'completed' as const,
        startedAt: Date.now() - 30000, completedAt: Date.now(),
        result: `Research review complete.

## Consensus Summary
- Prompt injection vulnerability in cross-review prompt construction (consensus-engine.ts:113)
- Trust boundary violation: peerAgentId from LLM response not validated against real agents (consensus-engine.ts:498)
- Information leakage via preset names in formatted report output (consensus-engine.ts:414)`,
      },
    ];

    console.log('\n=== Starting Consensus Cross-Review ===');
    const report = await engine.run(mockResults as any);
    console.log('\n=== Consensus Report ===');
    console.log(report.summary);

    // Verify report structure
    expect(report.agentCount).toBe(4);
    expect(report.rounds).toBe(2);
    expect(report.summary).toContain('CONSENSUS REPORT');

    // Should have some findings tagged
    const totalFindings = report.confirmed.length + report.disputed.length + report.unique.length;
    console.log(`\nFindings: ${report.confirmed.length} confirmed, ${report.disputed.length} disputed, ${report.unique.length} unique, ${report.newFindings.length} new`);
    expect(totalFindings).toBeGreaterThan(0);

    // Verify signals were generated
    expect(report.signals.length).toBeGreaterThan(0);
    console.log(`\nSignals: ${report.signals.length} total`);
    for (const s of report.signals.slice(0, 5)) {
      console.log(`  - ${s.signal} from ${s.agentId}${s.counterpartId ? ` about ${s.counterpartId}` : ''}`);
    }

    // Write signals to performance file
    const perfWriter = new PerformanceWriter(TEST_PERF_ROOT);
    perfWriter[WRITER_INTERNAL].appendSignals(report.signals);

    // Verify performance file was created
    expect(existsSync(PERF_FILE)).toBe(true);
    const perfContent = readFileSync(PERF_FILE, 'utf-8').trim().split('\n');
    console.log(`\nPerformance file: ${perfContent.length} entries written`);
    expect(perfContent.length).toBeGreaterThan(0);

    // Parse and validate entries
    for (const line of perfContent.slice(0, 3)) {
      const entry = JSON.parse(line);
      expect(entry.type).toBe('consensus');
      expect(entry.signal).toBeDefined();
      expect(entry.timestamp).toBeDefined();
      console.log(`  - ${JSON.stringify(entry)}`);
    }
  }, 300_000);
});
