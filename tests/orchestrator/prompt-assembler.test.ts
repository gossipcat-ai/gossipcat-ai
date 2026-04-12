import { assemblePrompt, parseSpecFrontMatter, buildSpecReviewEnrichment } from '@gossip/orchestrator';

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

  it('skills precede memory and lens (high priority — survives truncation)', () => {
    const result = assemblePrompt({
      memory: 'mem',
      lens: 'focus on DoS',
      skills: 'skills',
    });
    const skillsIdx = result.indexOf('--- SKILLS ---');
    const lensIdx = result.indexOf('--- LENS ---');
    const memIdx = result.indexOf('--- MEMORY ---');
    expect(skillsIdx).toBeLessThan(lensIdx);
    expect(lensIdx).toBeLessThan(memIdx);
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
    expect(result).toContain('<cite');
  });

  it('does not include consensus instruction when consensusSummary is false', () => {
    const result = assemblePrompt({});
    expect(result).not.toContain('## Consensus Summary');
  });

  it('specReviewContext precedes memory (survives truncation)', () => {
    const result = assemblePrompt({
      memory: 'mem content',
      specReviewContext: 'spec review content',
      lens: 'focus lens',
    });
    const specIdx = result.indexOf('--- SPEC REVIEW ---');
    const memIdx = result.indexOf('--- MEMORY ---');
    const lensIdx = result.indexOf('--- LENS ---');
    expect(specIdx).toBeGreaterThan(-1);
    expect(memIdx).toBeGreaterThan(-1);
    expect(lensIdx).toBeGreaterThan(-1);
    expect(lensIdx).toBeLessThan(specIdx);
    expect(specIdx).toBeLessThan(memIdx);
  });
});

describe('parseSpecFrontMatter', () => {
  it('extracts status from valid front-matter', () => {
    const content = '---\nstatus: proposal\n---\n\n# Title\n\nBody';
    expect(parseSpecFrontMatter(content)).toEqual({ status: 'proposal' });
  });

  it('accepts implemented and retired', () => {
    expect(parseSpecFrontMatter('---\nstatus: implemented\n---\nbody').status).toBe('implemented');
    expect(parseSpecFrontMatter('---\nstatus: retired\n---\nbody').status).toBe('retired');
  });

  it('accepts quoted values', () => {
    expect(parseSpecFrontMatter('---\nstatus: "proposal"\n---\nbody').status).toBe('proposal');
    expect(parseSpecFrontMatter("---\nstatus: 'retired'\n---\nbody").status).toBe('retired');
  });

  it('ignores unknown status values', () => {
    expect(parseSpecFrontMatter('---\nstatus: draft\n---\nbody').status).toBeUndefined();
    expect(parseSpecFrontMatter('---\nstatus: done\n---\nbody').status).toBeUndefined();
  });

  it('ignores front-matter without status field', () => {
    const content = '---\ntitle: Some Spec\nauthor: goku\n---\n\nBody';
    expect(parseSpecFrontMatter(content).status).toBeUndefined();
  });

  it('returns empty object when no front-matter', () => {
    expect(parseSpecFrontMatter('# Title\n\nBody')).toEqual({});
    expect(parseSpecFrontMatter('')).toEqual({});
  });

  it('does not match front-matter mid-document', () => {
    const content = 'Some intro text\n\n---\nstatus: proposal\n---\n\nBody';
    expect(parseSpecFrontMatter(content).status).toBeUndefined();
  });

  it('tolerates extra fields and whitespace', () => {
    const content = '---\ntitle: Test\nstatus:   proposal   \ndate: 2026-04-12\n---\nBody';
    expect(parseSpecFrontMatter(content).status).toBe('proposal');
  });
});

describe('buildSpecReviewEnrichment', () => {
  it('proposal status emits anti-"NOT IMPLEMENTED" framing guidance', () => {
    const result = buildSpecReviewEnrichment(['src/foo.ts'], 'proposal');
    expect(result).toBeTruthy();
    expect(result).toContain('PROPOSAL');
    expect(result).toContain('NOT IMPLEMENTED');
    expect(result).toContain('INTENDED changes');
    expect(result).toContain('src/foo.ts');
  });

  it('implemented status emits verify-against-code guidance (default behavior)', () => {
    const result = buildSpecReviewEnrichment(['src/foo.ts'], 'implemented');
    expect(result).toBeTruthy();
    expect(result).toContain('Verify described flows match the implementation');
    expect(result).not.toContain('PROPOSAL');
  });

  it('retired status warns against applying to current code', () => {
    const result = buildSpecReviewEnrichment(['src/foo.ts'], 'retired');
    expect(result).toBeTruthy();
    expect(result).toContain('RETIRED');
    expect(result).toContain('historical');
  });

  it('omitted status defaults to implemented behavior', () => {
    const result = buildSpecReviewEnrichment(['src/foo.ts']);
    expect(result).toBeTruthy();
    expect(result).toContain('Verify described flows match the implementation');
  });

  it('returns null when no files and no status', () => {
    expect(buildSpecReviewEnrichment([])).toBeNull();
  });

  it('proposal status fires even without implementation files', () => {
    const result = buildSpecReviewEnrichment([], 'proposal');
    expect(result).toBeTruthy();
    expect(result).toContain('PROPOSAL');
  });
});
