/**
 * Relay-task completion notices: a terminal relay task posts ONE kind=notice
 * into the orchestrator inbox (never the result), gossip_collect closes it, and
 * the inbox renders it with a gossip_collect hint.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DispatchPipeline } from '../../packages/orchestrator/src/dispatch-pipeline';
import type { AgentMailPort } from '../../packages/orchestrator/src/agent-mail-port';
import { ClaudeInbox, inboxDirFor, INBOX_MAX_UNANSWERED } from '@gossip/relay/dashboard/claude-inbox';
import {
  AGENT_MAIL_MAX_UNANSWERED_PER_SENDER, AGENT_MAIL_RESERVED_SLOTS, createInboxAgentMail,
} from '@gossip/relay/dashboard/agent-mail';
import { fenceMessage, renderBatch } from '../../apps/cli/src/inbox-format';

const RESULT = 'SECRET-RESULT-TEXT findings here';

describe('relay task completion notices', () => {
  let root: string;
  let inbox: ClaudeInbox;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dp-notice-'));
    mkdirSync(join(root, '.gossip'));
    inbox = new ClaudeInbox(inboxDirFor(root));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const baseWorker = { cancelTask: jest.fn(), subscribeToBatch: jest.fn().mockResolvedValue(undefined), unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined) };
  const okWorker = (result = RESULT) => ({
    ...baseWorker,
    executeTask: async function* () {
      yield { type: 'final_result', payload: { result, inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
    },
  });
  const errWorker = (error: string) => ({
    ...baseWorker,
    executeTask: async function* () { yield { type: 'error', payload: { error }, timestamp: Date.now() }; },
  });
  const hangingWorker = () => ({
    ...baseWorker,
    executeTask: async function* () {
      await new Promise((r) => setTimeout(r, 150));
      yield { type: 'progress', payload: { toolCalls: 0, inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
    },
  });

  function pipeline(workers: Record<string, unknown>, agentMail: AgentMailPort = createInboxAgentMail(root, () => {})): DispatchPipeline {
    return new DispatchPipeline({
      projectRoot: root,
      workers: new Map(Object.entries(workers)) as any,
      registryGet: (id: string) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      agentMail,
    });
  }
  const notices = () => inbox.list({ to: 'orchestrator' }).filter((e) => e.kind === 'notice');
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it('a completed relay task posts exactly one notice without the result', async () => {
    const p = pipeline({ x1: okWorker() });
    const { taskId, finalResultPromise } = p.dispatch('x1', 'task', { notifyOnDone: true });
    await finalResultPromise;
    await settle();
    const n = notices();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ from: 'x1', to: 'orchestrator', kind: 'notice', chat_id: 'agent-x1', ref: { task_id: taskId } });
    expect(n[0].content).toContain('gossip_collect');
    expect(n[0].content).toContain(`Task ${taskId} (x1) completed.`);
    expect(n[0].content).not.toContain('SECRET-RESULT-TEXT');
    expect(p.getTask(taskId)?.result).toBe(RESULT);
  });

  it('a failed task posts a notice with outcome and a capped detail', async () => {
    const p = pipeline({ x1: errWorker(`boom ${'e'.repeat(500)}`) });
    const { taskId, finalResultPromise } = p.dispatch('x1', 'task', { notifyOnDone: true });
    await expect(finalResultPromise).rejects.toThrow('boom');
    await settle();
    const n = notices();
    expect(n).toHaveLength(1);
    expect(n[0].content).toContain(`Task ${taskId} (x1) failed.`);
    expect(n[0].content.length).toBeLessThan(400);
  });

  it('cancelled and timed-out tasks post a notice with that outcome', async () => {
    const p = pipeline({ x1: hangingWorker(), x2: hangingWorker() });
    const a = p.dispatch('x1', 'task', { notifyOnDone: true });
    a.finalResultPromise.catch(() => {});
    p.cancelRunningTasks();
    await settle();
    await new Promise((r) => setTimeout(r, 200));
    expect(notices().map((e) => e.content)).toEqual([expect.stringContaining(`Task ${a.taskId} (x1) cancelled.`)]);

    const b = p.dispatch('x2', 'task', { notifyOnDone: true });
    b.finalResultPromise.catch(() => {});
    await p.collect([b.taskId], 20, { consume: false });
    await new Promise((r) => setTimeout(r, 200));
    expect(notices().map((e) => e.content).join('\n')).toContain(`Task ${b.taskId} (x2) timeout.`);
  });

  it('posts nothing unless the dispatch opts in (cross-review, utility, in-process awaits)', async () => {
    const p = pipeline({ x1: okWorker() });
    await p.dispatch('x1', 'internal').finalResultPromise;
    await settle();
    expect(notices()).toEqual([]);
  });

  it('is idempotent per task id', () => {
    const mail = createInboxAgentMail(root, () => {});
    expect(mail.notifyTaskDone('x1', 'tid00001', 'completed')).not.toBeNull();
    expect(mail.notifyTaskDone('x1', 'tid00001', 'failed')).toBeNull();
    expect(notices()).toHaveLength(1);
    mail.closeTaskNotices(['tid00001']);
    expect(mail.notifyTaskDone('x1', 'tid00001', 'completed')).toBeNull(); // answered notice still counts
    expect(notices()).toHaveLength(1);
  });

  it('a throwing port does not break the task', async () => {
    const real = createInboxAgentMail(root, () => {});
    const throwing: AgentMailPort = { ...real, notifyTaskDone: () => { throw new Error('port down'); } };
    const { finalResultPromise } = pipeline({ x1: okWorker() }, throwing).dispatch('x1', 'task', { notifyOnDone: true });
    await expect(finalResultPromise).resolves.toBeDefined();
    await settle();
  });

  it('collect closes the notice of collected task ids only', async () => {
    const p = pipeline({ x1: okWorker(), x2: okWorker() });
    const a = p.dispatch('x1', 'a', { notifyOnDone: true });
    const b = p.dispatch('x2', 'b', { notifyOnDone: true });
    await Promise.all([a.finalResultPromise, b.finalResultPromise]);
    await settle();
    expect(notices()).toHaveLength(2);
    await p.collect([a.taskId], 1000, { consume: false });
    const byTask = (id: string) => notices().find((e) => e.ref?.task_id === id)!;
    expect(byTask(a.taskId)).toMatchObject({ status: 'answered', answered_via: 'collected' });
    expect(byTask(b.taskId).status).toBe('queued');
  });

  it('collect never closes agent-authored notice mail that merely shares the task id', async () => {
    const mail = createInboxAgentMail(root, () => {});
    const e = inbox.append('agent-x1', 'my own note', Date.now(), { to: 'orchestrator', from: 'x1', kind: 'notice', ref: { task_id: 'tid00002' } });
    expect(mail.closeTaskNotices(['tid00002'])).toBe(0);
    expect(inbox.get(e.id)!.status).toBe('queued');
  });

  it('obeys the per-agent quota and never takes the human reserve', () => {
    const mail = createInboxAgentMail(root, () => {});
    const at = Date.now() - 100_000;
    for (let i = 0; i < AGENT_MAIL_MAX_UNANSWERED_PER_SENDER; i++) {
      inbox.append('agent-x1', `old ${i}`, at + i, { to: 'orchestrator', from: 'x1' });
    }
    expect(mail.notifyTaskDone('x1', 'tid00003', 'completed')).toBeNull();
    // Fill the shared cap up to the human reserve with other agents' mail.
    let i = 0;
    while (inbox.stats().unanswered < INBOX_MAX_UNANSWERED - AGENT_MAIL_RESERVED_SLOTS) {
      inbox.append('agent-fill', `fill ${i}`, at + 1000 + i, { to: 'orchestrator', from: `fill${Math.floor(i / 20)}` });
      i++;
    }
    expect(mail.notifyTaskDone('y1', 'tid00004', 'completed')).toBeNull();
    expect(() => inbox.append('dash', 'human still gets through', Date.now())).not.toThrow();
  });

  it('renders the notice with a gossip_collect hint, not the reply hints', () => {
    const mail = createInboxAgentMail(root, () => {});
    const id = mail.notifyTaskDone('x1', 'tid00005', 'completed')!;
    const e = inbox.get(id)!;
    const fenced = fenceMessage(e);
    expect(fenced).toContain('UNTRUSTED_AGENT_MESSAGE');
    expect(fenced).toContain('from=x1');
    expect(fenced).toContain('gossip_collect');
    expect(fenced).toContain('task_ids: ["tid00005"]');
    expect(fenced).not.toContain('gossip_inbox_send');
    expect(renderBatch([e])).toContain('task finished: collect it');
  });
});
