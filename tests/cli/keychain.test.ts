import { Keychain } from '../../apps/cli/src/keychain';
import { existsSync, unlinkSync } from 'fs';
import { isAbsolute, join } from 'path';

const ENCRYPTED_FILE = join(process.cwd(), '.gossip/keys.enc');

// Use a test-only service name so tests NEVER touch the real macOS keychain entries.
// Without this, running tests overwrites the user's real Gemini/OpenAI API keys
// with test placeholders like 'gkey-abc' — causing "API key not valid" errors.
const TEST_SERVICE = 'gossip-mesh-test';

function cleanupEncryptedFile() {
  try { unlinkSync(ENCRYPTED_FILE); } catch { /* noop */ }
}

function cleanupTestKeychain() {
  if (process.platform === 'darwin') {
    try {
      require('child_process').execFileSync('security', [
        'delete-generic-password', '-s', TEST_SERVICE, '-a', 'test-provider'
      ], { stdio: 'pipe' });
    } catch { /* doesn't exist */ }
    try {
      require('child_process').execFileSync('security', [
        'delete-generic-password', '-s', TEST_SERVICE, '-a', 'google'
      ], { stdio: 'pipe' });
    } catch { /* doesn't exist */ }
    try {
      require('child_process').execFileSync('security', [
        'delete-generic-password', '-s', TEST_SERVICE, '-a', 'openai'
      ], { stdio: 'pipe' });
    } catch { /* doesn't exist */ }
    try {
      require('child_process').execFileSync('security', [
        'delete-generic-password', '-s', TEST_SERVICE, '-a', 'provider-x'
      ], { stdio: 'pipe' });
    } catch { /* doesn't exist */ }
  }
}

describe('Keychain', () => {
  afterEach(() => {
    cleanupEncryptedFile();
    cleanupTestKeychain();
  });

  it('stores and retrieves keys in memory', async () => {
    const keychain = new Keychain(TEST_SERVICE);
    await keychain.setKey('test-provider', 'test-key-123');
    const key = await keychain.getKey('test-provider');
    expect(key).toBe('test-key-123');
  });

  it('returns null for non-existent key', async () => {
    const keychain = new Keychain(TEST_SERVICE);
    expect(await keychain.getKey('nonexistent')).toBeNull();
  });

  it('persists keys to encrypted file and loads on new instance', async () => {
    cleanupEncryptedFile();
    const kc1 = new Keychain(TEST_SERVICE);
    await kc1.setKey('google', 'gkey-abc');
    await kc1.setKey('openai', 'okey-xyz');

    const hasKeychainBackend = process.platform === 'darwin' || process.platform === 'linux';

    if (hasKeychainBackend) {
      // Keys go to OS keychain (under test service name), encrypted file may not exist
      // Verify in-memory retrieval still works
      expect(await kc1.getKey('google')).toBe('gkey-abc');
      expect(await kc1.getKey('openai')).toBe('okey-xyz');
    } else {
      // No OS keychain — keys persisted to encrypted file
      expect(existsSync(ENCRYPTED_FILE)).toBe(true);
      const kc2 = new Keychain(TEST_SERVICE);
      expect(await kc2.getKey('google')).toBe('gkey-abc');
      expect(await kc2.getKey('openai')).toBe('okey-xyz');
    }
  });

  it('overwrites keys on repeated setKey', async () => {
    const keychain = new Keychain(TEST_SERVICE);
    await keychain.setKey('provider-x', 'old-key');
    await keychain.setKey('provider-x', 'new-key');
    expect(await keychain.getKey('provider-x')).toBe('new-key');
  });

  it('storeInfo reports the service and an ABSOLUTE encrypted-file path (issue #667)', () => {
    const info = new Keychain(TEST_SERVICE).storeInfo();
    expect(info.service).toBe(TEST_SERVICE);
    expect(info.path).toBe(ENCRYPTED_FILE);
    expect(isAbsolute(info.path)).toBe(true);
    expect(['keychain', 'file']).toContain(info.kind);
  });

  it('setKey reports the store the key actually landed in (issue #667)', async () => {
    const kc = new Keychain(TEST_SERVICE);
    const dest = await kc.setKey('test-provider', 'test-key-123');

    if (kc.storeInfo().kind === 'file') {
      expect(dest).toBe('file'); // no OS keychain — the file is the only store
    } else {
      expect(['keychain', 'file']).toContain(dest); // a keychain write may fall back
    }
    if (dest === 'file') expect(existsSync(ENCRYPTED_FILE)).toBe(true);
  });

  it('setKey returns "file" when an available keychain write fails and falls back (issue #667)', async () => {
    const hasKeychainBackend = process.platform === 'darwin' || process.platform === 'linux';
    if (!hasKeychainBackend) return; // no keychain to fall back FROM

    const cp = require('child_process');
    const spy = jest.spyOn(cp, 'execFileSync').mockImplementation((...callArgs: unknown[]) => {
      const argv = (callArgs[1] as string[]) ?? [];
      // Availability probe (`security help` / `which secret-tool`) succeeds…
      if (argv[0] === 'help' || argv[0] === 'secret-tool') return Buffer.from('');
      throw new Error('keychain write refused'); // …but every write is refused.
    });

    try {
      const kc = new Keychain(TEST_SERVICE);
      expect(kc.storeInfo().kind).toBe('keychain');
      expect(await kc.setKey('test-provider', 'test-key-123')).toBe('file');
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(ENCRYPTED_FILE)).toBe(true);
  });

  it('handles corrupted encrypted file gracefully', async () => {
    const { writeFileSync, mkdirSync } = require('fs');
    const dir = join(process.cwd(), '.gossip');
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    writeFileSync(ENCRYPTED_FILE, Buffer.from('garbage-data'));

    // Should not throw — starts with empty store
    const kc = new Keychain(TEST_SERVICE);
    expect(await kc.getKey('anything')).toBeNull();
  });
});
