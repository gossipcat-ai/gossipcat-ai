import type { CSSProperties } from 'react';
import type { ClaudeLink, DeliveryStatus } from '@/lib/useClaudeInbox';

/**
 * InboxStatus — truthful Claude reachability + per-message delivery chips for
 * the durable dashboard→Claude inbox.
 *
 * DESIGN.md: status is always semantic. Link: --ok when Claude will see a
 * message now (channel / an `inbox wait` watcher is listening), --warn when it
 * will only be seen later (session up but not listening / watcher recently
 * exited), --idle when offline (messages queue). Delivery: queued --warn,
 * delivered --info (seen, no reply yet), answered --ok. Chips use the
 * `*-soft` bg + `*` fg pair, --r-pill, 11px, no shadow.
 */

export type InboxLang = 'en' | 'tr';

const LINK_TEXT: Record<InboxLang, Record<ClaudeLink['state'] | 'unknown', string>> = {
  en: {
    channel: 'Claude live (channel)',
    listening: 'Claude listening (inbox)',
    recent: 'Claude busy — will pick up',
    session: 'Claude session open, not listening — messages queue',
    offline: 'Claude offline — messages queue',
    unknown: 'Claude status unknown',
  },
  tr: {
    channel: 'Claude bağlı (kanal)',
    listening: 'Claude dinliyor (gelen kutusu)',
    recent: 'Claude meşgul — sonra alacak',
    session: 'Claude oturumu açık, dinlemiyor — mesajlar sırada',
    offline: 'Claude çevrimdışı — mesajlar sırada',
    unknown: 'Claude durumu bilinmiyor',
  },
};

const LINK_TONE: Record<ClaudeLink['state'] | 'unknown', 'ok' | 'warn' | 'idle'> = {
  channel: 'ok',
  listening: 'ok',
  recent: 'warn',
  session: 'warn',
  offline: 'idle',
  unknown: 'idle',
};

const DELIVERY_TEXT: Record<InboxLang, Record<DeliveryStatus, string>> = {
  en: { queued: 'queued', delivered: 'delivered', answered: 'answered' },
  tr: { queued: 'sırada', delivered: 'iletildi', answered: 'yanıtlandı' },
};

const DELIVERY_TONE: Record<DeliveryStatus, 'warn' | 'info' | 'ok'> = {
  queued: 'warn',
  delivered: 'info',
  answered: 'ok',
};

function chipStyle(tone: string): CSSProperties {
  return {
    background: `var(--${tone}-soft)`,
    color: `var(--${tone})`,
    borderRadius: 'var(--r-pill, 9999px)',
    padding: '1px 8px',
    fontSize: 11,
    fontWeight: 500,
  };
}

/** True when a just-sent message will be seen by Claude right away. */
export function isClaudeReachable(link: ClaudeLink | null): boolean {
  return link?.state === 'channel' || link?.state === 'listening';
}

export function ClaudeLinkBadge({ link, lang = 'en' }: { link: ClaudeLink | null; lang?: InboxLang }) {
  const state = link?.state ?? 'unknown';
  const tone = LINK_TONE[state];
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs"
      data-testid="claude-link"
      data-state={state}
      title={link?.last_seen ? `last inbox heartbeat ${link.last_seen}` : undefined}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: `var(--${tone})` }} aria-hidden />
      <span style={{ color: `var(--${tone})` }}>{LINK_TEXT[lang][state]}</span>
    </span>
  );
}

export function DeliveryChip({ status, lang = 'en' }: { status: DeliveryStatus; lang?: InboxLang }) {
  return (
    <span data-testid="delivery-chip" data-status={status} style={chipStyle(DELIVERY_TONE[status])}>
      {DELIVERY_TEXT[lang][status]}
    </span>
  );
}
