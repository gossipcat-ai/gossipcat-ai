import { useRef, useState, useCallback } from 'react';
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
 * Rename: double-click or F2 on a focused tab starts inline rename; Enter/blur
 * commits; Escape cancels. Empty commit reverts to auto-derived label.
 *
 * DESIGN.md (dark chat carve-out):
 *   - Active tab: subtle --surface fill + 2px --ink-2 bottom indicator.
 *   - Inactive: transparent, --ink-3, hover wash.
 *   - Unread dot: --info teal (NEVER --accent — terracotta is Send-CTA only).
 *   - Label = Geist; chat_id fallback label = JetBrains Mono.
 *   - Hairline borders, no shadows, --r-md radius.
 *   - Rename input: --surface-2 bg, --ink text, hairline --border, --r-sm.
 */

interface ChatTabsProps {
  conversations: ConversationView[];
  activeId: string;
  canAddTab: boolean;
  onSwitch: (key: string) => void;
  onClose: (key: string) => void;
  onNew: () => void;
  onRename: (key: string, label: string) => void;
}

export function ChatTabs({
  conversations,
  activeId,
  canAddTab,
  onSwitch,
  onClose,
  onNew,
  onRename,
}: ChatTabsProps) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Key of the tab currently being renamed (null = no rename in progress).
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  // Draft text while rename is active.
  const [draftLabel, setDraftLabel] = useState('');

  const onKeyNav = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'F2') {
      // F2 starts rename on the focused tab without activating a switch.
      e.preventDefault();
      const c = conversations[idx];
      if (c) startRename(c);
      return;
    }
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

  const startRename = useCallback((c: ConversationView) => {
    setRenamingKey(c.key);
    setDraftLabel(c.customLabel ?? c.label);
  }, []);

  const commitRename = useCallback(
    (key: string) => {
      // Empty/whitespace → revert (onRename handles this via empty string).
      onRename(key, draftLabel);
      setRenamingKey(null);
      // Return focus to the tab button so keyboard nav is preserved.
      requestAnimationFrame(() => {
        tabRefs.current[key]?.focus();
      });
    },
    [draftLabel, onRename]
  );

  const cancelRename = useCallback((key: string) => {
    setRenamingKey(null);
    // Return focus to the tab button.
    requestAnimationFrame(() => {
      tabRefs.current[key]?.focus();
    });
  }, []);

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, key: string) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitRename(key);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelRename(key);
      }
    },
    [commitRename, cancelRename]
  );

  return (
    <div
      className="cx-tabstrip shrink-0"
      role="tablist"
      aria-label="Conversations"
    >
      <div className="cx-tabstrip-scroll">
        {conversations.map((c, idx) => {
          const isActive = c.key === activeId;
          const isRenaming = c.key === renamingKey;
          // chat_id-derived labels (6-char short ids) render in mono; prose
          // snippets / "new chat" / custom labels render in Geist.
          const isIdLabel =
            !c.customLabel &&
            !!c.chatId &&
            c.label === c.chatId.slice(0, 6);
          const showUnread = !isActive && c.unread > 0;
          return (
            <div
              key={c.key}
              className={`cx-tab ${isActive ? 'is-active' : ''}`}
            >
              {isRenaming ? (
                /* ── inline rename input ── */
                <input
                  className="cx-tab-rename-input"
                  type="text"
                  value={draftLabel}
                  maxLength={40}
                  aria-label="Rename conversation"
                  autoFocus
                  onChange={(e) => setDraftLabel(e.target.value)}
                  onKeyDown={(e) => onInputKeyDown(e, c.key)}
                  onBlur={() => commitRename(c.key)}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
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
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    startRename(c);
                  }}
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
              )}
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
