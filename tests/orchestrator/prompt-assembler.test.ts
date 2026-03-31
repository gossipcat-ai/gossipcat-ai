import { assemblePrompt } from '@gossip/orchestrator';

describe('assemblePrompt', () => {
  it('assembles memory + skills', () => {
    const result = assemblePrompt({
      memory: 'memory content here',
      skills: 'skill content here',
    });
    expect(result).toContain('--- MEMORY ---');
    expect(result).toContain('memory content here');
    expect(result).toContain('--- END MEMORY ---');
    expect(result).toContain('--- SKILLS ---');
    expect(result).toContain('skill content here');
    expect(result).toContain('--- END SKILLS ---');
  });

  it('omits memory block when no memory', () => {
    const result = assemblePrompt({ skills: 'skills' });
    expect(result).not.toContain('--- MEMORY ---');
    expect(result).toContain('--- SKILLS ---');
  });

  it('omits lens block when no lens', () => {
    const result = assemblePrompt({ skills: 'skills', memory: 'mem' });
    expect(result).not.toContain('--- LENS ---');
  });

  it('includes lens block between memory and skills', () => {
    const result = assemblePrompt({
      memory: 'mem',
      lens: 'focus on DoS',
      skills: 'skills',
    });
    const memIdx = result.indexOf('--- END MEMORY ---');
    const lensIdx = result.indexOf('--- LENS ---');
    const skillsIdx = result.indexOf('--- SKILLS ---');
    expect(memIdx).toBeLessThan(lensIdx);
    expect(lensIdx).toBeLessThan(skillsIdx);
  });

  it('includes context after skills', () => {
    const result = assemblePrompt({ skills: 'skills', context: 'ctx' });
    expect(result).toContain('\n\nContext:\nctx');
  });

  it('handles all empty — returns empty string', () => {
    expect(assemblePrompt({})).toBe('');
  });

  it('includes consensus summary instruction when consensusSummary is true', () => {
    const result = assemblePrompt({ consensusSummary: true });
    expect(result).toContain('## Consensus Summary');
    expect(result).toContain('MUST include a citation');
  });

  it('does not include consensus instruction when consensusSummary is false', () => {
    const result = assemblePrompt({});
    expect(result).not.toContain('## Consensus Summary');
  });
});
