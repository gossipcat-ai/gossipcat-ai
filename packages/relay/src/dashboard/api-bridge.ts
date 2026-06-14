/**
 * api-bridge.ts — relay-side transport for the dashboard ⇄ live Claude Code
 * bridge (P1 backend, spec 2026-06-14-dashboard-cc-channel-bridge.md).
 *
 * NAMING (consensus f4): this is the "bridge", NOT a "channel" — packages/relay/
 * src/channels.ts already owns `ChannelManager` (agent pub-sub), a different
 * concept. The only place the literal `claude/channel` string appears is the MCP
 * capability key / notification method (the Claude Code protocol name, verbatim);
 * every identifier here is bridge-*.
 *
 * Two directions:
 *   - INBOUND  (dashboard → CC): the dashboard POSTs to /dashboard/api/bridge.
 *     The router calls the registered in-process sink (set by the MCP server via
 *     RelayServer.registerBridgeSink). The relay and the MCP server share one
 *     Node process (spec "#1 unknown RESOLVED"), so this is a direct callback —
 *     there is NO wire protocol / pending queue between them.
 *   - OUTBOUND (CC → dashboard): the MCP `reply` tool calls
 *     RelayServer.emitBridgeReply → BridgeHub.emitReply, which fans out an SSE
 *     frame to every connected dashboard bridge-stream client.
 *
 * Security posture (consensus f5/f10/f12/f13 — security in P1, not P4):
 *   - The POST route is gated by the EXISTING DashboardAuth + allowChatTurn
 *     rate-limit + a per-route readBody cap in routes.ts BEFORE this module runs.
 *   - chat_id is validated/bound on BOTH directions (untrusted on inbound POST,
 *     re-validated on outbound reply so an injected LLM can't address an
 *     arbitrary/forged stream id).
 *   - Every reply path guarantees a terminal/ack frame so push-into-idle never
 *     silently no-ops when Claude omits reply().
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';

/**
 * In-process sink the MCP server registers. Returns true when the message was
 * accepted for delivery to the live CC session, false when no bridge consumer
 * is wired (MCP server not booted / not registered) — the router surfaces that
 * to the dashboard rather than silently dropping.
 */
export type BridgeSink = (chatId: string, message: string) => boolean;

/** One outbound frame pushed to the dashboard over SSE. */
interface BridgeReplyFrame {
  type: 'reply' | 'ack' | 'error';
  chat_id: string;
  text?: string;
  ts: string;
}

// chat_id shape: callers may omit it (we mint one). When supplied it is
// UNTRUSTED — restrict to a conservative id charset + length so it can't be
// used for SSE header/log injection or to bloat the client keyspace. UUIDs and
// short opaque tokens both satisfy this.
const CHAT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
// Upper bound on a single inbound message. The route also enforces a readBody
// cap; this is the post-parse semantic guard (mirror CHAT message sizing).
const MAX_MESSAGE_LENGTH = 32 * 1024;
const MAX_BRIDGE_CLIENTS = 20;
const KEEPALIVE_MS = 25_000;
/** Consecutive failed writes before a client is evicted (mirror api-events). */
const BACKPRESSURE_EVICT_THRESHOLD = 2;

/**
 * Validate an untrusted chat_id. Returns the trimmed id when well-formed, or
 * null when absent/malformed. Callers decide whether null means "mint a fresh
 * one" (inbound) or "reject" (outbound bind).
 */
export function validateChatId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!CHAT_ID_RE.test(v)) return null;
  return v;
}

/**
 * BridgeHub — owns the outbound SSE client set and the registered inbound sink.
 * One instance per DashboardRouter. Process-local; a cold restart clears it.
 */
export class BridgeHub {
  private sink: BridgeSink | null = null;
  private clients = new Set<ServerResponse>();
  private backpressure = new WeakMap<ServerResponse, number>();
  // chat_ids we have seen on an INBOUND POST. Outbound replies bind against this
  // set (consensus f5): the live session can only address a stream the dashboard
  // actually opened, never an arbitrary/forged id. Bounded + TTL'd so a long
  // run can't grow it unbounded.
  private knownChatIds = new Map<string, number>();
  private static readonly MAX_KNOWN_CHAT_IDS = 64;
  private static readonly CHAT_ID_TTL_MS = 2 * 60 * 60 * 1000; // 2h, mirror chat-session-store

  /** Register (or clear) the in-process inbound sink. Called by RelayServer. */
  registerSink(fn: BridgeSink | null): void {
    this.sink = fn;
  }

  /** True when an MCP-side consumer is wired. */
  hasSink(): boolean {
    return this.sink !== null;
  }

  /**
   * INBOUND: deliver an untrusted dashboard message to the live CC session.
   * Body is already JSON-parsed by the route. Validates {chat_id?, message},
   * mints a chat_id when absent, records it for outbound binding, then invokes
   * the registered sink. Returns the response payload the route should send.
   */
  handlePost(body: unknown): { status: number; payload: Record<string, unknown> } {
    const b = (body ?? {}) as { chat_id?: unknown; message?: unknown };

    const message = b.message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      return { status: 400, payload: { error: 'message must be a non-empty string' } };
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return { status: 400, payload: { error: 'message too long' } };
    }

