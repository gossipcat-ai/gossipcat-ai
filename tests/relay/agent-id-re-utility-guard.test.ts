import { memoryHandler } from '@gossip/relay/dashboard/api-memory';
import { skillsBindHandler } from '@gossip/relay/dashboard/api-skills';
import { mkdtempSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Regression test for AGENT_ID_RE — must accept `_utility` and other live agent
// ID shapes used across the orchestrator (consensus-engine.ts:442,
// consensus-auto-verify.ts:50/160/184, utility-agents.ts:1). Session
// 2026-05-24 caught a HIGH regression where the regex had been tightened to
// `/^[a-z][a-z0-9.-]*$/i` — which rejects underscore-prefixed IDs and would
// have broken utility dispatch routing. Lock the contract here.

describe('AGENT_ID_RE accepts live agent ID shapes', () => {
  function emptyProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'gossip-agent-id-re-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });
    return root;
  }

  it('memoryHandler accepts `_utility` (underscore prefix must stay valid)', async () => {
    const root = emptyProject();
    await expect(memoryHandler(root, '_utility')).resolves.toBeDefined();
  });

  it('memoryHandler accepts dotted skill names like `gemini.flash`', async () => {
    const root = emptyProject();
    await expect(memoryHandler(root, 'gemini.flash')).resolves.toBeDefined();
  });

  it('memoryHandler rejects `__proto__` (DANGEROUS_IDS guard)', async () => {
    const root = emptyProject();
    await expect(memoryHandler(root, '__proto__')).rejects.toThrow('Invalid agent ID');
  });

  it('memoryHandler rejects empty string and shapes with disallowed chars', async () => {
    const root = emptyProject();
    await expect(memoryHandler(root, '')).rejects.toThrow('Invalid agent ID');
    await expect(memoryHandler(root, 'has space')).rejects.toThrow('Invalid agent ID');
    await expect(memoryHandler(root, 'has/slash')).rejects.toThrow('Invalid agent ID');
  });

  it('skillsBindHandler accepts `_utility` agent_id', async () => {
    const root = emptyProject();
    const r = await skillsBindHandler(root, { agent_id: '_utility', skill: 'verify-the-premise', enabled: true });
    expect(r.error).not.toBe('Invalid agent_id');
  });

  it('skillsBindHandler rejects empty or whitespace agent_id', async () => {
    const root = emptyProject();
    const r1 = await skillsBindHandler(root, { agent_id: '', skill: 'x', enabled: true });
    expect(r1.success).toBe(false);
    expect(r1.error).toBe('Invalid agent_id');
    const r2 = await skillsBindHandler(root, { agent_id: 'a b', skill: 'x', enabled: true });
    expect(r2.success).toBe(false);
    expect(r2.error).toBe('Invalid agent_id');
  });
});
