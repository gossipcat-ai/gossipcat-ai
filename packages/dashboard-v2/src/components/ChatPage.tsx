import { useEffect, useRef, useState } from 'react';
import { useBridgeContext } from '@/lib/BridgeContext';
import { AwaitingDots } from '@/components/chat/ChatPrimitives';
import { Transcript } from '@/components/chat/Transcript';
import { SessionRail } from '@/components/chat/SessionRail';

/**
 * ChatPage — operator command surface for the dashboard ⇄ Claude Code bridge.
 *
 * LAYOUT: fixed height: calc(100vh - 56px) so the page itself NEVER scrolls.
 * Only the transcript region and the rail's activity feed scroll internally.
 *
 * Two-column on lg+:
 *   LEFT  — chat card: compact info-bar + transcript (flex-1, overflow-y:auto) + composer
 *   RIGHT — SessionRail: ~288px — working agents + activity feed
 *
 * Shares the SAME bridge conversation as the bottom-right launcher via
 * BridgeContext (single useBridge() instance).
 *
 * DESIGN.md conformance (2026-06-15 dark carve-out):
 *   - .chat-surface scoped dark warm-charcoal tokens inside the card.
 *   - Info-bar: Geist 600 small-caps "Chat" + semantic status dot + JetBrains
 *     Mono chat_id (truncated) + git branch + 24h signals. NO Fraunces here.
 *   - Send button: --accent terracotta bg + paper-plane SVG icon (primary CTA).
 *   - Composer textarea: inner hairline border, focus glow (accent 30% ring).
 *   - StatusDot semantic: --ok open / --warn connecting / --bad error / --idle closed.
 *   - Hairline --border card; no drop shadows (DESIGN.md).
 *   - prefers-reduced-motion honored by animate-pulse → motion-reduce:animate-none.
 */

