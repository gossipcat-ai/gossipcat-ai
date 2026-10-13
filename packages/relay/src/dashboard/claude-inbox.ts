/**
 * claude-inbox.ts — durable, file-backed inbox for dashboard → Claude Code
 * bridge messages. Claude Code silently DROPS `notifications/claude/channel`
 * unless launched with `--channels`, so every Claude-addressed message is
 * persisted here FIRST; the channel notification is a best-effort fast path and
 * NEVER marks a message delivered by itself (see docs/CLAUDE_INBOX.md).
 *
 * Layout (`<root>/.gossip/bridge/inbox/`, dir 0700, files 0600):
 *   <id>.json        immutable record {id, chat_id, content, received_at,
 *                    to, from, kind, qid?, ref?, in_reply_to?} (envelope:
 *                    claude-inbox-envelope.ts; legacy records lack it)
 *   <id>.delivered   marker {at, via}: shown to Claude (inbox wait / hook / ack)
 *   <id>.answered    marker: the MCP `reply` tool answered this chat_id
 *   <id>.reminded    {at}: last time a hook re-surfaced it as unanswered
 *   <id>.quarantine  an oversized record moved aside (never read)
 *
 * Concurrency: records are written once (tmp + rename); status transitions are
 * separate marker files created with O_EXCL, so concurrent writers (relay and
 * CLI processes) can't lose or regress a transition. answered > delivered > queued.
 *
 * Bounds (nothing unanswered is ever deleted to make room): at most
 * INBOX_MAX_UNANSWERED unanswered records — append() throws InboxFullError
 * beyond that; answered records age out / are capped (claude-inbox-prune.ts);
 * records over INBOX_MAX_RECORD_BYTES are quarantined unread; one scan reads at
 * most INBOX_SCAN_MAX records.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { atomicWrite0600, isCanonicalIso, readJsonBounded } from './claude-inbox-io';
import { planPrune, readPruneLog, recordPrune, type PruneLog } from './claude-inbox-prune';
import { resolveEnvelope, type InboxEnvelope, type ResolvedEnvelope } from './claude-inbox-envelope';

export { atomicWrite0600 } from './claude-inbox-io';
export {
  DEFAULT_FROM, DEFAULT_KIND, DEFAULT_TO, INBOX_PARTY_RE,
  type InboxEnvelope, type InboxKind, type InboxRef,
} from './claude-inbox-envelope';

export type InboxStatus = 'queued' | 'delivered' | 'answered';

export interface InboxEntry extends ResolvedEnvelope {
  id: string;
  chat_id: string;
  content: string;
  received_at: string;
  status: InboxStatus;
  /** Who marked it delivered ('wait' | 'hook' | 'ack' | 'reply' | 'dispatch:<task_id>'), when known. */
  delivered_via?: string;
  /** When it was marked delivered, when known. */
  delivered_at?: string;
  /** When a hook last re-surfaced it as unanswered, when known. */
  reminded_at?: string;
}

interface StoredRecord extends ResolvedEnvelope {
  id: string;
  chat_id: string;
  content: string;
  received_at: string;
}

export interface InboxListOpts {
  /** Only entries whose status is in this list. */
  status?: readonly InboxStatus[];
  chatId?: string;
  /** Only entries addressed to this party (legacy records count as 'orchestrator'). */
  to?: string;
  /** Stop after this many matches. */
  limit?: number;
  /** Scan newest → oldest (result is still returned oldest first). */
  newestFirst?: boolean;
}

export interface InboxStats {
  /** Not yet claimed by any consumer (subset of unanswered). */
  queued: number;
  unanswered: number;
  answered: number;
  max_unanswered: number;
  pruned_total: number;
  last_pruned_at?: string;
}

