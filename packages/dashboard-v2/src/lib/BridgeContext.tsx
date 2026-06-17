import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  useBridge,
  type BridgeMessage,
  type BridgeStatus,
  type PendingQuestion,
  type AnswerResponse,
} from '@/lib/useBridge';

/**
 * BridgeContext — MULTI-CONVERSATION store for the dashboard ⇄ LIVE Claude Code
 * bridge. Drives the ChatPage tab strip: several INDEPENDENT conversations, each
 * with its own chat_id, message history, SSE stream, and status. The bottom-right
 * ChatDock launcher mirrors whichever conversation is ACTIVE.
 *
 * ── Why one hook per conversation, not one multiplexed stream ──
 * Post-#610 the relay filters the SSE server-side by ?chat_id, so a single
 * EventSource only receives ITS chat_id's frames. To keep every open tab live
 * (so an inactive tab can accrue an `unread` marker when a reply/mirror lands),
 * each open conversation runs its OWN useBridge() instance — ONE SSE per tab.
 * React's Rules of Hooks forbid calling useBridge() in a dynamic-length loop, so
 * we mount one headless <ConversationController> per tab; each calls useBridge()
 * and reports its live slice up into the store's `views` map.
 *
 * ── Persistence ──
 * Open tabs (chat_id + label + active) persist to localStorage under
 * `gossipcat_chat_tabs`. On load each persisted conversation reopens with
 * ?last_id=0 to replay the server ring. A never-sent (chat_id=null) tab is NOT
 * persisted — there is nothing to reattach to. Reads/writes are try/caught and
 * capped so corrupt or oversized storage degrades to a single fresh tab.
 */

const STORAGE_KEY = 'gossipcat_chat_tabs';
/** Hard ceiling on open tabs (well under server MAX_BRIDGE_CLIENTS=20). */
export const MAX_TABS = 8;
/** Label snippet length from the first user message. */
const LABEL_SNIPPET_LEN = 18;

/** Persistent tab metadata (the store's source of truth). */
interface TabMeta {
  /** Stable client-side key for React + active selection. Survives chat_id mint. */
  key: string;
  /** Server chat_id once minted/adopted; null for a brand-new never-sent tab. */
  chatId: string | null;
  /** Display label (first-message snippet, else short id, else "new chat"). */
  label: string;
  /**
   * User-assigned custom label, set via renameConversation(). When present,
   * resolves first in label precedence (before snippet/chatId/"new chat").
   * Cleared (set to undefined) when the user commits an empty/whitespace-only rename.
   */
  customLabel?: string;
}

/** Live per-conversation slice reported up by a ConversationController. */
export interface ConversationView {
  key: string;
  chatId: string | null;
  label: string;
  /** User-assigned custom label. When set, takes precedence over auto-derived label. */
  customLabel?: string;
  messages: BridgeMessage[];
  status: BridgeStatus;
  awaitingReply: boolean;
  unread: number;
  /** Last transient send error on this conversation (null when clear). */
  sendError: string | null;
  /** Outstanding gossip_ask question for this conversation (null when none). */
  pendingQuestion: PendingQuestion | null;
}

/** Imperative handle a ConversationController registers so the store can drive it. */
interface ConversationHandle {
  send: (text: string) => Promise<void>;
  markRead: () => void;
  submitAnswer: (responses: AnswerResponse[]) => Promise<boolean>;
}

export interface BridgeStoreValue {
  /** All open conversations, in tab order, merged meta + live state. */
  conversations: ConversationView[];
  /** Key of the active (visible) conversation. */
  activeId: string;
  /** The active conversation's live slice (always present — never zero tabs). */
  active: ConversationView | null;
  /** Last transient send error on the ACTIVE conversation. */
  sendError: string | null;
  /** POST a message to the ACTIVE conversation. */
  send: (text: string) => Promise<void>;
  /** Submit an answer to the ACTIVE conversation's pending gossip_ask question. */
  submitAnswer: (responses: AnswerResponse[]) => Promise<boolean>;
  /** Open a fresh conversation tab and switch to it. No-op at MAX_TABS. */
  newConversation: () => void;
  /** Close a tab; activates a neighbor. Closing the last leaves one fresh tab. */
  closeConversation: (key: string) => void;
  /** Switch the active tab (clears its unread). */
  switchConversation: (key: string) => void;
  /**
   * Set a user-defined custom label on a conversation. Trimmed + capped at 40 chars.
   * Passing an empty/whitespace-only string clears customLabel (reverts to auto-derived).
   * A custom label survives subsequent messages — it is never overwritten by the
   * auto-snippet or chat_id derivation once set.
   */
  renameConversation: (key: string, label: string) => void;
  /** True when another tab can be opened. */
  canAddTab: boolean;
}

