/**
 * Agent mail through the relay-worker dispatch path (spec
 * 2026-10-13-agent-inbox-addressing, steps 3 + 4): queued mail for agent X is
 * injected into X's prompt and, once the task returns a final result, marked
 * delivered via dispatch:<taskId> and closed; result <agent_message> tags
 * become to=orchestrator mail stamped with the task's agent.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DispatchPipeline } from '../../packages/orchestrator/src/dispatch-pipeline';
import { MAX_ASSEMBLED_PROMPT_CHARS } from '../../packages/orchestrator/src/prompt-assembler';
import type { AgentMailPort } from '../../packages/orchestrator/src/agent-mail-port';
import { ClaudeInbox, inboxDirFor } from '@gossip/relay/dashboard/claude-inbox';
import {
  agentChatId, AGENT_MAIL_MAX_UNANSWERED_PER_SENDER, createInboxAgentMail,
} from '@gossip/relay/dashboard/agent-mail';

describe('DispatchPipeline agent mail', () => {
  let root: string;
  let inbox: ClaudeInbox;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dp-mail-'));
    mkdirSync(join(root, '.gossip'));
    inbox = new ClaudeInbox(inboxDirFor(root));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function worker(result: string) {
    const prompts: string[] = [];
    return {
      prompts,
      worker: {
        cancelTask: jest.fn(),
        executeTask: async function* (_t: string, _l: unknown, prompt: string) {
          prompts.push(prompt);
          yield { type: 'final_result', payload: { result, inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
        },
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      },
    };
  }

  function failingWorker(error: string) {
    const prompts: string[] = [];
    return {
      prompts,
      worker: {
        cancelTask: jest.fn(),
        executeTask: async function* (_t: string, _l: unknown, prompt: string) {
          prompts.push(prompt);
          yield { type: 'error', payload: { error }, timestamp: Date.now() };
        },
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      },
    };
  }

  function pipeline(workers: Record<string, unknown>, agentMail: AgentMailPort = createInboxAgentMail(root, () => {})): DispatchPipeline {
    return new DispatchPipeline({
      projectRoot: root,
      workers: new Map(Object.entries(workers)) as any,
      registryGet: (id: string) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      agentMail,
    });
  }

  const sendTo = (agent: string, text: string, at: number): string =>
    inbox.append(agentChatId(agent)!, text, at, { to: agent, from: 'orchestrator' }).id;

  it('injects X\'s queued mail into X\'s prompt only and marks it delivered', async () => {
    const t0 = Date.now() - 1000;
    const idX = sendTo('x1', 'please also check the tests', t0);
    const idY = sendTo('y1', 'mail for y', t0 + 1);
    const wx = worker('ok');
    const wy = worker('ok');
    const p = pipeline({ x1: wx.worker, y1: wy.worker });

    const { taskId, finalResultPromise } = p.dispatch('x1', 'review module');
    await finalResultPromise;
    const prompt = wx.prompts[0];
    expect(prompt).toContain('--- INBOX MAIL ---');
    expect(prompt).toMatch(/<<<UNTRUSTED_AGENT_MESSAGE [0-9a-f]{8} from=orchestrator id=/);
    expect(prompt).toContain('please also check the tests');
    expect(prompt).not.toContain('mail for y');
    // Relay workers get the task as the user message; the mail is the last
    // (lowest-priority) block of the system-side prompt content.
    expect(prompt.trimEnd().endsWith('--- END INBOX MAIL ---')).toBe(true);
    // Orchestrator → agent mail needs no reply: delivery after success closes it.
    expect(inbox.get(idX)).toMatchObject({ status: 'answered', delivered_via: `dispatch:${taskId}` });
    expect(inbox.get(idY)!.status).toBe('queued');

    // Delivered mail is not injected again.
    const again = p.dispatch('x1', 'second task');
    await again.finalResultPromise;
    expect(wx.prompts[1]).not.toContain('--- INBOX MAIL ---');
  });

  it('teaches the agent the tag in task prompts', async () => {
    const w = worker('ok');
    const { finalResultPromise } = pipeline({ x1: w.worker }).dispatch('x1', 'task');
    await finalResultPromise;
    expect(w.prompts[0]).toContain('<agent_message to="orchestrator">');
  });

  it('writes result tags as from=<task agent> mail with ref.task_id; in_reply_to closes the delivered message', async () => {
    const q = sendTo('x1', 'which branch?', Date.now() - 1000);
    const w = worker(`findings...\n<agent_message to="orchestrator" in_reply_to="${q}" kind="chat">master</agent_message>\n<agent_message to="human">dropped</agent_message>`);
    const p = pipeline({ x1: w.worker });
    const { taskId, finalResultPromise } = p.dispatch('x1', 'task');
    await finalResultPromise;
    const mail = inbox.list({ to: 'orchestrator' });
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      from: 'x1', to: 'orchestrator', kind: 'chat', content: 'master', in_reply_to: q,
      ref: { task_id: taskId }, chat_id: 'agent-x1',
    });
    expect(inbox.get(q)!.status).toBe('answered');
    // The result itself is unchanged (tags are not stripped).
    expect(p.getTask(taskId)?.result).toContain('<agent_message to="orchestrator"');
  });

  it('marks nothing before the worker finishes', async () => {
    const id = sendTo('x1', 'early', Date.now() - 1000);
    let seen: string | undefined;
    const w = {
      cancelTask: jest.fn(),
      executeTask: async function* () {
        seen = inbox.get(id)!.status;
        yield { type: 'final_result', payload: { result: 'ok', inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
      },
      subscribeToBatch: jest.fn().mockResolvedValue(undefined),
      unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
    };
    await pipeline({ x1: w }).dispatch('x1', 'task').finalResultPromise;
    expect(seen).toBe('queued');
    expect(inbox.get(id)!.status).toBe('answered');
  });

  it('an errored worker leaves the mail queued and writes no agent mail', async () => {
    const id = sendTo('x1', 'retry me', Date.now() - 1000);
    const w = failingWorker('boom\n<agent_message to="orchestrator">from an errored run</agent_message>');
    const { finalResultPromise } = pipeline({ x1: w.worker }).dispatch('x1', 'task');
    await expect(finalResultPromise).rejects.toThrow('boom');
    expect(w.prompts[0]).toContain('retry me');
    expect(inbox.get(id)!.status).toBe('queued');
    expect(inbox.list({ to: 'orchestrator' })).toEqual([]);

    // The next successful dispatch carries it again and closes it.
    const ok = worker('ok');
    const again = pipeline({ x1: ok.worker }).dispatch('x1', 'task 2');
    await again.finalResultPromise;
    expect(ok.prompts[0]).toContain('retry me');
    expect(inbox.get(id)).toMatchObject({ status: 'answered', delivered_via: `dispatch:${again.taskId}` });
  });

  it('mail dropped by the prompt size budget stays queued even after success', async () => {
    const id = sendTo('x1', 'too big to fit', Date.now() - 1000);
    const real = createInboxAgentMail(root, () => {});
    const markDelivered = jest.fn(real.markDelivered);
    const oversized: AgentMailPort = {
      ...real,
      markDelivered,
      prepare: (agentId) => {
        const b = real.prepare(agentId);
        return b && { ...b, block: `${b.block}\n${'p'.repeat(MAX_ASSEMBLED_PROMPT_CHARS)}` };
      },
    };
    const w = worker('ok');
    await pipeline({ x1: w.worker }, oversized).dispatch('x1', 'task').finalResultPromise;
    expect(w.prompts[0]).not.toContain('too big to fit');
    expect(markDelivered).not.toHaveBeenCalled();
    expect(inbox.get(id)!.status).toBe('queued');
  });

  it('over-quota agent mail is dropped without failing the task; human mail is still accepted', async () => {
    const at = Date.now() - 10_000;
    for (let i = 0; i < AGENT_MAIL_MAX_UNANSWERED_PER_SENDER; i++) {
      inbox.append('agent-x1', `old ${i}`, at + i, { to: 'orchestrator', from: 'x1' });
    }
    const w = worker('<agent_message>one too many</agent_message>');
    const { finalResultPromise } = pipeline({ x1: w.worker }).dispatch('x1', 'task');
    await expect(finalResultPromise).resolves.toBeDefined();
    expect(inbox.list({ to: 'orchestrator' }).map((e) => e.content)).not.toContain('one too many');
    expect(() => inbox.append('dash', 'human still gets through', Date.now())).not.toThrow();
  });
});
