/**
 * claude-inbox.ts — durable, file-backed inbox for dashboard → Claude Code
 * bridge messages.
 *
 * Why: the in-process bridge sink emits `notifications/claude/channel`, which
 * Claude Code silently DROPS unless the session was launched with `--channels`
 * (or the development-channels flag). Without a durable record a dashboard
 * message to a plain `claude --resume` session vanishes. Every Claude-addressed
 * bridge message is therefore persisted here FIRST; the channel notification is
 * a best-effort fast path on top.
 *
 * Layout (`<root>/.gossip/bridge/inbox/`, dir 0700, files 0600):
 *   <id>.json        immutable message record {id, chat_id, content, received_at}
 *   <id>.delivered   marker: shown to Claude (inbox wait / hook / confirmed channel)
 *   <id>.answered    marker: the MCP `reply` tool answered this chat_id
 *
 * Concurrency: the relay (writer of messages + `answered`) and the CLI
 * (`gossipcat inbox wait`, writer of `delivered`) are different processes. The
 * record is written once (tmp file + rename = atomic) and never rewritten;
 * status transitions are separate marker files created with O_EXCL ('wx'). No
 * read-modify-write exists, so concurrent writers cannot lose or regress a
 * transition. Status = answered > delivered > queued (highest marker wins).
 *
 * Bounds: MAX_ENTRIES records, MAX_CONTENT_CHARS per record, RETENTION_MS age.
 * Pruning runs on every append. Readers tolerate files vanishing mid-scan.
 */

import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

export type InboxStatus = 'queued' | 'delivered' | 'answered';

export interface InboxEntry {
  id: string;
  chat_id: string;
  content: string;
  received_at: string;
  status: InboxStatus;
  /** Who marked it delivered ('channel' | 'wait' | 'hook' | 'ack'), when known. */
  delivered_via?: string;
}

interface StoredRecord {
  id: string;
  chat_id: string;
  content: string;
  received_at: string;
}

export const INBOX_MAX_ENTRIES = 200;
export const INBOX_MAX_CONTENT_CHARS = 32 * 1024;
export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** `<13-digit ms>-<12 hex>` — sortable by name = chronological. Also the path guard. */
export const INBOX_ID_RE = /^\d{13}-[0-9a-f]{12}$/;
const CHAT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MARKERS = ['delivered', 'answered'] as const;
type Marker = (typeof MARKERS)[number];

/** Canonical inbox dir for a project root. */
export function inboxDirFor(projectRoot: string): string {
  return join(projectRoot, '.gossip', 'bridge', 'inbox');
}

