import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { parseInboxSnapshot, useClaudeInbox, withDelivery } from '../useClaudeInbox';
import { useBridge, type BridgeMessage } from '../useBridge';
import { ClaudeLinkBadge, DeliveryChip, isClaudeReachable } from '@/components/chat/InboxStatus';

/**
 * Durable Claude inbox — dashboard truthfulness:
 *   - snapshot parsing is fail-closed on untrusted payloads
 *   - link badge maps server link state → semantic tone (never the SSE status)
 *   - per-message delivery chips (queued / delivered / answered)
 *   - useBridge tags the optimistic user turn with the POST's inbox_id
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseInboxSnapshot', () => {
  it('accepts a valid snapshot', () => {
    expect(
      parseInboxSnapshot({ link: { state: 'listening', last_seen: '2026-10-11T00:00:00Z' }, messages: [{ id: 'a', status: 'answered' }] }),
    ).toEqual({ link: { state: 'listening', last_seen: '2026-10-11T00:00:00Z' }, statusById: { a: 'answered' } });
  });
  it('keeps last_exit so a just-exited watcher shows as recent', () => {
    expect(parseInboxSnapshot({ link: { state: 'recent', last_exit: '2026-10-11T00:00:00.000Z' } }))
      .toEqual({ link: { state: 'recent', last_exit: '2026-10-11T00:00:00.000Z' }, statusById: {} });
  });
  it('rejects unknown link states and drops malformed message rows', () => {
    expect(parseInboxSnapshot({ link: { state: 'pwned' } })).toBeNull();
    expect(parseInboxSnapshot({ online: true, jobs: [] })).toBeNull();
    expect(parseInboxSnapshot({ link: { state: 'offline' }, messages: [{ id: 1, status: 'queued' }, { id: 'b', status: 'x' }] }))
      .toEqual({ link: { state: 'offline' }, statusById: {} });
  });
});

describe('withDelivery', () => {
  it('annotates only inbox-tagged turns and keeps identity of untouched ones', () => {
    const a: BridgeMessage = { id: 1, role: 'user', text: 'x', ts: 't', inboxId: 'i1', delivery: 'queued' };
    const b: BridgeMessage = { id: 2, role: 'assistant', text: 'y', ts: 't' };
    const out = withDelivery([a, b], { i1: 'answered' });
    expect(out[0].delivery).toBe('answered');
    expect(out[1]).toBe(b);
  });
});

describe('ClaudeLinkBadge / DeliveryChip', () => {
  it.each([
    ['channel', 'var(--ok)'],
    ['listening', 'var(--ok)'],
    ['session', 'var(--warn)'],
    ['offline', 'var(--idle)'],
  ] as const)('%s → %s', (state, color) => {
    render(<ClaudeLinkBadge link={{ state }} />);
    const el = screen.getByTestId('claude-link');
    expect(el.getAttribute('data-state')).toBe(state);
    expect(el.innerHTML).toContain(color);
  });
  it('unknown link (relay unreachable) is idle, not ok', () => {
    render(<ClaudeLinkBadge link={null} lang="tr" />);
    expect(screen.getByText('Claude durumu bilinmiyor')).toBeTruthy();
    expect(isClaudeReachable(null)).toBe(false);
  });
  it('delivery chips use semantic tones', () => {
    render(<><DeliveryChip status="queued" /><DeliveryChip status="answered" lang="tr" /></>);
    const chips = screen.getAllByTestId('delivery-chip');
    expect(chips[0].textContent).toBe('queued');
    expect(chips[0].getAttribute('style')).toContain('var(--warn)');
    expect(chips[1].textContent).toBe('yanıtlandı');
    expect(chips[1].getAttribute('style')).toContain('var(--ok)');
  });
});

describe('useClaudeInbox polling', () => {
  it('fetches the snapshot for the chat and exposes link + statuses', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ link: { state: 'recent' }, messages: [{ id: 'm1', status: 'delivered' }] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useClaudeInbox('chat-1', true, 60_000));
    await waitFor(() => expect(result.current.link?.state).toBe('recent'));
    expect(result.current.statusById).toEqual({ m1: 'delivered' });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/dashboard/api/bridge/inbox?chat_id=chat-1');
  });
  it('does not poll when disabled', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useClaudeInbox('chat-1', false));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useBridge — inbox_id tagging', () => {
  let realES: unknown;
  beforeEach(() => {
    realES = (window as unknown as { EventSource?: unknown }).EventSource;
    (window as unknown as { EventSource: unknown }).EventSource = class {
      onopen = null; onmessage = null; onerror = null;
      close() {}
    };
  });
  afterEach(() => {
    (window as unknown as { EventSource: unknown }).EventSource = realES;
  });

  it('a queued 202 tags the optimistic user turn with inbox_id + delivery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 202,
      json: async () => ({ ok: true, chat_id: 'chat-9', inbox_id: '1760000000000-abcdefabcdef', delivery: 'queued', live: false }),
    })));
    const { result } = renderHook(() => useBridge());
    await act(async () => { await result.current.send('hi claude'); });
    const user = result.current.messages.find((m) => m.role === 'user');
    expect(user).toMatchObject({ inboxId: '1760000000000-abcdefabcdef', delivery: 'queued' });
    expect(result.current.sendError).toBeNull();
  });
});
