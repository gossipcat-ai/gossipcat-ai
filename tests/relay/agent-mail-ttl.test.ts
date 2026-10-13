/**
 * Agent-mail TTL (agent-inbox spec step 6): unanswered agent ↔ orchestrator
 * mail older than AGENT_MAIL_TTL_MS is closed as answered(via 'expired') by the
 * prune pass; human mail never expires.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AGENT_MAIL_TTL_MS, ClaudeInbox, inboxDirFor } from '@gossip/relay/dashboard/claude-inbox';
import { isExpirableMail, pruneLogPath, readPruneLog } from '@gossip/relay/dashboard/claude-inbox-prune';
import {
  AGENT_MAIL_MAX_UNANSWERED_PER_SENDER, agentChatId, agentMailRoom, prepareAgentMail,
} from '@gossip/relay/dashboard/agent-mail';
import { runInboxCommand } from '../../apps/cli/src/inbox-command';
import { claimQueued } from '../../apps/cli/src/inbox-format';

let root: string;
let inbox: ClaudeInbox;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-mail-ttl-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  inbox = new ClaudeInbox(inboxDirFor(root));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const AGENT = 'sonnet-reviewer';
const chat = agentChatId(AGENT) as string;

describe('agent mail TTL', () => {
  it('expires agent mail in both directions, never human mail, and records telemetry', async () => {
    const now = Date.now();
    const old = now - AGENT_MAIL_TTL_MS - 60_000;
    const fromAgent = inbox.append(chat, 'from agent', old, { to: 'orchestrator', from: AGENT });
    const toAgent = inbox.append(chat, 'to agent', old + 1, { to: AGENT, from: 'orchestrator' });
    const human = inbox.append('chat-h', 'human', old + 2);
    const freshAgent = inbox.append(chat, 'fresh', now - 1000, { to: 'orchestrator', from: AGENT });
    claimQueued(inbox, 10, 'wait'); // delivered-unanswered also expires

    inbox.prune(now);
    expect(inbox.get(fromAgent.id)).toMatchObject({ status: 'answered', answered_via: 'expired' });
    expect(inbox.get(toAgent.id)).toMatchObject({ status: 'answered', answered_via: 'expired' });
    expect(inbox.get(human.id)?.status).toBe('delivered');
    expect(inbox.get(freshAgent.id)?.status).toBe('delivered');
    expect(readPruneLog(inbox.directory).expired_agent_mail).toBe(2);
    expect(JSON.parse(readFileSync(pruneLogPath(inbox.directory), 'utf-8'))).toMatchObject({ last_expired: 2, last_count: 0 });
    expect(inbox.stats().unanswered).toBe(2);
    expect(prepareAgentMail(inbox, AGENT)).toBeNull(); // expired mail is not delivered

    inbox.prune(now + 1000); // idempotent
    expect(readPruneLog(inbox.directory).expired_agent_mail).toBe(2);

    const out: string[] = [];
    await runInboxCommand(['list'], { out: (s) => out.push(s), err: () => undefined, root });
    const lines = out.join('').split('\n');
    expect(lines.find((l) => l.startsWith(fromAgent.id))).toContain('expired');
    expect(lines.find((l) => l.startsWith(human.id))).toContain('delivered');
    const j: string[] = [];
    await runInboxCommand(['list', '--json'], { out: (s) => j.push(s), err: () => undefined, root });
    expect(JSON.parse(j.join('')).find((e: { id: string }) => e.id === toAgent.id))
      .toMatchObject({ status: 'answered', answered_via: 'expired' });
  });

  it('frees the sender quota and the shared cap once expired', () => {
    const now = Date.now();
    const old = now - AGENT_MAIL_TTL_MS - 60_000;
    for (let i = 0; i < AGENT_MAIL_MAX_UNANSWERED_PER_SENDER; i++) {
      inbox.append(chat, `m${i}`, old + i, { to: 'orchestrator', from: AGENT });
    }
    expect(agentMailRoom(inbox, AGENT)).toBe(0);
    inbox.append('chat-h', 'human triggers prune', now); // append runs the prune pass
    expect(agentMailRoom(inbox, AGENT)).toBe(AGENT_MAIL_MAX_UNANSWERED_PER_SENDER);
    expect(inbox.stats().unanswered).toBe(1);
  });

  it('isExpirableMail: only agent→orchestrator and orchestrator→agent', () => {
    expect(isExpirableMail({ from: AGENT, to: 'orchestrator' })).toBe(true);
    expect(isExpirableMail({ from: 'orchestrator', to: AGENT })).toBe(true);
    expect(isExpirableMail({ from: 'human', to: 'orchestrator' })).toBe(false);
    expect(isExpirableMail({ from: 'orchestrator', to: 'human' })).toBe(false);
    expect(isExpirableMail({ from: 'orchestrator', to: 'orchestrator' })).toBe(false);
    expect(isExpirableMail({ from: AGENT, to: 'human' })).toBe(false);
  });
});
