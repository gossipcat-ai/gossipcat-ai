import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, waitFor, screen } from '@testing-library/react';
import { BridgeProvider, useBridgeStore, MAX_TABS } from '../BridgeContext';

/**
 * BridgeContext — multi-conversation tab store.
 *
 * Covers the ChatPage tab strip contract:
 *   - newConversation / switchConversation / closeConversation
 *   - localStorage persistence round-trip (open chat_ids + active id + labels)
 *   - unread accrues on an INACTIVE conversation, clears on switch
 *   - closing the ACTIVE tab activates a neighbor
 *   - closing the LAST tab leaves exactly one fresh "new chat" (never zero)
 *   - first-message snippet labels; new tab capped at MAX_TABS
 */

const STORAGE_KEY = 'gossipcat_chat_tabs';

// ── Mock EventSource ─────────────────────────────────────────────────────────
const instances: MockEventSource[] = [];

class MockEventSource {
  url: string;
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(frame: unknown) {
    this.onmessage?.call(this as unknown as EventSource, { data: JSON.stringify(frame) } as MessageEvent);
  }
  /** Find the most-recently-opened stream subscribed to a given chat_id. */
  static lastForChat(chatId: string): MockEventSource | undefined {
    for (let i = instances.length - 1; i >= 0; i--) {
      if (new URL(instances[i].url, 'http://localhost').searchParams.get('chat_id') === chatId) {
        return instances[i];
      }
    }
    return undefined;
  }
}

// fetch mints a fresh incrementing chat_id per send so each first-send gets its own.
let mintCounter = 0;
function stubFetchMinting() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      mintCounter += 1;
      const id = `chat-${mintCounter}`;
      return { status: 202, json: async () => ({ ok: true, chat_id: id }) };
    }) as unknown as typeof fetch
  );
}

let realEventSource: unknown;

beforeEach(() => {
  instances.length = 0;
  mintCounter = 0;
  localStorage.clear();
  realEventSource = (window as unknown as { EventSource?: unknown }).EventSource;
  (window as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  stubFetchMinting();
});

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { EventSource: unknown }).EventSource = realEventSource;
  localStorage.clear();
});

// ── Test harness: exposes the store via window for imperative driving ─────────
let store: ReturnType<typeof useBridgeStore>;
function Capture() {
  store = useBridgeStore();
  return (
    <div data-testid="tabs">
      {store.conversations.map((c) => (
        <span key={c.key} data-active={c.key === store.activeId} data-unread={c.unread}>
          {c.label}
        </span>
      ))}
    </div>
  );
}
function renderStore() {
  return render(
    <BridgeProvider>
      <Capture />
    </BridgeProvider>
  );
}

describe('BridgeContext — initial state', () => {
  it('starts with exactly one fresh "new chat" tab, active', async () => {
    renderStore();
    await waitFor(() => expect(store.conversations.length).toBe(1));
    expect(store.conversations[0].label).toBe('new chat');
    expect(store.activeId).toBe(store.conversations[0].key);
  });
});

describe('BridgeContext — new / switch / close', () => {
  it('opens a new tab and switches to it', async () => {
    renderStore();
    await waitFor(() => expect(store.conversations.length).toBe(1));
    const first = store.conversations[0].key;
    act(() => store.newConversation());
    await waitFor(() => expect(store.conversations.length).toBe(2));
    const second = store.conversations[1].key;
    expect(store.activeId).toBe(second);

    act(() => store.switchConversation(first));
    await waitFor(() => expect(store.activeId).toBe(first));
  });

  it('caps new tabs at MAX_TABS', async () => {
    renderStore();
    await waitFor(() => expect(store.conversations.length).toBe(1));
    for (let i = 0; i < MAX_TABS + 3; i++) {
      act(() => store.newConversation());
    }
    await waitFor(() => expect(store.conversations.length).toBe(MAX_TABS));
    expect(store.canAddTab).toBe(false);
  });

  it('closing the active tab activates a neighbor', async () => {
    renderStore();
    await waitFor(() => expect(store.conversations.length).toBe(1));
    act(() => store.newConversation());
    act(() => store.newConversation());
    await waitFor(() => expect(store.conversations.length).toBe(3));
    const [a, b] = store.conversations.map((c) => c.key);
    const c = store.conversations[2].key;
    // active is the third (last opened); close it → neighbor (b) becomes active.
    expect(store.activeId).toBe(c);
    act(() => store.closeConversation(c));
    await waitFor(() => expect(store.conversations.length).toBe(2));
    expect(store.activeId).toBe(b);
    // closing a non-active tab leaves active unchanged.
    act(() => store.closeConversation(a));
    await waitFor(() => expect(store.conversations.length).toBe(1));
    expect(store.activeId).toBe(b);
  });

  it('closing the last tab leaves exactly one fresh "new chat" (never zero)', async () => {
    renderStore();
    await waitFor(() => expect(store.conversations.length).toBe(1));
    const only = store.conversations[0].key;
    act(() => store.closeConversation(only));
    await waitFor(() => expect(store.conversations.length).toBe(1));
    // A brand-new tab with a different key + "new chat" label.
    expect(store.conversations[0].key).not.toBe(only);
    expect(store.conversations[0].label).toBe('new chat');
    expect(store.activeId).toBe(store.conversations[0].key);
  });
});

