import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SkillIndex, SkillGapTracker, resolveSkillExists } from '@gossip/orchestrator';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gossip-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('bind requires agent_id and skill', () => {
  let tmpDir: string;
  let index: SkillIndex;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    index = new SkillIndex(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when agent_id is empty', () => {
    expect(() => index.bind('', 'some-skill')).toThrow();
  });

  it('throws when skill is empty', () => {
    expect(() => index.bind('agent-a', '')).toThrow();
  });

  it('succeeds when both are provided', () => {
    // Create the skill file so resolveSkillExists would pass; SkillIndex.bind itself
    // does not check file existence — that is the MCP handler's responsibility.
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'agent-a', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'my-skill.md'), '# My Skill\n');

    const slot = index.bind('agent-a', 'my-skill');
    expect(slot.skill).toBe('my-skill');
  });
});

describe('resolveSkillExists validates file existence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false for a nonexistent skill', () => {
    expect(resolveSkillExists('agent-a', 'does-not-exist', tmpDir)).toBe(false);
  });

  it('returns true for a skill file in agent-local path', () => {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'agent-a', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'trust-boundaries.md'), '# Trust Boundaries\n');

    expect(resolveSkillExists('agent-a', 'trust-boundaries', tmpDir)).toBe(true);
  });

  it('returns true for a skill file in project-wide path', () => {
    const skillsDir = join(tmpDir, '.gossip', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'input-validation.md'), '# Input Validation\n');

    expect(resolveSkillExists('agent-a', 'input-validation', tmpDir)).toBe(true);
  });

  it('returns false for a path-traversal attempt', () => {
    // Agent IDs that fail the SAFE_AGENT_ID regex cause resolveSkill to return null.
    expect(resolveSkillExists('../evil', 'any-skill', tmpDir)).toBe(false);
  });
});

describe('unbind returns false for missing slot', () => {
  let tmpDir: string;
  let index: SkillIndex;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    index = new SkillIndex(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when agent has no slots', () => {
    expect(index.unbind('ghost-agent', 'missing-skill')).toBe(false);
  });

  it('returns false when agent exists but skill slot is absent', () => {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'agent-a', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'real-skill.md'), '# Real\n');

    index.bind('agent-a', 'real-skill');
    expect(index.unbind('agent-a', 'other-skill')).toBe(false);
  });

  it('returns true when the slot exists', () => {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'agent-a', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'real-skill.md'), '# Real\n');

    index.bind('agent-a', 'real-skill');
    expect(index.unbind('agent-a', 'real-skill')).toBe(true);
  });
});

describe('bind creates slot with correct defaults', () => {
  let tmpDir: string;
  let index: SkillIndex;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    index = new SkillIndex(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets version=1, enabled=true, source=manual for a new slot', () => {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'agent-a', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'my-skill.md'), '# My Skill\n');

    const slot = index.bind('agent-a', 'my-skill');

    expect(slot.version).toBe(1);
    expect(slot.enabled).toBe(true);
    expect(slot.source).toBe('manual');
  });

  it('increments version on re-bind', () => {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'agent-a', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'my-skill.md'), '# My Skill\n');

    index.bind('agent-a', 'my-skill');
    const slot = index.bind('agent-a', 'my-skill');

    expect(slot.version).toBe(2);
  });

  it('sets boundAt to a valid ISO timestamp', () => {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'agent-a', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'my-skill.md'), '# My Skill\n');

    const before = Date.now();
    const slot = index.bind('agent-a', 'my-skill');
    const after = Date.now();

    const boundAt = new Date(slot.boundAt).getTime();
    expect(boundAt).toBeGreaterThanOrEqual(before);
    expect(boundAt).toBeLessThanOrEqual(after);
  });
});

describe('develop auto-binds as permanent', () => {
  let tmpDir: string;
  let index: SkillIndex;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    index = new SkillIndex(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bind with source=auto and mode=permanent creates the expected slot', () => {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'agent-a', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'concurrency.md'), '# Concurrency\n');

    const slot = index.bind('agent-a', 'concurrency', { source: 'auto', mode: 'permanent' });

    expect(slot.source).toBe('auto');
    expect(slot.mode).toBe('permanent');
    expect(slot.enabled).toBe(true);
  });

  it('persisted slot retains source and mode after reload', () => {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'agent-a', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'concurrency.md'), '# Concurrency\n');

    index.bind('agent-a', 'concurrency', { source: 'auto', mode: 'permanent' });

    // Re-load from disk
    const reloaded = new SkillIndex(tmpDir);
    const slot = reloaded.getSlot('agent-a', 'concurrency');

    expect(slot).toBeDefined();
    expect(slot!.source).toBe('auto');
    expect(slot!.mode).toBe('permanent');
  });
});

