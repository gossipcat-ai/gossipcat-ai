/**
 * Tests for postBindSignals computation in api-agents.ts.
 *
 * Covers:
 *   1. When skill frontmatter has `bound_at`, postBindSignals = correct + hallucinated
 *      since that timestamp via getCountersSince.
 *   2. When frontmatter has no `bound_at`, postBindSignals is undefined.
 *   3. minEvidence is populated from MIN_EVIDENCE constant when bound_at is present.
 *   4. boundAtFrontmatter is populated from frontmatter when bound_at present.
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

// ── Fixture helpers ────────────────────────────────────────────────────────

function makeProjectRoot(): string {
  const dir = join(tmpdir(), `gossip-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeAgentConfig(agentId: string, skills: string[] = ['concurrency']) {
  return {
    id: agentId,
    provider: 'anthropic',
    model: 'sonnet',
    preset: undefined as string | undefined,
    skills,
    native: false,
  };
}

function writeSkillFrontmatter(root: string, agentId: string, skillName: string, frontmatter: string): void {
  const skillDir = join(root, '.gossip', 'agents', agentId, 'skills');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, `${skillName}.md`),
    `---\n${frontmatter}\n---\n\nSkill body content.\n`,
  );
}

function writeSkillBinding(root: string, agentId: string, skillName: string, boundAt: string): void {
  // SkillIndex reads .gossip/skill-index.json (centralized, all agents in one file).
  const gossipDir = join(root, '.gossip');
  mkdirSync(gossipDir, { recursive: true });
  const indexPath = join(gossipDir, 'skill-index.json');
  let data: Record<string, Record<string, unknown>> = {};
  try { data = JSON.parse(require('fs').readFileSync(indexPath, 'utf-8')); } catch { /* fresh */ }
  if (!data[agentId]) data[agentId] = {};
  data[agentId][skillName] = {
    skill: skillName,
    enabled: true,
    source: 'auto',
    mode: 'permanent',
    version: 1,
    boundAt,
  };
  writeFileSync(indexPath, JSON.stringify(data));
}

function writeSignalsJsonl(root: string, rows: object[]): void {
  const gossipDir = join(root, '.gossip');
  mkdirSync(gossipDir, { recursive: true });
  // Both readSignals and readSignalsRaw read .gossip/agent-performance.jsonl.
  // Rows must include `type: 'consensus'` to pass readSignalsRaw's filter at performance-reader.ts:487.
  const content = rows.map(r => JSON.stringify({ type: 'consensus', ...r })).join('\n') + '\n';
  writeFileSync(join(gossipDir, 'agent-performance.jsonl'), content);
}

// ── Import under test ──────────────────────────────────────────────────────

import { agentsHandler } from '../../packages/relay/src/dashboard/api-agents';

// ── Test suite 1: bound_at present in frontmatter ──────────────────────────

describe('postBindSignals — frontmatter bound_at present', () => {
  const AGENT_ID = 'sonnet-reviewer';
  const SKILL = 'concurrency';
  const BOUND_AT = '2026-01-01T00:00:00.000Z';
  const AFTER_BOUND = '2026-02-01T00:00:00.000Z';
  const BEFORE_BOUND = '2025-12-01T00:00:00.000Z';

  let root: string;
  let slots: any[];

  beforeAll(async () => {
    root = makeProjectRoot();
    writeSkillBinding(root, AGENT_ID, SKILL, BOUND_AT);
    writeSkillFrontmatter(root, AGENT_ID, SKILL, `status: pending\nbound_at: ${BOUND_AT}`);

    // 3 signals after bound_at (2 correct, 1 hallucinated), 1 before (excluded)
    writeSignalsJsonl(root, [
      { agentId: AGENT_ID, signal: 'agreement', category: SKILL, timestamp: AFTER_BOUND },
      { agentId: AGENT_ID, signal: 'agreement', category: SKILL, timestamp: AFTER_BOUND },
      { agentId: AGENT_ID, signal: 'hallucination_caught', category: SKILL, timestamp: AFTER_BOUND },
      { agentId: AGENT_ID, signal: 'agreement', category: SKILL, timestamp: BEFORE_BOUND }, // excluded
    ]);

    const config = makeAgentConfig(AGENT_ID, [SKILL]);
    const agents = await agentsHandler(root, [config]);
    slots = agents[0]?.skillSlots ?? [];
  });

  it('populates postBindSignals with correct + hallucinated count since bound_at', () => {
    const slot = slots.find((s: any) => s.name === SKILL);
    expect(slot).toBeDefined();
    // 2 agreement (correct) + 1 hallucination_caught (hallucinated) = 3; BEFORE_BOUND excluded
    expect(slot.postBindSignals).toBe(3);
  });

  it('populates minEvidence from MIN_EVIDENCE constant (positive integer)', () => {
    const slot = slots.find((s: any) => s.name === SKILL);
    expect(typeof slot.minEvidence).toBe('number');
    expect(slot.minEvidence).toBeGreaterThan(0);
  });

  it('populates boundAtFrontmatter with the frontmatter bound_at ISO string', () => {
    const slot = slots.find((s: any) => s.name === SKILL);
    expect(slot.boundAtFrontmatter).toBe(BOUND_AT);
  });
});

// ── Test suite 2: no bound_at in frontmatter ───────────────────────────────

describe('postBindSignals — no bound_at in frontmatter', () => {
  const AGENT_ID = 'gemini-reviewer';
  const SKILL = 'concurrency';
  const BOUND_AT = '2026-01-01T00:00:00.000Z';

  let root: string;
  let slots: any[];

  beforeAll(async () => {
    root = makeProjectRoot();
    writeSkillBinding(root, AGENT_ID, SKILL, BOUND_AT);
    // Frontmatter without bound_at
    writeSkillFrontmatter(root, AGENT_ID, SKILL, `status: pending`);
    writeSignalsJsonl(root, [
      { agentId: AGENT_ID, signal: 'agreement', category: SKILL, timestamp: BOUND_AT },
    ]);

    const config = makeAgentConfig(AGENT_ID, [SKILL]);
    const agents = await agentsHandler(root, [config]);
    slots = agents[0]?.skillSlots ?? [];
  });

  it('leaves postBindSignals undefined when frontmatter has no bound_at', () => {
    const slot = slots.find((s: any) => s.name === SKILL);
    expect(slot).toBeDefined();
    expect(slot.postBindSignals).toBeUndefined();
  });

  it('leaves minEvidence undefined when frontmatter has no bound_at', () => {
    const slot = slots.find((s: any) => s.name === SKILL);
    expect(slot.minEvidence).toBeUndefined();
  });

  it('leaves boundAtFrontmatter undefined when frontmatter has no bound_at', () => {
    const slot = slots.find((s: any) => s.name === SKILL);
    expect(slot.boundAtFrontmatter).toBeUndefined();
  });
});
