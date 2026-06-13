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

  it('all-special-character input returns "" (rejected as an invalid skill name)', () => {
    // No surviving [a-z0-9] chars → '' — SkillIndex.bind treats '' as an invalid
    // skill name and throws (skill-index.ts). Fail-closed rejection is the intended
    // behavior; these are not bindable skills.
    expect(normalizeSkillName('!!!')).toBe('');
    expect(normalizeSkillName('@#$%^&*')).toBe('');
    expect(normalizeSkillName('...')).toBe('');
  });

  it('caps length at 128 characters', () => {
    const long = 'a'.repeat(500);
    expect(normalizeSkillName(long).length).toBeLessThanOrEqual(128);
  });

  it('caps length at 128 characters on a 2000-char ASCII input', () => {
    const long = 'abc-'.repeat(500); // 2000 chars, valid ASCII
    const result = normalizeSkillName(long);
    expect(result.length).toBeLessThanOrEqual(128);
  });

  it('applies the 128 cap to the NORMALIZED form, not the raw input', () => {
    // 150 raw chars with interspersed strippable '!' → 100 surviving [a-z0-9].
    // The old slice(0,128)-first order would have capped the RAW input at 128
    // (→ ~85 surviving); the cap now bounds the normalized output, so all 100
    // survive. Documents the intended behavior change (finding efad8514:f1).
    const mixed = 'ab!'.repeat(50); // 150 chars; 'ab' survives, '!' stripped
    const result = normalizeSkillName(mixed);
    expect(result).toBe('ab'.repeat(50)); // 100 chars, ≤ 128, none truncated
    expect(result.length).toBeLessThanOrEqual(128);
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

  // --- ASCII regression tests (byte-identical to original behavior) ---

  it('trust_boundaries → trust-boundaries', () => {
    expect(normalizeSkillName('trust_boundaries')).toBe('trust-boundaries');
  });

  it('My  Skill → my-skill (double space collapses)', () => {
    expect(normalizeSkillName('My  Skill')).toBe('my-skill');
  });

  it('--foo-- → foo', () => {
    expect(normalizeSkillName('--foo--')).toBe('foo');
  });

  it('a.b.c → abc (dots stripped, no hyphens)', () => {
    expect(normalizeSkillName('a.b.c')).toBe('abc');
  });

  // --- Non-ASCII / empty-collapse tests ---

  it('fully non-ASCII input returns "" (fail-closed: rejected at the bind gate)', () => {
    // A name with no surviving [a-z0-9] chars normalizes to '' — SkillIndex.bind
    // uses `if (!name) throw 'Invalid skill name'`, so '' is the correct signal
    // to REJECT a garbage skill name (see skill-index.ts). Distinct non-ASCII
    // names sharing this '' is acceptable: none of them is a bindable skill.
    expect(normalizeSkillName('日本語')).toBe('');
    expect(normalizeSkillName('!!!')).toBe('');
    expect(normalizeSkillName('こんにちは')).toBe('');
  });

  it('accented latin input (résumé) keeps surviving ASCII letters and is stable', () => {
    const first = normalizeSkillName('résumé');
    const second = normalizeSkillName('résumé');
    // The accented chars (é) are non-ASCII and stripped; the ASCII letters
    // r,s,u,m survive — so this does NOT hit the hash fallback. Assert the
    // exact surviving form so a regression that strips all Latin is caught
    // (finding efad8514:f2). Transliteration is NOT required.
    expect(first).toBe('rsum');
    expect(first).toBe(second);
  });

  it('stability: same non-ASCII input → same output across calls', () => {
    const input = '中文-skill';
    expect(normalizeSkillName(input)).toBe(normalizeSkillName(input));
  });
});
