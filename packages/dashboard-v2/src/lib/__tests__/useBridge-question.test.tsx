import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useBridge } from '../useBridge';

/**
 * useBridge — gossip_ask question frame + answer submit (spec 2026-06-16-dashboard-ask).
 *   - a `question` frame for the active chat → pendingQuestion populated
 *   - a `question` frame for ANOTHER chat → filtered out
 *   - submitAnswer POSTs {chat_id, answer:{qid, responses}} + clears the card +
 *     optimistically renders a user turn
 */

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
  close() { this.closed = true; }
  emit(frame: unknown) {
    this.onmessage?.call(this as unknown as EventSource, { data: JSON.stringify(frame) } as MessageEvent);
  }
  open() { this.onopen?.call(this as unknown as EventSource, new Event('open')); }
}

let realEventSource: unknown;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  instances.length = 0;
  realEventSource = (window as unknown as { EventSource?: unknown }).EventSource;
  (window as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  fetchMock = vi.fn(async () => ({
    status: 202,
    json: async () => ({ ok: true, chat_id: 'chat-1' }),
  })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { EventSource: unknown }).EventSource = realEventSource;
});

async function mountWithChat() {
  const hook = renderHook(() => useBridge());
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  act(() => instances[0].open());
  await act(async () => { await hook.result.current.send('hello'); });
  await waitFor(() => expect(hook.result.current.chatId).toBe('chat-1'));
  return hook;
}

function lastStream(): MockEventSource {
  return instances[instances.length - 1];
}

const QUESTION = {
  type: 'question',
  chat_id: 'chat-1',
  qid: 'qid-7',
  ts: '2026-06-16T10:00:00.000Z',
  questions: [
    {
      questionId: 'q0',
      header: 'Approach',
      question: 'Which one?',
      options: [{ label: 'A' }, { label: 'B' }],
    },
  ],
};

describe('useBridge — question frames', () => {
  it('stores a question frame for the active chat as pendingQuestion', async () => {
    const hook = await mountWithChat();
    act(() => lastStream().emit(QUESTION));
    await waitFor(() => {
      expect(hook.result.current.pendingQuestion).toBeTruthy();
      expect(hook.result.current.pendingQuestion!.qid).toBe('qid-7');
      expect(hook.result.current.pendingQuestion!.questions[0].header).toBe('Approach');
    });
  });

  it('filters a question frame for a different chat_id', async () => {
    const hook = await mountWithChat();
    act(() => lastStream().emit({ ...QUESTION, chat_id: 'other-chat' }));
    expect(hook.result.current.pendingQuestion).toBeNull();
  });

  it('drops a malformed question frame (missing qid / options)', async () => {
    const hook = await mountWithChat();
    act(() => lastStream().emit({ type: 'question', chat_id: 'chat-1', questions: QUESTION.questions, ts: QUESTION.ts }));
    expect(hook.result.current.pendingQuestion).toBeNull();
    act(() => lastStream().emit({ type: 'question', chat_id: 'chat-1', qid: 'q', questions: [], ts: QUESTION.ts }));
    expect(hook.result.current.pendingQuestion).toBeNull();
  });

  it('submitAnswer POSTs the expected payload, clears the card, and renders a user turn', async () => {
    const hook = await mountWithChat();
    act(() => lastStream().emit(QUESTION));
    await waitFor(() => expect(hook.result.current.pendingQuestion).toBeTruthy());

    fetchMock.mockClear();
    await act(async () => {
      await hook.result.current.submitAnswer([{ questionId: 'q0', selected: ['B'] }]);
    });

    // POST shape
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      chat_id: 'chat-1',
      answer: { qid: 'qid-7', responses: [{ questionId: 'q0', selected: ['B'] }] },
    });

    // card cleared + optimistic user turn rendered
    expect(hook.result.current.pendingQuestion).toBeNull();
    expect(hook.result.current.messages.some((m) => m.role === 'user' && m.text.includes('Approach: B'))).toBe(true);
  });
});
