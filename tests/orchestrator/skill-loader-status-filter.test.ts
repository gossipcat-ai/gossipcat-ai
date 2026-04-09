/**
 * Tests for skill effectiveness status filtering in loadSkills().
 *
 * checkEffectiveness() writes a `status` field to skill frontmatter
 * ('passed', 'failed', 'pending', 'silent_skill', etc.). The loader must
 * filter out 'failed' and 'silent_skill' at dispatch time so the RL loop
 * reward actually re-enters the forward pass.
 *
 * This is "Step 4 of the RL loop": signal → counter → verdict → policy update
 * on next dispatch. Without this filter, failed skills keep polluting prompts
 * regardless of their effectiveness verdict.
 */
import { loadSkills } from '../../packages/orchestrator/src/skill-loader';
import { SkillIndex } from '../../packages/orchestrator/src/skill-index';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeSkillFile(status: string, content = 'Secret skill body.'): string {
  return `---
name: test-skill
description: A test skill
keywords: [auth, injection, security]
category: trust_boundaries
mode: permanent
status: ${status}
---

${content}
`;
}

describe('loadSkills — effectiveness status filtering', () => {
  let tmpDir: string;
  let index: SkillIndex;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gossip-status-filter-${Date.now()}`);
    mkdirSync(join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true });
    index = new SkillIndex(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgentSkill(name: string, status: string, body?: string): void {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills');
    writeFileSync(join(skillsDir, `${name}.md`), makeSkillFile(status, body));
    index.bind('test-agent', name, { source: 'auto', mode: 'permanent' });
  }

  it('injects skill with status: passed', () => {
    writeAgentSkill('passed', 'passed', 'Passed skill body.');
    const result = loadSkills('test-agent', [], tmpDir, index);
    expect(result.content).toContain('Passed skill body.');
    expect(result.loaded).toContain('passed');
  });

  it('injects skill with status: pending (default — not yet evaluated)', () => {
    writeAgentSkill('pending', 'pending', 'Pending skill body.');
    const result = loadSkills('test-agent', [], tmpDir, index);
    expect(result.content).toContain('Pending skill body.');
    expect(result.loaded).toContain('pending');
  });

  it('injects skill with status: insufficient_evidence', () => {
    writeAgentSkill('insufficient-evidence', 'insufficient_evidence', 'Insufficient skill body.');
    const result = loadSkills('test-agent', [], tmpDir, index);
    expect(result.content).toContain('Insufficient skill body.');
    expect(result.loaded).toContain('insufficient-evidence');
  });

  it('injects skill with status: flagged_for_manual_review', () => {
    writeAgentSkill('flagged', 'flagged_for_manual_review', 'Flagged skill body.');
    const result = loadSkills('test-agent', [], tmpDir, index);
    expect(result.content).toContain('Flagged skill body.');
    expect(result.loaded).toContain('flagged');
  });

  it('FILTERS OUT skill with status: failed', () => {
    writeAgentSkill('failed', 'failed', 'Failed skill body.');
    const result = loadSkills('test-agent', [], tmpDir, index);
    expect(result.content).not.toContain('Failed skill body.');
    expect(result.loaded).not.toContain('failed');
    expect(result.dropped).toContain('failed');
  });

  it('FILTERS OUT skill with status: silent_skill', () => {
    writeAgentSkill('silent', 'silent_skill', 'Silent skill body.');
    const result = loadSkills('test-agent', [], tmpDir, index);
    expect(result.content).not.toContain('Silent skill body.');
    expect(result.loaded).not.toContain('silent');
    expect(result.dropped).toContain('silent');
  });

  it('injects passed + pending, drops failed + silent in same dispatch', () => {
    writeAgentSkill('good-passed', 'passed', 'GOOD_PASSED_CONTENT');
    writeAgentSkill('good-pending', 'pending', 'GOOD_PENDING_CONTENT');
    writeAgentSkill('bad-failed', 'failed', 'BAD_FAILED_CONTENT');
    writeAgentSkill('bad-silent', 'silent_skill', 'BAD_SILENT_CONTENT');

    const result = loadSkills('test-agent', [], tmpDir, index);

    expect(result.content).toContain('GOOD_PASSED_CONTENT');
    expect(result.content).toContain('GOOD_PENDING_CONTENT');
    expect(result.content).not.toContain('BAD_FAILED_CONTENT');
    expect(result.content).not.toContain('BAD_SILENT_CONTENT');

    expect(result.loaded).toContain('good-passed');
    expect(result.loaded).toContain('good-pending');
    expect(result.loaded).not.toContain('bad-failed');
    expect(result.loaded).not.toContain('bad-silent');

    expect(result.dropped).toContain('bad-failed');
    expect(result.dropped).toContain('bad-silent');
  });

  it('includes insufficient_evidence and flagged_for_manual_review in dispatch', () => {
    writeAgentSkill('insuf', 'insufficient_evidence', 'INSUF_CONTENT');
    writeAgentSkill('flagged2', 'flagged_for_manual_review', 'FLAGGED_CONTENT');

    const result = loadSkills('test-agent', [], tmpDir, index);

    expect(result.content).toContain('INSUF_CONTENT');
    expect(result.content).toContain('FLAGGED_CONTENT');
    expect(result.loaded).toContain('insuf');
    expect(result.loaded).toContain('flagged2');
  });

  it('falls back to inject when status is unknown/missing (backwards compat)', () => {
    // A skill file with no status field should still be parsed and injected
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills');
    writeFileSync(join(skillsDir, 'no-status.md'), `---
name: no-status
description: A skill without status
keywords: [auth]
mode: permanent
---

NO_STATUS_CONTENT
`);
    index.bind('test-agent', 'no-status', { source: 'auto', mode: 'permanent' });
    const result = loadSkills('test-agent', [], tmpDir, index);
    // parseSkillFrontmatter returns null when required fields (status) are missing.
    // Null frontmatter → no status → inject (backwards compat).
    expect(result.content).toContain('NO_STATUS_CONTENT');
  });
});
