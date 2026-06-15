import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useBridge — frontend hook for the dashboard ⇄ LIVE Claude Code session bridge
 * (P1 backend, spec 2026-06-14-dashboard-cc-channel-bridge.md).
 *
 * Mirrors the useEventStream SSE pattern: open an EventSource, parse frames,
 * manual reconnect with backoff, cleanup-on-unmount. Adds the conversational
 * layer the bridge needs:
 *   - send(text): POST to /dashboard/api/bridge. Omits chat_id on the first
 *     send; the server mints + returns one, which we reuse for the conversation.
 *   - Frames are filtered to the active chat_id so a stray/forged stream id
 *     (or a different tab's conversation) can't bleed into this view.
 *
 * IMPORTANT: this wires the LIVE Claude Code orchestrator session, NOT the
 * dormant ChatbotAgent /api/chat brain. The two must never be conflated.
 *
 * Backend contract (do NOT change — fixed by api-bridge.ts):
 *   POST /dashboard/api/bridge {chat_id?, message}
 *     → 202 {ok:true, chat_id} | 400 | 429 | 503
 *   GET  /dashboard/api/bridge/stream[?last_id=N]  (SSE)
 *     Frames arriving on the SHARED stream (activity-mirror v2, spec
 *     2026-06-14-dashboard-cc-activity-mirror-v2.md §5/§6):
 *       {type:'reply'|'ack'|'error', chat_id, text?, ts}      — dashboard-typed turns
 *       {type:'mirror', chat_id, role, text, ts, id}          — live CC-session mirror
 *           role ∈ 'user'|'assistant'|'activity'; id is a per-chat_id monotonic
 *           counter, ts is server-stamped ISO. On connect the relay replays this
 *           chat_id's ring where id > ?last_id, then goes live.
 *       {type:'restart', chat_id, ts}                          — relay restarted; the
 *           per-chat_id counter reset to 1, so a client holding last_id=N would
 *           starve waiting for id>N. Drop last_id and reconnect with ?last_id=0.
 *   Forward-compat: any unknown frame `type` is silently ignored so a newer relay
 *   can add frame kinds without breaking an older dashboard build.
 */

// Minimal window surface — mirrors useEventStream so node/jsdom test envs that
// lack a full lib.dom EventSource don't trip the import.
declare const window:
  | {
      EventSource: typeof EventSource;
    }
  | undefined;

/** A single inbound SSE frame from the bridge (known frame kinds only). */
export interface BridgeFrame {
  type: 'reply' | 'ack' | 'error' | 'mirror' | 'restart';
  chat_id: string;
  text?: string;
  ts: string;
  /** Present on `mirror` frames: 'user'|'assistant'|'activity'. */
  role?: string;
  /** Present on `mirror` frames: per-chat_id monotonic server counter. */
  id?: number;
}

/**
 * Role of a rendered conversation turn.
 *   user/assistant — typed turns AND mirrored CC-session prose
 *   activity       — mirrored curated tool/dispatch row (v2)
 *   ack/error      — dashboard-typed status frames
 */
export type BridgeRole = 'user' | 'assistant' | 'activity' | 'ack' | 'error';

/** One rendered turn in the conversation view. */
export interface BridgeMessage {
  /** Stable client-side id (monotonic) for React keys. */
  id: number;
  role: BridgeRole;
  text: string;
  ts: string;
  /**
   * Server-assigned per-chat_id id for `mirror`-sourced turns (undefined for
   * locally-minted user echoes and dashboard reply/ack/error turns). Used to
   * track the high-water mark for ?last_id replay.
   */
  serverId?: number;
}

/** Connection lifecycle of the SSE stream. */
export type BridgeStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface UseBridgeResult {
  messages: BridgeMessage[];
  /** SSE connection status. */
  status: BridgeStatus;
  /** True between a send() and the next reply/ack/error frame for this chat. */
  awaitingReply: boolean;
  /** True once the server has minted (or we have adopted) a chat_id. */
  chatId: string | null;
  /** POST a user message to the live CC session. No-op for empty input. */
  send: (text: string) => Promise<void>;
  /** Last transient send error (network / HTTP), cleared on the next send. */
  sendError: string | null;
}

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 5_000;
const STREAM_PATH = '/dashboard/api/bridge/stream';
/** After this many consecutive onerror events with no successful onopen, surface 'error' status. */
const ERROR_AFTER_FAILURES = 4;
const POST_PATH = '/dashboard/api/bridge';
const POST_TIMEOUT_MS = 30_000;

/** HTTP status → human-readable send error, matching backend semantics. */
function postErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return 'message rejected — invalid or empty';
    case 429:
      return 'rate limited — slow down';
    case 503:
      return 'no live Claude Code session — start `gossipcat code`';
    case 401:
      return 'session expired — reload to re-authenticate';
    default:
      return `send failed — HTTP ${status}`;
  }
}

