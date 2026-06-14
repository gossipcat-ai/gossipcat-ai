import { useEffect, useRef, useState } from 'react';
import { useBridgeContext } from '@/lib/BridgeContext';
import { MessageBubble, StatusDot, AwaitingDots } from '@/components/chat/ChatPrimitives';
import { ChatEmptyState } from '@/components/chat/ChatEmptyState';

/**
 * ChatPage — full-page routed view for the dashboard ⇄ Claude Code bridge.
 *
 * Shares the SAME bridge conversation as the bottom-right launcher via
 * BridgeContext (single useBridge() instance). Navigating here does NOT open a
 * new session — it shows the same live messages as the popover.
 *
 * Layout: centered max-w-3xl column with a two-column header row (title + session
 * strip). Below: a bordered transcript region (flex-1, fills viewport minus topbar
 * and header) with the composer pinned at the bottom inside the column. On lg+
 * screens the session-info strip sits in-line at the header level.
 *
 * DESIGN.md conformance:
 *   - .h-route Fraunces serif title (route level, not section).
 *   - Section sub-header uses .h-section small-caps Geist.
 *   - --accent terracotta only on the Send button (primary CTA).
 *   - Status is semantic: --ok open, --warn connecting, --bad error, --idle closed.
 *   - JetBrains Mono for chat_id and timestamps; Geist body for message text.
 *   - Hairline --border card; no drop shadow (DESIGN.md: no shadows by default).
 *   - Page padding: --s-7 vertical (48px top), --s-6 horizontal (32px); composer
 *     area gets 24px bottom so the column breathes.
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

  /** Prefill the composer from an example chip click. */
  const prefill = (text: string) => {
    setDraft(text);
    inputRef.current?.focus();
  };

  const hasMessages = messages.length > 0;

  return (
    /*
     * Outer shell: full viewport height minus topbar (~56px), padded at top.
     * Uses flex-col so the inner column can stretch to fill.
     */
    <div
      className="flex flex-col"
      style={{
        minHeight: 'calc(100vh - 56px)',
        padding: '48px 32px 32px',
        boxSizing: 'border-box',
      }}
    >
      {/*
       * Centered column — max-w-3xl (768px) keeps prose readable;
       * flex-col + flex-1 lets transcript region fill remaining height.
       */}
      <div
        className="mx-auto flex w-full flex-col"
        style={{ maxWidth: '768px', flex: 1 }}
      >
        {/* ── Page header ── */}
        <div className="mb-5 flex flex-col gap-1 lg:flex-row lg:items-baseline lg:justify-between">
          <div>
            <h1 className="h-route">Chat</h1>
            <p
              className="mt-1 text-[14px]"
              style={{ color: 'var(--ink-3)' }}
            >
              Steer the live Claude Code session running in your terminal.
            </p>
          </div>

          {/* Session info strip — shows at lg+ inline; stacks below on narrow */}
          <div
            className="flex items-center gap-3 rounded-lg px-3 py-2 lg:shrink-0"
            style={{
              background: 'var(--surface-elev)',
              border: '1px solid var(--border)',
              alignSelf: 'flex-start',
            }}
          >
            <StatusDot status={status} compact={false} />
            {chatId && (
              <span
                className="font-mono text-[11px]"
                style={{ color: 'var(--ink-3)' }}
              >
                {chatId.slice(0, 8)}
              </span>
            )}
            <span
              className="hidden text-[12px] lg:inline"
              style={{ color: 'var(--ink-3)' }}
            >
              · same session as your terminal
            </span>
          </div>
        </div>

        {/*
         * Transcript card — the contained surface.
         * flex-1 fills remaining height; inner flex-col stacks
         * scrollable messages above a pinned composer.
         */}
        <div
          className="flex flex-col"
          style={{
            flex: 1,
            minHeight: 0,
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-lg)',
            background: 'var(--surface-elev)',
            overflow: 'hidden',
          }}
        >
          {/* Scrollable transcript */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto"
            style={{
              padding: '20px 20px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            {!hasMessages ? (
              <ChatEmptyState status={status} onChipClick={prefill} />
            ) : (
              <>
                {messages.map((m) => (
                  <MessageBubble key={m.id} msg={m} compact={false} />
                ))}
                {awaitingReply && <AwaitingDots compact={false} />}
              </>
            )}
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
      </div>
    </div>
  );
}
