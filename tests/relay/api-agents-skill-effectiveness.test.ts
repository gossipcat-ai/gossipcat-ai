import { agentsHandler } from '../../packages/relay/src/dashboard/api-agents';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gossip-test-agents-skill-'));
  mkdirSync(join(root, '.gossip', 'agents', 'sonnet-reviewer', 'skills'), { recursive: true });
  // Seed the skill-index.json so SkillIndex returns a slot for the agent.
  writeFileSync(
    join(root, '.gossip', 'skill-index.json'),
    JSON.stringify({
      'sonnet-reviewer': {
        'data-integrity': {
          skill: 'data-integrity',
          enabled: true,
          source: 'manual',
          mode: 'permanent',
          version: 1,
          boundAt: '2026-04-10T00:00:00Z',
        },
      },
    }),
  );
  return root;
}

const CONFIG = [{
  id: 'sonnet-reviewer',
  provider: 'anthropic',
  model: 'claude-3-5-sonnet',
  skills: ['data-integrity'],
  native: false,
}];

describe('agentsHandler — skill effectiveness + forced develops', () => {
  it('reads effectiveness and status from skill frontmatter', async () => {
    const root = setupRoot();
    writeFileSync(
      join(root, '.gossip', 'agents', 'sonnet-reviewer', 'skills', 'data-integrity.md'),
      [
        '---',
        'effectiveness: 0.72',
        'status: passed',
        'inconclusive_strikes: 0',
        '---',
        '# Data integrity skill',
        '',
        'Body text.',
      ].join('\n'),
    );

    const res = await agentsHandler(root, CONFIG);
    expect(res).toHaveLength(1);
    const slot = res[0].skillSlots.find(s => s.name === 'data-integrity');
    expect(slot).toBeDefined();
    expect(slot!.effectiveness).toBeCloseTo(0.72);
    expect(slot!.status).toBe('passed');
    expect(slot!.inconclusiveStrikes).toBe(0);
  });

  it('reads forced_develops from audit jsonl, filtered by agent + category', async () => {
    const root = setupRoot();
    writeFileSync(
      join(root, '.gossip', 'agents', 'sonnet-reviewer', 'skills', 'data-integrity.md'),
      '---\nstatus: inconclusive\ninconclusive_strikes: 2\n---\nbody\n',
    );
    // Mix of matching + non-matching rows; normalize across dash/underscore.
    writeFileSync(
      join(root, '.gossip', 'forced-skill-develops.jsonl'),
      [
        JSON.stringify({ agent_id: 'sonnet-reviewer', category: 'data_integrity', timestamp: '2026-04-14T10:00:00Z', reason: 'strike threshold' }),
        JSON.stringify({ agent_id: 'sonnet-reviewer', category: 'data-integrity', timestamp: '2026-04-15T10:00:00Z', reason: 'manual force' }),
        JSON.stringify({ agent_id: 'other-agent', category: 'data-integrity', timestamp: '2026-04-16T10:00:00Z', reason: 'should not match' }),
        JSON.stringify({ agent_id: 'sonnet-reviewer', category: 'input-validation', timestamp: '2026-04-16T10:00:00Z', reason: 'wrong category' }),
      ].join('\n'),
    );

    const res = await agentsHandler(root, CONFIG);
    const slot = res[0].skillSlots.find(s => s.name === 'data-integrity');
    expect(slot!.forcedDevelops).toBeDefined();
    expect(slot!.forcedDevelops).toHaveLength(2);
    expect(slot!.forcedDevelops!.map(e => e.reason).sort()).toEqual(['manual force', 'strike threshold']);
  });

  it('returns undefined effectiveness fields when skill file is missing', async () => {
    const root = setupRoot();
    // No skill file, no forced-develops jsonl.
    const res = await agentsHandler(root, CONFIG);
    const slot = res[0].skillSlots.find(s => s.name === 'data-integrity');
    expect(slot).toBeDefined();
    expect(slot!.name).toBe('data-integrity');
    expect(slot!.effectiveness).toBeUndefined();
    expect(slot!.status).toBeUndefined();
    expect(slot!.inconclusiveStrikes).toBeUndefined();
    expect(slot!.forcedDevelops).toBeUndefined();
  });
});
