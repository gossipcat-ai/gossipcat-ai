/**
 * Monotonic reminder markers (`<id>.reminded.<n>`, O_EXCL, never rewritten),
 * legacy `.reminded` compatibility, prune of tmp files by their own mtime, and
 * agent-mail expiry by last activity (claude-inbox-reminder.ts).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  AGENT_MAIL_TTL_MS, ClaudeInbox, inboxDirFor, INBOX_MAX_REMINDERS, INBOX_RETENTION_MS,
} from '@gossip/relay/dashboard/claude-inbox';

let root: string;
let inbox: ClaudeInbox;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'inbox-reminder-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  inbox = new ClaudeInbox(inboxDirFor(root));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const iso = (t: number): string => new Date(t).toISOString();
const always = (): boolean => true;
const marker = (id: string, suffix: string): string => join(inbox.directory, `${id}.${suffix}`);
const count = (id: string): number => inbox.get(id)?.reminded_count ?? 0;

describe('claimReminder — monotonic O_EXCL markers', () => {
  it('a consumer racing between the due-check and the create: exactly one wins every step', () => {
    const e = inbox.append('c', 'race', 1_700_000_000_001);
    inbox.mark(e.id, 'delivered', 'wait');
    const other = new ClaudeInbox(inboxDirFor(root));
    for (let k = 0; k < INBOX_MAX_REMINDERS; k++) {
      expect(count(e.id)).toBe(k);
      let otherGot: number | null = null;
      const got = inbox.claimReminder(e.id, 1_700_000_100_000 + k, () => {
        otherGot = other.claimReminder(e.id, 1_700_000_100_000 + k, always);
        return true;
      });
      expect(otherGot).toBe(k + 1);
      expect(got).toBeNull();
      expect(count(e.id)).toBe(k + 1);
    }
    // Cap holds with racing consumers.
    let dueChecked = false;
    expect(inbox.claimReminder(e.id, 1_700_000_200_000, () => { dueChecked = true; return true; })).toBeNull();
    expect(dueChecked).toBe(false); // capped before the due-check
    expect(other.claimReminder(e.id, 1_700_000_300_000, always)).toBeNull();
    expect(count(e.id)).toBe(INBOX_MAX_REMINDERS);
    expect(existsSync(marker(e.id, `reminded.${INBOX_MAX_REMINDERS + 1}`))).toBe(false);
  });

  it('a stale reader never regresses or resets the count', () => {
    const e = inbox.append('c', 'stale', 1_700_000_000_002);
    inbox.mark(e.id, 'delivered', 'wait');
    const other = new ClaudeInbox(inboxDirFor(root));
    const got = inbox.claimReminder(e.id, 1_700_000_100_000, (state) => {
      expect(state.count).toBe(0);
      expect(other.claimReminder(e.id, 1_700_000_100_001, always)).toBe(1);
      expect(other.claimReminder(e.id, 1_700_000_100_002, always)).toBe(2);
      return true;
    });
    expect(got).toBeNull();
    expect(inbox.get(e.id)).toMatchObject({ reminded_count: 2, reminded_at: iso(1_700_000_100_002) });
  });

  it('a crash right after a claim (even before the body is written) leaves a consistent count', () => {
    const e = inbox.append('c', 'crash', 1_700_000_000_003);
    inbox.mark(e.id, 'delivered', 'wait');
    expect(inbox.claimReminder(e.id, 1_700_000_100_000, always)).toBe(1);
    expect(inbox.get(e.id)).toMatchObject({ reminded_count: 1, reminded_at: iso(1_700_000_100_000) });
    writeFileSync(marker(e.id, 'reminded.2'), ''); // created, never written
    const r = inbox.get(e.id);
    expect(r?.reminded_count).toBe(2);
    expect(typeof r?.reminded_at).toBe('string'); // falls back to the file mtime
    expect(inbox.claimReminder(e.id, Date.now() + 1, always)).toBe(3);
    expect(readdirSync(inbox.directory).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('honors a legacy `.reminded` marker with a count; new claims continue above it', () => {
    const e = inbox.append('c', 'legacy', 1_700_000_000_004);
    inbox.mark(e.id, 'delivered', 'wait');
    writeFileSync(marker(e.id, 'reminded'), JSON.stringify({ at: iso(1_700_000_050_000), count: 3 }));
    expect(inbox.get(e.id)).toMatchObject({ reminded_count: 3, reminded_at: iso(1_700_000_050_000) });
    let seen = -1;
    expect(inbox.claimReminder(e.id, 1_700_000_100_000, (s) => { seen = s.count; return true; })).toBe(4);
    expect(seen).toBe(3);
    expect(existsSync(marker(e.id, 'reminded.4'))).toBe(true);
    expect(inbox.get(e.id)).toMatchObject({ reminded_count: 4, reminded_at: iso(1_700_000_100_000) });
  });

  it('honors a legacy marker without count (= 1) and a capped legacy count', () => {
    const a = inbox.append('c', 'a', 1_700_000_000_005);
    const b = inbox.append('c', 'b', 1_700_000_000_006);
    writeFileSync(marker(a.id, 'reminded'), JSON.stringify({ at: iso(1_700_000_050_000) }));
    writeFileSync(marker(b.id, 'reminded'), JSON.stringify({ at: iso(1_700_000_050_000), count: 50 }));
    expect(inbox.claimReminder(a.id, 1_700_000_100_000, always)).toBe(2);
    expect(existsSync(marker(a.id, 'reminded.2'))).toBe(true);
    expect(inbox.claimReminder(b.id, 1_700_000_100_000, always)).toBeNull();
    expect(count(b.id)).toBe(50);
  });
});

describe('prune — tmp age and reminder files', () => {
  it('keeps a fresh .tmp of an old record, removes a .tmp older than 60s by mtime', () => {
    const now = Date.now();
    const old = inbox.append('c', 'old', now - 2 * 60 * 60 * 1000);
    const fresh = join(inbox.directory, `${old.id}.delivered.${process.pid}.aaaaaaaaaaaa.tmp`);
    const stale = join(inbox.directory, `${old.id}.answered.${process.pid}.bbbbbbbbbbbb.tmp`);
    writeFileSync(fresh, '{}');
    writeFileSync(stale, '{}');
    utimesSync(stale, new Date(now - 120_000), new Date(now - 120_000));
    inbox.prune(now);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it('removes all reminder files and the expired tag with their record; reaps orphans', () => {
    const now = Date.now();
    const e = inbox.append('c', 'gone', now - INBOX_RETENTION_MS - 60_000);
    inbox.mark(e.id, 'delivered', 'wait');
    inbox.mark(e.id, 'answered', 'reply');
    for (const s of ['reminded', 'reminded.1', 'reminded.2', 'expired']) writeFileSync(marker(e.id, s), '{}');
    const orphan = '1700000000000-0123456789ab';
    writeFileSync(join(inbox.directory, `${orphan}.reminded.3`), '{}');
    expect(inbox.prune(now)).toBe(1);
    expect(readdirSync(inbox.directory).filter((n) => n.startsWith(e.id) || n.startsWith(orphan))).toEqual([]);
  });
});

describe('agent-mail expiry by last activity', () => {
  const AGENT = 'sonnet-reviewer';
  const mail = { to: 'orchestrator', from: AGENT } as const;

  it('expires only mail idle past the TTL; human mail never; stats exposes expired', () => {
    const now = Date.now();
    const old = now - AGENT_MAIL_TTL_MS - 60 * 60 * 1000;
    const queuedOld = inbox.append('agent-c', 'queued idle', old, mail);
    const deliveredRecently = inbox.append('agent-c', 'delivered recently', old + 1, mail);
    const remindedRecently = inbox.append('agent-c', 'reminded recently', old + 2, mail);
    const deliveredLongAgo = inbox.append('agent-c', 'delivered long ago', old + 3, mail);
    const human = inbox.append('human-c', 'human', old + 4);
    writeFileSync(marker(deliveredRecently.id, 'delivered'), JSON.stringify({ at: iso(now - 60_000), via: 'wait' }));
    writeFileSync(marker(remindedRecently.id, 'delivered'), JSON.stringify({ at: iso(old + 10), via: 'wait' }));
    writeFileSync(marker(remindedRecently.id, 'reminded.1'), JSON.stringify({ at: iso(now - 60 * 60 * 1000) }));
    writeFileSync(marker(deliveredLongAgo.id, 'delivered'), JSON.stringify({ at: iso(old + 10), via: 'wait' }));
    writeFileSync(marker(human.id, 'delivered'), JSON.stringify({ at: iso(old + 10), via: 'wait' }));

    inbox.prune(now);
    expect(inbox.get(queuedOld.id)).toMatchObject({ status: 'answered', answered_via: 'expired' });
    expect(inbox.get(deliveredLongAgo.id)).toMatchObject({ status: 'answered', answered_via: 'expired' });
    expect(inbox.get(deliveredRecently.id)?.status).toBe('delivered');
    expect(inbox.get(remindedRecently.id)?.status).toBe('delivered');
    expect(inbox.get(human.id)?.status).toBe('delivered');
    expect(inbox.stats()).toMatchObject({ expired: 2, answered: 2, unanswered: 3 });

    // Once the recent activity ages past the TTL too, it expires.
    inbox.prune(now + AGENT_MAIL_TTL_MS);
    expect(inbox.get(deliveredRecently.id)?.answered_via).toBe('expired');
    expect(inbox.get(remindedRecently.id)?.answered_via).toBe('expired');
    expect(inbox.get(human.id)?.status).toBe('delivered');
    expect(inbox.stats().expired).toBe(4);
  });

  it('a real reply is not counted as expired', () => {
    const e = inbox.append('agent-c', 'answered', Date.now(), mail);
    inbox.markAnswered('agent-c', { ids: [e.id] });
    expect(inbox.stats()).toMatchObject({ answered: 1, expired: 0 });
  });
});