const BridgeStore = createContext<BridgeStoreValue | null>(null);

// ── id generation ───────────────────────────────────────────────────────────

let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `tab-${Date.now().toString(36)}-${keyCounter}`;
}

// ── label derivation ─────────────────────────────────────────────────────────

/**
 * Derive a tab label: first USER-message snippet (~18 chars), else short chat_id
 * (first 6), else "new chat". Collapses whitespace + ellipsizes.
 */
function deriveLabel(messages: readonly BridgeMessage[], chatId: string | null): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.text.trim().length > 0);
  if (firstUser) {
    const snippet = firstUser.text.trim().replace(/\s+/g, ' ');
    return snippet.length > LABEL_SNIPPET_LEN ? `${snippet.slice(0, LABEL_SNIPPET_LEN)}…` : snippet;
  }
  if (chatId && chatId.length > 0) return chatId.slice(0, 6);
  return 'new chat';
}

// ── persistence ──────────────────────────────────────────────────────────────

interface PersistShape {
  tabs: { chatId: string; label: string; customLabel?: string }[];
  activeChatId: string | null;
}

function loadPersisted(): { tabs: TabMeta[]; activeKey: string } | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 64_000) return null; // cap against oversized/corrupt storage
    const parsed = JSON.parse(raw) as PersistShape;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    const tabs: TabMeta[] = [];
    for (const t of parsed.tabs) {
      if (!t || typeof t.chatId !== 'string' || t.chatId.length === 0) continue;
      const label = typeof t.label === 'string' && t.label.length > 0 ? t.label.slice(0, 64) : t.chatId.slice(0, 6);
      // Back-compat: old entries without customLabel are simply loaded without it.
      const customLabel =
        typeof t.customLabel === 'string' && t.customLabel.trim().length > 0
          ? t.customLabel.slice(0, 40)
          : undefined;
      tabs.push({ key: freshKey(), chatId: t.chatId, label, customLabel });
      if (tabs.length >= MAX_TABS) break;
    }
    if (tabs.length === 0) return null;
    const activeFromStore = tabs.find((t) => t.chatId === parsed.activeChatId);
    return { tabs, activeKey: (activeFromStore ?? tabs[0]).key };
  } catch {
    return null; // corrupt JSON / blocked storage → fresh start
  }
}

function persist(tabs: readonly TabMeta[], activeKey: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    // Only persist conversations that have a server chat_id (reattachable).
    const persistable = tabs.filter((t): t is TabMeta & { chatId: string } => typeof t.chatId === 'string');
    const active = tabs.find((t) => t.key === activeKey);
    const shape: PersistShape = {
      tabs: persistable.map((t) => ({
        chatId: t.chatId,
        label: t.label,
        ...(t.customLabel ? { customLabel: t.customLabel } : {}),
      })),
      activeChatId: active?.chatId ?? null,
    };
    if (shape.tabs.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  } catch {
    /* storage full / blocked — non-fatal, tabs still work in-memory */
  }
}

// ── ConversationController ────────────────────────────────────────────────────

/**
 * Headless per-conversation host. Mounts ONE useBridge() instance, reports its
 * live slice up to the store via onState, and registers an imperative handle
 * (send/markRead) so the store can drive the active conversation. Renders
 * nothing — purely a hook host (Rules-of-Hooks-safe N instances).
 */
