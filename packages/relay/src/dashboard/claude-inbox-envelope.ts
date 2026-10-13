/**
 * claude-inbox-envelope.ts — addressing envelope of a durable inbox record
 * (docs/specs/2026-10-13-agent-inbox-addressing.md, step 1).
 *
 * TRUST BOUNDARY: the envelope is validated when written AND when read back
 * from disk (record files are plain JSON any local process could edit).
 * - `to` / `from` decide who may claim a message and how it is fenced, so a
 *   PRESENT but invalid value is fail-closed: append() throws and the record is
 *   unreadable on load (never silently re-labelled as human mail).
 * - `kind` / `qid` / `ref` / `in_reply_to` are informational: invalid values
 *   are dropped, never coerced.
 * Missing fields (legacy records) default to to=orchestrator, from=human,
 * kind=chat. `from` is stamped by the relay in code, never parsed from text.
 */

/** Addressing party: 'human' | 'orchestrator' | an agent id (same shape). */
export const INBOX_PARTY_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const QID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
/** task ids, finding ids (`<consensus>:<agent>:fN`), file paths (`a/b.ts:12`). */
const REF_VALUE_RE = /^[A-Za-z0-9_.:/@#-]{1,256}$/;
/** Same shape as INBOX_ID_RE (kept here to avoid an import cycle). */
const IN_REPLY_TO_RE = /^\d{13}-[0-9a-f]{12}$/;
const KINDS = ['chat', 'answer', 'notice'] as const;
const REF_KEYS = ['task_id', 'finding_id', 'file'] as const;

export type InboxKind = (typeof KINDS)[number];

export interface InboxRef {
  task_id?: string;
  finding_id?: string;
  file?: string;
}

/** Caller-supplied envelope for append(); every field optional. */
export interface InboxEnvelope {
  to?: string;
  from?: string;
  kind?: InboxKind;
  qid?: string;
  ref?: InboxRef;
  in_reply_to?: string;
}

/** Normalized envelope: routing fields always present. */
export interface ResolvedEnvelope {
  to: string;
  from: string;
  kind: InboxKind;
  qid?: string;
  ref?: InboxRef;
  in_reply_to?: string;
}

export const DEFAULT_TO = 'orchestrator';
export const DEFAULT_FROM = 'human';
export const DEFAULT_KIND: InboxKind = 'chat';

function isKind(v: unknown): v is InboxKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

function party(v: unknown, fallback: string): string | null {
  if (v === undefined) return fallback;
  return typeof v === 'string' && INBOX_PARTY_RE.test(v) ? v : null;
}

function readRef(v: unknown): InboxRef | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const src = v as Record<string, unknown>;
  const out: InboxRef = {};
  for (const k of REF_KEYS) {
    const x = src[k];
    if (typeof x === 'string' && REF_VALUE_RE.test(x) && !x.split('/').includes('..')) out[k] = x;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate an envelope from any source (caller or disk). Returns null when a
 * present `to`/`from` is invalid (fail-closed); drops invalid optional fields.
 */
export function resolveEnvelope(raw: unknown): ResolvedEnvelope | null {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const to = party(src['to'], DEFAULT_TO);
  const from = party(src['from'], DEFAULT_FROM);
  if (to === null || from === null) return null;
  const env: ResolvedEnvelope = { to, from, kind: isKind(src['kind']) ? src['kind'] : DEFAULT_KIND };
  const qid = src['qid'];
  if (typeof qid === 'string' && QID_RE.test(qid)) env.qid = qid;
  const ref = readRef(src['ref']);
  if (ref) env.ref = ref;
  const irt = src['in_reply_to'];
  if (typeof irt === 'string' && IN_REPLY_TO_RE.test(irt)) env.in_reply_to = irt;
  return env;
}
