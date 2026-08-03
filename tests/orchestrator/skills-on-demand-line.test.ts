import { buildSkillsOnDemandLine } from '../../packages/orchestrator/src/skill-loader';
import type { DroppedSkill } from '../../packages/orchestrator/src/skill-loader';
import { assemblePrompt, SKILLS_BLOCK_CLOSE } from '../../packages/orchestrator/src/prompt-assembler';

const drop = (skill: string, reason: DroppedSkill['reason'], hits = 0): DroppedSkill =>
  ({ skill, reason, hits });

describe('buildSkillsOnDemandLine (issue #715 / #698 part 2)', () => {
  it('returns the exact single-line format for the native runtime', () => {
    const line = buildSkillsOnDemandLine(
      [drop('trust-boundaries', 'below-keyword-threshold', 0)],
      'native',
    );
    expect(line).toBe(
      'Skills available on demand (not loaded): trust-boundaries — fetch with mcp__gossipcat__gossip_skill_query(agent_id, skill)',
    );
    expect(line.split('\n')).toHaveLength(1);
  });

  it('returns the exact single-line format for the relay runtime', () => {
    const line = buildSkillsOnDemandLine([drop('concurrency', 'budget-exceeded', 3)], 'relay');
    expect(line).toBe(
      'Skills available on demand (not loaded): concurrency — fetch with skill_query(skill)',
    );
    expect(line.split('\n')).toHaveLength(1);
  });

  it('lists BOTH eligible reasons, comma-separated and name-sorted', () => {
    const line = buildSkillsOnDemandLine([
      drop('zebra-skill', 'budget-exceeded', 2),
      drop('alpha-skill', 'below-keyword-threshold', 0),
    ], 'relay');
    expect(line).toContain('alpha-skill, zebra-skill');
  });

  it('deduplicates a skill that appears twice in the drop list', () => {
    const line = buildSkillsOnDemandLine([
      drop('dup-skill', 'below-keyword-threshold', 0),
      drop('dup-skill', 'budget-exceeded', 1),
    ], 'relay');
    expect(line).toContain('(not loaded): dup-skill —');
  });

  it('NEVER advertises quarantined skills (status-failed / status-silent / status-drift-demoted)', () => {
    const line = buildSkillsOnDemandLine([
      drop('failed-skill', 'status-failed'),
      drop('silent-skill', 'status-silent'),
      drop('demoted-skill', 'status-drift-demoted'),
    ], 'relay');
    expect(line).toBe('');
  });

  it('NEVER advertises operator-suppressed or non-applicable skills', () => {
    const line = buildSkillsOnDemandLine([
      drop('killed-skill', 'kill-switch'),
      drop('excluded-skill', 'excluded'),
      drop('mismatched-skill', 'task-type-mismatch'),
      drop('scoped-skill', 'scope-type-mismatch'),
      drop('no-task-skill', 'no-task-provided'),
    ], 'relay');
    expect(line).toBe('');
  });

  it('filters a mixed list down to only the two eligible reasons', () => {
    const line = buildSkillsOnDemandLine([
      drop('eligible-one', 'below-keyword-threshold'),
      drop('quarantined', 'status-failed'),
      drop('eligible-two', 'budget-exceeded'),
      drop('mismatched', 'task-type-mismatch'),
    ], 'relay');
    expect(line).toContain('eligible-one, eligible-two');
    expect(line).not.toContain('quarantined');
    expect(line).not.toContain('mismatched');
  });

  it('returns empty string when nothing was dropped', () => {
    expect(buildSkillsOnDemandLine([], 'relay')).toBe('');
    expect(buildSkillsOnDemandLine([], 'native')).toBe('');
  });
});

describe('assemblePrompt skillsOnDemand placement', () => {
  const line = 'Skills available on demand (not loaded): foo — fetch with skill_query(skill)';

  it('emits the line immediately after the SKILLS block', () => {
    const prompt = assemblePrompt({ skills: 'SKILL BODY', skillsOnDemand: line, task: 'do a thing' });
    expect(prompt).toContain(`${SKILLS_BLOCK_CLOSE}\n\n${line}`);
  });

  it('omits the line entirely when it is empty', () => {
    const prompt = assemblePrompt({ skills: 'SKILL BODY', skillsOnDemand: '', task: 'do a thing' });
    expect(prompt).not.toContain('Skills available on demand');
    expect(prompt).toContain(SKILLS_BLOCK_CLOSE);
  });

  it('omits the line when the field is absent', () => {
    const prompt = assemblePrompt({ skills: 'SKILL BODY', task: 'do a thing' });
    expect(prompt).not.toContain('Skills available on demand');
  });
});
