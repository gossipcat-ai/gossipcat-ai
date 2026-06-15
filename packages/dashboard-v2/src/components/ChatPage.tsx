import { useEffect, useRef, useState } from 'react';
import { useBridgeContext } from '@/lib/BridgeContext';
import { AwaitingDots } from '@/components/chat/ChatPrimitives';
import { Transcript } from '@/components/chat/Transcript';
import { SessionRail } from '@/components/chat/SessionRail';

/**
 * ChatPage — operator command surface for the dashboard ⇄ Claude Code bridge.
 *
 * TWO-COLUMN LAYOUT (lg+):
 *   LEFT  — chat column: transcript card + composer (fills available width)
 *   RIGHT — SessionRail: ~280-320px hairline card with connection status and
 *           live SSE activity feed.
 *   On <lg screens the rail stacks below the chat column (never overlaps).
 *
 * Shares the SAME bridge conversation as the bottom-right launcher via
 * BridgeContext (single useBridge() instance). Navigating here does NOT open a
 * new session — it shows the same live messages as the popover.
 *
 * DESIGN.md conformance:
 *   - .h-route Fraunces serif title (route level, not section).
 *   - .h-section small-caps Geist for rail section labels (in SessionRail).
 *   - --accent terracotta ONLY on the Send button (primary CTA).
 *   - Status is semantic: --ok open, --warn connecting, --bad error, --idle closed.
 *   - JetBrains Mono for chat_id and timestamps; Geist body for message text.
 *   - Hairline --border card; no drop shadow (DESIGN.md: no shadows by default).
 *   - prefers-reduced-motion: animate-pulse gets motion-reduce:animate-none.
 */

export function ChatPage() {
  const { messages, status, awaitingReply, chatId, send, sendError } = useBridgeContext();
  const [draft, setDraft] = useState('');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-scroll to the newest turn whenever the conversation grows or the
  // awaiting indicator toggles.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, awaitingReply]);

  // Focus composer on page mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    void send(text);
    setDraft('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    /*
     * Outer shell: full viewport height minus topbar (~56px), padded at top.
     * flex-col so children can stretch to fill remaining height.
     */
    <div
      className="flex flex-col"
      style={{
        minHeight: 'calc(100vh - 56px)',
        padding: '48px 32px 32px',
        boxSizing: 'border-box',
      }}
    >
      {/* ── Page header ── */}
      <div className="mb-5 flex flex-col gap-1">
        <h1 className="h-route">Chat</h1>
        <p
          className="mt-1 text-[14px]"
          style={{ color: 'var(--ink-3)' }}
        >
          Steer the live Claude Code session running in your terminal.
        </p>
      </div>

      {/*
       * Two-column grid on lg+:
       *   - Left (1fr): chat transcript + composer
       *   - Right (300px): SessionRail
       * On <lg: single column, rail stacks below chat.
       * align-items: stretch ensures both columns share the same row height.
       */}
      <div
        className="flex flex-col gap-5 lg:grid"
        style={{
          flex: 1,
          minHeight: 0,
          // Named grid tracks so the rail can't accidentally shrink below 280px
          // or overflow above 320px on large screens.
          gridTemplateColumns: '1fr 300px',
          alignItems: 'stretch',
        }}
      >
        {/*
         * LEFT — Transcript card.
         * flex + flex-col + flex-1 inside lets the scroll region expand to fill
         * the full column height.
         */}
        <div
          className="chat-surface flex flex-col"
          style={{
            minHeight: 0,
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-lg)',
            overflow: 'hidden',
          }}
        >
          {/* Scrollable transcript — flowing CC-transcript view (activity-mirror v2) */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto"
            style={{
              padding: '20px 20px 8px',
              // Ensure the scroll region fills the card height so the composer
              // stays pinned at the bottom even when there are few messages.
              minHeight: 0,
            }}
          >
            <Transcript messages={messages} status={status} />
            {awaitingReply && <AwaitingDots compact={false} />}
          </div>

          {/* Transient send error — sits between transcript and composer */}
          {sendError && (
            <div
              role="alert"
              className="mx-5 mb-2 rounded px-3 py-1.5 font-mono text-[11px]"
              style={{
                color: 'var(--bad)',
                background: 'color-mix(in oklch, var(--bad) 10%, transparent)',
                border: '1px solid color-mix(in oklch, var(--bad) 30%, transparent)',
              }}
            >
              {sendError}
            </div>
          )}

          {/* Composer — pinned at bottom of the card */}
          <div
            className="flex items-end gap-3 border-t"
            style={{
              borderColor: 'var(--border)',
              padding: '16px 20px',
              background: 'var(--surface-elev)',
            }}
          >
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              placeholder="Message the live session…  (Enter to send, Shift+Enter for newline)"
              className="max-h-40 flex-1 resize-none rounded-lg border px-4 py-3 text-[14px] focus:outline-none focus:ring-2"
              style={{
                background: 'var(--surface)',
                color: 'var(--text)',
                borderColor: 'var(--border)',
                minHeight: '64px',
                '--tw-ring-color': 'color-mix(in oklch, var(--accent) 30%, transparent)',
              } as React.CSSProperties}
            />
            <button
              type="button"
              onClick={submit}
              disabled={draft.trim().length === 0}
              className="shrink-0 rounded-lg px-5 py-3 text-[14px] font-medium transition-opacity disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'var(--accent-foreground, #fff)' }}
              aria-label="Send message"
            >
              Send
            </button>
          </div>
        </div>

        {/*
         * RIGHT — SessionRail.
         * Extracts connection + live activity feed so ChatPage stays lean.
         * Stacks below on <lg (grid collapses to 1 col via flex-col fallback).
         */}
        <SessionRail status={status} chatId={chatId} />
      </div>
    </div>
  );
}