export const INBOX_MAX_ENTRIES = 200;
export const INBOX_MAX_UNANSWERED = 200;
export const INBOX_MAX_CONTENT_CHARS = 32 * 1024;
export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Worst case JSON escaping of 32K chars is ~6 bytes/char, plus metadata. */
export const INBOX_MAX_RECORD_BYTES = 256 * 1024;
export const INBOX_SCAN_MAX = 1000;

/** Thrown by append() when the inbox is full of unanswered messages. */
export class InboxFullError extends Error {
  constructor(readonly unanswered: number) {
    super(`inbox full: ${unanswered} unanswered messages`);
    this.name = 'InboxFullError';
  }
}

/** `<13-digit ms>-<12 hex>` — sortable by name = chronological. Also the path guard. */
export const INBOX_ID_RE = /^\d{13}-[0-9a-f]{12}$/;
const CHAT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MARKERS = ['delivered', 'answered'] as const;
type Marker = (typeof MARKERS)[number];
const AUX_SUFFIXES = ['delivered', 'answered', 'reminded'] as const;
const SMALL_FILE_BYTES = 4096;
/** `wait` | `hook` | `ack` | `reply`, or `dispatch:<task_id>` for agent mail injected into a prompt. */
const DELIVERED_VIA_RE = /^[a-z]{1,16}(?::[A-Za-z0-9_-]{1,64})?$/;

/** Canonical inbox dir for a project root. */
export function inboxDirFor(projectRoot: string): string {
  return join(projectRoot, '.gossip', 'bridge', 'inbox');
}

export class ClaudeInbox {
  /** id → immutable record cache (records never change once written). */
  private cache = new Map<string, StoredRecord>();
  private lastPrune: PruneLog | null = null;

  constructor(private readonly dir: string) {}

  get directory(): string {
    return this.dir;
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // mkdirSync's mode is masked by umask and ignored for pre-existing dirs.
    try { chmodSync(this.dir, 0o700); } catch { /* best effort */ }
  }

