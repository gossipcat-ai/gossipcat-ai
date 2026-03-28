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

  it('returns empty for all-special-character input', () => {
    expect(normalizeSkillName('!!!')).toBe('');
    expect(normalizeSkillName('@#$%^&*')).toBe('');
    expect(normalizeSkillName('...')).toBe('');
  });

  it('caps length at 128 characters', () => {
    const long = 'a'.repeat(500);
    expect(normalizeSkillName(long).length).toBeLessThanOrEqual(128);
  });

  it('strips leading and trailing hyphens', () => {
    expect(normalizeSkillName('_foo_')).toBe('foo');
    expect(normalizeSkillName('  bar  ')).toBe('bar');
    expect(normalizeSkillName('-security-')).toBe('security');
  });

  it('handles null/undefined gracefully', () => {
    expect(normalizeSkillName(null as any)).toBe('');
    expect(normalizeSkillName(undefined as any)).toBe('');
    expect(normalizeSkillName(42 as any)).toBe('');
  });

  it('collapses double hyphens', () => {
    expect(normalizeSkillName('foo--bar')).toBe('foo-bar');
    expect(normalizeSkillName('a---b----c')).toBe('a-b-c');
  });

  it('handles path traversal attempts', () => {
    expect(normalizeSkillName('../../etc/passwd')).toBe('etcpasswd');
    expect(normalizeSkillName('../.env')).toBe('env');
  });
});
