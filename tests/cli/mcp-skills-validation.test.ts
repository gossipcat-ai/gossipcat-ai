import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SkillIndex, SkillGapTracker, resolveSkillExists, resolveSkill, resolveSharedSkill } from '@gossip/orchestrator';

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

// ── gossip_skills(action: "get") — issue #698 part 1 ──────────────────────
//
// The `get` handler (apps/cli/src/mcp-server-sdk.ts, action === 'get' branch)
// is a thin wrapper over resolveSkill / resolveSharedSkill: it validates
// `skill` is present, resolves via the appropriate function, and formats the
// result. These tests exercise the resolution building blocks directly (the
// handler itself is not exported — see mcp-skills-develop-throttle.test.ts
// for the same "test the building blocks" convention used elsewhere in this
// suite) plus a local mirror of the one-line `skill` presence guard.

describe('resolveSkill / resolveSharedSkill power gossip_skills(action: "get")', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a) resolves a bundled default skill by name with no agent_id and no project override', () => {
    // No .gossip/skills or .gossip/agents dir exists in tmpDir at all — the
    // only place "implementation-discipline" can resolve from is the bundled
    // default-skills/ directory shipped with @gossip/orchestrator.
    const resolved = resolveSharedSkill('implementation-discipline', tmpDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.content).toContain('name: implementation-discipline');
    expect(resolved!.path.endsWith(join('default-skills', 'implementation-discipline.md'))).toBe(true);
  });

  it('(a2) resolveSkill (agent_id path) also falls through to the bundled default when no local/project override exists', () => {
    const resolved = resolveSkill('agent-a', 'implementation-discipline', tmpDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.content).toContain('name: implementation-discipline');
  });

  it('(b) returns null for a bogus skill name (not-found case for the handler to report)', () => {
    expect(resolveSharedSkill('this-skill-does-not-exist-anywhere-xyz', tmpDir)).toBeNull();
    expect(resolveSkill('agent-a', 'this-skill-does-not-exist-anywhere-xyz', tmpDir)).toBeNull();
  });

  it('(c) resolveSharedSkill prefers project-wide .gossip/skills over the bundled default', () => {
    const projectSkillsDir = join(tmpDir, '.gossip', 'skills');
    mkdirSync(projectSkillsDir, { recursive: true });
    // Reuse a name that also exists in default-skills/ so precedence is meaningfully tested.
    writeFileSync(join(projectSkillsDir, 'implementation-discipline.md'), '# PROJECT-WIDE OVERRIDE\n');

    const resolved = resolveSharedSkill('implementation-discipline', tmpDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.content).toBe('# PROJECT-WIDE OVERRIDE\n');
  });

  it('(c) resolveSharedSkill never reads an agent-local skills dir, even when one exists for the same name', () => {
    const agentSkillsDir = join(tmpDir, '.gossip', 'agents', 'some-agent', 'skills');
    mkdirSync(agentSkillsDir, { recursive: true });
    writeFileSync(join(agentSkillsDir, 'shared-priority-test.md'), '# AGENT LOCAL — SHOULD NEVER BE RETURNED\n');

    const projectSkillsDir = join(tmpDir, '.gossip', 'skills');
    mkdirSync(projectSkillsDir, { recursive: true });
    writeFileSync(join(projectSkillsDir, 'shared-priority-test.md'), '# PROJECT WIDE\n');

    const resolved = resolveSharedSkill('shared-priority-test', tmpDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.content).toBe('# PROJECT WIDE\n');
  });

  it('(c) resolveSharedSkill returns null for a skill that ONLY exists in an agent-local dir (no project/bundled copy)', () => {
    const agentSkillsDir = join(tmpDir, '.gossip', 'agents', 'some-agent', 'skills');
    mkdirSync(agentSkillsDir, { recursive: true });
    writeFileSync(join(agentSkillsDir, 'agent-only-skill.md'), '# AGENT ONLY\n');

    // resolveSkill (agent_id given) WOULD find it via the agent-local base...
    expect(resolveSkill('some-agent', 'agent-only-skill', tmpDir)).not.toBeNull();
    // ...but resolveSharedSkill (no agent_id / "get" without agent_id) must not.
    expect(resolveSharedSkill('agent-only-skill', tmpDir)).toBeNull();
  });

  it('(d) the handler\'s "skill is required for get" guard rejects an empty/missing skill param', () => {
    // Mirrors the exact one-line guard at the top of the `get` branch in
    // apps/cli/src/mcp-server-sdk.ts: `if (!skill) return { ... 'Error: skill is required for get.' ... }`.
    function simulateGetGuard(skill?: string): string | null {
      if (!skill) return 'Error: skill is required for get.';
      return null;
    }

    expect(simulateGetGuard(undefined)).toBe('Error: skill is required for get.');
    expect(simulateGetGuard('')).toBe('Error: skill is required for get.');
    expect(simulateGetGuard('implementation-discipline')).toBeNull();
  });
});
