import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useBridge } from '../useBridge';

/**
 * useBridge — activity-mirror v2 frame handling.
 *
 * Covers the new mirror/restart/last_id behavior on the SHARED bridge SSE stream
 * (spec 2026-06-14-dashboard-cc-activity-mirror-v2.md §3/§6):
 *   - mirror frame → appends a turn carrying role/text/ts/serverId
 *   - chat_id filter still applies to mirror frames
 *   - highest mirror id seen drives ?last_id on (re)connect
 *   - restart frame → reset last_id to 0 and reconnect
 *   - unknown frame type silently ignored (forward-compat)
 */

// ── Mock EventSource ────────────────────────────────────────────────────────
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
  /** Test helper: deliver a frame as an SSE message. */
  emit(frame: unknown) {
    this.onmessage?.call(this as unknown as EventSource, { data: JSON.stringify(frame) } as MessageEvent);
  }
  open() {
    this.onopen?.call(this as unknown as EventSource, new Event('open'));
  }
}

/** Read the last_id query param off a stream URL. */
function lastIdOf(url: string): string {
  return new URL(url, 'http://localhost').searchParams.get('last_id') ?? '';
}

let realEventSource: unknown;

beforeEach(() => {
  instances.length = 0;
  // Patch ONLY window.EventSource on the real jsdom window — replacing the whole
  // window would break @testing-library/react's render (needs jsdom document).
  realEventSource = (window as unknown as { EventSource?: unknown }).EventSource;
  (window as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  // POST is only exercised to mint a chat_id; stub fetch so send() resolves.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status: 202,
      json: async () => ({ ok: true, chat_id: 'chat-1' }),
    })) as unknown as typeof fetch
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { EventSource: unknown }).EventSource = realEventSource;
});

/** Mount the hook and adopt chat_id 'chat-1' via a send() so frames pass the filter. */
async function mountWithChat() {
  const hook = renderHook(() => useBridge());
  // The mount effect opens the first EventSource.
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  act(() => instances[0].open());
  await act(async () => {
    await hook.result.current.send('hello');
  });
  await waitFor(() => expect(hook.result.current.chatId).toBe('chat-1'));
  return hook;
}

describe('useBridge — ?last_id plumbing', () => {
  it('opens the stream with last_id=0 on first connect', async () => {
    renderHook(() => useBridge());
    await waitFor(() => expect(instances.length).toBe(1));
    expect(lastIdOf(instances[0].url)).toBe('0');
  });
});

describe('useBridge — mirror frames', () => {
  it('appends a mirror frame as a turn carrying role/text/ts/serverId', async () => {
    const hook = await mountWithChat();
    act(() => {
      instances[0].emit({
        type: 'mirror',
        chat_id: 'chat-1',
        role: 'assistant',
        text: 'live answer',
        ts: '2026-06-15T10:00:00.000Z',
        id: 7,
      });
    });
    await waitFor(() => {
      const turns = hook.result.current.messages;
      const mirror = turns.find((m) => m.text === 'live answer');
      expect(mirror).toBeTruthy();
      expect(mirror!.role).toBe('assistant');
      expect(mirror!.serverId).toBe(7);
    });
  });

  it('appends an activity-role mirror frame', async () => {
    const hook = await mountWithChat();
    act(() => {
      instances[0].emit({
        type: 'mirror',
        chat_id: 'chat-1',
        role: 'activity',
        text: '🔧 bash · npm run build',
        ts: '2026-06-15T10:00:01.000Z',
        id: 8,
      });
    });
    await waitFor(() =>
      expect(hook.result.current.messages.some((m) => m.role === 'activity')).toBe(true)
    );
  });

  it('drops a mirror frame whose chat_id does not match the active chat', async () => {
    const hook = await mountWithChat();
    const before = hook.result.current.messages.length;
    act(() => {
      instances[0].emit({
        type: 'mirror',
        chat_id: 'other-chat',
        role: 'assistant',
        text: 'should be filtered',
        ts: '2026-06-15T10:00:02.000Z',
        id: 99,
      });
    });
    // No new turn should appear.
    expect(hook.result.current.messages.length).toBe(before);
    expect(hook.result.current.messages.some((m) => m.text === 'should be filtered')).toBe(false);
  });

  it('ignores an unknown frame type without throwing', async () => {
    const hook = await mountWithChat();
    const before = hook.result.current.messages.length;
    act(() => {
      instances[0].emit({ type: 'future-kind', chat_id: 'chat-1', text: 'x', ts: '2026-06-15T10:00:03.000Z' });
    });
    expect(hook.result.current.messages.length).toBe(before);
  });

  it('coerces a non-string text to empty instead of crashing the render', async () => {
    const hook = await mountWithChat();
    act(() => {
      // Malformed relay payload: text is an object, not a string. The guard must
      // coerce to '' so downstream .trim()/.replace() renderers don't throw.
      instances[0].emit({
        type: 'mirror',
        chat_id: 'chat-1',
        role: 'assistant',
        text: { not: 'a string' },
        ts: '2026-06-15T10:00:06.000Z',
        id: 13,
      });
    });
    await waitFor(() => {
      const mirror = hook.result.current.messages.find((m) => m.serverId === 13);
      expect(mirror).toBeTruthy();
      expect(mirror!.text).toBe('');
    });
  });

  it('ignores a mirror frame with an unknown role', async () => {
    const hook = await mountWithChat();
    const before = hook.result.current.messages.length;
    act(() => {
      instances[0].emit({
        type: 'mirror',
        chat_id: 'chat-1',
        role: 'system',
        text: 'unknown role',
        ts: '2026-06-15T10:00:04.000Z',
        id: 12,
      });
    });
    expect(hook.result.current.messages.length).toBe(before);
  });
});

