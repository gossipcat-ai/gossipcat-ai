/**
 * agent-message-parser.ts — parse `<agent_message>` tags out of an agent's
 * task result (docs/specs/2026-10-13-agent-inbox-addressing.md, step 3).
 *
 *   <agent_message to="orchestrator" in_reply_to="<inbox id>" kind="chat|notice">text</agent_message>
 *
 * TRUST BOUNDARY: the result is LLM output. This parser is pure and only
 * extracts candidate messages; it never decides the sender (the caller stamps
 * `from` from the validated task record). Only `to="orchestrator"` is accepted
 * (a missing `to` means orchestrator, the only legal recipient today); any
 * other recipient is reported in `dropped`. `kind` is chat|notice (anything
 * else, including 'answer', becomes notice). An invalid `in_reply_to` is
 * dropped, not the message. Unclosed or attribute-less-garbage tags are
 * ignored. The scan is linear (indexOf, no backtracking regex over the body).
 */

/** Max messages accepted from one task result. */
export const AGENT_MESSAGE_MAX_PER_RESULT = 5;
/** Max body chars per message; longer bodies are cut with a marker. */
export const AGENT_MESSAGE_MAX_BODY_CHARS = 8 * 1024;
/** Only this prefix of a result is scanned (results are capped upstream anyway). */
export const AGENT_MESSAGE_MAX_SCAN_CHARS = 1_048_576;
/** The only recipient agents may address in this step. */
export const AGENT_MESSAGE_RECIPIENT = 'orchestrator';

const OPEN = '<agent_message';
const CLOSE = '</agent_message>';
const MAX_ATTR_CHARS = 512;
const ATTR_RE = /([a-z_]+)\s*=\s*"([^"]*)"/g;
const INBOX_ID_SHAPE = /^\d{13}-[0-9a-f]{12}$/;
const SAFE_LOG_RE = /[^A-Za-z0-9_.:-]/g;

export type AgentMessageKind = 'chat' | 'notice';

export interface ParsedAgentMessage {
  to: typeof AGENT_MESSAGE_RECIPIENT;
  text: string;
  kind: AgentMessageKind;
  in_reply_to?: string;
  truncated: boolean;
}

export interface DroppedAgentMessage {
  reason: 'recipient' | 'cap';
  /** Log-safe (escaped, capped) recipient, for `recipient` drops. */
  to?: string;
}

export interface AgentMessageParse {
  messages: ParsedAgentMessage[];
  dropped: DroppedAgentMessage[];
}

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of raw.matchAll(ATTR_RE)) {
    if (!attrs.has(m[1])) attrs.set(m[1], m[2]);
  }
  return attrs;
}

function capBody(text: string): { text: string; truncated: boolean } {
  if (text.length <= AGENT_MESSAGE_MAX_BODY_CHARS) return { text, truncated: false };
  const cut = text.length - AGENT_MESSAGE_MAX_BODY_CHARS;
  return { text: `${text.slice(0, AGENT_MESSAGE_MAX_BODY_CHARS)}\n[truncated by gossipcat: ${cut} chars dropped]`, truncated: true };
}

/** Extract `<agent_message>` tags from a task result. Never throws. */
export function parseAgentMessages(result: unknown): AgentMessageParse {
  const out: AgentMessageParse = { messages: [], dropped: [] };
  if (typeof result !== 'string' || !result.includes(OPEN)) return out;
  const src = result.length > AGENT_MESSAGE_MAX_SCAN_CHARS ? result.slice(0, AGENT_MESSAGE_MAX_SCAN_CHARS) : result;
  let pos = 0;
  for (;;) {
    const start = src.indexOf(OPEN, pos);
    if (start < 0) break;
    const afterName = start + OPEN.length;
    const next = src[afterName];
    // `<agent_messages`, `<agent_message_x` etc. are not our tag.
    if (next !== '>' && next !== ' ' && next !== '\t' && next !== '\n' && next !== '\r') { pos = afterName; continue; }
    // Bounded window: a far-away '>' must not make every opener rescan the input.
    const rel = src.slice(afterName, afterName + MAX_ATTR_CHARS + 1).indexOf('>');
    if (rel < 0) { pos = afterName; continue; }
    const gt = afterName + rel;
    const close = src.indexOf(CLOSE, gt + 1);
    // No closing tag after this opener means none after any later opener either.
    if (close < 0) break;
    pos = close + CLOSE.length;
    const attrs = parseAttrs(src.slice(afterName, gt));
    const body = src.slice(gt + 1, close).trim();
    if (body.length === 0) continue;
    const to = attrs.get('to') ?? AGENT_MESSAGE_RECIPIENT;
    if (to !== AGENT_MESSAGE_RECIPIENT) {
      out.dropped.push({ reason: 'recipient', to: to.slice(0, 64).replace(SAFE_LOG_RE, '?') });
      continue;
    }
    if (out.messages.length >= AGENT_MESSAGE_MAX_PER_RESULT) {
      out.dropped.push({ reason: 'cap' });
      continue;
    }
    const capped = capBody(body);
    const msg: ParsedAgentMessage = {
      to: AGENT_MESSAGE_RECIPIENT,
      text: capped.text,
      kind: attrs.get('kind') === 'chat' ? 'chat' : 'notice',
      truncated: capped.truncated,
    };
    const irt = attrs.get('in_reply_to');
    if (irt !== undefined && INBOX_ID_SHAPE.test(irt)) msg.in_reply_to = irt;
    out.messages.push(msg);
  }
  return out;
}