let nextMessageId = 1;
function makeMessage(role: BridgeRole, text: string, ts?: string, serverId?: number): BridgeMessage {
  return { id: nextMessageId++, role, text, ts: ts ?? new Date().toISOString(), serverId };
}

/**
 * Insert a message keeping the list ordered by server-stamped `ts` (ascending).
 * Mirror frames and dashboard reply/ack/error frames arrive on the same stream
 * but are not guaranteed to be globally ordered, so we interleave by ts.
 *
 * Optimistic local user echoes (no serverId, ts = client clock) are appended in
 * arrival order: we only reorder when the incoming frame's ts is strictly older
 * than the last turn, so a normal forward-moving stream stays append-only.
 */
function insertByTs(prev: readonly BridgeMessage[], msg: BridgeMessage): BridgeMessage[] {
  const last = prev[prev.length - 1];
  if (!last || msg.ts >= last.ts) return [...prev, msg];
  // Out-of-order arrival: find the first turn strictly newer than msg and splice before it.
  const idx = prev.findIndex((m) => m.ts > msg.ts);
  if (idx < 0) return [...prev, msg];
  return [...prev.slice(0, idx), msg, ...prev.slice(idx)];
}

export function useBridge(): UseBridgeResult {
  const [messages, setMessages] = useState<BridgeMessage[]>([]);
  const [status, setStatus] = useState<BridgeStatus>('connecting');
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // chat_id is read inside the EventSource onmessage closure (created once in the
  // mount effect) and written by send(). A ref keeps the frame filter reading the
  // latest value without re-opening the stream on every chat_id change.
  const chatIdRef = useRef<string | null>(null);
  const setChat = useCallback((id: string) => {
    chatIdRef.current = id;
    setChatId(id);
  }, []);

  // Highest mirror `id` seen for the active chat. Read on each (re)connect to
  // build ?last_id (mirrors useEventStream's read-on-open pattern so a reconnect
  // replays only the gap). Reset to 0 on a `restart` frame (server counter reset)
  // and a manual reconnect is triggered so the client doesn't starve on id>N.
  const lastMirrorIdRef = useRef(0);
  // Set by a `restart` frame to ask the open EventSource to close + reopen with
  // ?last_id=0. Read by onerror's reconnect path is not enough (no error fires),
  // so restart calls the captured reconnect() directly.
  const reconnectRef = useRef<(() => void) | null>(null);

  // ── SSE stream: open once, manual reconnect, filter frames to active chat ──
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') return;

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = BACKOFF_MIN_MS;
    let destroyed = false;
    let consecutiveFailures = 0;

    function open(): void {
      if (destroyed) return;
      setStatus('connecting');
      // Re-read the high-water mark on each (re)connect so a reconnect replays
      // only the gap (id > lastSeen), per spec §3 / P1#3. ?last_id mirrors the
      // working pattern in useEventStream.ts.
      const lastId = lastMirrorIdRef.current;
      es = new window!.EventSource(`${STREAM_PATH}?last_id=${lastId}`);

      es.onopen = () => {
        if (destroyed) return;
        consecutiveFailures = 0;
        setStatus('open');
        backoff = BACKOFF_MIN_MS;
      };

      es.onmessage = (evt: MessageEvent) => {
        let frame: BridgeFrame;
        try {
          frame = JSON.parse(evt.data);
        } catch {
          return; // malformed frame — skip
        }
        // Filter to the active conversation. Before our first send chatIdRef is
        // null and we have no stream to claim, so ignore frames until then.
        // Mirror frames carry chat_id too — the same filter applies.
        const active = chatIdRef.current;
        if (!active || frame.chat_id !== active) return;

        if (frame.type === 'reply') {
          setAwaitingReply(false);
          setMessages((prev) => insertByTs(prev, makeMessage('assistant', frame.text ?? '', frame.ts)));
        } else if (frame.type === 'ack') {
          // Ack means "received / working" — keep the awaiting indicator on but
          // record a discrete ack turn so the user sees the session is alive.
          setMessages((prev) => insertByTs(prev, makeMessage('ack', 'received — working…', frame.ts)));
        } else if (frame.type === 'error') {
          setAwaitingReply(false);
          setMessages((prev) =>
            insertByTs(prev, makeMessage('error', frame.text ?? 'the live session reported an error', frame.ts))
          );
        } else if (frame.type === 'mirror') {
          handleMirrorFrame(frame);
        } else if (frame.type === 'restart') {
          // Relay restarted → per-chat_id counter reset to 1. Drop our high-water
          // mark and reconnect with ?last_id=0 so we don't starve on id>previous.
          lastMirrorIdRef.current = 0;
          reconnectRef.current?.();
        }
        // Forward-compat: any other frame.type is silently ignored (staged rollout).
      };

      es.onerror = () => {
        if (es) {
          es.close();
          es = null;
        }
        if (destroyed) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= ERROR_AFTER_FAILURES) {
          setStatus('error');
        } else {
          setStatus('connecting');
        }
        retryTimer = setTimeout(() => open(), backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      };
    }

    /** Append a `mirror` frame as a turn, tracking the high-water id. */
    function handleMirrorFrame(frame: BridgeFrame): void {
      const role = frame.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'activity') {
        return; // unknown mirror role — ignore (forward-compat with future roles)
      }
      if (typeof frame.id === 'number' && frame.id > lastMirrorIdRef.current) {
        lastMirrorIdRef.current = frame.id;
      }
      // An assistant mirror frame is the live session answering — clear the
      // awaiting indicator so a typed turn's spinner doesn't linger.
      if (role === 'assistant') setAwaitingReply(false);
      // Coerce text defensively: a malformed relay payload could carry a
      // non-string `text` (object/number), which would throw in the downstream
      // .trim()/.replace() renderers. `?? ''` only guards null/undefined.
      const text = typeof frame.text === 'string' ? frame.text : '';
      setMessages((prev) => insertByTs(prev, makeMessage(role, text, frame.ts, frame.id)));
    }

    /** Close + reopen the stream immediately (used by the `restart` frame). */
    function reconnect(): void {
      if (destroyed) return;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (es) {
        es.close();
        es = null;
      }
      backoff = BACKOFF_MIN_MS;
      open();
    }
    reconnectRef.current = reconnect;

    open();

    return () => {
      destroyed = true;
      reconnectRef.current = null;
      setStatus('closed');
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (es) {
        es.close();
        es = null;
      }
    };
  }, []);

  const send = useCallback(
    async (raw: string): Promise<void> => {
      const text = raw.trim();
      if (text.length === 0) return;

      setSendError(null);
      // Optimistically render the user's turn immediately.
      setMessages((prev) => [...prev, makeMessage('user', text)]);
      setAwaitingReply(true);

      // Reuse the conversation's chat_id once minted; omit on the first send so
      // the server mints one and returns it.
      const existing = chatIdRef.current;
      const body: { message: string; chat_id?: string } = { message: text };
      if (existing) body.chat_id = existing;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      try {
        const res = await fetch(POST_PATH, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        // The backend returns chat_id on 202 AND on 503 (so a retry can reuse
        // the same conversation). Adopt it whenever present.
        let payload: { ok?: boolean; chat_id?: string; error?: string } = {};
        try {
          payload = await res.json();
        } catch {
          /* non-JSON body — fall through to status-based handling */
        }
        if (typeof payload.chat_id === 'string' && payload.chat_id.length > 0 && !chatIdRef.current) {
          setChat(payload.chat_id);
        }

        if (res.status === 202) return;

        // Non-2xx: surface the error, stop the awaiting indicator.
        setAwaitingReply(false);
        setSendError(payload.error ?? postErrorMessage(res.status));
      } catch (err) {
        setAwaitingReply(false);
        const aborted = err instanceof Error && err.name === 'AbortError';
        setSendError(aborted ? 'send timed out — relay unreachable' : 'send failed — relay unreachable');
      } finally {
        clearTimeout(timer);
      }
    },
    [setChat]
  );

  return { messages, status, awaitingReply, chatId, send, sendError };
}
