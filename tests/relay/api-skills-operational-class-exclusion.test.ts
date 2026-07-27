// tests/relay/api-skills-operational-class-exclusion.test.ts
//
// Pins the third `isOperationalClassRow` guard consolidated by PR #692 — the
// one in packages/relay's dashboard skill-effectiveness index
// (dashboard/api-skills.ts `buildSignalIndex`).
//
// Before this file, `buildSignalIndex` was imported by NO test anywhere; it was
// module-private and only reachable through `skillsGetHandler`, which needs a
// full SkillIndex + skill-frontmatter fixture and would not isolate the guard.
// It is now exported (minimal change) so the exclusion can be asserted directly.
//
// HOW WE KNOW THIS FAILS IF THE GUARD IS DELETED (no source mutation was
// performed): the operational fixture row and its positive control differ in
// exactly one field, `signal_class`. `buildSignalIndex` reads that field only
// via the imported `isOperationalClassRow` — `git grep signal_class -- api-skills.ts`
// returns no other hit. So the guard is the sole discriminator between the two
// rows; the control assertion proves the control row IS indexed, therefore
// deleting the guard makes the operational row indexed too and the exclusion
// assertion fails.
//
// Consensus f0a881eb-756e4580:f11.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildSignalIndex } from '../../packages/relay/src/dashboard/api-skills';

const CATEGORY = 'testing';
const OPERATIONAL_AGENT = 'ops-agent';
const CONTROL_AGENT = 'control-agent';
const NOW_ISO = new Date(Date.UTC(2026, 6, 20, 12, 0, 0)).toISOString();

function row(agentId: string, signal: string, signalClass: 'operational' | 'performance') {
  return {
    type: 'consensus',
    signal,
    signal_class: signalClass,
    agentId,
    taskId: `task-${agentId}-${signal}`,
    category: CATEGORY,
    timestamp: NOW_ISO,
  };
}

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gossip-skills-opclass-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  const rows = [
    // Operational by class, scoring by every other axis: a signal name in
    // CORRECT_SIGNALS/HALLUC_SIGNALS, a truthy category, a live timestamp and
    // no retraction. Only the class stamp keeps it out of the index.
    row(OPERATIONAL_AGENT, 'agreement', 'operational'),
    row(OPERATIONAL_AGENT, 'hallucination_caught', 'operational'),
    // Positive control — identical shape, scoring class.
    row(CONTROL_AGENT, 'agreement', 'performance'),
    row(CONTROL_AGENT, 'hallucination_caught', 'performance'),
  ];
  writeFileSync(
    join(root, '.gossip', 'agent-performance.jsonl'),
    rows.map(r => JSON.stringify(r)).join('\n') + '\n',
  );
  return root;
}

describe('buildSignalIndex — operational-class row exclusion', () => {
  let root: string;

  beforeAll(() => { root = setupRoot(); });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it('drops operational-class rows even when they carry a category', () => {
    const idx = buildSignalIndex(root);
    expect(idx.byAgentSkill.get(OPERATIONAL_AGENT)).toBeUndefined();
  });

  it('positive control — the same rows stamped performance ARE indexed', () => {
    const idx = buildSignalIndex(root);
    const events = idx.byAgentSkill.get(CONTROL_AGENT)?.get(CATEGORY);
    expect(events?.map(e => e.signal).sort()).toEqual(['agreement', 'hallucination_caught']);
  });
});
