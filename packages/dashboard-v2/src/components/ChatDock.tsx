import { useEffect, useRef, useState } from 'react';
import { navigate } from '@/lib/router';
import { useBridgeContext } from '@/lib/BridgeContext';
import { MessageBubble, StatusDot, AwaitingDots } from '@/components/chat/ChatPrimitives';

/**
 * ChatDock — bottom-RIGHT docked conversation panel wired to the LIVE Claude
 * Code orchestrator session over the P1 bridge.
 *
 * Placement: fixed bottom-right. The NotificationStack also anchors at
 * bottom-4 right-4 and stacks toasts upward. The FAB is placed at
 * bottom-28 right-4 (7rem from bottom) so it sits ABOVE the toast lane.
 * At 48-56px per toast, bottom-28 (112px) gives a clear gap above two
 * stacked toasts before the FAB enters the same zone. The expanded panel
 * also anchors at bottom-28 right-4, growing upward to avoid toast occlusion.
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

  // FAB anchors at bottom-28 right-4 (112px from bottom) to stay ABOVE the
  // NotificationStack toast lane which anchors at bottom-4 right-4 and grows
  // upward. Toasts are max-w-sm (~384px) and take ~48-56px each; 112px baseline
  // gives a clear gap above two toasts before the FAB enters the same zone.
  //
  // ── Collapsed launcher ──
  if (!openPanel) {
    return (
      <button
        type="button"
        onClick={() => setOpenPanel(true)}
        className="fixed bottom-28 right-4 z-50 flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors"
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

  // ── Expanded panel — bottom-right, grows upward ──
  return (
    <div
      className="fixed bottom-28 right-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col rounded-xl"
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
          aria-label="Expand to full chat page"
          title="Open full Chat page"
        >
          ⤢
        </button>
        {/* Collapse */}
        <button
          type="button"
          onClick={() => setOpenPanel(false)}
          className="shrink-0 rounded px-2 py-1 text-sm leading-none transition-colors hover:[background:var(--surface-sunk)]"
          style={{ color: 'var(--ink-3)' }}
          aria-label="Collapse chat dock"
        >
          –
        </button>
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
              {status === 'connecting' ? 'connecting to the live session…' : 'no messages yet'}
            </div>
            <div className="mt-1 text-[11px]" style={{ color: 'color-mix(in oklch, var(--ink-3) 70%, transparent)' }}>
              Type below to steer or start work. This reaches the same Claude Code session running in your terminal.
            </div>
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} msg={m} compact={true} />)
        )}

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
