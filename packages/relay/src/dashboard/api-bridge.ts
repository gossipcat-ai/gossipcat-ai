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
import { MirrorEventStore } from './api-mirror-events';

/**
 * In-process sink the MCP server registers. Returns true when the message was
 * accepted for delivery to the live CC session, false when no bridge consumer
 * is wired (MCP server not booted / not registered) — the router surfaces that
 * to the dashboard rather than silently dropping.
 */
export type BridgeSink = (chatId: string, message: string) => boolean;

/** One outbound frame pushed to the dashboard over SSE. */
interface BridgeReplyFrame {
  type: 'reply' | 'ack' | 'error' | 'mirror' | 'restart';
  chat_id: string;
  text?: string;
  ts: string;
}

/**
 * Strict role enum for mirror frames (spec §5). Anything outside this set is a
 * 400 at the route boundary, never a silent drop (resolves DISPUTED f21):
 *   - 'user'      — a terminal prompt the human typed in the CC session.
 *   - 'assistant' — the orchestrator's reply text block (Stop hook).
 *   - 'activity'  — a curated, scrubbed tool/dispatch one-liner (PostToolUse).
 */
export const MIRROR_ROLES = ['user', 'assistant', 'activity'] as const;
export type MirrorRole = (typeof MIRROR_ROLES)[number];

/** Type guard for the strict role enum. */
export function isMirrorRole(v: unknown): v is MirrorRole {
  return typeof v === 'string' && (MIRROR_ROLES as readonly string[]).includes(v);
}

/**
 * One mirror frame pushed to the dashboard over SSE and retained in the
 * per-chat_id ring (spec §5). `id` is a per-chat_id monotonic counter and `ts`
 * is SERVER-stamped — both are assigned by MirrorEventStore.push, never taken
 * from the untrusted hook payload (deepseek:f8 — ignore hook clocks).
 */
export interface MirrorFrame {
  type: 'mirror';
  chat_id: string;
  role: MirrorRole;
  text: string;
  ts: string; // SERVER-stamped (ISO 8601)
  id: number; // per-chat_id monotonic
}

/** One inbound mirror frame as it arrives in the POST body (pre-validation). */
export interface InboundMirrorFrame {
  role: unknown;
  text: unknown;
}

/**
 * Per-frame text cap for mirror frames (spec §4). SEPARATE from the route's
 * BRIDGE/MIRROR_MAX_BODY readBody cap: the body cap bounds the whole batch, this
 * bounds each individual frame so one giant frame can't dominate a small batch.
 * ~2 KB is generous for a scrubbed tool one-liner or a short assistant text.
 */
