/**
 * api-chat.ts — SSE seam for the dashboard chatbot (MVP-0, P2a).
 *
 * `handleChat` is reached only after the dashboard router has verified auth
 * (cookie or Bearer) — same contract as handleEventsSSE. It opens a
 * text/event-stream (mirroring api-events.ts headers), then drives the
 * injected `ChatbotAgent.turnStream` and forwards each event as an SSE frame.
 *
 * Invariants:
 *  - The `message` and `conversationId` in `body` are UNTRUSTED HTTP input.
 *    `message` must be a non-empty string or we 400 BEFORE opening the stream.
 *  - `chatbot == null` (no LLM provider configured) is a graceful-degrade path:
 *    emit an `error` event + `done`, then end. Never a 5xx.
 *  - The handler NEVER throws: the whole turn is wrapped so any failure becomes
 *    an `error` SSE event followed by stream close.
 *  - `req.on('close')` stops iteration cooperatively (a flag the loop checks),
 *    so a disconnecting client doesn't keep the generator (and its tool calls)
 *    running unbounded.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { ChatbotAgent } from '@gossip/orchestrator';
import type { LLMMessage } from '@gossip/types';
import type { ChatConversationStore } from './chat-session-store';

export interface ChatRequestBody {
  conversationId?: string | null;
  message: string;
}

/** Upper bound on a client-supplied conversationId (UUIDs are 36 chars). */
const MAX_CONVERSATION_ID_LENGTH = 128;

export interface HandleChatDeps {
  chatbot: ChatbotAgent | null;
  store: ChatConversationStore;
}

/** SSE headers — identical posture to api-events.ts handleEventsSSE. */
function writeSseHead(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/** Serialize one event as an SSE `data:` frame. */
function sse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  deps: HandleChatDeps,
): Promise<void> {
  // Trust boundary: validate untrusted body BEFORE opening the SSE stream so an
  // invalid request gets a plain 400 JSON response (no half-open event-stream).
  const b = (body ?? {}) as Partial<ChatRequestBody>;
  const message = b.message;
  if (typeof message !== 'string' || message.trim().length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'message must be a non-empty string' }));
    return;
  }
  // conversationId is optional; coerce anything non-string to null so the store
  // mints a fresh id rather than keying off attacker-controlled junk. A string
  // id is bounded — an over-long id is rejected (400) BEFORE opening the stream
  // so it can't be used to bloat the store's keyspace.
  const rawConvId = b.conversationId;
  if (typeof rawConvId === 'string' && rawConvId.length > MAX_CONVERSATION_ID_LENGTH) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'conversationId too long' }));
    return;
  }
  const conversationId = typeof rawConvId === 'string' && rawConvId.length > 0 ? rawConvId : null;

  // Cooperative cancellation: flip on client disconnect, checked in the loop.
  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  writeSseHead(res);

  // Single getOrCreate: capture both the (possibly minted) id and the existing
  // history in one lookup. A second call would redundantly stamp lastTouched and
  // re-run eviction.
  const { id, messages: history } = deps.store.getOrCreate(conversationId);
  // First frame always tells the client which conversation this turn belongs to
  // (especially important when the server minted a new id).
  sse(res, { type: 'conversation', conversationId: id });

  // Graceful degrade: no provider configured.
  if (!deps.chatbot) {
    sse(res, { type: 'error', message: 'Chat unavailable — no LLM provider configured' });
    sse(res, { type: 'done', text: '' });
    res.end();
    return;
  }

  try {
    let assistantText = '';
    // Track terminal state so we only persist a turn that actually completed.
    // A yielded `error` event (vs a thrown error) ends the for-await normally,
    // so without these flags we'd persist an empty assistant message.
    let sawDone = false;
    let sawError = false;

    for await (const ev of deps.chatbot.turnStream(message, history)) {
      if (clientGone) break;
      if (ev.type === 'done') {
        // Capture the final assistant text so we can persist the turn.
        sawDone = true;
        assistantText = ev.text;
      } else if (ev.type === 'error') {
        sawError = true;
      }
      sse(res, ev);
    }

    // A stream that yielded `error` but never `done` left the client without a
    // terminal frame. Emit one so the client's stream state machine always ends
    // cleanly (mirrors the throw path in the catch below). Skip if the client
    // already disconnected.
    if (sawError && !sawDone && !clientGone) {
      sse(res, { type: 'done', text: '' });
    }

    // Persist the turn (user + assistant) only on a clean completion: the client
    // is still attached AND the stream reached `done` without an `error`. A
    // disconnected client (partial/aborted turn) or an error stream must NOT
    // poison history — in particular, an error-only stream would otherwise
    // append an empty assistant message.
    if (sawDone && !sawError && !clientGone) {
      const userMsg: LLMMessage = { role: 'user', content: message };
      const assistantMsg: LLMMessage = { role: 'assistant', content: assistantText };
      deps.store.append(id, [userMsg, assistantMsg]);
    }
  } catch (err) {
    // NEVER throw out of the handler — surface as a terminal error event, then a
    // terminal `done` so the client's stream state machine always sees an end
    // frame (the yielded-error path emits its own done; this is the throw path).
    try {
      sse(res, { type: 'error', message: String(err) });
      sse(res, { type: 'done', text: '' });
    } catch { /* socket already gone */ }
  } finally {
    try { res.end(); } catch { /* already ended */ }
  }
}