  /**
   * Persist a new queued message. Throws on invalid input (including a present
   * but invalid `to`/`from`), a full inbox, or I/O failure. Invalid optional
   * envelope fields (kind/qid/ref/in_reply_to) are dropped. `envelope.from` must
   * be stamped by the calling code, never parsed from `content`.
   */
  append(chatId: string, content: string, now: number = Date.now(), envelope: InboxEnvelope = {}): InboxEntry {
    if (!CHAT_ID_RE.test(chatId)) throw new Error('invalid chat_id');
    if (typeof content !== 'string' || content.length === 0) throw new Error('empty content');
    if (content.length > INBOX_MAX_CONTENT_CHARS) throw new Error('content too long');
    const env = resolveEnvelope(envelope);
    if (!env) throw new Error('invalid to/from');
    this.ensureDir();
    this.prune(now);
    const unanswered = this.stats().unanswered;
    if (unanswered >= INBOX_MAX_UNANSWERED) throw new InboxFullError(unanswered);
    const id = `${String(now).padStart(13, '0')}-${randomBytes(6).toString('hex')}`;
    const rec: StoredRecord = { id, chat_id: chatId, content, received_at: new Date(now).toISOString(), ...env };
    atomicWrite0600(join(this.dir, `${id}.json`), JSON.stringify(rec));
    this.cache.set(id, rec);
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

  /** Record that a hook re-surfaced an unanswered message (overwrites; throttle only). */
  markReminded(id: string, now: number = Date.now()): void {
    if (!INBOX_ID_RE.test(id) || !existsSync(join(this.dir, `${id}.json`))) return;
    try { atomicWrite0600(join(this.dir, `${id}.reminded`), JSON.stringify({ at: new Date(now).toISOString() })); } catch { /* best effort */ }
  }

  /**
   * Close the entries a `reply` answered. With `ids`: exactly those ids, and
   * only when they belong to `chatId` (unknown / other-chat ids are ignored);
   * a still-`queued` id Claude explicitly named is marked delivered(via
   * 'reply') first. Without `ids` (legacy / channel-mode reply): only entries
   * of the chat that were already `delivered` (shown to Claude) and received
   * at/before `now` — a `queued` entry was never shown, so it is NEVER closed
   * here (duplicates are acceptable, losses are not).
   */
  markAnswered(chatId: string, opts: { ids?: readonly string[]; now?: number } = {}): number {
    const now = opts.now ?? Date.now();
    let n = 0;
    if (opts.ids !== undefined) {
      for (const id of new Set(opts.ids)) {
        if (typeof id !== 'string' || !INBOX_ID_RE.test(id)) continue;
        const e = this.get(id);
        if (!e || e.chat_id !== chatId || e.status === 'answered') continue;
        if (e.status === 'queued') this.mark(e.id, 'delivered', 'reply');
        if (this.mark(e.id, 'answered', 'reply')) n++;
      }
      return n;
    }
    for (const e of this.list({ chatId, status: ['delivered'] })) {
      if (Date.parse(e.received_at) > now) continue;
      if (this.mark(e.id, 'answered', 'reply')) n++;
    }
    return n;
  }

  /**
   * Entries, oldest first. Status filtering uses directory names only (no
   * reads); at most INBOX_SCAN_MAX records are read per call and the scan stops
   * once `limit` matches are found. Missing/corrupt/invalid files are skipped.
   */
  list(opts: InboxListOpts = {}): InboxEntry[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const present = new Set(names);
    const ids = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => INBOX_ID_RE.test(id)).sort();
    if (opts.newestFirst) ids.reverse();
    const out: InboxEntry[] = [];
    let reads = 0;
    for (const id of ids) {
      if (opts.limit !== undefined && out.length >= opts.limit) break;
      const status: InboxStatus = present.has(`${id}.answered`)
        ? 'answered'
        : present.has(`${id}.delivered`) ? 'delivered' : 'queued';
      if (opts.status && !opts.status.includes(status)) continue;
      if (!this.cache.has(id) && ++reads > INBOX_SCAN_MAX) break;
      const rec = this.readRecord(id);
      if (!rec || (opts.chatId !== undefined && rec.chat_id !== opts.chatId)) continue;
      if (opts.to !== undefined && rec.to !== opts.to) continue;
      const entry: InboxEntry = { ...rec, status };
      if (status !== 'queued') Object.assign(entry, this.readDelivered(id));
      if (present.has(`${id}.reminded`)) {
        const at = this.readAt(`${id}.reminded`);
        if (at) entry.reminded_at = at;
      }
      out.push(entry);
    }
    return opts.newestFirst ? out.reverse() : out;
  }

  queued(limit?: number, to?: string): InboxEntry[] {
    return this.list({ status: ['queued'], limit, to });
  }

  get(id: string): InboxEntry | null {
    if (!INBOX_ID_RE.test(id)) return null;
    const rec = this.readRecord(id);
    if (!rec) return null;
    const has = (m: string): boolean => existsSync(join(this.dir, `${id}.${m}`));
    const status: InboxStatus = has('answered') ? 'answered' : has('delivered') ? 'delivered' : 'queued';
    const entry: InboxEntry = { ...rec, status };
    if (status !== 'queued') Object.assign(entry, this.readDelivered(id));
    const reminded = has('reminded') ? this.readAt(`${id}.reminded`) : undefined;
    if (reminded) entry.reminded_at = reminded;
    return entry;
  }

  /** True when any retained record belongs to `chatId` (trusted: written by the relay). */
  hasChatId(chatId: string): boolean {
    return this.list({ chatId, limit: 1, newestFirst: true }).length > 0;
  }

