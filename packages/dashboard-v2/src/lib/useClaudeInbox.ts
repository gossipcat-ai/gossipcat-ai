import { useEffect, useState } from 'react';
import type { BridgeMessage } from '@/lib/useBridge';

/**
 * useClaudeInbox — polls GET /dashboard/api/bridge/inbox for the durable
 * dashboard→Claude inbox (relay claude-inbox.ts):
 *   - link: a TRUTHFUL Claude reachability signal computed server-side from the
 *     MCP sink, confirmed channel mode, and the `gossipcat inbox wait`
 *     heartbeat — NOT from the dashboard's own SSE connection.
 *   - statusById: per-message delivery status (queued / delivered / answered)
 *     keyed by the inbox_id the POST returned.
 *
 * Fail-soft: an unreachable relay or an unexpected payload leaves link=null
 * (rendered as "unknown") and keeps the last statuses.
 */

export type DeliveryStatus = 'queued' | 'delivered' | 'answered';
export type ClaudeLinkState = 'channel' | 'listening' | 'recent' | 'session' | 'offline';

export interface ClaudeLink {
  state: ClaudeLinkState;
  last_seen?: string;
}

export interface ClaudeInboxView {
  link: ClaudeLink | null;
  statusById: Record<string, DeliveryStatus>;
}

const PATH = '/dashboard/api/bridge/inbox';
const POLL_MS = 3000;
const LINK_STATES: readonly string[] = ['channel', 'listening', 'recent', 'session', 'offline'];
const DELIVERY: readonly string[] = ['queued', 'delivered', 'answered'];

/** Validate an untrusted snapshot payload into a ClaudeInboxView (or null). */
export function parseInboxSnapshot(raw: unknown): ClaudeInboxView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { link?: unknown; messages?: unknown };
  const l = r.link as { state?: unknown; last_seen?: unknown } | undefined;
  if (!l || typeof l.state !== 'string' || !LINK_STATES.includes(l.state)) return null;
  const link: ClaudeLink = { state: l.state as ClaudeLinkState };
  if (typeof l.last_seen === 'string') link.last_seen = l.last_seen;
  const statusById: Record<string, DeliveryStatus> = {};
  if (Array.isArray(r.messages)) {
    for (const m of r.messages as Array<{ id?: unknown; status?: unknown }>) {
      if (m && typeof m.id === 'string' && typeof m.status === 'string' && DELIVERY.includes(m.status)) {
        statusById[m.id] = m.status as DeliveryStatus;
      }
    }
  }
  return { link, statusById };
}

/**
 * Merge a fresh snapshot into the previous view, PRESERVING object identity
 * when nothing changed — consumers memoize on statusById/link, and a new object
 * every poll would re-render (and re-scroll) the transcript every 3s.
 */
function mergeView(prev: ClaudeInboxView, next: ClaudeInboxView | null): ClaudeInboxView {
  const link = next?.link ?? null;
  const sameLink = link?.state === prev.link?.state && link?.last_seen === prev.link?.last_seen;
  let statusById = prev.statusById;
  if (next && Object.entries(next.statusById).some(([id, st]) => prev.statusById[id] !== st)) {
    statusById = { ...prev.statusById, ...next.statusById };
  }
  if (sameLink && statusById === prev.statusById) return prev;
  return { link: sameLink ? prev.link : link, statusById };
}

export function useClaudeInbox(
  chatId: string | null | undefined,
  enabled: boolean = true,
  pollMs: number = POLL_MS,
): ClaudeInboxView {
  const [view, setView] = useState<ClaudeInboxView>({ link: null, statusById: {} });

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const url = chatId ? `${PATH}?chat_id=${encodeURIComponent(chatId)}` : PATH;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(url, { credentials: 'include', signal: controller.signal });
        const parsed = res.ok ? parseInboxSnapshot(await res.json()) : null;
        if (!stopped) {
          setView((prev) => mergeView(prev, parsed));
        }
      } catch {
        if (!stopped) setView((prev) => mergeView(prev, null));
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), pollMs);
      }
    };
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [chatId, enabled, pollMs]);

  return view;
}

/** Annotate messages with their delivery status (pure; keeps identity when unchanged). */
export function withDelivery(messages: BridgeMessage[], statusById: Record<string, DeliveryStatus>): BridgeMessage[] {
  return messages.map((m) => {
    if (!m.inboxId) return m;
    const delivery = statusById[m.inboxId] ?? m.delivery;
    return delivery === m.delivery ? m : { ...m, delivery };
  });
}
