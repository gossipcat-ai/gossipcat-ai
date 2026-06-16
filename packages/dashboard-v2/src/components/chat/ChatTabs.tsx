import { useRef } from 'react';
import type { ConversationView } from '@/lib/BridgeContext';

/**
 * ChatTabs — browser-tab-style strip for the multi-conversation ChatPage.
 *
 * Each tab is an INDEPENDENT conversation (own chat_id, history, SSE). The strip
 * sits directly under the compact info-bar, scrolls horizontally when crowded,
 * and ends with a `+` new-chat button (disabled at MAX_TABS).
 *
 * a11y: role=tablist / role=tab + aria-selected; ArrowLeft/ArrowRight roving
 * focus; close buttons carry aria-labels; prefers-reduced-motion honored via the
 * .cx-tab CSS (no transition under reduce).
 *
 * DESIGN.md (dark chat carve-out):
 *   - Active tab: subtle --surface fill + 2px --ink-2 bottom indicator.
 *   - Inactive: transparent, --ink-3, hover wash.
 *   - Unread dot: --info teal (NEVER --accent — terracotta is Send-CTA only).
 *   - Label = Geist; chat_id fallback label = JetBrains Mono.
 *   - Hairline borders, no shadows, --r-md radius.
 */

interface ChatTabsProps {
  conversations: ConversationView[];
  activeId: string;
  canAddTab: boolean;
  onSwitch: (key: string) => void;
  onClose: (key: string) => void;
  onNew: () => void;
}

export function ChatTabs({
  conversations,
  activeId,
  canAddTab,
  onSwitch,
  onClose,
  onNew,
}: ChatTabsProps) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyNav = (e: React.KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = conversations[(idx + dir + conversations.length) % conversations.length];
    // Manual activation (ARIA tabs): arrows move FOCUS only — they must not
    // call onSwitch, which would fire a full conversation switch (SSE reconnect,
    // auto-scroll, draft reset) on every keystroke. The native <button> click
    // handler activates on Enter/Space/click.
    if (next) tabRefs.current[next.key]?.focus();
  };

  return (
    <div
      className="cx-tabstrip shrink-0"
      role="tablist"
      aria-label="Conversations"
    >
      <div className="cx-tabstrip-scroll">
        {conversations.map((c, idx) => {
          const isActive = c.key === activeId;
          // chat_id-derived labels (6-char short ids) render in mono; prose
          // snippets / "new chat" render in Geist.
          const isIdLabel = !!c.chatId && c.label === c.chatId.slice(0, 6);
          const showUnread = !isActive && c.unread > 0;
          return (
            <div
              key={c.key}
              className={`cx-tab ${isActive ? 'is-active' : ''}`}
            >
              <button
                ref={(el) => {
                  tabRefs.current[c.key] = el;
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                className="cx-tab-btn"
                onClick={() => onSwitch(c.key)}
                onKeyDown={(e) => onKeyNav(e, idx)}
                title={c.chatId ?? 'new conversation'}
                aria-label={`${c.label}${showUnread ? `, ${c.unread} unread` : ''}`}
              >
                {showUnread && (
                  <span className="cx-tab-unread" aria-hidden="true" />
                )}
                <span className={isIdLabel ? 'cx-tab-label font-mono' : 'cx-tab-label'}>
                  {c.label}
                </span>
              </button>
              <button
                type="button"
                className="cx-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(c.key);
                }}
                aria-label={`Close conversation ${c.label}`}
                title="Close conversation"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="cx-tab-new shrink-0"
        onClick={onNew}
        disabled={!canAddTab}
        aria-label="New conversation"
        title={canAddTab ? 'New conversation' : 'Maximum conversations open'}
      >
        +
      </button>
    </div>
  );
}
