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
import { MirrorEventStore, MIRROR_RING_MAX, MIRROR_RING_TTL_MS } from './api-mirror-events';
import { FileChatStore, NullChatStore } from './chat-store';

/**
 * In-process sink the MCP server registers. Returns true when the message was
 * accepted for delivery to the live CC session, false when no bridge consumer
 * is wired (MCP server not booted / not registered) — the router surfaces that
 * to the dashboard rather than silently dropping.
 */
export type BridgeSink = (chatId: string, message: string) => boolean;

/** One outbound frame pushed to the dashboard over SSE. */
interface BridgeReplyFrame {
  type: 'reply' | 'ack' | 'error' | 'mirror' | 'restart' | 'question';
  chat_id: string;
  text?: string;
  ts: string;
  /** Present on `question` frames: the outstanding-question id (qid). */
  qid?: string;
  /** Present on `question` frames: the validated question set the dashboard renders. */
  questions?: AskQuestion[];
}

/**
 * One question in a `gossip_ask` round (spec 2026-06-16-dashboard-ask). The
 * orchestrator asks the dashboard a selection question; the dashboard renders
 * radios/checkboxes + an optional "Other" free-text and posts the answer back as
 * a normal channel turn. This is the dashboard-answerable parallel to the
 * terminal-only harness AskUserQuestion.
 *
 * UNTRUSTED on the inbound answer path: the registry retains the asked set so an
 * answer can be validated label-for-label against what was actually asked — a
 * forged questionId / option label / qid is rejected fail-closed (400).
 */
export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  /** Stable per-question id the answer references. Server-minted (q0, q1, …). */
  questionId: string;
  header: string;
  question: string;
  /** false/undefined → single-select radios; true → multi-select checkboxes. */
  multiSelect?: boolean;
  options: AskOption[];
  /** When true the dashboard may submit a trimmed free-text "other" value. */
  allowOther?: boolean;
}

/** One question as supplied by the MCP `gossip_ask` tool (pre-validation). */
export interface InboundAskQuestion {
  header?: unknown;
  question?: unknown;
  multiSelect?: unknown;
  options?: unknown;
  allowOther?: unknown;
}

/** One inbound answer to a single question (UNTRUSTED — from the dashboard POST). */
export interface InboundAnswerResponse {
  questionId?: unknown;
  selected?: unknown;
  other?: unknown;
}

/** The full inbound answer payload body (UNTRUSTED). */
export interface InboundAnswer {
  qid?: unknown;
  responses?: unknown;
}

/** A bounded/validated question set with the chat_id it was asked on. */
interface OutstandingQuestion {
  chatId: string;
  questions: AskQuestion[];
  at: number;
}

/** Caps for the gossip_ask input (DoS + UI sanity). */
export const ASK_MAX_QUESTIONS = 4;
export const ASK_MAX_OPTIONS = 8;
export const ASK_MAX_HEADER = 120;
export const ASK_MAX_QUESTION = 600;
export const ASK_MAX_LABEL = 120;
export const ASK_MAX_DESCRIPTION = 240;
/** Cap on a submitted free-text "other" value. */
export const ASK_MAX_OTHER = 400;

/**
 * Validate + normalize an untrusted `gossip_ask` question set (from the MCP
 * tool) into the canonical AskQuestion[] the dashboard renders and the registry
 * retains. Server-mints a stable per-question id (q0, q1, …) — the answer path
 * references these, never a client-supplied id. Fail-closed: any cap violation,
 * missing/empty header/question, empty options, or non-unique option labels
 * within a question returns an `error` string instead of a question set, so the
 * MCP tool can surface a clear validation error and emit nothing.
 *
 * Caps (DoS + UI sanity): ≤ ASK_MAX_QUESTIONS questions, ≤ ASK_MAX_OPTIONS
 * options each, with header/question/label/description length ceilings.
 */
