import { PerformanceWriter, PerformanceReader } from '@gossip/orchestrator';
import type { ConsensusSignal } from '@gossip/orchestrator';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// L2: sanctioned internal accessor for tests (Step 5 exemption).
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';

describe('Signal migration — empty-taskId retraction', () => {
  const testDir = join(tmpdir(), 'gossip-migration-' + Date.now());
  const filePath = join(testDir, '.gossip', 'agent-performance.jsonl');

  beforeAll(() => mkdirSync(join(testDir, '.gossip'), { recursive: true }));
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  it('retracted empty-taskId signals are excluded from scoring', () => {
    // Write a signal with empty taskId (simulating the legacy bug)
    const badSignal = {
      type: 'consensus',
      taskId: '',
      signal: 'hallucination_caught',
      agentId: 'test-agent',
      evidence: 'fabricated finding',
      timestamp: '2026-03-25T10:00:00Z',
    };
    writeFileSync(filePath, JSON.stringify(badSignal) + '\n');

    // Write a retraction using the original's timestamp as taskId
    // (this is how the reader matches when taskId is empty)
    const retraction: ConsensusSignal = {
      type: 'consensus',
      taskId: badSignal.timestamp, // KEY: use original's timestamp
      signal: 'signal_retracted',
      agentId: 'test-agent',
      evidence: 'Retracted: legacy empty-taskId signal',
      timestamp: new Date().toISOString(),
    };
    const writer = new PerformanceWriter(testDir);
    writer[WRITER_INTERNAL].appendSignal(retraction);

    // Verify the reader excludes the retracted signal
    const reader = new PerformanceReader(testDir);
    const scores = reader.getScores();
    const agentScore = scores.get('test-agent');
    // Agent should have no hallucinations counted (retracted)
    expect(agentScore?.hallucinations ?? 0).toBe(0);
  });
});
