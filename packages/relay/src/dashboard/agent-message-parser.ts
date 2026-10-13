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
 *
 * Only a REAL tag counts: its opener must start a line (optionally after
 * spaces/tabs), outside fenced code blocks (``` / ~~~) and outside
 * <agent_finding>…</agent_finding> bodies. Quoted examples — inline, fenced, or
 * inside a finding — are never turned into mail attributed to the agent.
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

const FINDING_OPEN = '<agent_finding';
const FINDING_CLOSE = '</agent_finding>';

/** Index of the first non-space/tab char at or after `from`, bounded by `end`. */
function skipIndent(src: string, from: number, end: number): number {
  let i = from;
  while (i < end && (src[i] === ' ' || src[i] === '\t')) i++;
  return i;
}

/** Length of a ``` / ~~~ fence run at `i` (>= 3), else 0. */
function fenceRun(src: string, i: number, end: number): number {
  const c = src[i];
  if (c !== '`' && c !== '~') return 0;
  let j = i;
  while (j < end && src[j] === c) j++;
  return j - i >= 3 ? j - i : 0;
}

/** Whether `<agent_finding` is left open at the end of src[from, end). */
function findingOpenAfter(src: string, from: number, end: number, wasOpen: boolean): boolean {
  const seg = src.slice(from, end);
  const lastOpen = seg.lastIndexOf(FINDING_OPEN);
  const lastClose = seg.lastIndexOf(FINDING_CLOSE);
  if (lastOpen < 0 && lastClose < 0) return wasOpen;
  return lastOpen > lastClose;
}

/** Parse one tag whose opener is at `start`; returns the next scan position, or -1 to stop. */
function takeTag(src: string, start: number, out: AgentMessageParse): number {
  const afterName = start + OPEN.length;
  const rel = src.slice(afterName, afterName + MAX_ATTR_CHARS + 1).indexOf('>');
  if (rel < 0) return afterName;
  const gt = afterName + rel;
  const close = src.indexOf(CLOSE, gt + 1);
  // No closing tag after this opener means none after any later opener either.
  if (close < 0) return -1;
  const attrs = parseAttrs(src.slice(afterName, gt));
  const body = src.slice(gt + 1, close).trim();
  const next = close + CLOSE.length;
  if (body.length === 0) return next;
  const to = attrs.get('to') ?? AGENT_MESSAGE_RECIPIENT;
  if (to !== AGENT_MESSAGE_RECIPIENT) {
    out.dropped.push({ reason: 'recipient', to: to.slice(0, 64).replace(SAFE_LOG_RE, '?') });
    return next;
  }
  if (out.messages.length >= AGENT_MESSAGE_MAX_PER_RESULT) {
    out.dropped.push({ reason: 'cap' });
    return next;
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
  return next;
}

function isTagStart(src: string, i: number): boolean {
  if (!src.startsWith(OPEN, i)) return false;
  // `<agent_messages`, `<agent_message_x` etc. are not our tag.
  const next = src[i + OPEN.length];
  return next === '>' || next === ' ' || next === '\t' || next === '\n' || next === '\r';
}

/**
 * Extract `<agent_message>` tags from a task result. Never throws. One pass
 * over lines: fence / finding state is tracked per line, and a tag body is
 * consumed up to its closing tag (scanning resumes on the rest of that line).
 */
export function parseAgentMessages(result: unknown): AgentMessageParse {
  const out: AgentMessageParse = { messages: [], dropped: [] };
  if (typeof result !== 'string' || !result.includes(OPEN)) return out;
  const src = result.length > AGENT_MESSAGE_MAX_SCAN_CHARS ? result.slice(0, AGENT_MESSAGE_MAX_SCAN_CHARS) : result;
  let fence: { char: string; len: number } | null = null;
  let inFinding = false;
  let pos = 0;
  while (pos < src.length) {
    const nl = src.indexOf('\n', pos);
    const end = nl < 0 ? src.length : nl;
    const first = skipIndent(src, pos, end);
    const run = fenceRun(src, first, end);
    if (fence) {
      if (run >= fence.len && src[first] === fence.char && src.slice(first + run, end).trim() === '') fence = null;
    } else if (inFinding) {
      inFinding = findingOpenAfter(src, pos, end, true);
    } else if (run > 0) {
      fence = { char: src[first], len: run };
    } else if (isTagStart(src, first)) {
      const next = takeTag(src, first, out);
      if (next < 0) break;
      // Resume on the remainder of the line the tag ended on: mid-line, so only
      // an <agent_finding> opener there can matter.
      const restEnd = src.indexOf('\n', next);
      const lineEnd = restEnd < 0 ? src.length : restEnd;
      inFinding = findingOpenAfter(src, next, lineEnd, false);
      pos = lineEnd + 1;
      continue;
    } else {
      inFinding = findingOpenAfter(src, pos, end, false);
    }
    pos = end + 1;
  }
  return out;
}
