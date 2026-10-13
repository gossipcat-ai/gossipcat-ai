/**
 * bridge-reply-outbox.ts — durable store for MCP `reply` texts that could not
 * be delivered because no dashboard SSE stream for that chat_id was open.
 *
 * With the durable inbox, Claude routinely answers while the dashboard tab is
 * closed or reconnecting. Dropping the reply (the old behaviour) loses the
 * only output of that turn, so BridgeHub.emitReply parks it here and
 * BridgeHub.handleStream flushes it — once — when a stream for the chat_id
 * opens.
 *
 * Layout: `<root>/.gossip/bridge/outbox/<chat_id>.json` (dir 0700, file 0600,
 * atomic writes) = {replies:[{text, ts}]}. chat_id is validated by the caller
 * against the same `[A-Za-z0-9_-]{1,128}` shape (also the path guard here).
 * Without a directory (legacy/test hubs) it is an in-memory map.
 *
 * Bounds: OUTBOX_MAX_PER_CHAT newest replies per chat, OUTBOX_MAX_TEXT chars per
 * reply, OUTBOX_MAX_CHATS chats (oldest file evicted), OUTBOX_TTL_MS age; files
 * over OUTBOX_MAX_FILE_BYTES are discarded unread.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWrite0600, isCanonicalIso, readJsonBounded } from './claude-inbox-io';

export const OUTBOX_MAX_PER_CHAT = 20;
export const OUTBOX_MAX_CHATS = 64;
export const OUTBOX_MAX_TEXT = 32 * 1024;
export const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;
const OUTBOX_MAX_FILE_BYTES = 4 * 1024 * 1024;
const CHAT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export interface PendingReply {
  text: string;
  ts: string;
}

export function outboxDirFor(projectRoot: string): string {
  return join(projectRoot, '.gossip', 'bridge', 'outbox');
}

export class ReplyOutbox {
  private memory = new Map<string, PendingReply[]>();

  constructor(private readonly dir: string | null) {}

  /** Park a reply for `chatId`. Throws on invalid id or I/O failure. */
  push(chatId: string, text: string, now: number = Date.now()): void {
    if (!CHAT_ID_RE.test(chatId)) throw new Error('invalid chat_id');
    const body = text.length > OUTBOX_MAX_TEXT
      ? `${text.slice(0, OUTBOX_MAX_TEXT)}\n[truncated ${text.length - OUTBOX_MAX_TEXT} chars]`
      : text;
    const replies = [...this.read(chatId, now), { text: body, ts: new Date(now).toISOString() }]
      .slice(-OUTBOX_MAX_PER_CHAT);
    if (!this.dir) {
      this.memory.delete(chatId); // re-insert = newest in Map order
      this.memory.set(chatId, replies);
      while (this.memory.size > OUTBOX_MAX_CHATS) this.memory.delete(this.memory.keys().next().value as string);
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    atomicWrite0600(this.path(chatId), JSON.stringify({ replies }));
    this.evictChats(chatId);
  }

  /** Remove and return the pending replies for `chatId` (oldest first). */
  take(chatId: string, now: number = Date.now()): PendingReply[] {
    if (!CHAT_ID_RE.test(chatId)) return [];
    const replies = this.read(chatId, now);
    if (!this.dir) this.memory.delete(chatId);
    else { try { unlinkSync(this.path(chatId)); } catch { /* none pending */ } }
    return replies;
  }

  /** Number of pending replies for `chatId` (non-destructive). */
  count(chatId: string, now: number = Date.now()): number {
    return CHAT_ID_RE.test(chatId) ? this.read(chatId, now).length : 0;
  }

  private path(chatId: string): string {
    return join(this.dir as string, `${chatId}.json`);
  }

  private read(chatId: string, now: number): PendingReply[] {
    const fresh = (r: PendingReply): boolean => now - Date.parse(r.ts) <= OUTBOX_TTL_MS;
    if (!this.dir) return (this.memory.get(chatId) ?? []).filter(fresh);
    const r = readJsonBounded(this.path(chatId), OUTBOX_MAX_FILE_BYTES);
    if (r === 'oversized') {
      try { unlinkSync(this.path(chatId)); } catch { /* best effort */ }
      return [];
    }
    if (!r) return [];
    const list = (r.value as { replies?: unknown } | null)?.replies;
    if (!Array.isArray(list)) return [];
    const out: PendingReply[] = [];
    for (const item of list.slice(-OUTBOX_MAX_PER_CHAT)) {
      const v = item as Partial<PendingReply> | null;
      if (!v || typeof v.text !== 'string' || v.text.length > OUTBOX_MAX_TEXT + 64 || !isCanonicalIso(v.ts)) continue;
      if (fresh(v as PendingReply)) out.push({ text: v.text, ts: v.ts });
    }
    return out;
  }

  /** Keep at most OUTBOX_MAX_CHATS files: evict the least recently written. */
  private evictChats(keep: string): void {
    let names: string[];
    try { names = readdirSync(this.dir as string).filter((n) => n.endsWith('.json')); } catch { return; }
    if (names.length <= OUTBOX_MAX_CHATS) return;
    const aged = names
      .filter((n) => n !== `${keep}.json`)
      .map((n) => {
        try { return { n, t: statSync(join(this.dir as string, n)).mtimeMs }; } catch { return { n, t: 0 }; }
      })
      .sort((a, b) => a.t - b.t);
    for (const { n } of aged.slice(0, names.length - OUTBOX_MAX_CHATS)) {
      try { unlinkSync(join(this.dir as string, n)); } catch { /* gone */ }
    }
  }
}