describe('BridgeContext — labels from first message', () => {
  it('labels a tab with the first user-message snippet after send', async () => {
    renderStore();
    await waitFor(() => expect(store.conversations.length).toBe(1));
    await act(async () => {
      await store.send('deploy the staging build now please');
    });
    await waitFor(() =>
      expect(store.conversations[0].label).toBe('deploy the staging…')
    );
    // chat_id minted + adopted.
    await waitFor(() => expect(store.conversations[0].chatId).toBe('chat-1'));
  });
});

describe('BridgeContext — unread on inactive tab', () => {
  it('accrues unread on an inactive conversation and clears on switch', async () => {
    renderStore();
    await waitFor(() => expect(store.conversations.length).toBe(1));
    // Send on tab 1 to mint chat-1, then open + switch to a fresh tab 2.
    await act(async () => {
      await store.send('first');
    });
    await waitFor(() => expect(store.conversations[0].chatId).toBe('chat-1'));
    act(() => store.newConversation()); // switches to tab 2; tab 1 now inactive
    await waitFor(() => expect(store.conversations.length).toBe(2));
    const tab1Key = store.conversations[0].key;

    // A reply lands on chat-1 while tab 1 is inactive → unread bumps.
    const es = MockEventSource.lastForChat('chat-1');
    expect(es).toBeTruthy();
    act(() => {
      es!.emit({
        type: 'mirror',
        chat_id: 'chat-1',
        role: 'assistant',
        text: 'background reply',
        ts: '2026-06-16T11:00:00.000Z',
        id: 2,
      });
    });
    await waitFor(() => {
      const tab1 = store.conversations.find((c) => c.key === tab1Key);
      expect(tab1?.unread).toBe(1);
    });

    // Switch back to tab 1 → its unread clears.
    act(() => store.switchConversation(tab1Key));
    await waitFor(() => {
      const tab1 = store.conversations.find((c) => c.key === tab1Key);
      expect(tab1?.unread).toBe(0);
    });
  });
});

describe('BridgeContext — persistence round-trip', () => {
  it('persists open chat_ids + active id, restores them on remount', async () => {
    const { unmount } = renderStore();
    await waitFor(() => expect(store.conversations.length).toBe(1));
    await act(async () => {
      await store.send('alpha');
    });
    await waitFor(() => expect(store.conversations[0].chatId).toBe('chat-1'));
    act(() => store.newConversation());
    await waitFor(() => expect(store.conversations.length).toBe(2));
    await act(async () => {
      await store.send('beta');
    });
    await waitFor(() => expect(store.conversations[1].chatId).toBe('chat-2'));

    // localStorage should now hold both chat_ids; active = chat-2 (tab 2).
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.tabs.map((t: { chatId: string }) => t.chatId)).toEqual(['chat-1', 'chat-2']);
    expect(parsed.activeChatId).toBe('chat-2');

    unmount();
    instances.length = 0;

    // Remount: tabs restore from storage; streams reopen subscribed to the ids.
    renderStore();
    await waitFor(() => expect(store.conversations.length).toBe(2));
    expect(store.conversations.map((c) => c.chatId)).toEqual(['chat-1', 'chat-2']);
    expect(store.active?.chatId).toBe('chat-2');
    // Each restored conversation opened a stream subscribed to its chat_id.
    await waitFor(() => {
      expect(MockEventSource.lastForChat('chat-1')).toBeTruthy();
      expect(MockEventSource.lastForChat('chat-2')).toBeTruthy();
    });
  });

  it('falls back to a single fresh tab when storage is corrupt', async () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    renderStore();
    await waitFor(() => expect(store.conversations.length).toBe(1));
    expect(store.conversations[0].label).toBe('new chat');
    expect(store.conversations[0].chatId).toBeNull();
  });

  it('does NOT persist a never-sent (chat_id=null) conversation', async () => {
    renderStore();
    await waitFor(() => expect(store.conversations.length).toBe(1));
    act(() => store.newConversation()); // two empty tabs, neither sent
    await waitFor(() => expect(store.conversations.length).toBe(2));
    // No chat_ids minted → storage stays empty (removeItem path).
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('BridgeContext — render integration', () => {
  it('renders one tab element per conversation', async () => {
    renderStore();
    await waitFor(() => expect(store.conversations.length).toBe(1));
    act(() => store.newConversation());
    await waitFor(() => {
      const spans = screen.getByTestId('tabs').querySelectorAll('span');
      expect(spans.length).toBe(2);
    });
  });
});
