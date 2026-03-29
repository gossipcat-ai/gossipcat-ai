import { randomBytes, timingSafeEqual, createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

const KEY_LENGTH = 16; // 16 bytes = 32 hex chars
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface Session {
  token: string;
  expiresAt: number;
}

export class DashboardAuth {
  private keyPath: string;
  private key: string = '';
  private sessions: Map<string, Session> = new Map();

  constructor(projectRoot: string) {
    this.keyPath = join(projectRoot, '.gossip', 'dashboard-key');
  }

  init(): void {
    if (existsSync(this.keyPath)) {
      this.key = readFileSync(this.keyPath, 'utf-8').trim();
      if (this.key.length === KEY_LENGTH * 2) return;
    }
    this.regenerateKey();
  }

  regenerateKey(): void {
    this.key = randomBytes(KEY_LENGTH).toString('hex');
    const dir = dirname(this.keyPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.keyPath, this.key + '\n', { mode: 0o600 });
    this.sessions.clear(); // invalidate all sessions
  }

  getKey(): string {
    return this.key;
  }

  /** Returns first 8 chars for display in CLI boot message */
  getKeyPrefix(): string {
    return this.key.slice(0, 8);
  }

  createSession(candidateKey: string): string | null {
    if (!candidateKey || typeof candidateKey !== 'string') return null;
    // Hash both to fixed length — avoids timing oracle from length comparison
    const a = createHash('sha256').update(candidateKey).digest();
    const b = createHash('sha256').update(this.key).digest();
    if (!timingSafeEqual(a, b)) return null;

    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { token, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  }

  validateSession(token: string): boolean {
    if (!token || typeof token !== 'string') return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }
}
