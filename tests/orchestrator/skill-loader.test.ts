import { loadSkills, listAvailableSkills } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SkillLoader', () => {
  it('loads default skills by name', () => {
    const content = loadSkills('test-agent', ['typescript'], process.cwd());
    expect(content).toContain('TypeScript');
    expect(content).toContain('SKILLS');
  });

  it('returns empty string for no skills', () => {
    expect(loadSkills('test-agent', [], process.cwd())).toBe('');
  });

  it('returns empty for unknown skill', () => {
    expect(loadSkills('test-agent', ['nonexistent-skill-xyz'], process.cwd())).toBe('');
  });

  it('lists available default skills', () => {
    const skills = listAvailableSkills('test-agent', process.cwd());
    expect(skills).toContain('typescript');
    expect(skills).toContain('code-review');
    expect(skills).toContain('debugging');
  });

  it('wraps multiple skills with delimiters', () => {
    const content = loadSkills('test-agent', ['typescript'], process.cwd());
    expect(content).toMatch(/^[\s\S]*--- SKILLS ---[\s\S]*--- END SKILLS ---[\s\S]*$/);
  });

  it('resolves underscore skill names to hyphenated filenames', () => {
    const tmpDir = join(tmpdir(), `gossip-test-${Date.now()}`);
    const skillDir = join(tmpDir, '.gossip', 'skills');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'code-review.md'), '# Code Review Skill');

    try {
      const result = loadSkills('test-agent', ['code_review'], tmpDir);
      expect(result).toContain('Code Review Skill');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