    // chat_id is optional. A supplied value must be well-formed; a malformed one
    // is rejected (fail closed) rather than silently coerced, so a client can't
    // smuggle junk that later fails outbound binding. Absent → mint.
    let chatId: string;
    if (b.chat_id === undefined || b.chat_id === null) {
      chatId = randomUUID();
    } else {
      const v = validateChatId(b.chat_id);
      if (v === null) {
        return { status: 400, payload: { error: 'invalid chat_id' } };
      }
      chatId = v;
    }

    if (!this.sink) {
      // No live CC session wired (MCP server not booted, or bridge not active).
      // Tell the dashboard explicitly instead of pretending it was delivered.
      return { status: 503, payload: { error: 'No live Claude Code bridge session is active', chat_id: chatId } };
    }

    this.rememberChatId(chatId);

    let delivered: boolean;
    try {
      delivered = this.sink(chatId, message);
    } catch {
      delivered = false;
    }
    if (!delivered) {
      return { status: 503, payload: { error: 'Bridge sink rejected the message', chat_id: chatId } };
    }
    return { status: 202, payload: { ok: true, chat_id: chatId } };
  }

  /**
   * OUTBOUND: the MCP `reply` tool forwards CC's reply here. Binds chat_id
   * (consensus f5) — drops a reply addressed to a stream the dashboard never
   * opened. Always fans out a `reply` frame on success. Returns whether the id
   * was bound (so the MCP tool can no-op honestly when it wasn't).
   */
  emitReply(rawChatId: string, text: string): boolean {
    const chatId = validateChatId(rawChatId);
    if (chatId === null) return false;
    if (!this.isKnownChatId(chatId)) return false;
    this.broadcast({ type: 'reply', chat_id: chatId, text, ts: new Date().toISOString() });
    return true;
  }

  /**
   * Emit a terminal ack frame for a chat_id (consensus f12). Used to guarantee a
   * closing frame + visible "working…/done" state so push-into-idle never
   * silently no-ops when Claude omits reply(). Bound the same way as emitReply.
   */
  emitAck(rawChatId: string): boolean {
    const chatId = validateChatId(rawChatId);
    if (chatId === null) return false;
    if (!this.isKnownChatId(chatId)) return false;
    this.broadcast({ type: 'ack', chat_id: chatId, ts: new Date().toISOString() });
    return true;
  }

  /**
   * SSE egress endpoint at /dashboard/api/bridge/stream. Auth is verified by the
   * router BEFORE this runs (same contract as handleEventsSSE). Long-lived — the
   * router must NOT route the response through json() afterwards.
   */
  handleStream(req: IncomingMessage, res: ServerResponse): void {
    if (this.clients.size >= MAX_BRIDGE_CLIENTS) {
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
      res.end('Too many bridge SSE clients — retry after 5s');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.backpressure.set(res, 0);
    this.clients.add(res);

    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch { clearInterval(keepalive); }
    }, KEEPALIVE_MS);
    keepalive.unref?.();

    req.on('close', () => {
      clearInterval(keepalive);
      this.clients.delete(res);
    });
  }

  /** Fan out one frame to every connected SSE client, with backpressure eviction. */
  private broadcast(frame: BridgeReplyFrame): void {
    const data = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of this.clients) {
      try {
        const ok = res.write(data);
        if (ok) {
          this.backpressure.set(res, 0);
        } else {
          const count = (this.backpressure.get(res) ?? 0) + 1;
          this.backpressure.set(res, count);
          if (count > BACKPRESSURE_EVICT_THRESHOLD) {
            res.destroy();
            this.clients.delete(res);
          }
        }
      } catch {
        this.clients.delete(res);
      }
    }
  }

  private rememberChatId(chatId: string): void {
    const now = Date.now();
    this.evictChatIds(now);
    if (!this.knownChatIds.has(chatId) && this.knownChatIds.size >= BridgeHub.MAX_KNOWN_CHAT_IDS) {
      // Drop the oldest-seen id to make room (capacity pressure).
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, v] of this.knownChatIds) {
        if (v < oldest) { oldest = v; oldestKey = k; }
      }
      if (oldestKey !== null) this.knownChatIds.delete(oldestKey);
    }
    this.knownChatIds.set(chatId, now);
  }

  private isKnownChatId(chatId: string): boolean {
    this.evictChatIds(Date.now());
    return this.knownChatIds.has(chatId);
  }

  private evictChatIds(now: number): void {
    for (const [k, v] of this.knownChatIds) {
      if (now - v > BridgeHub.CHAT_ID_TTL_MS) this.knownChatIds.delete(k);
    }
  }

  /** Test/introspection helper. */
  clientCount(): number {
    return this.clients.size;
  }
}