/** Write `data` to `path` atomically with mode 0600 (unique tmp + rename). */
export function atomicWrite0600(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

export class ClaudeInbox {
  /** id → immutable record cache (records never change once written). */
  private cache = new Map<string, StoredRecord>();
  /** id → delivered-marker `via` cache (markers are immutable too). */
  private viaCache = new Map<string, string>();

  constructor(private readonly dir: string) {}

  get directory(): string {
    return this.dir;
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // mkdirSync's mode is masked by umask and ignored for pre-existing dirs.
    try { chmodSync(this.dir, 0o700); } catch { /* best effort */ }
  }

  /** Persist a new queued message. Throws on invalid input or I/O failure. */
  append(chatId: string, content: string, now: number = Date.now()): InboxEntry {
    if (!CHAT_ID_RE.test(chatId)) throw new Error('invalid chat_id');
    if (typeof content !== 'string' || content.length === 0) throw new Error('empty content');
    if (content.length > INBOX_MAX_CONTENT_CHARS) throw new Error('content too long');
    this.ensureDir();
    const id = `${String(now).padStart(13, '0')}-${randomBytes(6).toString('hex')}`;
    const rec: StoredRecord = { id, chat_id: chatId, content, received_at: new Date(now).toISOString() };
    atomicWrite0600(join(this.dir, `${id}.json`), JSON.stringify(rec));
    this.cache.set(id, rec);
    this.prune(now);
    return { ...rec, status: 'queued' };
  }

  /**
   * Create a status marker. Returns true when this call made the transition,
   * false when the marker already existed or the record is unknown. O_EXCL
   * makes concurrent markers race-free (exactly one creator wins).
   */
  mark(id: string, marker: Marker, via: string = marker): boolean {
    if (!INBOX_ID_RE.test(id)) return false;
    if (!existsSync(join(this.dir, `${id}.json`))) return false;
    try {
      writeFileSync(join(this.dir, `${id}.${marker}`), JSON.stringify({ at: new Date().toISOString(), via }), {
        encoding: 'utf-8', mode: 0o600, flag: 'wx',
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Mark every not-yet-answered entry of `chatId` received at/before now as answered. */
  markAnsweredForChat(chatId: string, now: number = Date.now()): number {
    let n = 0;
    for (const e of this.list()) {
      if (e.chat_id !== chatId || e.status === 'answered') continue;
      if (Date.parse(e.received_at) > now) continue;
      if (e.status === 'queued') this.mark(e.id, 'delivered', 'reply');
      if (this.mark(e.id, 'answered', 'reply')) n++;
    }
    return n;
  }

  /** All entries, oldest first. Missing/corrupt files are skipped. */
  list(): InboxEntry[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const present = new Set(names);
    const out: InboxEntry[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!INBOX_ID_RE.test(id)) continue;
      const rec = this.readRecord(id);
      if (!rec) continue;
      const status: InboxStatus = present.has(`${id}.answered`)
        ? 'answered'
        : present.has(`${id}.delivered`) ? 'delivered' : 'queued';
      const entry: InboxEntry = { ...rec, status };
      if (status !== 'queued') {
        const via = this.readVia(id);
        if (via) entry.delivered_via = via;
      }
      out.push(entry);
    }
    return out;
  }

  queued(): InboxEntry[] {
    return this.list().filter((e) => e.status === 'queued');
  }

  get(id: string): InboxEntry | null {
    if (!INBOX_ID_RE.test(id)) return null;
    return this.list().find((e) => e.id === id) ?? null;
  }

  /** True when any retained record belongs to `chatId` (trusted: written by the relay). */
  hasChatId(chatId: string): boolean {
    return this.list().some((e) => e.chat_id === chatId);
  }

  /** Drop expired records and enforce the count cap (oldest first). */
  prune(now: number = Date.now()): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    const ids = names
      .filter((n) => n.endsWith('.json') && INBOX_ID_RE.test(n.slice(0, -5)))
      .map((n) => n.slice(0, -5))
      .sort();
    const drop = new Set<string>();
    for (const id of ids) {
      if (now - Number(id.slice(0, 13)) > INBOX_RETENTION_MS) drop.add(id);
    }
    const idSet = new Set(ids);
    const kept = ids.filter((id) => !drop.has(id));
    for (let i = 0; i < kept.length - INBOX_MAX_ENTRIES; i++) drop.add(kept[i]);
    for (const id of drop) this.remove(id);
    // Orphaned markers / stale tmp files from crashed writers.
    for (const n of names) {
      const base = n.split('.')[0];
      const isMarker = MARKERS.some((m) => n === `${base}.${m}`);
      if ((isMarker && !idSet.has(base)) || drop.has(base)) this.unlinkQuiet(n);
      else if (n.endsWith('.tmp') && now - Number(base.slice(0, 13)) > 60_000) this.unlinkQuiet(n);
    }
  }

  private remove(id: string): void {
    this.cache.delete(id);
    this.viaCache.delete(id);
    this.unlinkQuiet(`${id}.json`);
    for (const m of MARKERS) this.unlinkQuiet(`${id}.${m}`);
  }

  private unlinkQuiet(name: string): void {
    try { unlinkSync(join(this.dir, name)); } catch { /* already gone */ }
  }

  private readRecord(id: string): StoredRecord | null {
    const cached = this.cache.get(id);
    if (cached) return cached;
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf-8')) as Partial<StoredRecord>;
      if (raw.id !== id || typeof raw.chat_id !== 'string' || !CHAT_ID_RE.test(raw.chat_id)) return null;
      if (typeof raw.content !== 'string' || typeof raw.received_at !== 'string') return null;
      const rec: StoredRecord = {
        id, chat_id: raw.chat_id, content: raw.content.slice(0, INBOX_MAX_CONTENT_CHARS), received_at: raw.received_at,
      };
      this.cache.set(id, rec);
      return rec;
    } catch {
      return null;
    }
  }

  private readVia(id: string): string | undefined {
    const cached = this.viaCache.get(id);
    if (cached !== undefined) return cached;
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, `${id}.delivered`), 'utf-8')) as { via?: unknown };
      if (typeof raw.via !== 'string') return undefined;
      const via = raw.via.slice(0, 32);
      this.viaCache.set(id, via);
      return via;
    } catch {
      return undefined;
    }
  }
}
