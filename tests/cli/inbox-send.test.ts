/**
 * gossip_inbox_send (spec 2026-10-13-agent-inbox-addressing, step 3) and the
 * hook "N more waiting" count, which must ignore agent-addressed mail.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ClaudeInbox, inboxDirFor } from '@gossip/relay/dashboard/claude-inbox';
import { acceptAgentMessages } from '@gossip/relay/dashboard/agent-mail';
import { INBOX_SEND_MAX_CHARS, readConfiguredAgentIds, sendInboxMail } from '../../apps/cli/src/handlers/inbox-send';
import { AGENT_MAIL_MAX_CHARS, prepareAgentMail } from '@gossip/relay/dashboard/agent-mail';
import { claimForHook } from '../../apps/cli/src/inbox-format';

let root: string;
let inbox: ClaudeInbox;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'inbox-send-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  writeFileSync(join(root, '.gossip', 'config.json'), JSON.stringify({
    main_agent: { provider: 'none', model: 'x' },
    agents: { 'codex-sol': { provider: 'openai', model: 'x' }, 'sonnet-reviewer': { provider: 'anthropic', model: 'y' }, human: { provider: 'x', model: 'y' } },
  }));
  inbox = new ClaudeInbox(inboxDirFor(root));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('sendInboxMail', () => {
  it('reads configured agent ids, excluding non-agent parties', () => {
    expect(readConfiguredAgentIds(root).sort()).toEqual(['codex-sol', 'sonnet-reviewer']);
    expect(readConfiguredAgentIds(join(root, 'nope'))).toEqual([]);
  });

  it('writes from=orchestrator to a configured agent on chat agent-<id>, default kind chat', () => {
    const r = sendInboxMail(root, { to: 'codex-sol', text: 'please re-run', ref: { task_id: 'ab12cd34', file: '../etc/passwd' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(inbox.get(r.id)).toMatchObject({
      from: 'orchestrator', to: 'codex-sol', kind: 'chat', chat_id: 'agent-codex-sol', content: 'please re-run',
      ref: { task_id: 'ab12cd34' }, status: 'queued',
    });
  });

  it('rejects unknown agents, human, orchestrator, empty text and bad kinds', () => {
    for (const to of ['ghost', 'human', 'orchestrator', '../x', 42]) {
      expect(sendInboxMail(root, { to, text: 'x' }).ok).toBe(false);
    }
    expect(sendInboxMail(root, { to: 'codex-sol', text: '  ' }).ok).toBe(false);
    expect(sendInboxMail(root, { to: 'codex-sol', text: 'x', kind: 'shout' }).ok).toBe(false);
    expect(inbox.list()).toEqual([]);
  });

  it('rejects text longer than one dispatch can deliver whole; the longest accepted text is delivered untruncated', () => {
    expect(INBOX_SEND_MAX_CHARS).toBeLessThan(AGENT_MAIL_MAX_CHARS);
    const tooLong = sendInboxMail(root, { to: 'codex-sol', text: 'x'.repeat(INBOX_SEND_MAX_CHARS + 1) });
    expect(tooLong).toEqual({ ok: false, error: expect.stringContaining(`at most ${INBOX_SEND_MAX_CHARS} chars`) });
    expect(inbox.list()).toEqual([]);
    const r = sendInboxMail(root, {
      to: 'codex-sol', text: 'y'.repeat(INBOX_SEND_MAX_CHARS), kind: 'notice', ref: { task_id: 'z'.repeat(64) },
    });
    expect(r.ok).toBe(true);
    const batch = prepareAgentMail(inbox, 'codex-sol')!;
    expect(batch.block).toContain('y'.repeat(INBOX_SEND_MAX_CHARS));
    expect(batch.block).not.toContain('[truncated');
  });

  it('never takes the slots reserved for the human; human mail still fits', () => {
    const t0 = Date.now() - 1_000_000;
    for (let i = 0; i < 150; i++) inbox.append(`chat-${i}`, `h${i}`, t0 + i);
    const r = sendInboxMail(root, { to: 'codex-sol', text: 'one more' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/reserved|kept for the human/);
    expect(() => inbox.append('chat-human', 'still room for me', t0 + 500)).not.toThrow();
  });

  it('a stamped from can not be overridden by arguments', () => {
    const r = sendInboxMail(root, { to: 'codex-sol', text: 'x', from: 'human' } as any);
    expect(r.ok && inbox.get(r.id)!.from).toBe('orchestrator');
  });

  it('in_reply_to closes that agent\'s mail to the orchestrator, never a human message', () => {
    const [agentMsg] = acceptAgentMessages(inbox, 'codex-sol', 't1', '<agent_message>which branch?</agent_message>', () => {}, Date.now() - 1000);
    const human = inbox.append('dash-1', 'hi from the human', Date.now() - 500).id;
    const r1 = sendInboxMail(root, { to: 'codex-sol', text: 'master', in_reply_to: agentMsg });
    expect(r1.ok && r1.closed).toBe(true);
    expect(inbox.get(agentMsg)!.status).toBe('answered');
    const r2 = sendInboxMail(root, { to: 'codex-sol', text: 'x', in_reply_to: human });
    expect(r2.ok && r2.closed).toBe(false);
    expect(inbox.get(human)!.status).toBe('queued');
  });
});

describe('hook "N more waiting" count', () => {
  it('ignores mail addressed to agents', () => {
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 30; i++) sendInboxMail(root, { to: 'codex-sol', text: `agent mail ${i}` });
    for (let i = 0; i < 26; i++) inbox.append('dash', `human ${i}`, t0 + i);
    const { text, count } = claimForHook(inbox, { now: Date.now() });
    expect(count).toBe(5);
    // 26 orchestrator-addressed: 5 shown, 21 more (the 30 agent mails are not counted).
    expect(text).toContain('21 more waiting');
  });

  it('reports no remainder when only agent mail is queued beyond the window', () => {
    for (let i = 0; i < 30; i++) sendInboxMail(root, { to: 'codex-sol', text: `agent mail ${i}` });
    inbox.append('dash', 'one human message', Date.now() - 60_000);
    const { text, count } = claimForHook(inbox, { now: Date.now() });
    expect(count).toBe(1);
    expect(text).not.toContain('more waiting');
  });
});
