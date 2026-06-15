/**
 * ChatEmptyState — the empty/connecting/error hero shown inside the
 * ChatPage transcript region when there are no messages yet.
 *
 * Lives in components/chat/ (sibling of ChatPrimitives) so ChatPage stays
 * under ~300 lines while keeping the empty-state UX encapsulated.
 *
 * DESIGN.md conformance:
 *   - .h-section small-caps Geist for the glyph label above the headline.
 *   - Geist body for helper text (14px / --ink-3).
 *   - Example chips use --r-pill, --surface-sunk bg, hairline --border.
 *   - --accent only on hover wash of chips (accent-soft), NOT chip bg.
 *   - Connecting state: pulsing glyph (motion-reduce:animate-none).
 *   - No new shadows; no new colors; no new fonts.
 */

type BridgeStatus = 'open' | 'connecting' | 'closed' | 'error';

const EXAMPLE_PROMPTS = [
  'What\'s the current branch?',
  'Run the CLI tests',
  'Review my last change',
];

interface ChatEmptyStateProps {
  status: BridgeStatus;
  onChipClick: (text: string) => void;
  /**
   * compact=true — dock mode (~320px interior): smaller vertical padding,
   * smaller glyph, chips wrap cleanly at narrow width.
   * compact=false (default) — full ChatPage look, unchanged.
   */
  compact?: boolean;
}

export function ChatEmptyState({ status, onChipClick, compact = false }: ChatEmptyStateProps) {
  const isConnecting = status === 'connecting';
  const isError = status === 'error';
  const isClosed = status === 'closed';

  const headline = isError
    ? 'Relay disconnected'
    : isConnecting
      ? 'Connecting to the live session…'
      : isClosed
        ? 'Session offline'
        : 'Talk to your live Claude Code session';

  const helper = isError
    ? 'The gossipcat relay is unreachable. Check that the MCP server is running, then reload.'
    : isConnecting
      ? 'Establishing the bridge to your terminal…'
      : isClosed
        ? 'Start gossipcat in your terminal to open a new session.'
        : 'Type below or pick a prompt to steer the orchestrator running in your terminal — not a separate AI.';

  const glyphColor = isError
    ? 'var(--bad)'
    : isConnecting
      ? 'var(--warn)'
      : isClosed
        ? 'var(--idle)'
        : 'var(--ink-3)';

  return (
    <div
      className="flex h-full flex-col items-center justify-center text-center"
      style={{
        gap: compact ? '10px' : '16px',
        padding: compact ? '20px 16px' : '48px 24px',
        minHeight: compact ? '160px' : '320px',
      }}
    >
      {/* Glyph */}
      <span
        className={`select-none leading-none ${compact ? 'text-2xl' : 'text-4xl'} ${isConnecting ? 'animate-pulse motion-reduce:animate-none' : ''}`}
        style={{ color: glyphColor }}
        aria-hidden
      >
        ◎
      </span>

      {/* Headline */}
      <div style={{ maxWidth: compact ? '260px' : '380px' }}>
        <div
          className={`font-medium ${compact ? 'text-[13px]' : 'text-[15px]'}`}
          style={{ color: 'var(--ink)', lineHeight: 1.4 }}
        >
          {headline}
        </div>
        <div
          className={`mt-1.5 ${compact ? 'text-[11px]' : 'text-[13px]'}`}
          style={{ color: 'var(--ink-3)', lineHeight: 1.55 }}
        >
          {helper}
        </div>
      </div>

      {/* Example prompt chips — only when open/idle (not connecting/error/closed) */}
      {status === 'open' && (
        <div
          className="flex flex-wrap justify-center gap-1.5"
          style={{ maxWidth: compact ? '280px' : '440px' }}
        >
          <span className="h-section w-full" style={{ color: 'var(--ink-3)' }}>
            try an example
          </span>
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onChipClick(prompt)}
              className={`rounded-full font-medium transition-colors hover:[background:var(--accent-soft)] ${compact ? 'px-2.5 py-1 text-[11px]' : 'px-3.5 py-1.5 text-[12px]'}`}
              style={{
                background: 'var(--surface-sunk)',
                border: '1px solid var(--border)',
                color: 'var(--ink-2)',
                cursor: 'pointer',
              }}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
