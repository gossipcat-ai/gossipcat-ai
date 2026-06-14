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
 *   GET  /dashboard/api/bridge/stream  (SSE)
 *     → frames {type:'reply'|'ack'|'error', chat_id, text?, ts}
 */

// Minimal window surface — mirrors useEventStream so node/jsdom test envs that
// lack a full lib.dom EventSource don't trip the import.
declare const window:
  | {
      EventSource: typeof EventSource;
    }
  | undefined;

/** A single inbound SSE frame from the bridge. */
export interface BridgeFrame {
  type: 'reply' | 'ack' | 'error';
  chat_id: string;
  text?: string;
  ts: string;
}

/** Role of a rendered conversation turn. */
export type BridgeRole = 'user' | 'assistant' | 'ack' | 'error';

/** One rendered turn in the conversation view. */
export interface BridgeMessage {
  /** Stable client-side id (monotonic) for React keys. */
  id: number;
  role: BridgeRole;
  text: string;
  ts: string;
}

/** Connection lifecycle of the SSE stream. */
export type BridgeStatus = 'connecting' | 'open' | 'closed';

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
function makeMessage(role: BridgeRole, text: string, ts?: string): BridgeMessage {
  return { id: nextMessageId++, role, text, ts: ts ?? new Date().toISOString() };
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

  // ── SSE stream: open once, manual reconnect, filter frames to active chat ──
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') return;

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = BACKOFF_MIN_MS;
    let destroyed = false;

    function open(): void {
      if (destroyed) return;
      setStatus('connecting');
      es = new window!.EventSource(STREAM_PATH);

      es.onopen = () => {
        if (destroyed) return;
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
        const active = chatIdRef.current;
        if (!active || frame.chat_id !== active) return;

        if (frame.type === 'reply') {
          setAwaitingReply(false);
          setMessages((prev) => [...prev, makeMessage('assistant', frame.text ?? '', frame.ts)]);
        } else if (frame.type === 'ack') {
          // Ack means "received / working" — keep the awaiting indicator on but
          // record a discrete ack turn so the user sees the session is alive.
          setMessages((prev) => [...prev, makeMessage('ack', 'received — working…', frame.ts)]);
        } else if (frame.type === 'error') {
          setAwaitingReply(false);
          setMessages((prev) => [
            ...prev,
            makeMessage('error', frame.text ?? 'the live session reported an error', frame.ts),
          ]);
        }
      };

      es.onerror = () => {
        if (es) {
          es.close();
          es = null;
        }
        if (destroyed) return;
        setStatus('connecting');
        retryTimer = setTimeout(() => open(), backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      };
    }

    open();

    return () => {
      destroyed = true;
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
