import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryWriter } from '../../packages/orchestrator/src/memory-writer';
import { AgentMemoryReader } from '../../packages/orchestrator/src/agent-memory';

const knowledgeDir = (root: string, id: string) =>
  join(root, '.gossip', 'agents', id, 'memory', 'knowledge');

// Regressions from the #642 whole-branch review (consensus fable-reviewer).

describe('f1 — lesson cards survive the shared warmth pruner', () => {
  it('pruneKnowledgeDir (25-cap, runs on consensus writes) never evicts lesson-*.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-f1-'));
    const w = new MemoryWriter(root);
    const kdir = knowledgeDir(root, 'r1');
    mkdirSync(kdir, { recursive: true });

    // Seed the dir to the 25-file cap with evictable non-lesson knowledge.
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(kdir, `2020-01-01T00-00-${String(i).padStart(2, '0')}-x.md`), '---\nimportance: 0.1\n---\nold');
    }
    // Write a lesson card (non-date filename → NaN warmth in the shared pruner).
    w.writeLessonCard('r1', {
      signal: 'hallucination_caught', findingId: 'ab12cd34-ef56ab78:r1:keep',
      finding: 'x', lesson: 'durable',
    });

    // Trigger the shared warmth pruner (cap 25) via a consensus-knowledge write.
    w.writeConsensusKnowledge('r1', [{ originalAgentId: 'peer', finding: 'trigger', tag: 'confirmed' }]);

    const files = readdirSync(kdir);
    // Lesson card survived...
    expect(files.filter(f => f.startsWith('lesson-')).length).toBe(1);
    // ...and the pruner really ran (evicted at least one non-lesson dummy).
    expect(files.filter(f => /^2020-01-01/.test(f)).length).toBeLessThan(25);
  });
});

describe('f2 — inline "---" in a lesson does not leak frontmatter into the injected snippet', () => {
  it('the anchored frontmatter-strip keeps the real lesson, not YAML debris', () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-f2-'));
    new MemoryWriter(root).writeLessonCard('r1', {
      signal: 'hallucination_caught', findingId: 'ab12cd34-ef56ab78:r1:diff',
      finding: 'patch bug', lesson: 'the --- a/foo.ts diff marker misled me, read the whole hunk',
    });

    const out = new AgentMemoryReader(root)
      .prefetchAgentCorrectionsText('r1', 'review foo.ts patch hunk diff');

    expect(out.length).toBe(1);
    expect(out[0]).toContain('read the whole hunk');   // the real lesson survives
    expect(out[0]).not.toContain('type: lesson');       // no frontmatter debris leaked
    expect(out[0]).not.toContain('finding_id');
  });
});