describe('useBridge — last_id high-water mark', () => {
  it('reconnects with ?last_id set to the highest mirror id seen', async () => {
    await mountWithChat();
    // After mountWithChat(), setChat('chat-1') triggers an immediate reconnect
    // so the server can subscribe this client to the correct ring (?chat_id=chat-1).
    // instances[0] = initial (no chat_id); instances[1] = reconnect with ?chat_id.
    // Wait for the chat_id reconnect to settle before emitting mirror frames.
    await waitFor(() => expect(instances.length).toBeGreaterThanOrEqual(2));
    const active = instances[instances.length - 1]; // most-recently-opened stream
    act(() => {
      active.emit({
        type: 'mirror',
        chat_id: 'chat-1',
        role: 'assistant',
        text: 'a',
        ts: '2026-06-15T10:00:00.000Z',
        id: 5,
      });
      active.emit({
        type: 'mirror',
        chat_id: 'chat-1',
        role: 'assistant',
        text: 'b',
        ts: '2026-06-15T10:00:01.000Z',
        id: 9,
      });
    });
    // Trigger a reconnect via onerror — the retry is scheduled behind a backoff
    // timer, so drive it with fake timers to reach the next connect deterministically.
    const countBefore = instances.length;
    vi.useFakeTimers();
    act(() => active.onerror?.call(active as unknown as EventSource, new Event('error')));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    vi.useRealTimers();
    expect(instances.length).toBe(countBefore + 1);
    // The newly-opened stream should carry last_id=9 (the highest mirror id seen).
    expect(lastIdOf(instances[instances.length - 1].url)).toBe('9');
  });
});

describe('useBridge — unread (inactive conversation)', () => {
  it('increments unread when an inbound frame lands while inactive, markRead clears it', async () => {
    const hook = renderHook(({ active }) => useBridge({ active }), {
      initialProps: { active: false },
    });
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    act(() => instances[0].open());
    await act(async () => {
      await hook.result.current.send('hello');
    });
    await waitFor(() => expect(hook.result.current.chatId).toBe('chat-1'));
    await waitFor(() => expect(instances.length).toBeGreaterThanOrEqual(2));
    const active = instances[instances.length - 1];

    act(() => {
      active.emit({
        type: 'mirror',
        chat_id: 'chat-1',
        role: 'assistant',
        text: 'reply while hidden',
        ts: '2026-06-16T10:00:00.000Z',
        id: 3,
      });
    });
    await waitFor(() => expect(hook.result.current.unread).toBe(1));

    act(() => hook.result.current.markRead());
    expect(hook.result.current.unread).toBe(0);
  });

  it('does NOT increment unread when the conversation is active', async () => {
    const hook = renderHook(() => useBridge({ active: true }));
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    act(() => instances[0].open());
    await act(async () => {
      await hook.result.current.send('hi');
    });
    await waitFor(() => expect(hook.result.current.chatId).toBe('chat-1'));
    await waitFor(() => expect(instances.length).toBeGreaterThanOrEqual(2));
    const active = instances[instances.length - 1];
    act(() => {
      active.emit({
        type: 'mirror',
        chat_id: 'chat-1',
        role: 'assistant',
        text: 'visible reply',
        ts: '2026-06-16T10:00:01.000Z',
        id: 4,
      });
    });
    await waitFor(() =>
      expect(hook.result.current.messages.some((m) => m.text === 'visible reply')).toBe(true)
    );
    expect(hook.result.current.unread).toBe(0);
  });
});

describe('useBridge — initialChatId', () => {
  it('opens the stream subscribed to a restored chat_id and replays the ring (last_id=0)', async () => {
    renderHook(() => useBridge({ initialChatId: 'restored-chat' }));
    await waitFor(() => expect(instances.length).toBe(1));
    const url = new URL(instances[0].url, 'http://localhost');
    expect(url.searchParams.get('chat_id')).toBe('restored-chat');
    expect(url.searchParams.get('last_id')).toBe('0');
  });
});

describe('useBridge — restart frame', () => {
  it('resets last_id to 0 and reconnects on a restart frame', async () => {
    await mountWithChat();
    // Wait for the setChat-triggered reconnect to settle.
    await waitFor(() => expect(instances.length).toBeGreaterThanOrEqual(2));
    const active = instances[instances.length - 1];
    act(() => {
      active.emit({
        type: 'mirror',
        chat_id: 'chat-1',
        role: 'assistant',
        text: 'a',
        ts: '2026-06-15T10:00:00.000Z',
        id: 42,
      });
    });
    const countBefore = instances.length;
    // Restart → relay counter reset; client must drop last_id and refetch from 0.
    act(() => {
      active.emit({ type: 'restart', chat_id: 'chat-1', ts: '2026-06-15T10:00:05.000Z' });
    });
    await waitFor(() => expect(instances.length).toBe(countBefore + 1));
    expect(lastIdOf(instances[instances.length - 1].url)).toBe('0');
    expect(active.closed).toBe(true);
  });
});