export function ChatPage() {
  const { messages, status, awaitingReply, chatId, send, sendError } = useBridgeContext();
  const [draft, setDraft] = useState('');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-scroll to newest turn when conversation grows or awaiting indicator toggles.
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Semantic status dot color + label
  const statusMap: Record<string, { color: string; label: string }> = {
    open: { color: 'var(--ok)', label: 'live' },
    connecting: { color: 'var(--warn)', label: 'connecting' },
    closed: { color: 'var(--idle)', label: 'offline' },
    error: { color: 'var(--bad)', label: 'down' },
  };
  const { color: dotColor, label: statusLabel } = statusMap[status] ?? statusMap['closed'];

  return (
    /*
     * Shell: fills its parent (App renders /chat inside a full-height flex
     * main, so the shell is height:100% — NOT a hardcoded 100vh-56px, which
     * overshot because the topbar is 69px and main added its own padding).
     * Internal-only scroll: page body.scrollHeight must NOT exceed innerHeight.
     */
    <div
      className="flex flex-col"
      style={{
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        padding: '16px 24px',
        boxSizing: 'border-box',
        gap: '0',
      }}
    >
      {/*
       * Two-column grid on lg+; single column (<lg) with rail below.
       * flex-1 + min-height:0 lets the columns fill remaining height after padding.
       */}
      <div
        className="flex flex-col gap-4 lg:grid"
        style={{
          flex: 1,
          minHeight: 0,
          gridTemplateColumns: '1fr 288px',
          alignItems: 'stretch',
          height: '100%',
        }}
      >
        {/* ── LEFT: Chat card ── */}
        <div
          className="chat-surface flex flex-col"
          style={{
            minHeight: 0,
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-lg)',
            overflow: 'hidden',
          }}
        >
          {/*
           * Info-bar (~44px): compact route label + status dot + chat_id + branch + signals.
           * NOT the big .h-route Fraunces title — that wastes ~120px.
           * Design: Geist 600 small-caps "chat" label | semantic dot | mono chat_id | meta
           */}
          <div
            className="chat-info-bar flex items-center gap-3 shrink-0"
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--border)',
              background: 'color-mix(in srgb, var(--surface) 80%, var(--bg))',
              minHeight: '44px',
              flexWrap: 'wrap',
              rowGap: '4px',
            }}
          >
            {/* Route label — small-caps Geist, not Fraunces (info density, not hero) */}
            <span className="h-section h-section--lg shrink-0">
              chat
            </span>

            {/* Divider */}
            <span
              aria-hidden
              style={{ width: '1px', height: '20px', background: 'var(--border)', flexShrink: 0 }}
            />

            {/* Semantic live status dot + label */}
            <span className="inline-flex items-center gap-1.5 shrink-0">
              <span
                className={`inline-block h-2 w-2 rounded-full shrink-0 ${status === 'connecting' ? 'animate-pulse motion-reduce:animate-none' : ''}`}
                style={{ background: dotColor }}
                aria-hidden
              />
              <span
                className="font-mono text-[11px]"
                style={{ color: 'var(--ink-3)' }}
                aria-label={`Bridge status: ${statusLabel}`}
              >
                {statusLabel}
              </span>
            </span>

            {/* chat_id — truncated JetBrains Mono */}
            {chatId && (
              <>
                <span
                  aria-hidden
                  style={{ width: '1px', height: '20px', background: 'var(--border)', flexShrink: 0 }}
                />
                <span
                  className="font-mono text-[11px] truncate"
                  style={{ color: 'var(--ink-3)', maxWidth: '160px' }}
                  title={chatId}
                  aria-label={`Chat ID: ${chatId}`}
                >
                  {chatId}
                </span>
              </>
            )}

            {/* Spacer pushes right-side meta to the end */}
            <span style={{ flex: 1 }} />

            {/* "CC transcript" label — subtle right-aligned context */}
            <span
              className="font-mono text-[10px] shrink-0"
              style={{ color: 'var(--ink-3)', letterSpacing: '0.03em' }}
              aria-hidden
            >
              cc transcript
            </span>
          </div>

          {/* Scrollable transcript — fills remaining card height */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto"
            style={{
              padding: '16px 16px 8px',
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
              className="mx-4 mb-2 rounded px-3 py-1.5 font-mono text-[11px]"
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
            className="flex items-end gap-2.5 border-t shrink-0"
            style={{
              borderColor: 'var(--border)',
              padding: '12px 16px',
              background: 'color-mix(in srgb, var(--surface) 60%, var(--bg))',
            }}
          >
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              placeholder="Message the live session…  (Enter to send)"
              aria-label="Compose message"
              className="flex-1 resize-none text-[13px] focus:outline-none"
              style={{
                background: 'color-mix(in srgb, var(--surface) 50%, var(--bg))',
                color: 'var(--ink)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
                padding: '10px 12px',
                minHeight: '60px',
                maxHeight: '140px',
                boxSizing: 'border-box',
                // Focus glow: accent at 30% opacity
                outline: 'none',
                transition: 'border-color 100ms ease-out, box-shadow 100ms ease-out',
                fontFamily: 'var(--font-sans)',
                lineHeight: '1.5',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--accent) 60%, var(--border))';
                e.currentTarget.style.boxShadow = '0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'var(--border)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
            {/* Send button — terracotta --accent bg + paper-plane icon (ONLY place for --accent) */}
            <button
              type="button"
              onClick={submit}
              disabled={draft.trim().length === 0}
              className="chat-send-btn shrink-0 rounded-lg flex items-center gap-1.5 font-medium transition-opacity"
              style={{
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                padding: '10px 14px',
                fontSize: '13px',
                cursor: 'pointer',
                opacity: draft.trim().length === 0 ? 0.55 : 1,
                transition: 'opacity 100ms ease-out, box-shadow 100ms ease-out',
                minHeight: '40px',
              }}
              aria-label="Send message"
            >
              {/* Paper-plane / arrow-up icon */}
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              Send
            </button>
          </div>
        </div>

        {/*
         * RIGHT — SessionRail.
         * Stacks below on <lg (grid collapses to 1 col via flex-col fallback).
         */}
        <SessionRail status={status} chatId={chatId} />
      </div>
    </div>
  );
}
