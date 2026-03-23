import { normalizeGitUrl } from '../../apps/cli/src/identity';

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
