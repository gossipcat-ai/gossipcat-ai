/**
 * Idle recovery (agent-inbox spec step 5): the `inbox wait` watcher re-surfaces
 * delivered-but-unanswered orchestrator mail after the grace period, sharing
 * the race-free reminder bookkeeping with the hooks, capped at
 * INBOX_MAX_REMINDERS; delivered markers record the claiming consumer.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ClaudeInbox, inboxDirFor } from '@gossip/relay/dashboard/claude-inbox';
import { runInboxCommand } from '../../apps/cli/src/inbox-command';
import {
  CHANNEL_GRACE_MS, claimQueued, claimUnanswered, INBOX_MAX_REMINDERS, renderPromptHookInjection, UNANSWERED_GRACE_MS,
} from '../../apps/cli/src/inbox-format';

let root: string;
let inbox: ClaudeInbox;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'inbox-resurface-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  inbox = new ClaudeInbox(inboxDirFor(root));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function io(now: number, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  return { out, io: { out: (s: string) => out.push(s), err: () => undefined, root, pollMs: 50, now: () => now, env } };
}

const iso = (t: number): string => new Date(t).toISOString();
const wait = (now: number, env: NodeJS.ProcessEnv = {}) => {
  const t = io(now, env);
  return runInboxCommand(['wait', '--timeout', '1'], t.io).then((code) => ({ code, text: t.out.join('') }));
};

describe('watcher idle recovery', () => {
  it('re-surfaces a delivered-unanswered message after the grace period, once per window', async () => {
    const t0 = Date.now();
    const e = inbox.append('c', 'printed then lost', t0);
    expect(claimQueued(inbox, 10, 'wait').claimed).toHaveLength(1);

    expect((await wait(t0 + 1000)).code).toBe(2); // within grace: nothing

    const later = t0 + UNANSWERED_GRACE_MS + 1000;
    const first = await wait(later);
    expect(first.code).toBe(0);
    expect(first.text).toContain('printed then lost');
    expect(first.text).toContain('[unanswered');
    expect(inbox.get(e.id)).toMatchObject({ status: 'delivered', reminded_at: iso(later), reminded_count: 1 });

    expect((await wait(later + 1000)).code).toBe(2); // same window: not again
    expect((await wait(later + UNANSWERED_GRACE_MS + 1000)).text).toContain('printed then lost');
    expect(inbox.get(e.id)?.reminded_count).toBe(2);
  });

  it('hooks and the watcher never both remind for the same window', async () => {
    const t0 = Date.now();
    inbox.append('c', 'shared window', t0);
    claimQueued(inbox, 10, 'wait');
    const t1 = t0 + UNANSWERED_GRACE_MS + 1000;
    expect(renderPromptHookInjection(root, {}, t1)).toContain('shared window');
    expect((await wait(t1 + 1000)).code).toBe(2);
    const t2 = t1 + UNANSWERED_GRACE_MS + 1000;
    expect((await wait(t2)).text).toContain('shared window');
    expect(renderPromptHookInjection(root, {}, t2 + 1000)).toBe('');
  });

  it('stops after INBOX_MAX_REMINDERS; the message stays delivered and listed', async () => {
    const t0 = Date.now();
    const e = inbox.append('c', 'nag', t0);
    claimQueued(inbox, 10, 'wait');
    let t = t0;
    for (let i = 0; i < INBOX_MAX_REMINDERS; i++) {
      t += UNANSWERED_GRACE_MS + 1000;
      expect(claimUnanswered(inbox, 10, { now: t })).toHaveLength(1);
    }
    t += UNANSWERED_GRACE_MS + 1000;
    expect(claimUnanswered(inbox, 10, { now: t })).toHaveLength(0);
    expect(renderPromptHookInjection(root, {}, t)).toBe('');
    expect((await wait(t)).code).toBe(2);
    expect(inbox.get(e.id)).toMatchObject({ status: 'delivered', reminded_count: INBOX_MAX_REMINDERS });
    const l = io(t);
    await runInboxCommand(['list'], l.io);
    expect(l.out.join('')).toContain('delivered');
  });

  it('a capped message does not block a later due one', () => {
    const t0 = Date.now();
    const capped = inbox.append('c', 'capped', t0);
    const fresh = inbox.append('c', 'fresh', t0 + 1);
    claimQueued(inbox, 10, 'wait');
    writeFileSync(join(inbox.directory, `${capped.id}.reminded`), JSON.stringify({ at: iso(t0), count: INBOX_MAX_REMINDERS }));
    const got = claimUnanswered(inbox, 1, { now: t0 + UNANSWERED_GRACE_MS + 1000 });
    expect(got.map((e) => e.id)).toEqual([fresh.id]);
  });

  it('a legacy `.reminded` marker without count counts as 1', () => {
    const t0 = Date.now();
    const e = inbox.append('c', 'legacy', t0);
    claimQueued(inbox, 10, 'wait');
    writeFileSync(join(inbox.directory, `${e.id}.reminded`), JSON.stringify({ at: iso(t0) }));
    expect(inbox.get(e.id)?.reminded_count).toBe(1);
    expect(claimUnanswered(inbox, 10, { now: t0 + UNANSWERED_GRACE_MS + 1000 })).toHaveLength(1);
    expect(inbox.get(e.id)?.reminded_count).toBe(2);
  });

  it('claimReminder: a reminder that lands between read and rename wins; the loser backs off', () => {
    const t0 = Date.now();
    const e = inbox.append('c', 'race', t0);
    inbox.mark(e.id, 'delivered', 'wait');
    writeFileSync(join(inbox.directory, `${e.id}.reminded`), JSON.stringify({ at: iso(t0), count: 1 }));
    const other = new ClaudeInbox(inboxDirFor(root));
    const now = t0 + UNANSWERED_GRACE_MS + 1000;
    const got = inbox.claimReminder(e.id, now, () => {
      expect(other.claimReminder(e.id, now + 5, () => true)).toBe(2); // the concurrent consumer
      return true;
    });
    expect(got).toBeNull();
    expect(JSON.parse(readFileSync(join(inbox.directory, `${e.id}.reminded`), 'utf-8'))).toEqual({ at: iso(now + 5), count: 2 });
  });

  it('channel mode: does not re-surface mail received within the channel grace', async () => {
    const t0 = Date.now();
    const e = inbox.append('c', 'channel turn', t0);
    // Delivered "long ago" (clock skew / fabricated marker), but received just now.
    writeFileSync(join(inbox.directory, `${e.id}.delivered`), JSON.stringify({ at: iso(t0 - 2 * UNANSWERED_GRACE_MS), via: 'wait' }));
    const now = t0 + CHANNEL_GRACE_MS - 1000;
    expect((await wait(now, { GOSSIPCAT_CHANNEL_ACTIVE: '1' })).code).toBe(2);
    expect((await wait(now, {})).text).toContain('channel turn');
  });

  it('channel mode: hooks still hold fresh queued mail for the channel grace', () => {
    const t0 = Date.now();
    inbox.append('c', 'queued in channel', t0);
    expect(renderPromptHookInjection(root, { GOSSIPCAT_CHANNEL_ACTIVE: '1' }, t0 + 1000)).toBe('');
    expect(renderPromptHookInjection(root, { GOSSIPCAT_CHANNEL_ACTIVE: '1' }, t0 + CHANNEL_GRACE_MS + 1000)).toContain('queued in channel');
  });
});

describe('delivered marker consumer', () => {
  it('records wait:<pid> / hook:<pid>; old markers without it still read', () => {
    const a = inbox.append('c', 'a', 1_700_000_000_001);
    claimQueued(inbox, 10, 'wait');
    expect(inbox.get(a.id)).toMatchObject({ status: 'delivered', delivered_via: 'wait', delivered_consumer: `wait:${process.pid}` });

    const b = inbox.append('c', 'b', 1_700_000_000_002);
    renderPromptHookInjection(root, {});
    expect(inbox.get(b.id)).toMatchObject({ delivered_via: 'hook', delivered_consumer: `hook:${process.pid}` });

    const c = inbox.append('c', 'c', 1_700_000_000_003);
    writeFileSync(join(inbox.directory, `${c.id}.delivered`), JSON.stringify({ at: iso(1_700_000_000_003), via: 'wait' }));
    const old = inbox.get(c.id);
    expect(old).toMatchObject({ status: 'delivered', delivered_via: 'wait' });
    expect(old?.delivered_consumer).toBeUndefined();

    const d = inbox.append('c', 'd', 1_700_000_000_004);
    writeFileSync(join(inbox.directory, `${d.id}.delivered`), JSON.stringify({ at: iso(1_700_000_000_004), via: 'wait', consumer: 'evil\n' }));
    expect(inbox.get(d.id)?.delivered_consumer).toBeUndefined();
    expect(inbox.list().find((e) => e.id === a.id)?.delivered_consumer).toBe(`wait:${process.pid}`);
  });

  it('an invalid consumer is dropped, not written', () => {
    const e = inbox.append('c', 'x');
    expect(inbox.mark(e.id, 'delivered', 'wait', 'nope')).toBe(true);
    expect(JSON.parse(readFileSync(join(inbox.directory, `${e.id}.delivered`), 'utf-8')).consumer).toBeUndefined();
  });
});