export function validateAskQuestions(
  raw: unknown,
): { questions: AskQuestion[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'questions must be a non-empty array' };
  }
  if (raw.length > ASK_MAX_QUESTIONS) {
    return { error: `too many questions (max ${ASK_MAX_QUESTIONS})` };
  }
  const out: AskQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] as InboundAskQuestion;
    if (!q || typeof q !== 'object') {
      return { error: `question ${i} must be an object` };
    }
    if (typeof q.header !== 'string' || q.header.trim().length === 0) {
      return { error: `question ${i} header must be a non-empty string` };
    }
    if (q.header.length > ASK_MAX_HEADER) {
      return { error: `question ${i} header too long (max ${ASK_MAX_HEADER})` };
    }
    if (typeof q.question !== 'string' || q.question.trim().length === 0) {
      return { error: `question ${i} question must be a non-empty string` };
    }
    if (q.question.length > ASK_MAX_QUESTION) {
      return { error: `question ${i} question too long (max ${ASK_MAX_QUESTION})` };
    }
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') {
      return { error: `question ${i} multiSelect must be a boolean` };
    }
    if (q.allowOther !== undefined && typeof q.allowOther !== 'boolean') {
      return { error: `question ${i} allowOther must be a boolean` };
    }
    if (!Array.isArray(q.options) || q.options.length === 0) {
      return { error: `question ${i} options must be a non-empty array` };
    }
    if (q.options.length > ASK_MAX_OPTIONS) {
      return { error: `question ${i} has too many options (max ${ASK_MAX_OPTIONS})` };
    }
    const options: AskOption[] = [];
    const labels = new Set<string>();
    for (let j = 0; j < q.options.length; j++) {
      const o = q.options[j] as { label?: unknown; description?: unknown };
      if (!o || typeof o !== 'object') {
        return { error: `question ${i} option ${j} must be an object` };
      }
      if (typeof o.label !== 'string' || o.label.trim().length === 0) {
        return { error: `question ${i} option ${j} label must be a non-empty string` };
      }
      if (o.label.length > ASK_MAX_LABEL) {
        return { error: `question ${i} option ${j} label too long (max ${ASK_MAX_LABEL})` };
      }
      // Option labels must be unique WITHIN a question — the answer path matches
      // a submitted label against this set, so a duplicate would be ambiguous.
      if (labels.has(o.label)) {
        return { error: `question ${i} has a duplicate option label` };
      }
      labels.add(o.label);
      const opt: AskOption = { label: o.label };
      if (o.description !== undefined && o.description !== null) {
        if (typeof o.description !== 'string') {
          return { error: `question ${i} option ${j} description must be a string` };
        }
        if (o.description.length > ASK_MAX_DESCRIPTION) {
          return { error: `question ${i} option ${j} description too long (max ${ASK_MAX_DESCRIPTION})` };
        }
        opt.description = o.description;
      }
      options.push(opt);
    }
    out.push({
      questionId: `q${i}`,
      header: q.header,
      question: q.question,
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      options,
      ...(q.allowOther === true ? { allowOther: true } : {}),
    });
  }
  return { questions: out };
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

/** Optional configuration for BridgeHub. */
export interface BridgeHubOpts {
  /** When provided, mirror history is persisted under this directory. */
  chatDir?: string;
}

/**
 * BridgeHub — owns the outbound SSE client set and the registered inbound sink.
 * One instance per DashboardRouter. Process-local; a cold restart clears it.
 */
export class BridgeHub {
  private sink: BridgeSink | null = null;
  private clients = new Set<ServerResponse>();
  private backpressure = new WeakMap<ServerResponse, number>();
  // Per-client keepalive interval (f12). Tracked so broadcast()'s backpressure
  // eviction can clearInterval too — the req 'close' handler may never fire on
  // an abrupt res.destroy(), which would otherwise leak the timer.
  private keepalives = new Map<ServerResponse, ReturnType<typeof setInterval>>();
  // Per-client subscribed chat_id (null = no ?chat_id supplied = live-only legacy
  // consumer). Set when the client is added to this.clients in handleStream.
  // Server-side filtering in broadcast() uses this: each frame is only delivered
  // to the client(s) whose subscribed chat_id matches frame.chat_id. A null-
  // subscribed client receives nothing — the old "shared broadcast to all"
  // behaviour is intentionally replaced with per-client routing.
  private clientChatId = new Map<ServerResponse, string | null>();
  // chat_ids we have seen on an INBOUND POST. Outbound replies bind against this
  // set (consensus f5): the live session can only address a stream the dashboard
  // actually opened, never an arbitrary/forged id. Bounded + TTL'd so a long
  // run can't grow it unbounded.
  private knownChatIds = new Map<string, number>();
  private static readonly MAX_KNOWN_CHAT_IDS = 64;
  private static readonly CHAT_ID_TTL_MS = 2 * 60 * 60 * 1000; // 2h, mirror chat-session-store

