import { normalizeSkillName } from '@gossip/orchestrator';

describe('normalizeSkillName', () => {
  it('converts underscores to hyphens', () => {
    expect(normalizeSkillName('security_audit')).toBe('security-audit');
  });

  it('converts to lowercase', () => {
    expect(normalizeSkillName('DoS_Resilience')).toBe('dos-resilience');
  });

  it('strips non-alphanumeric characters', () => {
    expect(normalizeSkillName('web.socket security!')).toBe('websocket-security');
  });

  it('converts spaces to hyphens', () => {
    expect(normalizeSkillName('rate limit check')).toBe('rate-limit-check');
  });

  it('is idempotent', () => {
    expect(normalizeSkillName('already-kebab')).toBe('already-kebab');
  });

  it('handles empty string', () => {
    expect(normalizeSkillName('')).toBe('');
  });

  it('collapses multiple separators', () => {
    expect(normalizeSkillName('too__many___underscores')).toBe('too-many-underscores');
  });
});
