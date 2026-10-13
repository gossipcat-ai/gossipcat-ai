/**
 * `gossipcat inbox …` — pure-file access to the durable Claude inbox
 * (.gossip/bridge/inbox, see packages/relay/src/dashboard/claude-inbox.ts).
 * Works without the MCP server running and never boots it.
 *
 *   inbox wait [--timeout <sec>] [--max <n>]
 *       Block until ≥1 queued message exists (fs.watch + polling fallback),
 *       claim + print them fenced as UNTRUSTED data with the exact `gossip_chat_reply`
 *       instruction, exit 0. Exit 2 on timeout (default 3600s; 0 = never),
 *       exit 3 if orphaned (parent died). Writes a heartbeat while blocked so
 *       the dashboard can show "listening", and a last-exit record on exit so
 *       it can show "recent". A printed message that is never answered is
 *       re-surfaced by the hooks after a grace period (inbox-format.ts).
 *   inbox list [--json] [--queued]    one sanitized line per entry
 *   inbox show <id>                    fenced full content (read-only)
 *   inbox ack <id> [--answered]        mark delivered (or answered)
 *   inbox session-start                SessionStart hook body (internal)
 *
 * Exit codes: 0 ok · 1 usage / unknown id / error · 2 wait timeout · 3 orphaned.
 */
import { mkdirSync, watch, type FSWatcher } from 'fs';
import { INBOX_ID_RE } from '@gossip/relay/dashboard/claude-inbox';
import { clearWatcherHeartbeat, writeWatcherHeartbeat } from '@gossip/relay/dashboard/claude-inbox-watcher';
import {
  claimQueued, fenceMessage, findProjectRoot, openInbox, previewLine, renderBatch,
  renderSessionStartInjection, RESTART_WATCHER_HINT,
} from './inbox-format';

export interface InboxIo {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Project root override (tests). Defaults to the nearest `.gossip` ancestor of cwd. */
  root?: string;
  /** Poll interval override (tests). */
  pollMs?: number;
  /** Heartbeat interval override (tests). */
  heartbeatMs?: number;
}

const USAGE =
  'Usage: gossipcat inbox wait [--timeout <sec>] [--max <n>] | list [--json] [--queued] | show <id> | ack <id> [--answered]\n';
const DEFAULT_TIMEOUT_SEC = 3600;
const DEFAULT_MAX = 10;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function parseNonNegInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d{1,9}$/.test(raw)) return null;
  return Number(raw);
}

export async function runInboxCommand(argv: string[], io: InboxIo): Promise<number> {
  const sub = argv[0];
  const args = argv.slice(1);
  const root = io.root ?? findProjectRoot();
  try {
    switch (sub) {
      case 'wait': {
        const timeout = parseNonNegInt(flagValue(args, '--timeout'), DEFAULT_TIMEOUT_SEC);
        const max = parseNonNegInt(flagValue(args, '--max'), DEFAULT_MAX);
        if (timeout === null || max === null || max === 0) { io.err(USAGE); return 1; }
        return await waitForMessages(root, timeout, max, io);
      }
      case 'list': {
        const inbox = openInbox(root);
        let entries = inbox.list();
        if (args.includes('--queued')) entries = entries.filter((e) => e.status === 'queued');
        if (args.includes('--json')) {
          // JSON.stringify escapes control chars, so raw content is terminal-safe here.
          io.out(JSON.stringify(entries.map(({ id, chat_id, status, received_at, delivered_via, delivered_at }) =>
            ({ id, chat_id, status, received_at, delivered_via, delivered_at })), null, 2) + '\n');
          return 0;
        }
        if (entries.length === 0) { io.out('[gossipcat inbox] empty\n'); return 0; }
        for (const e of entries) {
          io.out(`${e.id}  ${e.status.padEnd(9)}  chat=${e.chat_id}  ${e.received_at}  ${previewLine(e.content)}\n`);
        }
        return 0;
      }
      case 'show': {
        const id = args[0];
        if (!id || !INBOX_ID_RE.test(id)) { io.err(USAGE); return 1; }
        const e = openInbox(root).get(id);
        if (!e) { io.err(`gossipcat inbox: unknown id ${id}\n`); return 1; }
        io.out(`status: ${e.status}\n${fenceMessage(e)}\n`);
        return 0;
      }
      case 'ack': {
        const id = args[0];
        if (!id || !INBOX_ID_RE.test(id)) { io.err(USAGE); return 1; }
        const inbox = openInbox(root);
        if (!inbox.get(id)) { io.err(`gossipcat inbox: unknown id ${id}\n`); return 1; }
        inbox.mark(id, 'delivered', 'ack');
        if (args.includes('--answered')) inbox.mark(id, 'answered', 'ack');
        io.out(`[gossipcat inbox] ${id} → ${inbox.get(id)?.status ?? 'unknown'}\n`);
        return 0;
      }
      case 'session-start':
        io.out(renderSessionStartInjection(root));
        return 0;
      default:
        io.err(USAGE);
        return 1;
    }
  } catch (e) {
    io.err(`gossipcat inbox: ${(e as Error).message}\n`);
    return 1;
  }
}

/**
 * Block until queued messages exist, then claim + print them. Resolves with
 * the exit code. Waiters race safely: claiming is an O_EXCL marker create.
 */
function waitForMessages(root: string, timeoutSec: number, max: number, io: InboxIo): Promise<number> {
  const inbox = openInbox(root);
  const startPpid = process.ppid;
  return new Promise<number>((resolveP) => {
    let done = false;
    let watcher: FSWatcher | null = null;
    const intervals: ReturnType<typeof setInterval>[] = [];
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const onSignal = (): void => finish(130);

    const finish = (code: number, text?: string): void => {
      if (done) return;
      done = true;
      for (const t of intervals) clearInterval(t);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      try { watcher?.close(); } catch { /* ignore */ }
      // Records the last-exit time (dashboard `recent` state) and drops the heartbeat.
      clearWatcherHeartbeat(root, code);
      if (text) io.out(text);
      resolveP(code);
    };

    const check = (): void => {
      if (done) return;
      const { claimed, remaining } = claimQueued(inbox, max, 'wait');
      if (claimed.length > 0) finish(0, renderBatch(claimed, { remaining, footer: RESTART_WATCHER_HINT }));
    };

    const beat = (): void => {
      if (done) return;
      // Orphan guard: a re-parented watcher (Claude Code exited) would otherwise
      // keep a live heartbeat and the dashboard would claim someone is listening.
      if (process.ppid !== startPpid) { finish(3); return; }
      try { writeWatcherHeartbeat(root); } catch { /* best effort */ }
    };

    // Ensure the dir exists so fs.watch can attach (0700 via the store).
    try { inbox.prune(); } catch { /* ignore */ }
    try {
      mkdirSync(inbox.directory, { recursive: true, mode: 0o700 });
      watcher = watch(inbox.directory, () => setTimeout(check, 50));
      watcher.on('error', () => { try { watcher?.close(); } catch { /* */ } watcher = null; });
    } catch {
      watcher = null; // polling fallback below covers it
    }

    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    beat();
    check();
    if (done) return;
    intervals.push(setInterval(check, io.pollMs ?? 2000));
    intervals.push(setInterval(beat, io.heartbeatMs ?? 5000));
    if (timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        io.err(`[gossipcat inbox] no messages within ${timeoutSec}s — restart \`gossipcat inbox wait\` to keep listening.\n`);
        finish(2);
      }, timeoutSec * 1000);
    }
  });
}
