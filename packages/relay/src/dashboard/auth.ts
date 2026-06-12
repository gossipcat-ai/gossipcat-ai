import { randomBytes, timingSafeEqual, createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const KEY_LENGTH = 16; // 16 bytes = 32 hex chars
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SESSIONS = 50;

/** Basename of the persisted auth file under `.gossip/`. */
export const AUTH_FILE_NAME = 'dashboard-auth.json';

interface Session {
  token: string;
  expiresAt: number;
}

/**
 * On-disk shape of `.gossip/dashboard-auth.json`. The key + every session is an
 * opaque random token; nothing here is derived from user input. `version` lets
 * future format changes prune-and-regenerate instead of crashing on a stale
 * shape.
 */
interface PersistedAuth {
  version: 1;
  key: string;
  sessions: Session[];
}

export class DashboardAuth {
  private key: string = '';
  private sessions: Map<string, Session> = new Map();
  /**
   * Absolute path to `.gossip/dashboard-auth.json`, or null when running in
   * memory-only mode (no `projectRoot` passed to init()). Existing callers and
   * tests that call `init()` with no argument keep the original ephemeral
   * behavior — a fresh key per process, no disk writes.
   */
  private persistPath: string | null = null;

  /**
   * @param projectRoot Directory that contains `.gossip/`. When provided, the
   * key and active sessions survive relay restarts (load + prune on init,
   * persist on every session mutation). Omit for in-memory-only mode.
   */
  init(projectRoot?: string): void {
    this.persistPath = projectRoot ? join(projectRoot, '.gossip', AUTH_FILE_NAME) : null;

    if (this.persistPath && this.loadPersisted(this.persistPath)) {
      // Loaded an existing key + pruned sessions. Re-persist so the file
      // reflects the pruned set immediately (a long-dead relay may have left
      // many expired sessions on disk).
      this.persist();
      return;
    }

    // No persisted state (or memory-only mode, or a corrupt/stale file) — mint
    // a fresh key and an empty session set.
    this.key = randomBytes(KEY_LENGTH).toString('hex');
    this.sessions.clear();
    this.persist();
  }

  regenerateKey(): void {
    this.key = randomBytes(KEY_LENGTH).toString('hex');
    this.sessions.clear();
    this.persist();
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

    this.pruneExpired();
    // Cap active sessions
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { token, expiresAt: Date.now() + SESSION_TTL_MS });
    this.persist();
    return token;
  }

  validateSession(token: string): boolean {
    if (!token || typeof token !== 'string') return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      this.persist();
      return false;
    }
    return true;
  }

  /** Drop every expired session from the in-memory map. */
  private pruneExpired(): void {
    const now = Date.now();
    for (const [t, s] of this.sessions) {
      if (now > s.expiresAt) this.sessions.delete(t);
    }
  }

  /**
   * Load key + sessions from disk, pruning expired sessions. Returns true when
   * a usable key was loaded, false on any failure (missing file, parse error,
   * stale shape) so the caller falls back to minting a fresh key.
   *
   * Trust boundary: the file lives under `.gossip/` and is written 0600 by this
   * class, but it is still persisted state that could be tampered with or
   * left half-written by a crash. Validate the shape before trusting it and
   * fail closed (regenerate) on anything unexpected — never throw.
   */
  private loadPersisted(path: string): boolean {
    try {
      if (!existsSync(path)) return false;
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isPersistedAuth(parsed)) return false;

      this.key = parsed.key;
      this.sessions.clear();
      const now = Date.now();
      for (const s of parsed.sessions) {
        if (s.expiresAt > now) this.sessions.set(s.token, { token: s.token, expiresAt: s.expiresAt });
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Atomically persist key + active sessions to `.gossip/dashboard-auth.json`
   * (temp file + rename, matching signal-aggregate-index.ts). No-op in
   * memory-only mode. Writes are best-effort: a disk failure must not take down
   * auth, so errors are swallowed (the in-memory state stays authoritative for
   * this process).
   */
  private persist(): void {
    if (!this.persistPath) return;
    const data: PersistedAuth = {
      version: 1,
      key: this.key,
      sessions: [...this.sessions.values()],
    };
    const tmp = `${this.persistPath}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      // 0600: the key + session tokens are bearer credentials. Matches
      // keychain.ts:99's mode for the encrypted credential store.
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, this.persistPath);
    } catch {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

/** Fail-closed shape guard for the persisted auth file (untrusted disk state). */
function isPersistedAuth(v: unknown): v is PersistedAuth {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (typeof o.key !== 'string' || !/^[0-9a-f]{32}$/.test(o.key)) return false;
  if (!Array.isArray(o.sessions)) return false;
  // Reject files that list more sessions than createSession ever allows — a
  // file with an inflated session count could be tampered or corrupt.
  if (o.sessions.length > MAX_SESSIONS) return false;
  return o.sessions.every(
    (s) =>
      typeof s === 'object' && s !== null &&
      typeof (s as Session).token === 'string' &&
      // Session tokens are randomBytes(32).toString('hex') — exactly 64 hex chars.
      /^[0-9a-f]{64}$/.test((s as Session).token) &&
      typeof (s as Session).expiresAt === 'number' &&
      // expiresAt must be a finite number (not NaN / Infinity from JSON tricks).
      Number.isFinite((s as Session).expiresAt),
  );
}
