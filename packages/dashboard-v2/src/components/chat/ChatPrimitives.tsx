import { useBridgeContext } from '@/lib/BridgeContext';
import type { BridgeMessage } from '@/lib/useBridge';

/**
 * ChatPrimitives — shared atoms for ChatPage (full-width) and ChatDock
 * (360px panel). Kept in a single file to prevent the two surfaces from
 * drifting apart again.
 *
 * Size differences between surfaces are expressed via the `compact` prop:
 *   compact=false (default) → ChatPage full-width layout
 *   compact=true            → ChatDock 360px panel
 *
 * DESIGN.md conformance:
 *   - Status semantic: --ok open, --warn connecting, --bad error, --idle closed.
 *   - JetBrains Mono for timestamps; Geist body for message text.
 *   - Hairline --border bubbles; no drop shadow.
 *   - --ink-3 for dim text (text context), --ink-4 for decorative dots.
 *   - prefers-reduced-motion: animate-pulse gets motion-reduce:animate-none.
 */

export function timeShort(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface MessageBubbleProps {
  msg: BridgeMessage;
  /** compact=true → ChatDock 360px panel sizing; false → ChatPage full-width */
  compact?: boolean;
}

export function MessageBubble({ msg, compact = false }: MessageBubbleProps) {
  const isUser = msg.role === 'user';
  const isError = msg.role === 'error';
  const isAck = msg.role === 'ack';

  if (isAck) {
    return (
      <div className="flex justify-center py-0.5">
        <span
          className={`rounded-full font-mono ${compact ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-0.5 text-[11px]'}`}
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

  // Assistant bubble: cap at 640px on full page; compact uses 85% of panel.
  // User bubbles: 78% on full page, 85% in dock — consistent with original.
  const bubbleWidthClass = compact
    ? 'max-w-[85%]'
    : isUser
      ? 'max-w-[78%]'
      : 'max-w-[640px]';

  const bubbleTextClass = compact
    ? 'text-[13px] leading-snug'
    : 'text-[14px] leading-relaxed';

  return (
    <div
      className={`flex flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'}`}
    >
      <div
        className={`${bubbleWidthClass} whitespace-pre-wrap break-words rounded-lg ${compact ? 'px-3 py-2' : 'px-4 py-3'} ${bubbleTextClass}`}
        style={bubbleStyle}
      >
        {isError && (
          <span
            className={`h-section block ${compact ? 'mb-0.5' : 'mb-1'}`}
            style={{ color: 'var(--bad)' }}
          >
            session error
          </span>
        )}
        {msg.text}
      </div>
      <span
        className="px-1 font-mono text-[11px]"
        style={{ color: 'var(--ink-3)' }}
      >
        {timeShort(msg.ts)}
      </span>
    </div>
  );
}

interface StatusDotProps {
  status: ReturnType<typeof useBridgeContext>['status'];
  /** compact=true → ChatDock smaller dot/text sizing */
  compact?: boolean;
}

export function StatusDot({ status, compact = false }: StatusDotProps) {
  const map: Record<string, { color: string; label: string }> = {
    open: { color: 'var(--ok)', label: 'live' },
    connecting: { color: 'var(--warn)', label: 'connecting' },
    closed: { color: 'var(--idle)', label: 'offline' },
    error: { color: 'var(--bad)', label: 'relay down' },
  };
  const { color, label } = map[status] ?? map['closed'];
  const dotSize = compact ? 'h-1.5 w-1.5' : 'h-2 w-2';
  const textClass = compact ? 'font-mono text-[10px]' : 'font-mono text-[12px]';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block ${dotSize} rounded-full ${
          status === 'connecting' ? 'animate-pulse motion-reduce:animate-none' : ''
        }`}
        style={{ background: color }}
        aria-hidden
      />
      <span className={textClass} style={{ color: 'var(--ink-3)' }}>
        {label}
      </span>
    </span>
  );
}

/**
 * AwaitingDots — 3-dot "working…" indicator shown while awaitingReply.
 * Three dots on both surfaces (page and dock) for consistency.
 */
interface AwaitingDotsProps {
  compact?: boolean;
}

export function AwaitingDots({ compact = false }: AwaitingDotsProps) {
  const dotSize = compact ? 'h-1.5 w-1.5' : 'h-2 w-2';
  const textClass = compact ? 'text-[10px]' : 'text-[12px]';
  const padding = compact ? 'px-1 py-1' : 'px-1 py-2';
  return (
    <div className={`flex items-center gap-2 ${padding}`}>
      <span className="inline-flex gap-1" aria-hidden>
        <span
          className={`${dotSize} animate-pulse motion-reduce:animate-none rounded-full`}
          style={{ background: 'var(--ink-4)' }}
        />
        <span
          className={`${dotSize} animate-pulse motion-reduce:animate-none rounded-full`}
          style={{ background: 'var(--ink-4)', animationDelay: '150ms' }}
        />
        <span
          className={`${dotSize} animate-pulse motion-reduce:animate-none rounded-full`}
          style={{ background: 'var(--ink-4)', animationDelay: '300ms' }}
        />
      </span>
      <span className={textClass} style={{ color: 'var(--ink-3)' }}>
        working…
      </span>
    </div>
  );
}
