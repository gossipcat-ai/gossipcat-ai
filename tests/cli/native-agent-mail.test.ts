/**
 * Agent mail on the NATIVE paths (spec 2026-10-13-agent-inbox-addressing,
 * steps 3 + 4): native dispatch prompts carry the agent's queued mail (cold
 * and warm cache paths), and gossip_relay results with <agent_message> tags
 * land in the inbox only after relay_token validation.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ctx } from '../../apps/cli/src/mcp-context';
import { composeWarmBody, handleDispatchSingle } from '../../apps/cli/src/handlers/dispatch';
import { handleNativeRelay } from '../../apps/cli/src/handlers/native-tasks';
import { commitNativeAgentMail, joinPreTaskBlocks } from '../../apps/cli/src/handlers/native-agent-mail';
import { assemblePrompt } from '../../packages/orchestrator/src/prompt-assembler';
import { splitAssembledPrompt } from '../../apps/cli/src/handlers/dispatch-prompt-cache';
import { ClaudeInbox, inboxDirFor } from '@gossip/relay/dashboard/claude-inbox';
import { agentChatId, prepareAgentMail } from '@gossip/relay/dashboard/agent-mail';

function makeMainAgent(): any {
  return {
    dispatch: jest.fn(), collect: jest.fn().mockResolvedValue({ results: [] }),
    getAgentConfig: jest.fn().mockReturnValue(null), getLLM: jest.fn().mockReturnValue(null), getLlm: jest.fn().mockReturnValue(null),
    getAgentList: jest.fn().mockReturnValue([]), getSkillIndex: jest.fn().mockReturnValue(null),
    getSessionGossip: jest.fn().mockReturnValue([]), getSessionConsensusHistory: jest.fn().mockReturnValue([]),
    recordNativeTask: jest.fn(), recordNativeTaskCompleted: jest.fn(), recordPlanStepResult: jest.fn(),
    publishNativeGossip: jest.fn().mockResolvedValue(undefined), getChainContext: jest.fn().mockReturnValue(''),
    getTask: jest.fn().mockReturnValue(null), getPerfReader: jest.fn().mockReturnValue(null),
    scopeTracker: { hasOverlap: jest.fn().mockReturnValue({ overlaps: false }), register: jest.fn(), release: jest.fn() },
    pipeline: null,
  };
}

const saved = {
  mainAgent: ctx.mainAgent, nativeTaskMap: ctx.nativeTaskMap, nativeResultMap: ctx.nativeResultMap,
  nativeAgentConfigs: ctx.nativeAgentConfigs, booted: ctx.booted, boot: ctx.boot,
  nativeUtilityConfig: ctx.nativeUtilityConfig, skillEngine: (ctx as any).skillEngine,
};

let root: string;
let prevCwd: string;
let inbox: ClaudeInbox;
beforeEach(() => {
  prevCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'native-mail-'));
  mkdirSync(join(root, '.gossip', 'skills'), { recursive: true });
  process.chdir(root);
  inbox = new ClaudeInbox(inboxDirFor(root));
  ctx.mainAgent = makeMainAgent();
  ctx.nativeTaskMap = new Map();
  ctx.nativeResultMap = new Map();
  ctx.nativeAgentConfigs = new Map();
  ctx.nativeUtilityConfig = null;
  (ctx as any).skillEngine = null;
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;
  ctx.nativeAgentConfigs.set('native-a', { model: 'claude-sonnet-4-6', instructions: 'You review.', description: 'r', skills: [] });
});
afterEach(() => {
  Object.assign(ctx, saved);
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

const sendTo = (agent: string, text: string, at: number): string =>
  inbox.append(agentChatId(agent)!, text, at, { to: agent, from: 'orchestrator' }).id;
const agentPrompt = (content: Array<{ text: string }>): string => content.find((c) => c.text.startsWith('AGENT_PROMPT:'))!.text;

describe('native dispatch drain', () => {
  it('injects the agent\'s queued mail before Task: and marks it delivered via dispatch:<taskId>', async () => {
    const t0 = Date.now() - 1000;
    const mine = sendTo('native-a', 'use the new helper', t0);
    const other = sendTo('native-b', 'not for a', t0 + 1);
    const res = await handleDispatchSingle('native-a', 'Audit the parser');
    const prompt = agentPrompt(res.content);
    expect(prompt).toContain('use the new helper');
    expect(prompt).not.toContain('not for a');
    expect(prompt.indexOf('--- END INBOX MAIL ---')).toBeLessThan(prompt.lastIndexOf('\n\n---\n\nTask: Audit the parser'));
    const taskId = /AGENT_PROMPT:(\S+)/.exec(prompt)![1];
    expect(inbox.get(mine)).toMatchObject({ status: 'delivered', delivered_via: `dispatch:${taskId}` });
    expect(inbox.get(other)!.status).toBe('queued');
  });

  it('warm composition is byte-identical to the cold assemble (mail never cached)', () => {
    sendTo('native-a', 'hello', Date.now() - 1000);
    const mail = prepareAgentMail(inbox, 'native-a')!;
    const parts = { identity: '## Identity\nagent_id: native-a', skills: 'SKILLS', task: 'T' };
    const tail = '\n\nTask: T';
    const plain = assemblePrompt(parts);
    const { skillsSection } = splitAssembledPrompt(plain, tail);
    expect(skillsSection).not.toContain('INBOX MAIL');
    const cold = assemblePrompt({ ...parts, retrievedLessons: 'LESSONS', inboxMail: mail.block });
    expect(composeWarmBody(skillsSection, tail, joinPreTaskBlocks('LESSONS', mail))).toBe(cold);
  });

  it('commit marks nothing when the block did not make it into the prompt', () => {
    const id = sendTo('native-a', 'hello', Date.now() - 1000);
    const mail = prepareAgentMail(inbox, 'native-a')!;
    commitNativeAgentMail(mail, 'a prompt without the block', 'tk1', root);
    expect(inbox.get(id)!.status).toBe('queued');
  });
});

describe('native relay → agent mail', () => {
  function register(taskId: string, token: string): void {
    ctx.nativeTaskMap.set(taskId, { agentId: 'native-a', task: 't', startedAt: Date.now(), relayToken: token } as any);
  }
  const tagged = '<agent_message to="orchestrator" from="human" kind="chat">is X intended?</agent_message>';

  it('a validated result writes from=<task agent>, to=orchestrator, ref.task_id', async () => {
    register('tk-ok', 'tok123');
    await handleNativeRelay('tk-ok', `findings\n${tagged}`, undefined, undefined, 'tok123');
    const mail = inbox.list({ to: 'orchestrator' });
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ from: 'native-a', to: 'orchestrator', kind: 'chat', ref: { task_id: 'tk-ok' }, chat_id: 'agent-native-a' });
  });

  it('an invalid or missing relay token writes nothing', async () => {
    register('tk-bad', 'tok123');
    await handleNativeRelay('tk-bad', tagged, undefined, undefined, 'wrong');
    await handleNativeRelay('tk-bad', tagged, undefined, undefined, undefined);
    expect(inbox.list()).toEqual([]);
  });

  it('a failed task writes nothing', async () => {
    register('tk-err', 'tok123');
    await handleNativeRelay('tk-err', tagged, 'boom', undefined, 'tok123');
    expect(inbox.list()).toEqual([]);
  });

  it('a reply with in_reply_to closes the orchestrator message to that agent', async () => {
    const q = sendTo('native-a', 'which branch?', Date.now() - 1000);
    register('tk-r', 'tok123');
    await handleNativeRelay('tk-r', `<agent_message in_reply_to="${q}">master</agent_message>`, undefined, undefined, 'tok123');
    expect(inbox.get(q)!.status).toBe('answered');
  });
});