describe('list returns bound skills', () => {
  let tmpDir: string;
  let index: SkillIndex;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    index = new SkillIndex(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getEnabledSkills returns all enabled skills after binding several', () => {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'agent-a', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'skill-one.md'), '# One\n');
    writeFileSync(join(skillsDir, 'skill-two.md'), '# Two\n');
    writeFileSync(join(skillsDir, 'skill-three.md'), '# Three\n');

    index.bind('agent-a', 'skill-one');
    index.bind('agent-a', 'skill-two');
    index.bind('agent-a', 'skill-three');

    const enabled = index.getEnabledSkills('agent-a');
    expect(enabled).toHaveLength(3);
    expect(enabled).toContain('skill-one');
    expect(enabled).toContain('skill-two');
    expect(enabled).toContain('skill-three');
  });

  it('getEnabledSkills excludes disabled slots', () => {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'agent-a', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'skill-one.md'), '# One\n');
    writeFileSync(join(skillsDir, 'skill-two.md'), '# Two\n');

    index.bind('agent-a', 'skill-one');
    index.bind('agent-a', 'skill-two', { enabled: false });

    const enabled = index.getEnabledSkills('agent-a');
    expect(enabled).toContain('skill-one');
    expect(enabled).not.toContain('skill-two');
  });

  it('returns empty array for unknown agent', () => {
    expect(index.getEnabledSkills('no-such-agent')).toEqual([]);
  });
});

describe('build discovery reports pending gaps', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, '.gossip'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSuggestion(skill: string, agent: string): string {
    return JSON.stringify({
      type: 'suggestion',
      skill,
      reason: `Need ${skill}`,
      agent,
      task_context: 'some task',
      timestamp: new Date().toISOString(),
    });
  }

  it('checkThresholds reports skill with 3 suggestions from 2 agents', () => {
    const gapLogPath = join(tmpDir, '.gossip', 'skill-gaps.jsonl');
    writeFileSync(
      gapLogPath,
      [
        writeSuggestion('error-handling', 'agent-alpha'),
        writeSuggestion('error-handling', 'agent-alpha'),
        writeSuggestion('error-handling', 'agent-beta'),
      ].join('\n') + '\n'
    );

    const tracker = new SkillGapTracker(tmpDir);
    const result = tracker.checkThresholds();

    expect(result.count).toBe(1);
    expect(result.pending).toContain('error-handling');
  });

  it('checkThresholds does not report skill with fewer than 3 suggestions', () => {
    const gapLogPath = join(tmpDir, '.gossip', 'skill-gaps.jsonl');
    writeFileSync(
      gapLogPath,
      [
        writeSuggestion('error-handling', 'agent-alpha'),
        writeSuggestion('error-handling', 'agent-beta'),
      ].join('\n') + '\n'
    );

    const tracker = new SkillGapTracker(tmpDir);
    const result = tracker.checkThresholds();

    expect(result.count).toBe(0);
  });

  it('checkThresholds does not report skill with 3 suggestions all from same agent', () => {
    const gapLogPath = join(tmpDir, '.gossip', 'skill-gaps.jsonl');
    writeFileSync(
      gapLogPath,
      [
        writeSuggestion('error-handling', 'agent-alpha'),
        writeSuggestion('error-handling', 'agent-alpha'),
        writeSuggestion('error-handling', 'agent-alpha'),
      ].join('\n') + '\n'
    );

    const tracker = new SkillGapTracker(tmpDir);
    const result = tracker.checkThresholds();

    expect(result.count).toBe(0);
  });

  it('checkThresholds returns count=0 when gap log is empty', () => {
    const tracker = new SkillGapTracker(tmpDir);
    const result = tracker.checkThresholds();

    expect(result.count).toBe(0);
    expect(result.pending).toEqual([]);
  });

  it('resolved skills are excluded from pending', () => {
    const gapLogPath = join(tmpDir, '.gossip', 'skill-gaps.jsonl');
    writeFileSync(
      gapLogPath,
      [
        writeSuggestion('error-handling', 'agent-alpha'),
        writeSuggestion('error-handling', 'agent-alpha'),
        writeSuggestion('error-handling', 'agent-beta'),
      ].join('\n') + '\n'
    );

    const tracker = new SkillGapTracker(tmpDir);
    tracker.recordResolution('error-handling');

    const result = tracker.checkThresholds();
    expect(result.count).toBe(0);
    expect(result.pending).not.toContain('error-handling');
  });
});
