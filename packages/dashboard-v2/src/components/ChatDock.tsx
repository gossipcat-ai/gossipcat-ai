import { useEffect, useRef, useState } from 'react';
import { navigate } from '@/lib/router';
import { useBridgeContext } from '@/lib/BridgeContext';
import { StatusDot, AwaitingDots } from '@/components/chat/ChatPrimitives';
import { Transcript } from '@/components/chat/Transcript';

/**
 * ChatDock — bottom-RIGHT docked conversation panel wired to the LIVE Claude
 * Code orchestrator session over the P1 bridge.
 *
 * Placement: fixed bottom-right CORNER (bottom-5 right-5), the conventional
 * chat-launcher anchor. The NotificationStack toast lane is offset upward
 * (bottom-20) so transient toasts stack ABOVE the launcher instead of
 * colliding with it — the standard "launcher in the corner, notifications
 * above it" pattern. The expanded panel shares the same corner anchor and
 * grows upward.
 *
 * Shared conversation: ChatDock consumes useBridgeContext() (NOT useBridge()
 * directly) so it shares the same SSE stream, chat_id, and messages as
 * ChatPage. The bridge is instantiated exactly ONCE in <BridgeProvider>
 * mounted in App.tsx.
 *
 * DESIGN.md conformance:
 *   - --accent terracotta only on FAB + Send button (primary CTA).
 *   - Status is semantic: --ok open, --warn connecting, --bad error, --idle closed.
 *   - .h-section small-caps Geist for the panel label.
 *   - Hairline --border, --r-lg card, NO new shadow token (uses project
 *     --shadow-card consistent with NotificationStack).
 *   - JetBrains Mono for chat_id + timestamps; Geist body for message text.
 *   - prefers-reduced-motion: animate-pulse gets motion-reduce:animate-none.
 */

export function ChatDock() {
  const [openPanel, setOpenPanel] = useState(false);
  const [draft, setDraft] = useState('');
  const { messages, status, awaitingReply, chatId, send, sendError } = useBridgeContext();

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

  const expandToPage = () => {
    setOpenPanel(false);
    navigate('/chat');
  };

  // ── Collapsed launcher (bottom-right corner) ──
  if (!openPanel) {
    return (
      <button
        type="button"
        onClick={() => setOpenPanel(true)}
        className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors"
        // position:fixed inline because the global `[data-tooltip]{position:relative}`
        // rule has equal specificity to Tailwind's `.fixed` and is declared later, so
        // it would otherwise override the fixed anchor and drop the FAB into page flow.
        style={{ position: 'fixed', background: 'var(--accent)', color: 'var(--accent-foreground, #fff)' }}
        aria-label="Open live Claude Code chat"
        data-tooltip="Talk to the live Claude Code session"
        data-tooltip-pos="left"
      >
        <span aria-hidden>◎</span>
        <span>Live session</span>
      </button>
    );
  }

  // ── Expanded panel — bottom-right corner, grows upward ──
  return (
    <div
      className="fixed bottom-5 right-5 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col rounded-xl"
      style={{
        height: 'min(560px, calc(100vh - 6rem))',
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
            <StatusDot status={status} compact={true} />
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px]" style={{ color: 'var(--ink-3)' }}>
            {chatId ? `chat ${chatId.slice(0, 8)}` : 'same session as your terminal'}
          </div>
        </div>
        {/* Expand to full page */}
        <button
          type="button"
          onClick={expandToPage}
          className="shrink-0 rounded px-2 py-1 text-sm leading-none transition-colors hover:[background:var(--surface-sunk)]"
          style={{ color: 'var(--ink-3)' }}
          aria-label="Open full Chat page"
          data-tooltip="Open full Chat page"
          data-tooltip-pos="left"
        >
          ⤢
        </button>
        {/* Minimize */}
        <button
          type="button"
          onClick={() => setOpenPanel(false)}
          className="shrink-0 rounded px-2 py-1 text-sm leading-none transition-colors hover:[background:var(--surface-sunk)]"
          style={{ color: 'var(--ink-3)' }}
          aria-label="Minimize chat"
          data-tooltip="Minimize chat"
          data-tooltip-pos="left"
        >
          –
        </button>
      </div>

      {/* Conversation — flowing CC-transcript view (activity-mirror v2) */}
      <div ref={scrollRef} className="chat-surface flex-1 overflow-y-auto px-3 py-3">
        <Transcript messages={messages} status={status} />
        {awaitingReply && <AwaitingDots compact={true} />}
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
          placeholder="Message the live session…"
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
