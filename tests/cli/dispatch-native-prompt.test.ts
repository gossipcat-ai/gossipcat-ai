/**
 * Regression tests for the native dispatch prompt pipeline.
 *
 * These exist because PR #56 added FINDING_TAG_SCHEMA injection inside
 * assemblePrompt() — but the native dispatch path built prompts via manual
 * concat and silently missed the update. The bug shipped to fresh installs:
 * native agents produced markdown tables instead of <agent_finding> tags,
 * consensus synthesis fell through to bullet parsing, and the dashboard
 * showed 0 findings.
 *
 * The fix (combined PR) unifies all dispatch paths through assemblePrompt()
 * and these tests assert the schema blocks appear in the native agent prompt
 * output so a future drift is caught in CI.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ctx } from '../../apps/cli/src/mcp-context';
import {
  handleDispatchSingle,
  handleDispatchParallel,
  handleDispatchConsensus,
} from '../../apps/cli/src/handlers/dispatch';

type SkillIndexStub = {
  getAgentSlots: (agentId: string) => Array<{ slot: number }>;
  getEnabledSkills: (agentId: string) => string[];
  getSkillMode: (agentId: string, skill: string) => 'permanent' | 'contextual';
};

function makeSkillIndex(enabled: string[]): SkillIndexStub {
  return {
    getAgentSlots: () => enabled.map((_, i) => ({ slot: i })),
    getEnabledSkills: () => enabled,
    getSkillMode: () => 'permanent' as const,
  };
}

function makeMainAgent(overrides: Record<string, any> = {}): any {
  return {
    dispatch: jest.fn().mockReturnValue({ taskId: 'default-task-id' }),
    collect: jest.fn().mockResolvedValue({ results: [] }),
    getAgentConfig: jest.fn().mockReturnValue(null),
    getLlm: jest.fn().mockReturnValue(null),
    getLLM: jest.fn().mockReturnValue(null),
    getAgentList: jest.fn().mockReturnValue([]),
    getSkillGapSuggestions: jest.fn().mockReturnValue([]),
    getSkillIndex: jest.fn().mockReturnValue(null),
    getSessionGossip: jest.fn().mockReturnValue([]),
    getSessionConsensusHistory: jest.fn().mockReturnValue([]),
    recordNativeTask: jest.fn(),
    recordNativeTaskCompleted: jest.fn(),
    recordPlanStepResult: jest.fn(),
    publishNativeGossip: jest.fn().mockResolvedValue(undefined),
    getChainContext: jest.fn().mockReturnValue(''),
    generateLensesForAgents: jest.fn().mockResolvedValue(new Map()),
    dispatchParallel: jest.fn().mockResolvedValue({ taskIds: [], errors: [] }),
    dispatchParallelWithLenses: jest.fn().mockResolvedValue({ taskIds: [], errors: [] }),
    getTask: jest.fn().mockReturnValue(null),
    scopeTracker: {
      hasOverlap: jest.fn().mockReturnValue({ overlaps: false }),
      register: jest.fn(),
      release: jest.fn(),
    },
    pipeline: null,
    projectRoot: '/tmp/gossip-test-project',
    ...overrides,
  };
}

const originalCtx = {
  mainAgent: ctx.mainAgent,
  relay: ctx.relay,
  workers: ctx.workers,
  keychain: ctx.keychain,
  skillEngine: ctx.skillEngine,
  nativeTaskMap: ctx.nativeTaskMap,
  nativeResultMap: ctx.nativeResultMap,
  nativeAgentConfigs: ctx.nativeAgentConfigs,
  pendingConsensusRounds: ctx.pendingConsensusRounds,
  booted: ctx.booted,
  boot: ctx.boot,
  syncWorkersViaKeychain: ctx.syncWorkersViaKeychain,
};

function resetCtx(mainAgentOverrides: Record<string, any> = {}) {
  ctx.mainAgent = makeMainAgent(mainAgentOverrides);
  ctx.nativeTaskMap = new Map();
  ctx.nativeResultMap = new Map();
  ctx.nativeAgentConfigs = new Map();
  ctx.pendingConsensusRounds = new Map();
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;
  ctx.syncWorkersViaKeychain = jest.fn().mockResolvedValue(undefined) as any;
  (ctx as any).skillEngine = null;
}

function restoreCtx() {
  Object.assign(ctx, originalCtx);
}

/**
 * AGENT_PROMPT is emitted as the second content item for native dispatches.
 * Tests use this helper so they fail loudly if the payload layout changes
 * (instead of silently checking the wrong string).
 */
function extractAgentPrompt(content: Array<{ text: string }>): string {
  const match = content.find(c => c.text.startsWith('AGENT_PROMPT:'));
  if (!match) throw new Error(`no AGENT_PROMPT content item; got: ${content.map(c => c.text.slice(0, 40)).join(' | ')}`);
  return match.text;
}

