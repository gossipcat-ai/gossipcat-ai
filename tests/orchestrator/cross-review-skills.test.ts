// tests/orchestrator/cross-review-skills.test.ts
//
// Issue #666: cross-review skill injection is severity-conditional on the
// gossip_collect path. These tests pin the pure gate (findings[] → verdict) and
// the single shared resolver that both DispatchPipeline and the collect handler
// use to turn configured skills into prompt content.
import {
  crossReviewSkillGateSeverity,
  shouldInjectCrossReviewSkills,
  createAgentSkillsContentResolver,
} from '../../packages/orchestrator/src/cross-review-skills';
import { SkillIndex } from '../../packages/orchestrator/src/skill-index';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('crossReviewSkillGateSeverity', () => {
  it('opens on a critical finding', () => {
    expect(crossReviewSkillGateSeverity([{ severity: 'critical' }])).toBe('critical');
  });

  it('opens on a high finding', () => {
    expect(crossReviewSkillGateSeverity([{ severity: 'high' }])).toBe('high');
  });

  it('reports critical when both critical and high are present, regardless of order', () => {
    expect(crossReviewSkillGateSeverity([{ severity: 'high' }, { severity: 'critical' }])).toBe('critical');
    expect(crossReviewSkillGateSeverity([{ severity: 'critical' }, { severity: 'high' }])).toBe('critical');
  });

  it('opens when a single critical/high hides among lower severities', () => {
    expect(crossReviewSkillGateSeverity([
      { severity: 'low' },
      { severity: 'medium' },
      { severity: undefined },
      { severity: 'high' },
      { severity: 'low' },
    ])).toBe('high');
  });

  it('stays closed for medium, low, and absent severities', () => {
    expect(crossReviewSkillGateSeverity([{ severity: 'medium' }])).toBeNull();
    expect(crossReviewSkillGateSeverity([{ severity: 'low' }])).toBeNull();
    expect(crossReviewSkillGateSeverity([{ severity: undefined }])).toBeNull();
    expect(crossReviewSkillGateSeverity([{}])).toBeNull();
    expect(crossReviewSkillGateSeverity([{ severity: 'medium' }, { severity: 'low' }, {}])).toBeNull();
  });

  it('stays closed on an empty findings list', () => {
    expect(crossReviewSkillGateSeverity([])).toBeNull();
  });

  it('fails closed on malformed severities rather than coercing them', () => {
    // Only the canonical lowercase enum from parseAgentFindingsStrict counts.
    expect(crossReviewSkillGateSeverity([{ severity: 'HIGH' }])).toBeNull();
    expect(crossReviewSkillGateSeverity([{ severity: 'Critical' }])).toBeNull();
    expect(crossReviewSkillGateSeverity([{ severity: ' high' }])).toBeNull();
    expect(crossReviewSkillGateSeverity([{ severity: 'sev:critical' }])).toBeNull();
    expect(crossReviewSkillGateSeverity([{ severity: 1 }])).toBeNull();
    expect(crossReviewSkillGateSeverity([{ severity: true }])).toBeNull();
    expect(crossReviewSkillGateSeverity([{ severity: ['critical'] }])).toBeNull();
    expect(crossReviewSkillGateSeverity([{ severity: null }])).toBeNull();
  });

  it('fails closed on malformed containers instead of throwing', () => {
    expect(crossReviewSkillGateSeverity(null)).toBeNull();
    expect(crossReviewSkillGateSeverity(undefined)).toBeNull();
    expect(crossReviewSkillGateSeverity('critical' as unknown as never)).toBeNull();
    expect(crossReviewSkillGateSeverity([null, undefined, 'critical'] as unknown as never)).toBeNull();
  });

  it('skips malformed entries without losing a later valid trigger', () => {
    expect(crossReviewSkillGateSeverity(
      [null, 'critical', { severity: 'critical' }] as unknown as never,
    )).toBe('critical');
  });
});

