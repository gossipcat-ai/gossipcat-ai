/**
 * inbox-send.ts — `gossip_inbox_send`: the orchestrator writes mail to a
 * configured agent (docs/specs/2026-10-13-agent-inbox-addressing.md, step 3).
 * The mail is delivered into that agent's prompt on its next dispatch.
 *
 * TRUST BOUNDARY: every argument is model-supplied. `from` is always
 * 'orchestrator' (stamped here). `to` must be an agent id configured in
 * .gossip/config.json (never 'human' / 'orchestrator' — the human is answered
 * with `gossip_chat_reply`). kind/ref/in_reply_to are validated by the store and dropped
 * when invalid.
 */
import { readFileSync } from 'fs';
import {
  ClaudeInbox, InboxFullError, INBOX_ID_RE, INBOX_MAX_UNANSWERED, inboxDirFor, type InboxKind, type InboxRef,
} from '@gossip/relay/dashboard/claude-inbox';
import { AGENT_MAIL_MAX_MESSAGE_CHARS, AGENT_MAIL_RESERVED_SLOTS, agentChatId, closeRepliedMail, isAgentParty } from '@gossip/relay/dashboard/agent-mail';

/** Longest text gossip_inbox_send accepts: what one dispatch can deliver whole. */
export const INBOX_SEND_MAX_CHARS = AGENT_MAIL_MAX_MESSAGE_CHARS;
import { findConfigPath } from '../config';

export interface InboxSendArgs {
  to: unknown;
  text: unknown;
  kind?: unknown;
  ref?: unknown;
  in_reply_to?: unknown;
}

export type InboxSendResult = { ok: true; id: string; closed: boolean } | { ok: false; error: string };

const SEND_KINDS: readonly InboxKind[] = ['chat', 'notice', 'answer'];

/** Agent ids declared in the project's JSON config; empty on any doubt (fail closed). */
export function readConfiguredAgentIds(projectRoot: string): string[] {
  try {
    const path = findConfigPath(projectRoot);
    if (!path || !path.endsWith('.json')) return [];
    const agents = (JSON.parse(readFileSync(path, 'utf-8')) as { agents?: unknown }).agents;
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return [];
    return Object.keys(agents).filter(isAgentParty);
  } catch {
    return [];
  }
}

export function sendInboxMail(projectRoot: string, args: InboxSendArgs, agentIds: readonly string[] = readConfiguredAgentIds(projectRoot)): InboxSendResult {
  const { to, text } = args;
  if (typeof to !== 'string' || !isAgentParty(to) || !agentIds.includes(to)) {
    return { ok: false, error: `"to" must be a configured agent id (one of: ${agentIds.join(', ') || 'none'}). Use \`reply\` to answer the human.` };
  }
  if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, error: '"text" must be a non-empty string.' };
  if (text.length > INBOX_SEND_MAX_CHARS) {
    return { ok: false, error: `"text" is ${text.length} chars; one message can carry at most ${INBOX_SEND_MAX_CHARS} chars into an agent's prompt. Shorten it or split it into several messages.` };
  }
  if (args.kind !== undefined && !SEND_KINDS.includes(args.kind as InboxKind)) {
    return { ok: false, error: '"kind" must be chat, notice or answer.' };
  }
  const chatId = agentChatId(to);
  if (!chatId) return { ok: false, error: `invalid agent id "${to}".` };
  const irt = typeof args.in_reply_to === 'string' && INBOX_ID_RE.test(args.in_reply_to) ? args.in_reply_to : undefined;
  const inbox = new ClaudeInbox(inboxDirFor(projectRoot));
  // Like agent-authored mail, orchestrator→agent mail never takes the slots reserved for the human.
  const unanswered = inbox.stats().unanswered;
  if (unanswered >= INBOX_MAX_UNANSWERED - AGENT_MAIL_RESERVED_SLOTS) {
    return { ok: false, error: `inbox nearly full (${unanswered} unanswered messages); the last ${AGENT_MAIL_RESERVED_SLOTS} slots are kept for the human.` };
  }
  try {
    const e = inbox.append(chatId, text, Date.now(), {
      to, from: 'orchestrator', kind: (args.kind as InboxKind | undefined) ?? 'chat',
      ...(args.ref && typeof args.ref === 'object' ? { ref: args.ref as InboxRef } : {}),
      ...(irt ? { in_reply_to: irt } : {}),
    });
    // Answering this agent's mail to the orchestrator closes it (never a human message).
    const closed = irt ? closeRepliedMail(inbox, irt, 'orchestrator', to) : false;
    return { ok: true, id: e.id, closed };
  } catch (err) {
    if (err instanceof InboxFullError) return { ok: false, error: `inbox full (${err.unanswered} unanswered messages).` };
    return { ok: false, error: (err as Error).message };
  }
}