describe('native dispatch — FINDING TAG SCHEMA injection (non-consensus)', () => {
  let skillDir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    skillDir = mkdtempSync(join(tmpdir(), 'gossip-native-prompt-'));
    mkdirSync(join(skillDir, '.gossip', 'skills'), { recursive: true });
    process.chdir(skillDir);
    resetCtx();
  });

  afterEach(() => {
    restoreCtx();
    process.chdir(prevCwd);
    rmSync(skillDir, { recursive: true, force: true });
  });

  it('handleDispatchSingle injects FINDING TAG SCHEMA markers', async () => {
    ctx.nativeAgentConfigs.set('native-claude', {
      model: 'claude-sonnet-4-6',
      instructions: 'You are a reviewer.',
      description: 'Native reviewer',
      skills: [],
    });

    const result = await handleDispatchSingle('native-claude', 'Audit the memory system');
    const prompt = extractAgentPrompt(result.content);
    expect(prompt).toContain('--- FINDING TAG SCHEMA ---');
    expect(prompt).toContain('--- END FINDING TAG SCHEMA ---');
    // The slim schema goes out on non-consensus — full cross-review framing must NOT appear.
    expect(prompt).not.toContain('--- CONSENSUS OUTPUT FORMAT ---');
  });

  it('handleDispatchSingle places the schema AFTER skills (ordering invariant)', async () => {
    writeFileSync(
      join(skillDir, '.gossip', 'skills', 'memory-retrieval.md'),
      '---\nname: memory-retrieval\nmode: permanent\n---\nRecall past findings before making new claims.\n',
    );
    ctx.mainAgent = makeMainAgent({
      getSkillIndex: jest.fn().mockReturnValue(makeSkillIndex(['memory-retrieval'])),
    });
    ctx.nativeAgentConfigs.set('native-claude', {
      model: 'claude-sonnet-4-6',
      instructions: 'You are a reviewer.',
      description: 'Native reviewer',
      skills: ['memory-retrieval'],
    });

    const result = await handleDispatchSingle('native-claude', 'Audit memory');
    const prompt = extractAgentPrompt(result.content);
    const skillsIdx = prompt.indexOf('--- SKILLS ---');
    const schemaIdx = prompt.indexOf('--- FINDING TAG SCHEMA ---');
    const taskIdx = prompt.indexOf('Task: Audit memory');
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(schemaIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeLessThan(schemaIdx);
    expect(schemaIdx).toBeLessThan(taskIdx);
  });

  it('handleDispatchParallel (consensus=false) injects FINDING TAG SCHEMA', async () => {
    ctx.nativeAgentConfigs.set('native-claude', {
      model: 'claude-sonnet-4-6',
      instructions: 'You are a reviewer.',
      description: 'Native reviewer',
      skills: [],
    });

    const result = await handleDispatchParallel(
      [{ agent_id: 'native-claude', task: 'Audit x' }],
      false,
    );
    const prompt = extractAgentPrompt(result.content);
    expect(prompt).toContain('--- FINDING TAG SCHEMA ---');
    expect(prompt).not.toContain('--- CONSENSUS OUTPUT FORMAT ---');
  });
});

describe('native dispatch — CONSENSUS OUTPUT FORMAT injection (consensus)', () => {
  let skillDir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    skillDir = mkdtempSync(join(tmpdir(), 'gossip-native-consensus-'));
    mkdirSync(join(skillDir, '.gossip', 'skills'), { recursive: true });
    process.chdir(skillDir);
    resetCtx({
      generateLensesForAgents: jest.fn().mockResolvedValue(new Map()),
    });
  });

  afterEach(() => {
    restoreCtx();
    process.chdir(prevCwd);
    rmSync(skillDir, { recursive: true, force: true });
  });

  it('handleDispatchConsensus injects CONSENSUS OUTPUT FORMAT markers', async () => {
    ctx.nativeAgentConfigs.set('native-claude', {
      model: 'claude-sonnet-4-6',
      instructions: 'You are a reviewer.',
      description: 'Native reviewer',
      skills: [],
    });

    const result = await handleDispatchConsensus([
      { agent_id: 'native-claude', task: 'Audit memory' },
    ]);
    const prompt = extractAgentPrompt(result.content);
    expect(prompt).toContain('--- CONSENSUS OUTPUT FORMAT ---');
    expect(prompt).toContain('--- END CONSENSUS OUTPUT FORMAT ---');
    // Consensus path emits the full block, not the slim schema.
    expect(prompt).not.toContain('--- FINDING TAG SCHEMA ---');
  });

  it('handleDispatchConsensus preserves block ordering: SKILLS < CONSENSUS FORMAT < TASK', async () => {
    writeFileSync(
      join(skillDir, '.gossip', 'skills', 'memory-retrieval.md'),
      '---\nname: memory-retrieval\nmode: permanent\n---\nRecall past findings.\n',
    );
    ctx.mainAgent = makeMainAgent({
      generateLensesForAgents: jest.fn().mockResolvedValue(new Map()),
      getSkillIndex: jest.fn().mockReturnValue(makeSkillIndex(['memory-retrieval'])),
    });
    ctx.nativeAgentConfigs.set('native-claude', {
      model: 'claude-sonnet-4-6',
      instructions: 'You are a reviewer.',
      description: 'Native reviewer',
      skills: ['memory-retrieval'],
    });

    const result = await handleDispatchConsensus([
      { agent_id: 'native-claude', task: 'Audit memory' },
    ]);
    const prompt = extractAgentPrompt(result.content);
    const skillsIdx = prompt.indexOf('--- SKILLS ---');
    const consensusIdx = prompt.indexOf('--- CONSENSUS OUTPUT FORMAT ---');
    const taskIdx = prompt.indexOf('Task: Audit memory');
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(consensusIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeLessThan(consensusIdx);
    expect(consensusIdx).toBeLessThan(taskIdx);
  });
});
