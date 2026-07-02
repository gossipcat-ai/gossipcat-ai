// tests/orchestrator/agent-corrections-prefetch.test.ts
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryWriter } from '../../packages/orchestrator/src/memory-writer';
import { AgentMemoryReader } from '../../packages/orchestrator/src/agent-memory';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'gossip-corr-'));
  const w = new MemoryWriter(root);
  w.writeLessonCard('r1', {
    signal: 'hallucination_caught', findingId: 'ab12cd34-ef56ab78:r1:f1',
    finding: 'worktree resolution: asserted absence without reading resolutionRoots path',
    lesson: 'read the worktree path before claiming a symbol is missing',
    taskTokens: 'worktree resolutionRoots absence',
  });
  return { root, reader: new AgentMemoryReader(root) };
}

describe('prefetchAgentCorrectionsText', () => {
  it('returns the agent\'s own matching lesson card body for a related task', () => {
    const { reader } = seed();
    const out = reader.prefetchAgentCorrectionsText('r1', 'review the worktree resolutionRoots handling');
    expect(out.length).toBe(1);
    expect(out[0]).toContain('worktree');
  });

  it('is per-agent isolated — agent r2 never sees r1\'s cards', () => {
    const { reader } = seed();
    expect(reader.prefetchAgentCorrectionsText('r2', 'worktree resolutionRoots')).toEqual([]);
  });

  it('ignores non-lesson knowledge files', () => {
    const { root, reader } = seed();
    // A consensus knowledge file must not be surfaced as a "correction"
    new MemoryWriter(root).writeConsensusKnowledge('r1', [
      { originalAgentId: 'peer', finding: 'worktree resolutionRoots unrelated peer finding', tag: 'confirmed' },
    ]);
    const out = reader.prefetchAgentCorrectionsText('r1', 'worktree resolutionRoots');
    expect(out.every(s => !s.includes('unrelated peer finding'))).toBe(true);
  });

  it('returns [] when the task shares no keywords', () => {
    const { reader } = seed();
    expect(reader.prefetchAgentCorrectionsText('r1', 'completely different topic zzz')).toEqual([]);
  });

  it('caps at CORRECTIONS_MAX_RESULTS (2)', () => {
    const { root, reader } = seed();
    const w = new MemoryWriter(root);
    for (let i = 2; i < 6; i++) {
      w.writeLessonCard('r1', {
        signal: 'impl_test_fail', findingId: `ab12cd34-ef56ab78:r1:f${i}`,
        finding: `worktree resolutionRoots case ${i}`, lesson: `lesson ${i}`, taskTokens: 'worktree resolutionRoots',
      });
    }
    expect(reader.prefetchAgentCorrectionsText('r1', 'worktree resolutionRoots').length).toBeLessThanOrEqual(2);
  });
});
