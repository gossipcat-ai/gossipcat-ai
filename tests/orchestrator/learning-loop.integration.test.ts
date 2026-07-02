import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeLessonCardsForSignals } from '../../packages/orchestrator/src/memory-writer';
import { AgentMemoryReader } from '../../packages/orchestrator/src/agent-memory';
import { assemblePrompt } from '../../packages/orchestrator/src/prompt-assembler';

describe('learning loop (A → B-delta) end to end', () => {
  it('a recorded correction surfaces in the same agent\'s next dispatch prompt', () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-loop-'));

    // A: orchestrator records a terminal correction with a lesson.
    writeLessonCardsForSignals(root, [{
      signal: 'hallucination_caught',
      agent_id: 'sonnet-reviewer',
      finding: 'claimed writeLessonCard missing from memory-writer.ts',
      finding_id: 'ab12cd34-ef56ab78:sonnet-reviewer:f1',
      lesson: 'grep the file before claiming a symbol is absent',
    }]);

    // B-delta: a later dispatch on a related task pulls the card...
    const corrections = new AgentMemoryReader(root)
      .prefetchAgentCorrectionsText('sonnet-reviewer', 'review memory-writer.ts writeLessonCard changes');
    expect(corrections.length).toBe(1);

    // ...and it lands in the assembled prompt under Your Prior Corrections.
    const prompt = assemblePrompt({ task: 'review memory-writer.ts writeLessonCard changes', agentCorrections: corrections });
    expect(prompt).toContain('### Your Prior Corrections');
    expect(prompt).toContain('grep the file before claiming a symbol is absent');
  });
});
