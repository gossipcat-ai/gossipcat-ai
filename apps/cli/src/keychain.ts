import { execFileSync } from 'child_process';
import { platform } from 'os';

const SERVICE_NAME = 'gossip-mesh';
const VALID_PROVIDERS = /^[a-zA-Z0-9_-]{1,32}$/;

export class Keychain {
  private inMemoryStore: Map<string, string> = new Map();
  private useKeychain: boolean;

  constructor() {
    this.useKeychain = this.isKeychainAvailable();
    if (!this.useKeychain) {
      console.warn('[Keychain] OS keychain not available. Keys stored in memory only (not persisted).');
    }
  }

  async getKey(provider: string): Promise<string | null> {
    if (this.useKeychain) {
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
    if (this.useKeychain) {
      try {
        this.writeToKeychain(provider, key);
      } catch {
        console.warn(`[Keychain] Failed to write to OS keychain. Key for ${provider} stored in memory only.`);
      }
    }
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
