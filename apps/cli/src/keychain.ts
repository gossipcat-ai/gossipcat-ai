import { execFileSync } from 'child_process';
import { platform, hostname, userInfo } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const SERVICE_NAME = 'gossip-mesh';
const VALID_PROVIDERS = /^[a-zA-Z0-9_-]{1,32}$/;
const ENCRYPTED_FILE = '.gossip/keys.enc';
const ALGO = 'aes-256-gcm';

export class Keychain {
  private inMemoryStore: Map<string, string> = new Map();
  private keychainAvailable: boolean;
  private encryptionKey: Buffer;

  constructor() {
    this.keychainAvailable = this.isKeychainAvailable();
    this.encryptionKey = this.deriveEncryptionKey();

    if (!this.keychainAvailable) {
      this.loadEncryptedFile();
    }
  }

  async getKey(provider: string): Promise<string | null> {
    if (this.keychainAvailable) {
      try {
        return this.readFromKeychain(provider);
      } catch {
        return this.inMemoryStore.get(provider) || null;
      }
    }
    return this.inMemoryStore.get(provider) || null;
  }

  async setKey(provider: string, key: string): Promise<void> {
    this.inMemoryStore.set(provider, key);
    if (this.keychainAvailable) {
      try {
        this.writeToKeychain(provider, key);
      } catch {
        // Keychain write failed — fall through to encrypted file
        this.saveEncryptedFile();
      }
    } else {
      this.saveEncryptedFile();
    }
  }

  private deriveEncryptionKey(): Buffer {
    const seed = `${SERVICE_NAME}:${hostname()}:${userInfo().username}`;
    return createHash('sha256').update(seed).digest();
  }

  private loadEncryptedFile(): void {
    const filePath = join(process.cwd(), ENCRYPTED_FILE);
    if (!existsSync(filePath)) return;

    try {
      const raw = readFileSync(filePath);
      if (raw.length < 29) return; // iv(12) + tag(16) + min 1 byte

      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ciphertext = raw.subarray(28);

      const decipher = createDecipheriv(ALGO, this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const entries: Record<string, string> = JSON.parse(decrypted.toString('utf8'));

      for (const [k, v] of Object.entries(entries)) {
        this.inMemoryStore.set(k, v);
      }
    } catch {
      // Corrupted or wrong machine — start fresh
    }
  }

  private saveEncryptedFile(): void {
    const filePath = join(process.cwd(), ENCRYPTED_FILE);
    const dir = join(process.cwd(), '.gossip');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data = JSON.stringify(Object.fromEntries(this.inMemoryStore));
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Format: iv(12) + tag(16) + ciphertext
    writeFileSync(filePath, Buffer.concat([iv, tag, encrypted]), { mode: 0o600 });
  }

  private isKeychainAvailable(): boolean {
    if (platform() === 'darwin') {
      try {
        execFileSync('security', ['help'], { stdio: 'pipe' });
        return true;
      } catch { return false; }
    }
    if (platform() === 'linux') {
      try {
        execFileSync('which', ['secret-tool'], { stdio: 'pipe' });
        return true;
      } catch { return false; }
    }
    return false;
  }

  private validateProvider(provider: string): void {
    if (!VALID_PROVIDERS.test(provider)) {
      throw new Error(`Invalid provider name: "${provider}"`);
    }
  }

  private readFromKeychain(provider: string): string {
    this.validateProvider(provider);
    if (platform() === 'darwin') {
      return execFileSync('security', [
        'find-generic-password', '-s', SERVICE_NAME, '-a', provider, '-w'
      ], { stdio: 'pipe' }).toString().trim();
    }
    if (platform() === 'linux') {
      return execFileSync('secret-tool', [
        'lookup', 'service', SERVICE_NAME, 'provider', provider
      ], { stdio: 'pipe' }).toString().trim();
    }
    throw new Error('Unsupported platform');
  }

  private writeToKeychain(provider: string, key: string): void {
    this.validateProvider(provider);
    if (platform() === 'darwin') {
      try {
        execFileSync('security', [
          'delete-generic-password', '-s', SERVICE_NAME, '-a', provider
        ], { stdio: 'pipe' });
      } catch { /* doesn't exist yet */ }
      execFileSync('security', [
        'add-generic-password', '-s', SERVICE_NAME, '-a', provider, '-w', key
      ], { stdio: 'pipe' });
      return;
    }
    if (platform() === 'linux') {
      execFileSync('secret-tool', [
        'store', '--label', `Gossip Mesh ${provider}`, 'service', SERVICE_NAME, 'provider', provider
      ], { input: key, stdio: ['pipe', 'pipe', 'pipe'] });
      return;
    }
  }
}