describe('shouldInjectCrossReviewSkills', () => {
  it('is true exactly when the gate reports a triggering severity', () => {
    expect(shouldInjectCrossReviewSkills([{ severity: 'critical' }])).toBe(true);
    expect(shouldInjectCrossReviewSkills([{ severity: 'high' }])).toBe(true);
    expect(shouldInjectCrossReviewSkills([{ severity: 'medium' }])).toBe(false);
    expect(shouldInjectCrossReviewSkills([{ severity: 'low' }])).toBe(false);
    expect(shouldInjectCrossReviewSkills([])).toBe(false);
    expect(shouldInjectCrossReviewSkills(undefined)).toBe(false);
  });
});

describe('createAgentSkillsContentResolver', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'xr-skills-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const writeAgentSkill = (agentId: string, name: string, body: string): void => {
    const dir = join(tmp, '.gossip', 'agents', agentId, 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), body);
  };

  it('resolves the agent-local skill file for the configured skills', () => {
    writeAgentSkill('agent-a', 'local-lens', '# Local Lens\nAGENT_LOCAL_SKILL_BODY');
    const resolve = createAgentSkillsContentResolver({
      registryGet: () => ({ skills: ['local-lens'] }),
      projectRoot: tmp,
    });
    expect(resolve('agent-a', 'review the code')).toContain('AGENT_LOCAL_SKILL_BODY');
  });

  it('prefers the agent-local file over the project-wide one (resolution order)', () => {
    writeAgentSkill('agent-a', 'shared-lens', 'AGENT_LOCAL_WINS');
    const projectDir = join(tmp, '.gossip', 'skills');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'shared-lens.md'), 'PROJECT_WIDE_LOSES');

    const resolve = createAgentSkillsContentResolver({
      registryGet: () => ({ skills: ['shared-lens'] }),
      projectRoot: tmp,
    });
    const content = resolve('agent-a', 'review the code');
    expect(content).toContain('AGENT_LOCAL_WINS');
    expect(content).not.toContain('PROJECT_WIDE_LOSES');
  });

  it('falls back to bundled default skills when no local override exists', () => {
    const resolve = createAgentSkillsContentResolver({
      registryGet: () => ({ skills: ['typescript'] }),
      projectRoot: tmp,
    });
    expect(resolve('agent-a', 'review the code')).toContain('TypeScript');
  });

  it('returns undefined when the agent has no skills', () => {
    const resolve = createAgentSkillsContentResolver({
      registryGet: () => ({ skills: [] }),
      projectRoot: tmp,
    });
    expect(resolve('agent-a', 'review the code')).toBeUndefined();
  });

  it('returns undefined when the agent is not in the registry', () => {
    const resolve = createAgentSkillsContentResolver({
      registryGet: () => undefined,
      projectRoot: tmp,
    });
    expect(resolve('ghost-agent', 'review the code')).toBeUndefined();
  });

  it('swallows a registry throw instead of aborting the round', () => {
    const resolve = createAgentSkillsContentResolver({
      registryGet: () => { throw new Error('registry exploded'); },
      projectRoot: tmp,
    });
    expect(resolve('agent-a', 'review the code')).toBeUndefined();
  });

  it('reads the skill index lazily so an index installed after construction is honored', () => {
    writeAgentSkill('agent-a', 'late-lens', 'LATE_INDEX_SKILL');
    let index: SkillIndex | null = null;
    const resolve = createAgentSkillsContentResolver({
      registryGet: () => ({ skills: [] }),
      projectRoot: tmp,
      getSkillIndex: () => index,
    });
    // No index and no configured skills → nothing resolves.
    expect(resolve('agent-a', 'review the code')).toBeUndefined();

    index = new SkillIndex(tmp);
    index.bind('agent-a', 'late-lens', { mode: 'permanent' });
    expect(resolve('agent-a', 'review the code')).toContain('LATE_INDEX_SKILL');
  });
});
