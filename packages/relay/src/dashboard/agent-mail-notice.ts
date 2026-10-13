/**
 * agent-mail-notice.ts — task completion notices on top of the durable inbox.
 *
 * When a relay task reaches a terminal state nothing wakes the orchestrator
 * (native agents wake Claude Code themselves). The dispatch pipeline posts ONE
 * short notice per task into the orchestrator inbox; the `inbox wait` watcher
 * and hooks then surface it, and `gossip_collect` closes it. A notice never
 * carries the task result: results stay on gossip_collect so signals and
 * scoring are unaffected.
 *
 * Kept free of agent-mail.ts imports (it imports this file): quota and chat id
 * are passed in by the caller.
 */
import { ClaudeInbox, INBOX_ID_RE } from './claude-inbox';
import { sanitizeUntrusted } from './inbox-fence';

export type TaskDoneOutcome = 'completed' | 'failed' | 'cancelled' | 'timeout';

/** Max chars of failure detail appended to a notice. */
export const TASK_NOTICE_DETAIL_MAX = 200;
/** Marker `delivered_via` / `answered_via` of a notice closed by gossip_collect. */
export const TASK_NOTICE_COLLECTED_VIA = 'collected';

/** Content of the notice (no result text, only a capped, sanitized detail). */
export function taskNoticeContent(agentId: string, taskId: string, outcome: TaskDoneOutcome, detail?: string): string {
  const base = `Task ${taskId} (${agentId}) ${outcome}. Collect the result with gossip_collect(task_ids: ["${taskId}"]).`;
  const clean = detail ? sanitizeUntrusted(detail).replace(/\s+/g, ' ').trim().slice(0, TASK_NOTICE_DETAIL_MAX) : '';
  return clean ? `${base} Detail: ${clean}` : base;
}

/**
 * True for a completion notice of `taskId`. Agent-authored `<agent_message>`
 * mail is also kind=notice with ref.task_id, so the notice's own content
 * prefix is part of the match: collect must never close an agent's message.
 */
function isTaskNotice(e: { kind?: string; from: string; content: string; ref?: { task_id?: string } }, taskId: string): boolean {
  return e.kind === 'notice' && e.ref?.task_id === taskId && e.content.startsWith(`Task ${taskId} (${e.from}) `);
}

/**
 * Post the completion notice of `taskId` unless one already exists in any
 * status (bounded lookup). `room` is the sender's remaining agent-mail quota.
 * Returns the new inbox id, or null when skipped.
 */
export function postTaskDoneNotice(
  inbox: ClaudeInbox, chatId: string, room: number, agentId: string, taskId: string,
  outcome: TaskDoneOutcome, detail: string | undefined, log: (msg: string) => void, now: number = Date.now(),
): string | null {
  const exists = inbox.list({
    chatId, to: 'orchestrator', limit: 1,
    where: (e) => e.from === agentId && isTaskNotice(e, taskId),
  }).length > 0;
  if (exists) return null;
  if (room < 1) { log(`task notice for [${taskId}] dropped: agent mail quota reached for ${agentId}`); return null; }
  return inbox.append(chatId, taskNoticeContent(agentId, taskId, outcome, detail), now, {
    to: 'orchestrator', from: agentId, kind: 'notice', ref: { task_id: taskId },
  }).id;
}

/**
 * Close the open notices of the collected tasks (marked delivered then answered
 * via 'collected'). Only notices whose ref.task_id is in `taskIds`. Returns how
 * many were closed.
 */
export function closeTaskNotices(inbox: ClaudeInbox, taskIds: readonly string[]): number {
  const wanted = new Set(taskIds.filter((t) => typeof t === 'string' && t.length > 0));
  if (wanted.size === 0) return 0;
  let n = 0;
  const open = inbox.list({
    to: 'orchestrator', status: ['queued', 'delivered'],
    where: (e) => e.ref?.task_id !== undefined && wanted.has(e.ref.task_id) && isTaskNotice(e, e.ref.task_id),
  });
  for (const e of open) {
    if (!INBOX_ID_RE.test(e.id)) continue;
    if (e.status === 'queued') inbox.mark(e.id, 'delivered', TASK_NOTICE_COLLECTED_VIA);
    if (inbox.mark(e.id, 'answered', TASK_NOTICE_COLLECTED_VIA)) n++;
  }
  return n;
}
