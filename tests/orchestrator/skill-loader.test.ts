import { loadSkills, listAvailableSkills } from '@gossip/orchestrator';

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
});
