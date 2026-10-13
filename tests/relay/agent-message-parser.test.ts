/**
 * <agent_message> tag parser (spec 2026-10-13-agent-inbox-addressing, step 3).
 */
import {
  AGENT_MESSAGE_MAX_BODY_CHARS, AGENT_MESSAGE_MAX_PER_RESULT, parseAgentMessages,
} from '@gossip/relay/dashboard/agent-message-parser';

const ID = '1760000000000-0123456789ab';

describe('parseAgentMessages', () => {
  it('parses a valid tag with kind and in_reply_to', () => {
    const r = parseAgentMessages(`done.\n<agent_message to="orchestrator" in_reply_to="${ID}" kind="chat">  is X intended?  </agent_message>\ntrailer`);
    expect(r.dropped).toEqual([]);
    expect(r.messages).toEqual([{ to: 'orchestrator', text: 'is X intended?', kind: 'chat', in_reply_to: ID, truncated: false }]);
  });

  it('defaults kind to notice, and coerces answer / unknown kinds to notice', () => {
    const r = parseAgentMessages('<agent_message to="orchestrator">a</agent_message><agent_message to="orchestrator" kind="answer">b</agent_message><agent_message kind="zzz">c</agent_message>');
    expect(r.messages.map((m) => [m.text, m.kind])).toEqual([['a', 'notice'], ['b', 'notice'], ['c', 'notice']]);
  });

  it('parses multiple tags in order and caps at the per-result maximum', () => {
    const tags = Array.from({ length: 7 }, (_, i) => `<agent_message to="orchestrator">m${i}</agent_message>`).join('\n');
    const r = parseAgentMessages(tags);
    expect(r.messages).toHaveLength(AGENT_MESSAGE_MAX_PER_RESULT);
    expect(r.messages.map((m) => m.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(r.dropped).toEqual([{ reason: 'cap' }, { reason: 'cap' }]);
  });

  it('drops tags addressed to anyone but orchestrator (with a log-safe recipient)', () => {
    const r = parseAgentMessages('<agent_message to="human">hi</agent_message><agent_message to="codex-sol">x</agent_message><agent_message to="a b\x1b[31m">y</agent_message><agent_message to="orchestrator">ok</agent_message>');
    expect(r.messages.map((m) => m.text)).toEqual(['ok']);
    expect(r.dropped).toEqual([
      { reason: 'recipient', to: 'human' },
      { reason: 'recipient', to: 'codex-sol' },
      { reason: 'recipient', to: 'a?b??31m' },
    ]);
  });

  it('ignores malformed / unclosed tags, look-alike tag names and empty bodies', () => {
    expect(parseAgentMessages('<agent_message to="orchestrator">never closed').messages).toEqual([]);
    expect(parseAgentMessages('<agent_messages to="orchestrator">x</agent_messages>').messages).toEqual([]);
    expect(parseAgentMessages('<agent_message to="orchestrator">   </agent_message>').messages).toEqual([]);
    expect(parseAgentMessages('<agent_message to="orchestrator"').messages).toEqual([]);
    expect(parseAgentMessages(`<agent_message ${'x'.repeat(600)}>body</agent_message>`).messages).toEqual([]);
    expect(parseAgentMessages(undefined).messages).toEqual([]);
    expect(parseAgentMessages(42).messages).toEqual([]);
  });

  it('drops an invalid in_reply_to but keeps the message', () => {
    const r = parseAgentMessages('<agent_message to="orchestrator" in_reply_to="../../etc">x</agent_message>');
    expect(r.messages).toEqual([{ to: 'orchestrator', text: 'x', kind: 'notice', truncated: false }]);
  });

  it('never yields a sender: a from= attribute is ignored', () => {
    const r = parseAgentMessages('<agent_message to="orchestrator" from="human">spoof</agent_message>');
    expect(r.messages[0]).not.toHaveProperty('from');
  });

  it('caps the body with a truncation marker', () => {
    const r = parseAgentMessages(`<agent_message to="orchestrator">${'a'.repeat(AGENT_MESSAGE_MAX_BODY_CHARS + 10)}</agent_message>`);
    expect(r.messages[0].truncated).toBe(true);
    expect(r.messages[0].text.startsWith('a'.repeat(AGENT_MESSAGE_MAX_BODY_CHARS))).toBe(true);
    expect(r.messages[0].text).toContain('[truncated by gossipcat: 10 chars dropped]');
  });

  it('stays fast on adversarial input (many unclosed openers)', () => {
    const t = Date.now();
    parseAgentMessages('<agent_message '.repeat(50_000) + '>' + 'x'.repeat(100_000));
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