function ConversationController({
  meta,
  active,
  onState,
  onChatIdMinted,
  registerHandle,
}: {
  meta: TabMeta;
  active: boolean;
  onState: (view: ConversationView) => void;
  onChatIdMinted: (key: string, chatId: string, label: string) => void;
  registerHandle: (key: string, handle: ConversationHandle | null) => void;
}) {
  const bridge = useBridge({ initialChatId: meta.chatId, active });

  // Register/unregister this conversation's imperative handle.
  useEffect(() => {
    registerHandle(meta.key, { send: bridge.send, markRead: bridge.markRead, submitAnswer: bridge.submitAnswer });
    return () => registerHandle(meta.key, null);
  }, [meta.key, bridge.send, bridge.markRead, bridge.submitAnswer, registerHandle]);

  // Report the live slice up whenever any displayed field changes. The auto-label is
  // derived from messages so it updates from "new chat" → first-message snippet.
  // customLabel (when present) takes precedence and is NOT overwritten by auto-derivation.
  const autoLabel = deriveLabel(bridge.messages, bridge.chatId);
  const label = meta.customLabel ?? autoLabel;
  useEffect(() => {
    onState({
      key: meta.key,
      chatId: bridge.chatId,
      label,
      customLabel: meta.customLabel,
      messages: bridge.messages,
      status: bridge.status,
      awaitingReply: bridge.awaitingReply,
      unread: bridge.unread,
      sendError: bridge.sendError,
      pendingQuestion: bridge.pendingQuestion,
    });
  }, [
    meta.key,
    meta.customLabel,
    bridge.chatId,
    label,
    bridge.messages,
    bridge.status,
    bridge.awaitingReply,
    bridge.unread,
    bridge.sendError,
    bridge.pendingQuestion,
    onState,
  ]);

  // When this conversation mints its first chat_id, tell the store so it persists
  // + records the id against the stable tab key. Pass autoLabel (not customLabel)
  // so the stored label reflects the derived snippet for future sessions that
  // don't yet have a customLabel set.
  const prevChatId = useRef<string | null>(meta.chatId);
  useEffect(() => {
    if (bridge.chatId && bridge.chatId !== prevChatId.current) {
      prevChatId.current = bridge.chatId;
      onChatIdMinted(meta.key, bridge.chatId, autoLabel);
    }
  }, [meta.key, bridge.chatId, autoLabel, onChatIdMinted]);

  return null;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function BridgeProvider({ children }: { children: ReactNode }) {
  // Restore once: loadPersisted() mints fresh keys, so calling it twice would
  // produce mismatched tab/active keys. A single lazy initializer keeps them in
  // sync. (useState initializers run once; a useRef-cached value is overkill.)
  const initial = useRef<{ tabs: TabMeta[]; activeKey: string }>(undefined as never);
  if (initial.current === (undefined as never)) {
    const restored = loadPersisted();
    initial.current = restored ?? (() => {
      const tab = { key: freshKey(), chatId: null, label: 'new chat' };
      return { tabs: [tab], activeKey: tab.key };
    })();
  }

  // Tab metadata = source of truth for which conversations exist + their ids.
  const [tabs, setTabs] = useState<TabMeta[]>(() => initial.current.tabs);
  const [activeKey, setActiveKey] = useState<string>(() => initial.current.activeKey);

  // Defensive: keep activeKey pointing at a real tab.
  useEffect(() => {
    if (!tabs.some((t) => t.key === activeKey) && tabs.length > 0) {
      setActiveKey(tabs[0].key);
    }
  }, [tabs, activeKey]);

  // Live per-conversation slices, keyed by tab key. Updated by controllers.
  const [views, setViews] = useState<Record<string, ConversationView>>({});

  // Imperative handles per conversation (send/markRead), kept in a ref (not state)
  // so registering one doesn't re-render the whole store.
  const handlesRef = useRef<Record<string, ConversationHandle>>({});

  const registerHandle = useCallback((key: string, handle: ConversationHandle | null) => {
    if (handle) handlesRef.current[key] = handle;
    else delete handlesRef.current[key];
  }, []);

  const onState = useCallback((view: ConversationView) => {
    setViews((prev) => {
      const existing = prev[view.key];
      if (
        existing &&
        existing.chatId === view.chatId &&
        existing.label === view.label &&
        existing.messages === view.messages &&
        existing.status === view.status &&
        existing.awaitingReply === view.awaitingReply &&
        existing.unread === view.unread &&
        existing.sendError === view.sendError &&
        existing.pendingQuestion === view.pendingQuestion
      ) {
        return prev; // no change — avoid a needless re-render
      }
      return { ...prev, [view.key]: view };
    });
  }, []);

  const onChatIdMinted = useCallback((key: string, chatId: string, label: string) => {
    setTabs((prev) => prev.map((t) => (t.key === key ? { ...t, chatId, label } : t)));
  }, []);

  // Persist whenever tabs (with chat_ids) or the active selection changes.
  useEffect(() => {
    persist(tabs, activeKey);
  }, [tabs, activeKey]);

  // ── tab operations ──
  const newConversation = useCallback(() => {
    setTabs((prev) => {
      if (prev.length >= MAX_TABS) return prev;
      const key = freshKey();
      setActiveKey(key);
      return [...prev, { key, chatId: null, label: 'new chat' }];
    });
  }, []);

  const switchConversation = useCallback((key: string) => {
    setActiveKey(key);
    handlesRef.current[key]?.markRead();
  }, []);

  const renameConversation = useCallback((key: string, label: string) => {
    const trimmed = label.trim().slice(0, 40);
    setTabs((prev) =>
      prev.map((t) =>
        t.key === key
          ? { ...t, customLabel: trimmed.length > 0 ? trimmed : undefined }
          : t
      )
    );
  }, []);

  const closeConversation = useCallback((key: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.key === key);
      if (idx < 0) return prev;
      const next = prev.filter((t) => t.key !== key);

      // Never zero tabs: closing the last leaves one fresh "new chat".
      if (next.length === 0) {
        const freshTab = { key: freshKey(), chatId: null, label: 'new chat' };
        setActiveKey(freshTab.key);
        return [freshTab];
      }

      // Closing the active tab → activate a neighbor (prefer the one to the left,
      // else the new tab now at the same index).
      setActiveKey((curActive) => {
        if (curActive !== key) return curActive;
        const neighbor = next[Math.max(0, idx - 1)] ?? next[0];
        // Switching surfaces the neighbor's content → clear its unread.
        handlesRef.current[neighbor.key]?.markRead();
        return neighbor.key;
      });
      return next;
    });
    // Drop the closed conversation's cached view so it stops rendering.
    setViews((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _gone, ...rest } = prev;
      return rest;
    });
  }, []);

  const send = useCallback(
    (text: string): Promise<void> => {
      const handle = handlesRef.current[activeKey];
      if (!handle) return Promise.resolve();
      return handle.send(text);
    },
    [activeKey]
  );

  const submitAnswer = useCallback(
    (responses: AnswerResponse[]): Promise<boolean> => {
      const handle = handlesRef.current[activeKey];
      if (!handle) return Promise.resolve(false);
      return handle.submitAnswer(responses);
    },
    [activeKey]
  );

  // Build the ordered, merged conversation list (tab order + live slice).
  const conversations = useMemo<ConversationView[]>(
    () =>
      tabs.map(
        (t) =>
          views[t.key] ?? {
            key: t.key,
            chatId: t.chatId,
            label: t.label,
            messages: [],
            status: 'connecting' as BridgeStatus,
            awaitingReply: false,
            unread: 0,
            sendError: null,
            pendingQuestion: null,
          }
      ),
    [tabs, views]
  );

  const active = conversations.find((c) => c.key === activeKey) ?? conversations[0] ?? null;
  // sendError tracks the ACTIVE conversation (matches the old single-bridge API).
  const sendError = active?.sendError ?? null;

  const value = useMemo<BridgeStoreValue>(
    () => ({
      conversations,
      activeId: activeKey,
      active,
      sendError,
      send,
      submitAnswer,
      newConversation,
      closeConversation,
      switchConversation,
      renameConversation,
      canAddTab: tabs.length < MAX_TABS,
    }),
    [conversations, activeKey, active, sendError, send, submitAnswer, newConversation, closeConversation, switchConversation, renameConversation, tabs.length]
  );

  return (
    <BridgeStore.Provider value={value}>
      {/* One headless hook host per open conversation — keeps every tab streaming. */}
      {tabs.map((t) => (
        <ConversationController
          key={t.key}
          meta={t}
          active={t.key === activeKey}
          onState={onState}
          onChatIdMinted={onChatIdMinted}
          registerHandle={registerHandle}
        />
      ))}
      {children}
    </BridgeStore.Provider>
  );
}

/**
 * useBridgeStore — consume the multi-conversation store.
 * Throws if called outside <BridgeProvider>.
 */
export function useBridgeStore(): BridgeStoreValue {
  const ctx = useContext(BridgeStore);
  if (ctx === null) {
    throw new Error('useBridgeStore must be used inside <BridgeProvider>');
  }
  return ctx;
}

/** Active-conversation slice in the legacy single-bridge shape. */
export interface ActiveBridge {
  messages: BridgeMessage[];
  status: BridgeStatus;
  awaitingReply: boolean;
  chatId: string | null;
  sendError: string | null;
  send: (text: string) => Promise<void>;
}

/**
 * useBridgeContext — backward-compatible accessor for the ACTIVE conversation,
 * shaped like the original single-bridge result. ChatDock + ChatPrimitives use
 * this so the launcher always mirrors whichever tab is active without knowing
 * about the multi-conversation store.
 */
export function useBridgeContext(): ActiveBridge {
  const store = useBridgeStore();
  const a = store.active;
  return {
    messages: a?.messages ?? [],
    status: a?.status ?? 'connecting',
    awaitingReply: a?.awaitingReply ?? false,
    chatId: a?.chatId ?? null,
    sendError: store.sendError,
    send: store.send,
  };
}