  /** Counts from directory names only, plus prune telemetry. */
  stats(): InboxStats {
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { /* empty */ }
    const present = new Set(names);
    let unanswered = 0;
    let answered = 0;
    let queued = 0;
    for (const n of names) {
      const id = n.slice(0, -5);
      if (!n.endsWith('.json') || !INBOX_ID_RE.test(id)) continue;
      if (present.has(`${id}.answered`)) answered++;
      else {
        unanswered++;
        if (!present.has(`${id}.delivered`)) queued++;
      }
    }
    const log = readPruneLog(this.dir);
    const total = Math.max(log.total, this.lastPrune?.total ?? 0);
    const s: InboxStats = { queued, unanswered, answered, max_unanswered: INBOX_MAX_UNANSWERED, pruned_total: total };
    const last = log.at ?? this.lastPrune?.at;
    if (last) s.last_pruned_at = last;
    return s;
  }

  /**
   * Age out ANSWERED records past retention and cap the answered count. Never
   * deletes a queued or delivered-unanswered record (claude-inbox-prune.ts).
   * Also reaps orphaned markers, stale tmp files and old quarantined records.
   * Returns how many records were removed (persisted to inbox-prune.json).
   */
  prune(now: number = Date.now()): number {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    const plan = planPrune(names, now, {
      idRe: INBOX_ID_RE, aux: AUX_SUFFIXES, retentionMs: INBOX_RETENTION_MS, maxAnswered: INBOX_MAX_ENTRIES,
    });
    for (const id of plan.drop) this.remove(id);
    for (const n of plan.unlink) this.unlinkQuiet(n);
    if (plan.drop.size > 0) this.lastPrune = recordPrune(this.dir, plan.drop.size, now);
    return plan.drop.size;
  }

  private remove(id: string): void {
    this.cache.delete(id);
    this.unlinkQuiet(`${id}.json`);
    for (const m of AUX_SUFFIXES) this.unlinkQuiet(`${id}.${m}`);
  }

  private unlinkQuiet(name: string): void {
    try { unlinkSync(join(this.dir, name)); } catch { /* already gone */ }
  }

  private readRecord(id: string): StoredRecord | null {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const path = join(this.dir, `${id}.json`);
    const r = readJsonBounded(path, INBOX_MAX_RECORD_BYTES);
    if (r === 'oversized') {
      // Never read it; move it aside so later scans don't keep paying for it.
      try { renameSync(path, join(this.dir, `${id}.quarantine`)); } catch { /* best effort */ }
      return null;
    }
    if (!r) return null;
    const raw = r.value as Partial<StoredRecord> | null;
    if (!raw || typeof raw !== 'object' || raw.id !== id) return null;
    if (typeof raw.chat_id !== 'string' || !CHAT_ID_RE.test(raw.chat_id)) return null;
    if (typeof raw.content !== 'string' || raw.content.length > INBOX_MAX_CONTENT_CHARS) return null;
    if (!isCanonicalIso(raw.received_at)) return null;
    const env = resolveEnvelope(raw);
    if (!env) return null;
    const rec: StoredRecord = { id, chat_id: raw.chat_id, content: raw.content, received_at: raw.received_at, ...env };
    this.cache.set(id, rec);
    return rec;
  }

  private readDelivered(id: string): Pick<InboxEntry, 'delivered_via' | 'delivered_at'> {
    const r = readJsonBounded(join(this.dir, `${id}.delivered`), SMALL_FILE_BYTES);
    if (!r || r === 'oversized') return {};
    const v = r.value as { via?: unknown; at?: unknown } | null;
    const out: Pick<InboxEntry, 'delivered_via' | 'delivered_at'> = {};
    if (v && typeof v.via === 'string' && DELIVERED_VIA_RE.test(v.via)) out.delivered_via = v.via;
    if (v && isCanonicalIso(v.at)) out.delivered_at = v.at;
    return out;
  }

  private readAt(name: string): string | undefined {
    const r = readJsonBounded(join(this.dir, name), SMALL_FILE_BYTES);
    if (!r || r === 'oversized') return undefined;
    const v = r.value as { at?: unknown } | null;
    return v && isCanonicalIso(v.at) ? v.at : undefined;
  }
}
