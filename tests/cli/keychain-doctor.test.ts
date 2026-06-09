import { detectStaleKeychainEntries } from '../../apps/cli/src/keychain-doctor';

function fakeGetKey(store: Map<string, string>) {
  return async (service: string): Promise<string | null> => store.get(service) ?? null;
}

describe('detectStaleKeychainEntries', () => {
  it('flags a known test placeholder with a placeholder reason', async () => {
    const store = new Map([['openai', 'okey-xyz']]);
    const warnings = await detectStaleKeychainEntries(fakeGetKey(store), ['openai']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].service).toBe('openai');
    expect(warnings[0].reason).toMatch(/placeholder/i);
  });

  it('does NOT flag a plausible real key', async () => {
    const realKey = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2';
    const store = new Map([['anthropic', realKey]]);
    const warnings = await detectStaleKeychainEntries(fakeGetKey(store), ['anthropic']);
    expect(warnings).toHaveLength(0);
  });

  it('flags an implausibly short key with a short reason', async () => {
    const store = new Map([['google', 'shortkey']]); // 8 chars
    const warnings = await detectStaleKeychainEntries(fakeGetKey(store), ['google']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toMatch(/short/i);
    expect(warnings[0].reason).toContain('8');
  });

  it('skips null/empty values (missing keys handled elsewhere)', async () => {
    const store = new Map([['deepseek', '']]);
    const warnings = await detectStaleKeychainEntries(fakeGetKey(store), [
      'deepseek',
      'openclaw', // not in store → getKey returns null
    ]);
    expect(warnings).toHaveLength(0);
  });

  it('never leaks the full secret in redactedValue', async () => {
    // A long value that IS flagged (test- prefix) so we can assert redaction
    // happens on a real warning, not on a skipped/clean key.
    const longSecret = 'test-this-is-a-very-long-secret-value-1234567890abcdef';
    const store = new Map([['openai', longSecret]]);
    const warnings = await detectStaleKeychainEntries(fakeGetKey(store), ['openai']);
    expect(warnings).toHaveLength(1);
    // The full raw secret must NOT appear in the redacted value.
    expect(warnings[0].redactedValue).not.toBe(longSecret);
    expect(warnings[0].redactedValue.includes(longSecret)).toBe(false);
    // Truncated to first 4 chars + ellipsis.
    expect(warnings[0].redactedValue).toBe('test…');
    expect(warnings[0].redactedValue.length).toBeLessThan(longSecret.length);
  });

  it('flags values starting with the test- prefix', async () => {
    const store = new Map([['custom-ref', 'test-something-here-longer']]);
    const warnings = await detectStaleKeychainEntries(fakeGetKey(store), ['custom-ref']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toMatch(/placeholder/i);
  });

  it('redacts a flagged 1-4 char value to <short> without exposing it', async () => {
    const store = new Map([['google', 'abc']]); // 3 chars → short reason + <short> redaction
    const warnings = await detectStaleKeychainEntries(fakeGetKey(store), ['google']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toMatch(/short/i);
    // length <= 4 takes the <short> marker, never slice — no chars of the value leak.
    expect(warnings[0].redactedValue).toBe('<short>');
    expect(warnings[0].redactedValue.includes('abc')).toBe(false);
  });
});
