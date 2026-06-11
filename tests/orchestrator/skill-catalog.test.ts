import { SkillCatalog } from '@gossip/orchestrator';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SkillCatalog', () => {
  const catalog = new SkillCatalog();

  it('loads catalog from default-skills directory', () => {
    const skills = catalog.listSkills();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.find(s => s.name === 'security-audit')).toBeDefined();
    expect(skills.find(s => s.name === 'code-review')).toBeDefined();
  });

  it('matches task text against skill keywords', () => {
    const matches = catalog.matchTask('review this WebSocket server for DoS vulnerabilities');
    const names = matches.map(m => m.name);
    expect(names).toContain('security-audit');
  });

  it('returns empty array for task with no keyword matches', () => {
    const matches = catalog.matchTask('hello world');
    expect(matches).toEqual([]);
  });

  it('checks skill coverage for an agent', () => {
    const agentSkills = ['code-review', 'debugging'];
    const warnings = catalog.checkCoverage(
      agentSkills,
      'review this code for security vulnerabilities and injection attacks'
    );
    expect(warnings.some(w => w.includes('security-audit'))).toBe(true);
  });

  it('returns no warnings when agent covers all matched skills', () => {
    const agentSkills = ['security-audit', 'code-review', 'implementation'];
    const warnings = catalog.checkCoverage(
      agentSkills,
      'review this code for security vulnerabilities'
    );
    expect(warnings).toEqual([]);
  });

  it('validates catalog against skill files', () => {
    const issues = catalog.validate();
    expect(issues).toEqual([]);
  });

  // Regression: coverage-gap detector single-source-of-truth
  // (project_coverage_gap_detector_config_vs_index, CONFIRMED 2026-06-11).
  // checkCoverage must receive the SAME effective skill set the prompt builder
  // injects — index-precedence, not the raw config.json list. A skill enabled
  // in the index but absent from the config list WAS injected, so it must NOT
  // produce a false "skill may be relevant but is not assigned" warning.
  it('no coverage warning for a skill enabled in the index but absent from the config list', () => {
    const { SkillIndex } = require('../../packages/orchestrator/src/skill-index');
    const { resolveEffectiveSkills } = require('../../packages/orchestrator/src/skill-loader');
    const dir = join(tmpdir(), `gossip-coverage-single-source-${Date.now()}`);
    mkdirSync(join(dir, '.gossip'), { recursive: true });
    try {
      const index = new SkillIndex(dir);
      // security-audit is bound in the INDEX but NOT in the config list below.
      index.bind('agent-x', 'security-audit', { source: 'auto', mode: 'contextual' });

      const configSkills = ['code-review']; // does NOT list security-audit
      const effective = resolveEffectiveSkills('agent-x', configSkills, index);
      // Index has slots → effective set is the index-enabled list.
      expect(effective).toContain('security-audit');

      // Feeding the EFFECTIVE set (the fix) yields no false warning.
      const warnEffective = catalog.checkCoverage(
        effective,
        'review this code for security vulnerabilities and injection attacks',
      );
      expect(warnEffective.some(w => w.includes('security-audit'))).toBe(false);

      // Feeding the raw CONFIG list (the bug) WOULD have produced the false
      // warning — pin that the difference is real, not vacuous.
      const warnConfig = catalog.checkCoverage(
        configSkills,
        'review this code for security vulnerabilities and injection attacks',
      );
      expect(warnConfig.some(w => w.includes('security-audit'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveEffectiveSkills falls back to the config list when the index has no slots', () => {
    const { SkillIndex } = require('../../packages/orchestrator/src/skill-index');
    const { resolveEffectiveSkills } = require('../../packages/orchestrator/src/skill-loader');
    const dir = join(tmpdir(), `gossip-coverage-fallback-${Date.now()}`);
    mkdirSync(join(dir, '.gossip'), { recursive: true });
    try {
      const index = new SkillIndex(dir); // no binds → no slots for agent-y
      expect(resolveEffectiveSkills('agent-y', ['code-review'], index)).toEqual(['code-review']);
      // No index at all → config list.
      expect(resolveEffectiveSkills('agent-y', ['debugging'], undefined)).toEqual(['debugging']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SkillCatalog with project skills', () => {
  const testDir = join(tmpdir(), `gossip-catalog-test-${Date.now()}`);
  const skillsDir = join(testDir, '.gossip', 'skills');

  beforeEach(() => {
    mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('loads project skills from .gossip/skills/*.md', () => {
    writeFileSync(join(skillsDir, 'dos-resilience.md'), `---
name: dos-resilience
description: Review for DoS vectors.
keywords: [dos, rate-limit, payload]
status: active
---
# DoS Resilience
`);
    const catalog = new SkillCatalog(testDir);
    const skills = catalog.listSkills();
    expect(skills.find(s => s.name === 'dos-resilience')).toBeDefined();
    expect(skills.find(s => s.name === 'dos-resilience')?.source).toBe('project');
  });

  it('project skills override defaults with same name', () => {
    writeFileSync(join(skillsDir, 'security-audit.md'), `---
name: security-audit
description: Custom project security audit.
keywords: [security, audit, custom]
status: active
---
# Custom Security
`);
    const catalog = new SkillCatalog(testDir);
    const entry = catalog.listSkills().find(s => s.name === 'security-audit');
    expect(entry?.description).toBe('Custom project security audit.');
    expect(entry?.source).toBe('project');
  });

  it('skips disabled project skills in matchTask', () => {
    writeFileSync(join(skillsDir, 'dos-resilience.md'), `---
name: dos-resilience
description: Review for DoS.
keywords: [dos, rate-limit]
status: disabled
---
# Disabled
`);
    const catalog = new SkillCatalog(testDir);
    const matches = catalog.matchTask('check for DoS vulnerabilities');
    expect(matches.find(m => m.name === 'dos-resilience')).toBeUndefined();
  });

  it('matchTask finds project skills by keywords', () => {
    writeFileSync(join(skillsDir, 'dos-resilience.md'), `---
name: dos-resilience
description: DoS review.
keywords: [dos, rate-limit, payload]
status: active
---
# DoS
`);
    const catalog = new SkillCatalog(testDir);
    const matches = catalog.matchTask('check rate-limit configuration');
    expect(matches.find(m => m.name === 'dos-resilience')).toBeDefined();
  });

  it('hot-reloads when new skill file added', () => {
    const catalog = new SkillCatalog(testDir);
    expect(catalog.listSkills().find(s => s.name === 'new-skill')).toBeUndefined();

    writeFileSync(join(skillsDir, 'new-skill.md'), `---
name: new-skill
description: A new skill.
keywords: [newskill]
status: active
---
# New
`);
    const matches = catalog.matchTask('newskill test');
    expect(matches.find(m => m.name === 'new-skill')).toBeDefined();
  });

  it('normalizes skill names from default catalog', () => {
    const catalog = new SkillCatalog(testDir);
    const entry = catalog.listSkills().find(s => s.name === 'security-audit');
    expect(entry).toBeDefined();
  });
});
