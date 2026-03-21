import { checkSkillCoverage } from '../../apps/cli/src/skill-catalog-check';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('checkSkillCoverage', () => {
  const testDir = join(tmpdir(), `gossip-catalog-check-test-${Date.now()}`);
  const catalogDir = join(testDir, 'packages', 'orchestrator', 'src', 'default-skills');
  const catalogPath = join(catalogDir, 'catalog.json');

  const catalog = {
    version: 1,
    skills: [
      {
        name: 'security_audit',
        description: 'OWASP Top 10, injection, auth, secrets',
        keywords: ['security', 'vulnerability', 'injection', 'auth'],
        categories: ['review', 'security'],
      },
      {
        name: 'code_review',
        description: 'Bug finding, edge cases, naming, structure',
        keywords: ['review', 'bugs', 'quality'],
        categories: ['review'],
      },
      {
        name: 'testing',
        description: 'Unit/integration/e2e, mocking, coverage',
        keywords: ['test', 'unit', 'integration', 'mock'],
        categories: ['testing'],
      },
    ],
  };

  beforeEach(() => {
    mkdirSync(catalogDir, { recursive: true });
    writeFileSync(catalogPath, JSON.stringify(catalog));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array when catalog not found', () => {
    const emptyDir = join(tmpdir(), `gossip-no-catalog-${Date.now()}`);
    const result = checkSkillCoverage('agent-1', [], 'security review please', emptyDir);
    expect(result).toEqual([]);
  });

  it('matches task text against skill keywords', () => {
    const result = checkSkillCoverage('agent-1', [], 'review this code for security vulnerabilities', testDir);
    // "security" matches security_audit, "review" matches code_review
    expect(result.length).toBeGreaterThanOrEqual(1);
    const skillNames = result.map(w => w);
    expect(skillNames.some(w => w.includes('security_audit'))).toBe(true);
  });

  it('returns warning when agent is missing a matched skill', () => {
    const result = checkSkillCoverage('my-agent', [], 'check for injection vulnerabilities', testDir);
    // "injection" matches security_audit, agent has no skills
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Agent 'my-agent' may need skill 'security_audit'");
    expect(result[0]).toContain('OWASP Top 10');
  });

  it('returns empty when agent has all matched skills', () => {
    const result = checkSkillCoverage(
      'my-agent',
      ['security_audit', 'code_review'],
      'review this code for security vulnerabilities',
      testDir
    );
    expect(result).toEqual([]);
  });

  it('returns warning only for missing skills when agent has some but not all', () => {
    // task has "review" (code_review) and "unit" (testing); agent has code_review but not testing
    const result = checkSkillCoverage(
      'my-agent',
      ['code_review'],
      'write unit tests to review this code',
      testDir
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('testing');
  });

  it('performs case-insensitive keyword matching', () => {
    // "SECURITY" uppercased should still match the "security" keyword
    const resultUpper = checkSkillCoverage('agent-1', [], 'SECURITY audit needed', testDir);
    const resultLower = checkSkillCoverage('agent-1', [], 'security audit needed', testDir);
    expect(resultUpper.length).toBe(resultLower.length);
    expect(resultUpper.some(w => w.includes('security_audit'))).toBe(true);
  });

  it('returns empty when task text has no matching keywords', () => {
    const result = checkSkillCoverage('agent-1', [], 'deploy to production server', testDir);
    expect(result).toEqual([]);
  });

  it('warning message includes agent id and skill description', () => {
    const result = checkSkillCoverage('gemini-reviewer', [], 'find bugs in this code', testDir);
    // "bugs" matches code_review
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Agent 'gemini-reviewer'");
    expect(result[0]).toContain("skill 'code_review'");
    expect(result[0]).toContain('Bug finding, edge cases');
  });
});
