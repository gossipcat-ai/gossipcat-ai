import { assemblePrompt, assembleUtilityPrompt, MAX_ASSEMBLED_PROMPT_CHARS, parseSpecFrontMatter, buildSpecReviewEnrichment } from '@gossip/orchestrator';

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

describe('assembleUtilityPrompt', () => {
  const baseArgs = {
    taskId: 'abc12345',
    modelShort: 'haiku',
    system: 'You are a planner.',
    user: 'Decompose this task.',
    intro: 'Planner ready.',
    reentrantCall: 'gossip_plan(task: "x", _utility_task_id: "abc12345")',
  };

  it('produces two content items: instructions + AGENT_PROMPT', () => {
    const result = assembleUtilityPrompt(baseArgs);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('text');
    expect(result[1].type).toBe('text');
    expect(result[1].text).toContain('AGENT_PROMPT:abc12345');
    expect(result[1].text).toContain('You are a planner.');
    expect(result[1].text).toContain('Decompose this task.');
  });

  it('includes the three-step EXECUTE NOW block with the task id', () => {
    const text = assembleUtilityPrompt(baseArgs)[0].text;
    expect(text).toContain('EXECUTE NOW');
    expect(text).toContain('Agent(model: "haiku"');
    expect(text).toContain('AGENT_PROMPT:abc12345');
    expect(text).toMatch(/1\. Agent/);
    expect(text).toMatch(/2\. When agent completes/);
    expect(text).toMatch(/3\. Then re-call/);
  });

  it('includes relay_token in the relay step when supplied', () => {
    const text = assembleUtilityPrompt({ ...baseArgs, relayToken: 'tok-xyz' })[0].text;
    expect(text).toContain('relay_token: "tok-xyz"');
    expect(text).toContain('task_id: "abc12345"');
  });

  it('omits relay_token from the relay step when not supplied', () => {
    const text = assembleUtilityPrompt(baseArgs)[0].text;
    expect(text).not.toContain('relay_token');
    expect(text).toContain('task_id: "abc12345"');
  });

  it('echoes the caller-supplied re-entrant call verbatim', () => {
    const text = assembleUtilityPrompt(baseArgs)[0].text;
    expect(text).toContain(baseArgs.reentrantCall);
  });
});

describe('MAX_ASSEMBLED_PROMPT_CHARS', () => {
  it('is exported as a positive number around 30K chars', () => {
    expect(typeof MAX_ASSEMBLED_PROMPT_CHARS).toBe('number');
    expect(MAX_ASSEMBLED_PROMPT_CHARS).toBeGreaterThan(10_000);
    expect(MAX_ASSEMBLED_PROMPT_CHARS).toBeLessThan(100_000);
  });
});

describe('assemblePrompt suffix cap (F14 — priority-ordered drop)', () => {
  const BIG = (label: string) => `${label}:` + 'x'.repeat(25_000);

  it('preserves TASK and SCHEMA even when lower-priority blocks are dropped', () => {
    const result = assemblePrompt({
      task: 'do the thing',
      memory: BIG('huge memory'),
      context: BIG('huge context'),
      sessionContext: BIG('huge session'),
    });
    expect(result).toContain('Task: do the thing');
    expect(result).toContain('--- FINDING TAG SCHEMA ---');
    expect(result.length).toBeLessThanOrEqual(MAX_ASSEMBLED_PROMPT_CHARS + 100);
  });

  it('drops lowest-priority suffix first when suffix exceeds its reserve', () => {
    // context is priority 6 (lowest), memory is priority 3.
    const result = assemblePrompt({
      task: 'do the thing',
      memory: 'small memory block',
      context: BIG('oversized context'),
    });
    // Small memory must survive; oversized freeform context must be dropped.
    expect(result).toContain('small memory block');
    expect(result).not.toContain('oversized context');
  });

  it('drops AGENT MEMORY before MEMORY when only one drop is needed (priority 4 > priority 3)', () => {
    // Size MEMORY just over the reserve budget so AGENT_MEMORY's removal
    // alone brings total back under reserve. Schema ~600 + OUTPUT_DELIVERY ~400
    // + AGENT_MEMORY ~500 + task tiny → memory body of ~16700 pushes total
    // just over 18K reserve.
    const memoryBlock = 'actual memory: ' + 'y'.repeat(16_700);
    const result = assemblePrompt({
      task: 'x',
      memory: memoryBlock,
      memoryDir: '/tmp/agent-dir',
    });
    expect(result).toContain('actual memory:');
    expect(result).not.toContain('--- AGENT MEMORY ---');
  });

  it('drops multiple suffix blocks in priority order when one drop is insufficient', () => {
    // Oversized memory forces BOTH AGENT_MEMORY and MEMORY to drop.
    // MEMORY is still dropped AFTER lower-priority blocks try first.
    const result = assemblePrompt({
      task: 'x',
      memory: 'm'.repeat(25_000),
      memoryDir: '/tmp/agent-dir',
      context: 'small context',
      sessionContext: 'small session',
    });
    // task + schema always survive
    expect(result).toContain('Task: x');
    expect(result).toContain('--- FINDING TAG SCHEMA ---');
    // Oversized MEMORY cannot be kept
    expect(result).not.toContain('m'.repeat(100));
    // AGENT_MEMORY (priority 4) was dropped before us getting here
    expect(result).not.toContain('--- AGENT MEMORY ---');
  });

  it('keeps everything when combined size fits the budget', () => {
    const result = assemblePrompt({
      task: 'x',
      memory: 'small',
      context: 'small',
      sessionContext: 'small',
      memoryDir: '/tmp/d',
      lens: 'focus',
    });
    expect(result).toContain('--- MEMORY ---');
    expect(result).toContain('--- AGENT MEMORY ---');
    expect(result).toContain('--- LENS ---');
    expect(result).toContain('Context:');
  });
});
