import { mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeLessonCardsForSignals } from '../../packages/orchestrator/src/memory-writer';

const knowledgeDir = (root: string, id: string) =>
  join(root, '.gossip', 'agents', id, 'memory', 'knowledge');

describe('writeLessonCardsForSignals', () => {
  it('writes cards only for terminal signals that carry a finding_id', () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-wire-'));
    writeLessonCardsForSignals(root, [
      { signal: 'hallucination_caught', agent_id: 'r1', finding: 'a', finding_id: 'ab12cd34-ef56ab78:r1:f1', lesson: 'why' },
      { signal: 'agreement', agent_id: 'r1', finding: 'b', finding_id: 'ab12cd34-ef56ab78:r1:f2' }, // not terminal
      { signal: 'impl_test_fail', agent_id: 'r2', finding: 'c' }, // no finding_id → skip
      { signal: 'impl_peer_rejected', agent_id: 'r3', finding: 'd', finding_id: 'ab12cd34-ef56ab78:r3:f1' },
    ]);
    expect(readdirSync(knowledgeDir(root, 'r1'))).toHaveLength(1);
    expect(() => readdirSync(knowledgeDir(root, 'r2'))).toThrow(); // dir never created
    expect(readdirSync(knowledgeDir(root, 'r3'))).toHaveLength(1);
  });
});