export const MIRROR_MAX_TEXT = 2 * 1024;
/** Max frames accepted in a single mirror POST batch (DoS guard). */
export const MIRROR_MAX_FRAMES = 64;

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

  // ── Mirror state (spec v2 §3) ──────────────────────────────────────────────
  // chat_ids eligible to RECEIVE mirror frames. SEPARATE from knownChatIds
  // (sonnet:f7/f12). P1#1: this set is seeded ONLY from the relay's validated
  // inbound POST body (handlePost / registerMirrorChatId from a dashboard turn),
  // NEVER from a hook-extracted wrapper chat_id — a prompt-injected wrapper
  // could otherwise seed an arbitrary id and address a stream it never opened.
  // emitReply STILL gates on knownChatIds, so mirroring never widens the
  // outbound reply boundary (api-bridge.ts emitReply isKnownChatId check).
  private mirrorChatIds = new Map<string, number>();
  // Session→chat_id map (P1#5). The relay has no native "active session
  // chat_id" notion — a no-chat_id inbound POST mints a fresh UUID. We learn the
  // mapping from the dashboard turn: a turn carries BOTH a chat_id (validated)
  // and a session_id (the CC session_id the wrapper/hook reports). Terminal
  // (no-chat_id) mirror POSTs that DO carry a session_id resolve their chat_id
  // through here. Established only from a validated dashboard inbound POST.
  private sessionToChatId = new Map<string, { chatId: string; at: number }>();
  // Per-chat_id mirror rings (bounded FIFO + TTL + proactive sweep).
  private mirror = new MirrorEventStore();
  // PROVISIONAL buffer (P1#5 fallback): a purely-terminal mirror POST with no
  // resolvable chat_id (no body chat_id, no known session mapping) is buffered
  // under a provisional id so a later observer can backfill it — OR dropped,
  // per the config flag. The provisional id is a single, fixed, reserved id
  // (never a real chat_id — it uses a `_` prefix that CHAT_ID_RE forbids at the
  // route, so it can never collide with or be addressed by a client). Its ring
  // is bounded + swept by the SAME MirrorEventStore, so MIRROR_RING_MAX caps the
  // backfill depth and the TTL sweep reclaims it if no observer ever arrives.
  // Backfill merges provisional frames into the resolved chat_id ring (re-pushed
  // → re-stamped with that ring's ids), capped by MIRROR_RING_MAX.
  private static readonly PROVISIONAL_CHAT_ID = '_provisional';
  private dropUnresolvedMirror = false;
  // session→chat_id entries share the same 2h TTL ceiling as knownChatIds.
  private static readonly MAX_SESSION_MAPPINGS = 64;

  /** Register (or clear) the in-process inbound sink. Called by RelayServer. */
  registerSink(fn: BridgeSink | null): void {
    this.sink = fn;
  }

  /**
   * Config: when true, an unresolvable terminal mirror POST (no chat_id, no
   * known session mapping) is DROPPED instead of buffered under the provisional
   * id. Default false (buffer for backfill). Set by the app layer.
   */
  setDropUnresolvedMirror(drop: boolean): void {
    this.dropUnresolvedMirror = drop;
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
    const b = (body ?? {}) as { chat_id?: unknown; message?: unknown; session_id?: unknown };

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
    // P1#1: seed the mirror registry ONLY from this validated inbound POST body.
    // This is the sole trusted seeding path for mirrorChatIds — hooks NEVER seed
    // it. P1#5: if the dashboard turn reports its CC session_id, record the
    // session→chat_id mapping so later terminal (no-chat_id) mirror POSTs resolve.
    this.registerMirrorChatId(chatId);
    const sessionId = validateChatId(b.session_id);
    if (sessionId !== null) this.bindSession(sessionId, chatId);

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
    // No connected SSE client → the reply cannot be delivered. Return false so
    // the MCP `reply` tool surfaces an honest "no open stream" error instead of
    // reporting a success that silently vanished (consensus f7e5bc15 f5).
    if (this.clients.size === 0) return false;
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
    if (this.clients.size === 0) return false;
    this.broadcast({ type: 'ack', chat_id: chatId, ts: new Date().toISOString() });
    return true;
  }

  /**
   * MIRROR ingress (spec v2 §3). Validates the (already body-capped + role-
   * checked-at-route) batch a SECOND time at the trust boundary, resolves the
   * target chat_id, stamps id + ts SERVER-SIDE per frame, retains each in the
   * per-chat_id ring, and fans out to SSE.
   *
   * Returns a route-shaped {status,payload}:
   *   - 400 — malformed chat_id, bad/oversize frame, empty/oversize batch.
   *     A bad frame anywhere in the batch rejects the WHOLE batch (reject →
   *     400, not silent drop — resolves DISPUTED f21). NOTHING is pushed on a
   *     400, so a partially-validated batch can't half-apply.
   *   - 202 — accepted; payload reports the resolved chat_id + how many frames.
   *
   * Trust boundaries:
   *   - chat_id (P1#1): an explicit body chat_id must be in mirrorChatIds (seeded
   *     ONLY from a dashboard inbound POST). A no-chat_id POST resolves through
   *     the session→chat_id map; if neither resolves, it goes to the provisional
   *     buffer (or is dropped per config) — it can NEVER seed mirrorChatIds.
   *   - id + ts are assigned by MirrorEventStore.push (NOT the hook payload —
   *     deepseek:f8). The InboundMirrorFrame carries only role + text.
   *   - Does NOT gate on clients.size (deepseek:f10): a mirror frame with no
   *     current observer is still retained for ring replay. This asymmetry vs
   *     emitReply is intentional and consensus-verified (sonnet:f12).
   *
   * P1#6 turn-ordering: UserPromptSubmit (turn start) and Stop (turn end) are
   * separate POSTs; the server `ts` is ARRIVAL order, not causal order — if Stop
   * races ahead of UserPromptSubmit the frames interleave by arrival. Per spec
   * we ACCEPT arrival-order and document it here rather than adding a per-turn
   * sequence number now.
   */
  emitMirror(
    rawChatId: string | undefined | null,
    frames: InboundMirrorFrame[],
    sessionId?: string | null,
  ): { status: number; payload: Record<string, unknown> } {
    if (!Array.isArray(frames) || frames.length === 0) {
      return { status: 400, payload: { error: 'frames must be a non-empty array' } };
    }
    if (frames.length > MIRROR_MAX_FRAMES) {
      return { status: 400, payload: { error: 'too many frames in batch' } };
    }

    // Validate EVERY frame BEFORE touching any ring (gemini:f5 — the route's
    // handlePost only validated a flat {message}; mirror must iterate). A single
    // bad frame fails the whole batch with 400.
    const validated: Array<{ role: MirrorRole; text: string }> = [];
    for (const f of frames) {
      if (!f || typeof f !== 'object') {
        return { status: 400, payload: { error: 'each frame must be an object' } };
      }
      if (!isMirrorRole((f as InboundMirrorFrame).role)) {
        return { status: 400, payload: { error: 'invalid frame role' } };
      }
      const text = (f as InboundMirrorFrame).text;
      if (typeof text !== 'string' || text.length === 0) {
        return { status: 400, payload: { error: 'frame text must be a non-empty string' } };
      }
      if (text.length > MIRROR_MAX_TEXT) {
        return { status: 400, payload: { error: 'frame text too long' } };
      }
      validated.push({ role: (f as InboundMirrorFrame).role as MirrorRole, text });
    }

    // Resolve the target chat_id.
    let chatId: string;
    if (rawChatId !== undefined && rawChatId !== null) {
      const v = validateChatId(rawChatId);
      if (v === null) {
        return { status: 400, payload: { error: 'invalid chat_id' } };
      }
      // P1#1: an explicit chat_id is only honored if the dashboard already
      // opened it (seeded via handlePost). A hook-supplied id we've never seen
      // on a validated inbound POST is rejected — it CANNOT seed mirrorChatIds.
      if (!this.isMirrorChatId(v)) {
        return { status: 400, payload: { error: 'unknown chat_id (not an open dashboard stream)' } };
      }
      chatId = v;
    } else {
      // No chat_id: resolve through the session map (P1#5).
      const sid = validateChatId(sessionId);
      const resolved = sid !== null ? this.resolveSession(sid) : null;
      if (resolved !== null) {
        chatId = resolved;
      } else if (this.dropUnresolvedMirror) {
        // Config: drop purely-terminal frames with no observer/mapping.
        return { status: 202, payload: { ok: true, chat_id: null, dropped: validated.length } };
      } else {
        // Buffer under the reserved provisional id for later backfill. This id
        // can never be a real chat_id (CHAT_ID_RE forbids the `_` route-side).
        chatId = BridgeHub.PROVISIONAL_CHAT_ID;
      }
    }

    const stamped: MirrorFrame[] = [];
    for (const { role, text } of validated) {
      const frame = this.mirror.push(chatId, role, text);
      stamped.push(frame);
      // Do NOT gate on clients.size — frame is already retained for replay.
      this.broadcast(frame);
    }
    return {
      status: 202,
      payload: { ok: true, chat_id: chatId === BridgeHub.PROVISIONAL_CHAT_ID ? null : chatId, frames: stamped.length },
    };
  }

  /**
   * SSE egress endpoint at /dashboard/api/bridge/stream. Auth is verified by the
   * router BEFORE this runs (same contract as handleEventsSSE). Long-lived — the
   * router must NOT route the response through json() afterwards.
   *
   * Mirror replay (spec §3 / P1#3): when the URL carries `?chat_id=<id>`, on
   * connect we replay that chat_id's retained mirror frames where `id > last_id`
   * THEN go live. We replay ONLY `mirror` frames — never reply/ack (sonnet:f11);
   * those are live-only outbound control frames with no per-chat_id ring.
   *
   * P1#3 restart discontinuity: on a relay restart the per-chat_id counter
   * resets to 1, so a client holding `last_id=50` requesting `id>50` would
   * silently starve (our highest id is now < 50). We detect `last_id >
   * highestId(chat_id)` and emit an explicit `{type:'restart'}` sentinel telling
   * the client to drop last_id and refetch from 0, then replay the full ring.
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

    // Parse ?chat_id + ?last_id (absent in the original bridge — mirror
    // api-events' ?last_id pattern). Both optional: no chat_id → live-only
    // (legacy reply/ack consumers); chat_id → replay that ring first.
    const url = req.url ?? '';
    const qIdx = url.indexOf('?');
    const search = qIdx >= 0 ? url.slice(qIdx + 1) : '';
    const params = new URLSearchParams(search);
    const chatId = validateChatId(params.get('chat_id'));
    const lastId = parseInt(params.get('last_id') ?? '0', 10) || 0;

    if (chatId !== null) {
      const highest = this.mirror.highestId(chatId);
      if (lastId > highest) {
        // Restart discontinuity (P1#3): our counter is behind the client's
        // cursor → a restart reset it. Tell the client to drop last_id, then
        // replay the entire current ring from the start.
        this.writeFrame(res, { type: 'restart', chat_id: chatId, ts: new Date().toISOString() });
        for (const frame of this.mirror.replaySlice(chatId, 0)) {
          this.writeFrame(res, frame);
        }
      } else {
        for (const frame of this.mirror.replaySlice(chatId, lastId)) {
          this.writeFrame(res, frame);
        }
      }
    }

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

  /**
   * Write one frame to a single SSE response (used during replay, before the
   * client joins the broadcast set). Mirror frames carry an SSE `id:` line so
   * the browser EventSource exposes lastEventId for reconnect-cursor reuse.
   */
  private writeFrame(res: ServerResponse, frame: BridgeReplyFrame | MirrorFrame): void {
    const idLine = 'id' in frame && typeof frame.id === 'number' ? `id: ${frame.id}\n` : '';
    try { res.write(`${idLine}data: ${JSON.stringify(frame)}\n\n`); } catch { /* client gone */ }
  }

  /** Fan out one frame to every connected SSE client, with backpressure eviction. */
  private broadcast(frame: BridgeReplyFrame | MirrorFrame): void {
    // Mirror frames carry an SSE `id:` line so the browser EventSource exposes
    // lastEventId; reply/ack/restart control frames have no per-chat_id id.
    const idLine = 'id' in frame && typeof (frame as MirrorFrame).id === 'number' ? `id: ${(frame as MirrorFrame).id}\n` : '';
    const data = `${idLine}data: ${JSON.stringify(frame)}\n\n`;
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

  // ── Mirror chat-id registry (SEPARATE from knownChatIds — P1#1/sonnet:f7) ──
  // Same bounded + TTL eviction discipline as knownChatIds, but a DISTINCT map:
  // mirrorChatIds gates emitMirror; knownChatIds gates emitReply. Keeping them
  // separate is the whole point — mirroring must never widen the outbound reply
  // boundary.

  /**
   * Seed the mirror registry. Called ONLY from handlePost (a validated
   * dashboard inbound POST). There is intentionally NO hook-facing path to this
   * method (P1#1): a hook-extracted wrapper chat_id can never seed it.
   */
  private registerMirrorChatId(chatId: string): void {
    const now = Date.now();
    this.evictMirrorChatIds(now);
    if (!this.mirrorChatIds.has(chatId) && this.mirrorChatIds.size >= BridgeHub.MAX_KNOWN_CHAT_IDS) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, v] of this.mirrorChatIds) {
        if (v < oldest) { oldest = v; oldestKey = k; }
      }
      if (oldestKey !== null) this.mirrorChatIds.delete(oldestKey);
    }
    this.mirrorChatIds.set(chatId, now);
  }

  private isMirrorChatId(chatId: string): boolean {
    this.evictMirrorChatIds(Date.now());
    return this.mirrorChatIds.has(chatId);
  }

  private evictMirrorChatIds(now: number): void {
    for (const [k, v] of this.mirrorChatIds) {
      if (now - v > BridgeHub.CHAT_ID_TTL_MS) this.mirrorChatIds.delete(k);
    }
  }

  /**
   * Record a session→chat_id mapping (P1#5). Established ONLY from a validated
   * dashboard inbound POST (handlePost). Bounded + TTL'd like the other maps.
   */
  private bindSession(sessionId: string, chatId: string): void {
    const now = Date.now();
    this.evictSessions(now);
    if (!this.sessionToChatId.has(sessionId) && this.sessionToChatId.size >= BridgeHub.MAX_SESSION_MAPPINGS) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, v] of this.sessionToChatId) {
        if (v.at < oldest) { oldest = v.at; oldestKey = k; }
      }
      if (oldestKey !== null) this.sessionToChatId.delete(oldestKey);
    }
    this.sessionToChatId.set(sessionId, { chatId, at: now });
  }

  /**
   * Resolve a session_id to its bound chat_id, or null. Only returns a chat_id
   * that is STILL an open mirror stream — a session whose chat_id has since been
   * evicted from mirrorChatIds resolves to null (fail closed) so a stale mapping
   * can't re-open mirroring on a dead stream.
   */
  private resolveSession(sessionId: string): string | null {
    this.evictSessions(Date.now());
    const entry = this.sessionToChatId.get(sessionId);
    if (!entry) return null;
    if (!this.isMirrorChatId(entry.chatId)) return null;
    return entry.chatId;
  }

  private evictSessions(now: number): void {
    for (const [k, v] of this.sessionToChatId) {
      if (now - v.at > BridgeHub.CHAT_ID_TTL_MS) this.sessionToChatId.delete(k);
    }
  }

  // ── Test/introspection helpers ──────────────────────────────────────────────

  /** Test/introspection helper. */
  clientCount(): number {
    return this.clients.size;
  }

  /** Test helper: is this chat_id an open mirror stream? */
  hasMirrorChatId(chatId: string): boolean {
    return this.isMirrorChatId(chatId);
  }

  /** Test helper: highest retained mirror id for a chat_id (0 if none). */
  mirrorHighestId(chatId: string): number {
    return this.mirror.highestId(chatId);
  }

  /** Test helper: replay slice for a chat_id. */
  mirrorReplay(chatId: string, lastId = 0): MirrorFrame[] {
    return this.mirror.replaySlice(chatId, lastId);
  }

  /** Test helper: force a proactive ring sweep at a given clock. */
  sweepMirror(now: number): void {
    this.mirror.sweep(now);
  }

  /** Test helper: number of live mirror rings. */
  mirrorRingCount(): number {
    return this.mirror.ringCount();
  }

  /** Stop the mirror sweep timer (clean shutdown / tests). */
  dispose(): void {
    this.mirror.dispose();
  }
}
