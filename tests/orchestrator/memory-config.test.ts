import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadMemoryConfig } from '../../packages/orchestrator/src/memory-config';
import { loadSkills } from '../../packages/orchestrator/src/skill-loader';
import { SkillIndex } from '../../packages/orchestrator/src/skill-index';

const PROPAGATED_SKILL_CONTENT = `---
name: propagated-skill
description: Test fixture for ikp §4 kill-switch
keywords: [test]
category: testing
mode: permanent
propagated: true
status: active
---

# Propagated Skill (Test Fixture)
`;

const REGULAR_SKILL_CONTENT = `---
name: regular-skill
description: Non-propagated skill — should always pass kill-switch
keywords: [test]
category: testing
mode: permanent
status: active
---

# Regular Skill (not propagated)
`;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gossip-memcfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '.gossip'), { recursive: true });
  return dir;
}

function writeConfig(dir: string, config: object): void {
  writeFileSync(join(dir, '.gossip', 'memory-config.json'), JSON.stringify(config));
}

function writeSkill(dir: string, agentId: string, skillName: string, content: string): void {
  const skillDir = join(dir, '.gossip', 'agents', agentId, 'skills');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, `${skillName}.md`), content);
}

describe('loadMemoryConfig', () => {
  it('returns defaults when file is absent', () => {
    const dir = makeTmpDir();
    try {
      const config = loadMemoryConfig(dir);
      expect(config.bundledMemories.enabled).toBe(true);
      expect(config.bundledMemories.exclude).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns defaults and logs warning on malformed JSON (does not throw)', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, '.gossip', 'memory-config.json'), 'not-valid-json{{{');
      const config = loadMemoryConfig(dir);
      expect(config.bundledMemories.enabled).toBe(true);
      expect(config.bundledMemories.exclude).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors enabled:false', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { bundledMemories: { enabled: false, exclude: [] } });
      const config = loadMemoryConfig(dir);
      expect(config.bundledMemories.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors exclude list', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { bundledMemories: { enabled: true, exclude: ['skill-a', 'skill-b'] } });
      const config = loadMemoryConfig(dir);
      expect(config.bundledMemories.exclude).toEqual(['skill-a', 'skill-b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to defaults for partial config (missing bundledMemories)', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, {});
      const config = loadMemoryConfig(dir);
      expect(config.bundledMemories.enabled).toBe(true);
      expect(config.bundledMemories.exclude).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadSkills — kill-switch integration', () => {
  it('skips propagated skill when enabled:false', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { bundledMemories: { enabled: false, exclude: [] } });
      writeSkill(dir, 'test-agent', 'propagated-skill', PROPAGATED_SKILL_CONTENT);

      const index = new SkillIndex(dir);
      index.bind('test-agent', 'propagated-skill', { mode: 'permanent' });

      const result = loadSkills('test-agent', ['propagated-skill'], dir, index);
      expect(result.loaded).not.toContain('propagated-skill');
      expect(result.dropped.map(d => d.skill)).toContain('propagated-skill');
      const drop = result.dropped.find(d => d.skill === 'propagated-skill');
      expect(drop?.reason).toBe('kill-switch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips propagated skill when listed in exclude', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { bundledMemories: { enabled: true, exclude: ['propagated-skill'] } });
      writeSkill(dir, 'test-agent', 'propagated-skill', PROPAGATED_SKILL_CONTENT);

      const index = new SkillIndex(dir);
      index.bind('test-agent', 'propagated-skill', { mode: 'permanent' });

      const result = loadSkills('test-agent', ['propagated-skill'], dir, index);
      expect(result.loaded).not.toContain('propagated-skill');
      const drop = result.dropped.find(d => d.skill === 'propagated-skill');
      expect(drop?.reason).toBe('excluded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('non-propagated skill passes regardless of enabled:false', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { bundledMemories: { enabled: false, exclude: [] } });
      writeSkill(dir, 'test-agent', 'regular-skill', REGULAR_SKILL_CONTENT);

      const index = new SkillIndex(dir);
      index.bind('test-agent', 'regular-skill', { mode: 'permanent' });

      const result = loadSkills('test-agent', ['regular-skill'], dir, index);
      expect(result.loaded).toContain('regular-skill');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('non-propagated skill passes even when listed in exclude', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, { bundledMemories: { enabled: true, exclude: ['regular-skill'] } });
      writeSkill(dir, 'test-agent', 'regular-skill', REGULAR_SKILL_CONTENT);

      const index = new SkillIndex(dir);
      index.bind('test-agent', 'regular-skill', { mode: 'permanent' });

      const result = loadSkills('test-agent', ['regular-skill'], dir, index);
      expect(result.loaded).toContain('regular-skill');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagated skill loads normally when config is absent (defaults)', () => {
    const dir = makeTmpDir();
    try {
      // No config file — defaults apply (enabled:true, exclude:[])
      writeSkill(dir, 'test-agent', 'propagated-skill', PROPAGATED_SKILL_CONTENT);

      const index = new SkillIndex(dir);
      index.bind('test-agent', 'propagated-skill', { mode: 'permanent' });

      const result = loadSkills('test-agent', ['propagated-skill'], dir, index);
      expect(result.loaded).toContain('propagated-skill');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
