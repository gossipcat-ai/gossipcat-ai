import { normalizeGitUrl, getTeamUserId, getGitEmail } from '../../apps/cli/src/identity';

describe('normalizeGitUrl', () => {
  it('normalizes SSH URLs', () => {
    expect(normalizeGitUrl('git@github.com:team/myapp.git')).toBe('github.com/team/myapp');
  });

  it('normalizes HTTPS URLs', () => {
    expect(normalizeGitUrl('https://github.com/team/myapp.git')).toBe('github.com/team/myapp');
  });

  it('normalizes SCP-style URLs', () => {
    expect(normalizeGitUrl('github.com:team/myapp.git')).toBe('github.com/team/myapp');
  });

  it('strips .git suffix', () => {
    expect(normalizeGitUrl('https://github.com/team/myapp.git')).toBe('github.com/team/myapp');
    expect(normalizeGitUrl('https://github.com/team/myapp')).toBe('github.com/team/myapp');
  });

  it('returns null for empty input', () => {
    expect(normalizeGitUrl('')).toBeNull();
  });

  it('handles non-standard URLs via fallback', () => {
    const result = normalizeGitUrl('ssh://git@gitlab.com/team/myapp.git');
    expect(result).toBe('gitlab.com/team/myapp');
  });
});

describe('getTeamUserId', () => {
  it('produces consistent hash from email + salt', () => {
    const id1 = getTeamUserId('alice@co.com', 'salt123');
    const id2 = getTeamUserId('alice@co.com', 'salt123');
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(16);
  });

  it('produces different hashes for different emails', () => {
    const id1 = getTeamUserId('alice@co.com', 'salt123');
    const id2 = getTeamUserId('bob@co.com', 'salt123');
    expect(id1).not.toBe(id2);
  });

  it('produces different hashes for different salts', () => {
    const id1 = getTeamUserId('alice@co.com', 'salt-a');
    const id2 = getTeamUserId('alice@co.com', 'salt-b');
    expect(id1).not.toBe(id2);
  });
});

describe('getGitEmail', () => {
  it('returns a string or null', () => {
    const email = getGitEmail();
    expect(typeof email === 'string' || email === null).toBe(true);
  });
});
