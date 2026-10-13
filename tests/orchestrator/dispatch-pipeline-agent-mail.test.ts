/**
 * Agent mail through the relay-worker dispatch path (spec
 * 2026-10-13-agent-inbox-addressing, steps 3 + 4): queued mail for agent X is
 * injected into X's prompt and marked delivered via dispatch:<taskId>; result
 * <agent_message> tags become to=orchestrator mail stamped with the task's agent.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DispatchPipeline } from '../../packages/orchestrator/src/dispatch-pipeline';
import { ClaudeInbox, inboxDirFor } from '@gossip/relay/dashboard/claude-inbox';
import { agentChatId, createInboxAgentMail } from '@gossip/relay/dashboard/agent-mail';

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

  function pipeline(workers: Record<string, unknown>): DispatchPipeline {
    return new DispatchPipeline({
      projectRoot: root,
      workers: new Map(Object.entries(workers)) as any,
      registryGet: (id: string) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      agentMail: createInboxAgentMail(root, () => {}),
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
    expect(inbox.get(idX)).toMatchObject({ status: 'delivered', delivered_via: `dispatch:${taskId}` });
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
});