  // ── Outstanding-question registry (gossip_ask round-trip) ───────────────────
  // qid → {chatId, questions, at}. An inbound answer is validated against the
  // EXACT set that was asked: the questionId must exist, each selected label must
  // be one of that question's option labels, `other` only when allowOther. The
  // registry is bounded + TTL'd (fail-closed eviction) so a long-running session
  // can't grow it unbounded and a stale qid can never be answered.
  private outstandingQuestions = new Map<string, OutstandingQuestion>();
  private static readonly MAX_OUTSTANDING_QUESTIONS = 64;
  private static readonly QUESTION_TTL_MS = 2 * 60 * 60 * 1000; // 2h, mirror knownChatIds

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
  // Constructed with a FileChatStore when chatDir is provided, else NullChatStore.
  private mirror: MirrorEventStore;
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

  constructor(opts: BridgeHubOpts = {}) {
    const store = opts.chatDir
      ? new FileChatStore(opts.chatDir)
      : new NullChatStore();
    this.mirror = new MirrorEventStore(MIRROR_RING_MAX, MIRROR_RING_TTL_MS, undefined, store);
  }

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
      // Reserve the internal provisional sentinel from client input (trust
      // boundary). CHAT_ID_RE admits a leading `_`, so '_provisional' (and any
      // other leading-`_` reserved form) would otherwise pass validateChatId.
      // A client must NOT be able to register a real stream under the sentinel
      // key: a later backfillProvisional → drainInto('_provisional', other)
      // would STEAL + DELETE that client's buffered frames. Internal callers
      // (drainInto / backfillProvisional) pass the constant directly, not
      // through here, so this only closes the inbound-client path.
      if (v === BridgeHub.PROVISIONAL_CHAT_ID || v.startsWith('_')) {
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
   * OUTBOUND: the MCP `gossip_ask` tool asks the dashboard a selection question.
   * Gates on knownChatIds EXACTLY like emitReply — a question may only target a
   * stream the dashboard actually opened, never an arbitrary/forged id. On
   * success the validated question set is registered under `qid` (so a later
   * inbound answer can be validated against what was asked) and a `question`
   * frame is fanned out over SSE.
   *
   * LIVE-ONLY: like reply/ack, a `question` frame has NO per-chat_id ring — an
   * unanswered question is LOST on a dashboard reload (acceptable v1). The
   * registry entry survives a reload (so an answer typed after reconnect would
   * still validate), but the rendered card does not.
   *
   * Returns false (no registration, no broadcast) when the chat_id is
   * malformed/unbound or no SSE client is connected, so the MCP tool can no-op
   * honestly — same posture as emitReply.
   */
  emitQuestion(rawChatId: string, qid: string, questions: AskQuestion[]): boolean {
    const chatId = validateChatId(rawChatId);
    if (chatId === null) return false;
    if (!this.isKnownChatId(chatId)) return false;
    if (this.clients.size === 0) return false;
    if (typeof qid !== 'string' || qid.length === 0) return false;
    if (!Array.isArray(questions) || questions.length === 0) return false;
    this.registerOutstandingQuestion(qid, chatId, questions);
    this.broadcast({ type: 'question', chat_id: chatId, qid, questions, ts: new Date().toISOString() });
    return true;
  }

  /**
   * INBOUND ANSWER (UNTRUSTED — this is the security boundary). The dashboard
   * POSTs `{chat_id, answer:{qid, responses:[{questionId, selected[], other?}]}}`.
   * VALIDATES fail-closed against the registered question set:
   *   - chat_id is known (bound to an opened stream);
   *   - qid is an outstanding question FOR THAT chat_id (cross-chat reuse → 400);
   *   - each questionId exists in the asked set, with no duplicates / no missing;
   *   - each `selected` label is one of THAT question's option labels (an unknown
   *     label → 400; a single-select question accepts at most one label);
   *   - `other` is only allowed when that question had allowOther, and is trimmed
   *     + length-capped.
   * On VALID: a concise channel turn is formatted and delivered to the live CC
   * session via the SAME sink path inbound chat messages use (so it arrives as a
   * normal turn), then the qid is deleted (single-use). Returns a route-shaped
   * {status,payload}: 202 on accept, 400 on any validation failure, 503 when no
   * sink is wired.
   */
  handleAnswer(body: unknown): { status: number; payload: Record<string, unknown> } {
    const b = (body ?? {}) as { chat_id?: unknown; answer?: unknown };

    const chatId = validateChatId(b.chat_id);
    if (chatId === null) {
      return { status: 400, payload: { error: 'invalid chat_id' } };
    }
    if (!this.isKnownChatId(chatId)) {
      return { status: 400, payload: { error: 'unknown chat_id (not an open dashboard stream)' } };
    }

    const answer = b.answer as InboundAnswer | undefined;
    if (!answer || typeof answer !== 'object') {
      return { status: 400, payload: { error: 'answer must be an object' } };
    }
    const qid = answer.qid;
    if (typeof qid !== 'string' || qid.length === 0) {
      return { status: 400, payload: { error: 'answer.qid must be a non-empty string' } };
    }
    // Evict stale entries first so an aged-out qid fails closed.
    this.evictOutstandingQuestions(Date.now());
    const outstanding = this.outstandingQuestions.get(qid);
    if (!outstanding) {
      return { status: 400, payload: { error: 'unknown or expired qid' } };
    }
    // The qid must belong to THIS chat_id — a qid asked on another stream cannot
    // be answered here (cross-stream replay guard).
    if (outstanding.chatId !== chatId) {
      return { status: 400, payload: { error: 'qid does not belong to this chat_id' } };
    }

    const responses = answer.responses;
    if (!Array.isArray(responses) || responses.length === 0) {
      return { status: 400, payload: { error: 'answer.responses must be a non-empty array' } };
    }
    if (responses.length > outstanding.questions.length) {
      return { status: 400, payload: { error: 'too many responses' } };
    }

    // Validate each response against the asked question; collect formatted parts.
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const r of responses) {
      if (!r || typeof r !== 'object') {
        return { status: 400, payload: { error: 'each response must be an object' } };
      }
      const rr = r as InboundAnswerResponse;
      if (typeof rr.questionId !== 'string') {
        return { status: 400, payload: { error: 'response.questionId must be a string' } };
      }
      const questionId = rr.questionId;
      if (seen.has(questionId)) {
        return { status: 400, payload: { error: 'duplicate questionId in responses' } };
      }
      const q = outstanding.questions.find((x) => x.questionId === questionId);
      if (!q) {
        return { status: 400, payload: { error: `unknown questionId "${questionId}"` } };
      }
      seen.add(questionId);

      if (!Array.isArray(rr.selected)) {
        return { status: 400, payload: { error: 'response.selected must be an array' } };
      }
      const selected = rr.selected;
      // A single-select question accepts at most one label; multi can be empty
      // only when an `other` value is supplied (handled below).
      if (!q.multiSelect && selected.length > 1) {
        return { status: 400, payload: { error: `question "${questionId}" is single-select` } };
      }
      if (selected.length > q.options.length) {
        return { status: 400, payload: { error: 'too many selected labels' } };
      }
      const labels = new Set(q.options.map((o) => o.label));
      const chosen: string[] = [];
      const seenLabels = new Set<string>();
      for (const s of selected) {
        if (typeof s !== 'string' || !labels.has(s)) {
          return { status: 400, payload: { error: `unknown option label for question "${questionId}"` } };
        }
        if (seenLabels.has(s)) {
          return { status: 400, payload: { error: 'duplicate selected label' } };
        }
        seenLabels.add(s);
        chosen.push(s);
      }

      // `other` only allowed when the question opted in; trim + length-cap.
      let otherText: string | null = null;
      if (rr.other !== undefined && rr.other !== null) {
        if (!q.allowOther) {
          return { status: 400, payload: { error: `question "${questionId}" does not allow other` } };
        }
        if (typeof rr.other !== 'string') {
          return { status: 400, payload: { error: 'response.other must be a string' } };
        }
        // SECURITY (consensus security review): `other` is untrusted dashboard
        // free-text that gets echoed into the channel turn delivered to the live
        // orchestrator. Collapse ALL control chars + whitespace (incl. newlines)
        // to single spaces so it cannot inject a fake `[answer qid=…]` line or a
        // standalone instruction line, then escape `\` and `"` so it cannot break
        // the `other: "…"` framing. Length-cap the sanitized result.
        const sanitized = rr.other
          .replace(/[\x00-\x1F\x7F]/g, " ")
          .replace(/\s+/g, " ")
          // Defang the answer-framing token so `other` cannot forge a second
          // `[answer qid=…]` marker inline (newlines are already collapsed above).
          .replace(/\[answer/gi, "(answer")
          .trim();
        if (sanitized.length > ASK_MAX_OTHER) {
          return { status: 400, payload: { error: 'other text too long' } };
        }
        if (sanitized.length > 0) {
          otherText = sanitized.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        }
      }

      // A question must yield at least one signal (a chosen label OR other text).
      if (chosen.length === 0 && otherText === null) {
        return { status: 400, payload: { error: `question "${questionId}" has no selection` } };
      }

      const segs: string[] = [];
      if (chosen.length > 0) segs.push(chosen.join(', '));
      if (otherText !== null) segs.push(`other: "${otherText}"`);
      parts.push(`${q.header}: ${segs.join(' · ')}`);
    }

    if (!this.sink) {
      return { status: 503, payload: { error: 'No live Claude Code bridge session is active' } };
    }

    const turn = `[answer qid=${qid}] ${parts.join(' · ')}`;
    let delivered: boolean;
    try {
      delivered = this.sink(chatId, turn);
    } catch {
      delivered = false;
    }
    if (!delivered) {
      return { status: 503, payload: { error: 'Bridge sink rejected the answer' } };
    }
    // Single-use: drop the outstanding question so it can't be answered twice.
    this.outstandingQuestions.delete(qid);
    return { status: 202, payload: { ok: true, qid, chat_id: chatId } };
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
        // UNRESOLVED: no explicit chat_id AND no session-map hit.
        // Run an eviction pass first so only live ids are targeted.
        this.evictMirrorChatIds(Date.now());
        const liveIds = Array.from(this.mirrorChatIds.keys());
        if (liveIds.length > 0) {
          // Multi-observer fanout: push a per-ring copy to EVERY live mirror
          // chat_id. This replaces the single-pointer latestMirrorChatId
          // heuristic (consensus 96350953) — every active dashboard tab receives
          // the terminal frame instead of only the most-recently-registered one.
          // Per-ring id counters are independent and correct by design.
          // SECURITY: only chat_ids already in mirrorChatIds are targeted — that
          // map is seeded ONLY from validated inbound POSTs (handlePost). Hooks
          // cannot seed it.
          let totalFrames = 0;
          for (const id of liveIds) {
            for (const { role, text } of validated) {
              const frame = this.mirror.push(id, role, text);
              // Do NOT gate on clients.size — frame is retained for replay.
              this.broadcast(frame);
              totalFrames++;
            }
          }
          return {
            status: 202,
            payload: { ok: true, chat_id: null, fanout: liveIds.length, frames: totalFrames },
          };
        } else {
          // No live mirror chat_ids → buffer under the reserved provisional id
          // for later backfill. This id can never be a real chat_id (CHAT_ID_RE
          // forbids the `_` route-side).
          chatId = BridgeHub.PROVISIONAL_CHAT_ID;
        }
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
    // FORWARD-HARDENING (consensus 8c396aee, deferred): ?chat_id is shape-validated
    // but NOT gated against knownChatIds/mirrorChatIds, so an authenticated client
    // may subscribe to any chat_id it names. Not exploitable in the current
    // single-auth-principal model (one dashboard key, server-minted random-UUID
    // chat_ids) and strictly better than the prior broadcast-to-all. A gate here
    // would have to preserve post-restart replay/re-register recovery (a naive
    // null-store breaks it, since the client reuses its chat_id on resend without
    // reconnecting) — implement carefully before any multi-user auth model.

    if (chatId !== null) {
      // f6: serving a chat_id that's an open mirror stream TOUCHES its TTL so an
      // actively-observed stream isn't deauthorized just because mirror POSTs
      // paused (the only other TTL bump is registerMirrorChatId, on inbound POST).
      // An idle-but-OPEN SSE observer keeps its own authorization alive.
      this.touchMirrorChatId(chatId);
      const highest = this.mirror.highestId(chatId);
      if (lastId > highest) {
        // Restart discontinuity (P1#3): our counter is behind the client's
        // cursor → a restart reset it. Tell the client to drop last_id, then
        // replay the entire current ring from the start.
        if (!this.writeFrame(res, { type: 'restart', chat_id: chatId, ts: new Date().toISOString() })) {
          // Slow client backed up on the very first frame — abandon replay.
          // The client reconnects with its last_id and we replay again (f10).
          return;
        }
        this.replayWithBackpressure(res, chatId, 0);
      } else {
        // FIFO-overflow gap (f7): the lowest frame we can still serve is past
        // lastId+1 because the oldest frames were FIFO-evicted. A late observer
        // would silently lose that history. Detect it and emit the SAME restart
        // sentinel used for the counter-reset case so the client drops its
        // cursor and refetches the full retained ring from 0.
        const slice = this.mirror.replaySlice(chatId, lastId);
        if (lastId > 0 && slice.length > 0 && slice[0].id > lastId + 1) {
          if (!this.writeFrame(res, { type: 'restart', chat_id: chatId, ts: new Date().toISOString() })) {
            return;
          }
          this.replayWithBackpressure(res, chatId, 0);
        } else {
          if (!this.replayFrames(res, slice)) return;
        }
      }
    }

    this.backpressure.set(res, 0);
    this.clients.add(res);
    // Track which chat_id this client is subscribed to for server-side filtering
    // in broadcast(). null means no ?chat_id (legacy live-only consumer).
    this.clientChatId.set(res, chatId);

    const keepalive = setInterval(() => {
      // f6 (completion): an OPEN-but-idle stream — no mirror POST, no reconnect —
      // would still TTL-evict its mirror authorization after CHAT_ID_TTL_MS even
      // though the socket is live. The connect-time touchMirrorChatId only covers
      // the open instant; refresh on every keepalive tick (~25s) so an actively
      // CONNECTED stream stays mirror-authorized for as long as the socket is up.
      // touchMirrorChatId is fail-closed: it no-ops unless chatId is already a
      // registered mirror stream, so a never-registered/legacy id is NOT
      // resurrected. chatId is captured in this closure (null for legacy
      // live-only consumers → skipped).
      if (chatId !== null) this.touchMirrorChatId(chatId);
      try { res.write(':keepalive\n\n'); } catch { clearInterval(keepalive); }
    }, KEEPALIVE_MS);
    keepalive.unref?.();
    // f12: track the interval per client so broadcast()'s backpressure eviction
    // can clear it too — the req 'close' handler may never fire on an abrupt
    // socket destroy, leaking the timer.
    this.keepalives.set(res, keepalive);

    req.on('close', () => {
      this.clearKeepalive(res);
      this.clients.delete(res);
      this.clientChatId.delete(res);
    });
  }

  /**
   * Replay a chat_id's ring (id > lastId) to a single client, honoring
   * backpressure (f10): stop the moment a write returns false instead of
   * silently dropping later frames into a full socket buffer. The client
   * reconnects with its last SSE id and replay resumes from there. Returns false
   * when replay was cut short.
   */
  private replayWithBackpressure(res: ServerResponse, chatId: string, lastId: number): boolean {
    return this.replayFrames(res, this.mirror.replaySlice(chatId, lastId));
  }

  /** Write a pre-fetched frame slice with backpressure, stopping on first false. */
  private replayFrames(res: ServerResponse, slice: MirrorFrame[]): boolean {
    for (const frame of slice) {
      if (!this.writeFrame(res, frame)) return false;
    }
    return true;
  }

  /**
   * Write one frame to a single SSE response (used during replay, before the
   * client joins the broadcast set). Mirror frames carry an SSE `id:` line so
   * the browser EventSource exposes lastEventId for reconnect-cursor reuse.
   * Returns the underlying res.write() result so the replay loop can honor
   * backpressure (f10) — false means the socket buffer is full / the client is
   * gone, and the caller must stop replaying.
   */
  private writeFrame(res: ServerResponse, frame: BridgeReplyFrame | MirrorFrame): boolean {
    const idLine = 'id' in frame && typeof frame.id === 'number' ? `id: ${frame.id}\n` : '';
    try { return res.write(`${idLine}data: ${JSON.stringify(frame)}\n\n`); } catch { return false; }
  }

  /**
   * Fan out one frame to matching connected SSE clients (server-side filter),
   * with backpressure eviction.
   *
   * Each frame carries a chat_id. Only the client(s) subscribed to that
   * chat_id receive the write — clients subscribed to a different chat_id or
   * with a null subscription (legacy live-only consumer) are skipped. This
   * eliminates the prior behaviour of broadcasting EVERY frame to ALL clients
   * (the bandwidth/confidentiality gap noted in the multi-tab fix spec).
   */
  private broadcast(frame: BridgeReplyFrame | MirrorFrame): void {
    // Mirror frames carry an SSE `id:` line so the browser EventSource exposes
    // lastEventId; reply/ack/restart control frames have no per-chat_id id.
    const idLine = 'id' in frame && typeof (frame as MirrorFrame).id === 'number' ? `id: ${(frame as MirrorFrame).id}\n` : '';
    const data = `${idLine}data: ${JSON.stringify(frame)}\n\n`;
    for (const res of this.clients) {
      // Server-side chat_id filter: only deliver to clients whose subscribed
      // chat_id matches this frame's chat_id. A null-subscribed (legacy) client
      // receives nothing — it never supplied a ?chat_id so the server has no
      // basis to route to it. The dashboard client-side filter in useBridge.ts
      // remains as defense-in-depth.
      const subscribedChatId = this.clientChatId.get(res) ?? null;
      if (subscribedChatId === null || subscribedChatId !== frame.chat_id) continue;

      try {
        const ok = res.write(data);
        if (ok) {
          this.backpressure.set(res, 0);
        } else {
          const count = (this.backpressure.get(res) ?? 0) + 1;
          this.backpressure.set(res, count);
          if (count > BACKPRESSURE_EVICT_THRESHOLD) {
            this.clearKeepalive(res); // f12: don't leak the timer on eviction
            res.destroy();
            this.clients.delete(res);
            this.clientChatId.delete(res); // clean up subscription on eviction
          }
        }
      } catch {
        this.clearKeepalive(res);
        this.clients.delete(res);
        this.clientChatId.delete(res); // clean up subscription on exception
      }
    }
  }

  /** Clear + drop a client's keepalive interval (f12). Safe if absent. */
  private clearKeepalive(res: ServerResponse): void {
    const timer = this.keepalives.get(res);
    if (timer !== undefined) {
      clearInterval(timer);
      this.keepalives.delete(res);
    }
  }

  /**
   * Bump the TTL of an OPEN mirror chat_id (f6) without seeding a new one. Unlike
   * registerMirrorChatId this NEVER adds an id — it only refreshes the timestamp
   * of an id that is already an open mirror stream, so an actively-observed SSE
   * stream stays authorized even when mirror POSTs pause. A chat_id that isn't a
   * mirror stream (or has already aged out) is left untouched (fail closed).
   */
  private touchMirrorChatId(chatId: string): void {
    const now = Date.now();
    // Refresh FIRST, then evict: an open SSE stream re-authorizes its own
    // chat_id even if it had aged past the TTL since the last mirror POST. If we
    // evicted before refreshing, an idle-but-open stream would be dropped right
    // before the touch could save it (f6). Other stale ids are still reaped.
    if (this.mirrorChatIds.has(chatId)) this.mirrorChatIds.set(chatId, now);
    this.evictMirrorChatIds(now);
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

  // ── Outstanding-question registry helpers (gossip_ask) ──────────────────────

  /**
   * Register a validated question set under `qid`. Bounded + TTL'd: a stale
   * entry is reaped before insert, and at capacity the oldest entry is dropped
   * to make room (fail-closed — an unanswered old question is forgotten rather
   * than letting the map grow unbounded).
   */
  private registerOutstandingQuestion(qid: string, chatId: string, questions: AskQuestion[]): void {
    const now = Date.now();
    this.evictOutstandingQuestions(now);
    if (!this.outstandingQuestions.has(qid) && this.outstandingQuestions.size >= BridgeHub.MAX_OUTSTANDING_QUESTIONS) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, v] of this.outstandingQuestions) {
        if (v.at < oldest) { oldest = v.at; oldestKey = k; }
      }
      if (oldestKey !== null) this.outstandingQuestions.delete(oldestKey);
    }
    this.outstandingQuestions.set(qid, { chatId, questions, at: now });
  }

  private evictOutstandingQuestions(now: number): void {
    for (const [k, v] of this.outstandingQuestions) {
      if (now - v.at > BridgeHub.QUESTION_TTL_MS) this.outstandingQuestions.delete(k);
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
    const isNew = !this.mirrorChatIds.has(chatId);
    if (isNew && this.mirrorChatIds.size >= BridgeHub.MAX_KNOWN_CHAT_IDS) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, v] of this.mirrorChatIds) {
        if (v < oldest) { oldest = v; oldestKey = k; }
      }
      if (oldestKey !== null) this.mirrorChatIds.delete(oldestKey);
    }
    this.mirrorChatIds.set(chatId, now);
    // Provisional backfill (spec §2 / P2 — f1/f7): the FIRST time a stream is
    // established, drain any frames buffered under the provisional id (terminal
    // mirror POSTs that arrived before this chat_id existed) into THIS ring,
    // re-stamped with this ring's monotonic ids + a fresh server ts, capped at
    // MIRROR_RING_MAX by the ring's own FIFO. Then the provisional ring is
    // cleared. Only on first-seen so a re-touch of an existing stream doesn't
    // re-drain (the provisional ring is empty after the first drain anyway, but
    // guarding on isNew makes the single-shot intent explicit). If dropping is
    // configured the provisional buffer is never populated, so this is a no-op.
    if (isNew) this.backfillProvisional(chatId, now);
  }

  /**
   * Drain the provisional ring into a newly-established chat_id ring and fan the
   * re-stamped frames out to any currently-connected SSE client whose cursor is
   * on this chat_id (they receive them as live frames; a later reconnect replays
   * them from the ring). Cap is enforced by MirrorEventStore.drainInto's FIFO.
   */
  private backfillProvisional(chatId: string, now: number): void {
    if (chatId === BridgeHub.PROVISIONAL_CHAT_ID) return;
    const transferred = this.mirror.drainInto(BridgeHub.PROVISIONAL_CHAT_ID, chatId, now);
    for (const frame of transferred) {
      this.broadcast(frame);
    }
  }

  private isMirrorChatId(chatId: string): boolean {
    this.evictMirrorChatIds(Date.now());
    return this.mirrorChatIds.has(chatId);
  }

  private evictMirrorChatIds(now: number): void {
    for (const [k, v] of this.mirrorChatIds) {
      if (now - v > BridgeHub.CHAT_ID_TTL_MS) {
        this.mirrorChatIds.delete(k);
      }
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

  /**
   * Test helper (f6): age an open mirror chat_id's last-touch timestamp into the
   * past by `ms`, so the next TTL check would evict it unless something (an open
   * SSE stream) touches it first. Returns false if the id isn't an open stream.
   */
  ageMirrorChatId(chatId: string, ms: number): boolean {
    const cur = this.mirrorChatIds.get(chatId);
    if (cur === undefined) return false;
    this.mirrorChatIds.set(chatId, cur - ms);
    return true;
  }

  /** Test helper: count of live keepalive timers (f12 leak check). */
  keepaliveCount(): number {
    return this.keepalives.size;
  }

  /** Test helper: number of live mirror rings. */
  mirrorRingCount(): number {
    return this.mirror.ringCount();
  }

  /** Stop the mirror sweep timer + all per-client keepalives (clean shutdown / tests). */
  dispose(): void {
    for (const timer of this.keepalives.values()) clearInterval(timer);
    this.keepalives.clear();
    this.mirror.dispose();
  }
}
