import { useEffect, useRef, useState } from 'react';
import { useBridge, type BridgeMessage } from '@/lib/useBridge';

/**
 * ChatDock — bottom-right docked conversation panel wired to the LIVE Claude
 * Code orchestrator session over the P1 bridge (spec
 * 2026-06-14-dashboard-cc-channel-bridge.md).
 *
 * This is the SAME session running in the terminal — typing here reaches the
 * live orchestrator; its replies stream back over SSE. It is explicitly NOT the
 * dormant ChatbotAgent /api/chat brain (never wired here).
 *
 * DESIGN.md conformance:
 *   - Terracotta --accent is reserved for the send CTA + the collapsed launcher
 *     (a primary action), NEVER on chat chrome / bubbles / status.
 *   - Status is semantic: --ok (open), --warn (connecting), --bad (error),
 *     --idle (closed). Connection chip + error turns use these only.
 *   - Section label uses the small-caps Geist .h-section signature.
 *   - Hairline --border, --r-lg card, NO drop shadow (the dock floats with the
 *     project's existing --shadow-card token, consistent with NotificationStack).
 *   - JetBrains Mono (--font-mono) for the chat_id + timestamps; Geist body for
 *     message text.
 *
 * Placement: fixed bottom-right launcher that expands into a panel, mirroring
 * NotificationStack's fixed bottom-right anchor (it sits to the LEFT of the
 * toast lane so the two don't overlap). Alternative considered: a persistent
 * right rail — rejected because the dashboard's hero/grid already owns full
 * width and a rail would force a layout reflow on every route. A collapsible
 * dock is non-invasive and matches the "complements the terminal" intent.
 */

function timeShort(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function MessageBubble({ msg }: { msg: BridgeMessage }) {
  const isUser = msg.role === 'user';
  const isError = msg.role === 'error';
  const isAck = msg.role === 'ack';

  // Ack is a centered system note, not a bubble.
  if (isAck) {
    return (
      <div className="flex justify-center py-0.5">
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px]"
          style={{
            color: 'var(--idle)',
            background: 'color-mix(in oklch, var(--idle) 12%, transparent)',
          }}
        >
          {msg.text}
        </span>
      </div>
    );
  }

  const bubbleStyle = isError
    ? {
        color: 'var(--bad)',
        background: 'color-mix(in oklch, var(--bad) 10%, transparent)',
        border: '1px solid color-mix(in oklch, var(--bad) 30%, transparent)',
      }
    : isUser
      ? {
          color: 'var(--text)',
          background: 'var(--surface-sunk)',
          border: '1px solid var(--border)',
        }
      : {
          color: 'var(--text)',
          background: 'var(--surface-elev)',
          border: '1px solid var(--border)',
        };

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} gap-0.5`}>
      <div
        className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[13px] leading-snug"
        style={bubbleStyle}
      >
        {isError && (
          <span className="h-section mb-0.5 block" style={{ color: 'var(--bad)' }}>
            session error
          </span>
        )}
        {msg.text}
      </div>
      <span className="px-1 font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
        {timeShort(msg.ts)}
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: ReturnType<typeof useBridge>['status'] }) {
  const map: Record<string, { color: string; label: string }> = {
    open: { color: 'var(--ok)', label: 'live' },
    connecting: { color: 'var(--warn)', label: 'connecting' },
    closed: { color: 'var(--idle)', label: 'offline' },
    error: { color: 'var(--bad)', label: 'relay down' },
  };
  const { color, label } = map[status] ?? map['closed'];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${status === 'connecting' ? 'animate-pulse' : ''}`}
        style={{ background: color }}
        aria-hidden
      />
      <span className="font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
        {label}
      </span>
    </span>
  );
}

export function ChatDock() {
  const [openPanel, setOpenPanel] = useState(false);
  const [draft, setDraft] = useState('');
  const { messages, status, awaitingReply, chatId, send, sendError } = useBridge();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-scroll to the newest turn whenever the conversation grows or the
  // working indicator toggles.
  useEffect(() => {
    if (!openPanel) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, awaitingReply, openPanel]);

  useEffect(() => {
    if (openPanel) inputRef.current?.focus();
  }, [openPanel]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    void send(text);
    setDraft('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline (multi-line steering prompts).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // ── Collapsed launcher ──
  if (!openPanel) {
    return (
      <button
        type="button"
        onClick={() => setOpenPanel(true)}
        className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors"
        style={{ background: 'var(--accent)', color: 'var(--accent-foreground, #fff)' }}
        aria-label="Open live Claude Code chat"
        data-tooltip="Talk to the live Claude Code session"
        data-tooltip-pos="right"
      >
        <span aria-hidden>◎</span>
        <span>Live session</span>
      </button>
    );
  }

  // ── Expanded panel ──
  return (
    <div
      className="fixed bottom-4 left-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col rounded-xl"
      style={{
        height: 'min(560px, calc(100vh - 2rem))',
        background: 'var(--surface-elev)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-card)',
      }}
      role="region"
      aria-label="Live Claude Code session chat"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="h-section">live claude code</span>
            <StatusDot status={status} />
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
            {chatId ? `chat ${chatId.slice(0, 8)}` : 'same session as your terminal'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpenPanel(false)}
          className="shrink-0 rounded px-2 py-1 text-sm leading-none transition-colors hover:[background:var(--surface-sunk)]"
          style={{ color: 'var(--text-dim)' }}
          aria-label="Collapse chat dock"
        >
          –
        </button>
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
              {status === 'connecting' ? 'connecting to the live session…' : 'no messages yet'}
            </div>
            <div className="mt-1 text-[11px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}>
              Type below to steer or start work. This reaches the same Claude Code session running in your terminal.
            </div>
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} msg={m} />)
        )}

        {awaitingReply && (
          <div className="flex items-center gap-2 px-1 py-1">
            <span className="inline-flex gap-1" aria-hidden>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'var(--text-faint)' }} />
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
              working…
            </span>
          </div>
        )}
      </div>

      {/* Transient send error */}
      {sendError && (
        <div
          role="alert"
          className="mx-3 mb-1 rounded-sm px-2 py-1 font-mono text-[10px]"
          style={{
            color: 'var(--bad)',
            background: 'color-mix(in oklch, var(--bad) 10%, transparent)',
            border: '1px solid color-mix(in oklch, var(--bad) 30%, transparent)',
          }}
        >
          {sendError}
        </div>
      )}

      {/* Composer */}
      <div className="flex items-end gap-2 border-t px-3 py-3" style={{ borderColor: 'var(--border)' }}>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Message the live session…  (Enter to send)"
          className="max-h-28 min-h-[36px] flex-1 resize-none rounded-md border px-3 py-2 text-[13px] focus:outline-none"
          style={{
            background: 'var(--surface)',
            color: 'var(--text)',
            borderColor: 'var(--border)',
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={draft.trim().length === 0}
          className="shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-opacity disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'var(--accent-foreground, #fff)' }}
          aria-label="Send message"
        >
          Send
        </button>
      </div>
    </div>
  );
}
