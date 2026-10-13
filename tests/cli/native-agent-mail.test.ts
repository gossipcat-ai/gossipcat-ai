/**
 * Agent mail on the NATIVE paths (spec 2026-10-13-agent-inbox-addressing,
 * steps 3 + 4): native dispatch prompts carry the agent's queued mail (cold
 * and warm cache paths, single / parallel / consensus). The ids are recorded on
 * the native task and marked delivered (and closed) only after a successful,
 * token-validated gossip_relay of THAT task. Result <agent_message> tags land
 * in the inbox only after relay_token validation and within the agent quota.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ctx } from '../../apps/cli/src/mcp-context';
import {
  composeWarmBody, handleDispatchConsensus, handleDispatchParallel, handleDispatchSingle,
} from '../../apps/cli/src/handlers/dispatch';
import { handleNativeRelay } from '../../apps/cli/src/handlers/native-tasks';
import { attachNativeAgentMail } from '../../apps/cli/src/handlers/native-agent-mail';
import { assemblePrompt, MAX_ASSEMBLED_PROMPT_CHARS } from '../../packages/orchestrator/src/prompt-assembler';
import { MemoryWriter } from '../../packages/orchestrator/src/memory-writer';
import { renderLessonBlock, selectLessons } from '../../packages/orchestrator/src/lesson-injector';
import { splitAssembledPrompt, __resetForTest } from '../../apps/cli/src/handlers/dispatch-prompt-cache';
import { ClaudeInbox, inboxDirFor } from '@gossip/relay/dashboard/claude-inbox';
import {
  agentChatId, AGENT_MAIL_MAX_UNANSWERED_PER_SENDER, prepareAgentMail,
} from '@gossip/relay/dashboard/agent-mail';

function makeMainAgent(): any {
  return {
    dispatch: jest.fn(), collect: jest.fn().mockResolvedValue({ results: [] }),
    getAgentConfig: jest.fn().mockReturnValue(null), getLLM: jest.fn().mockReturnValue(null), getLlm: jest.fn().mockReturnValue(null),
    getAgentList: jest.fn().mockReturnValue([]), getSkillIndex: jest.fn().mockReturnValue(null),
    getSkillGapSuggestions: jest.fn().mockReturnValue([]),
    getSessionGossip: jest.fn().mockReturnValue([]), getSessionConsensusHistory: jest.fn().mockReturnValue([]),
    recordNativeTask: jest.fn(), recordNativeTaskCompleted: jest.fn(), recordPlanStepResult: jest.fn(),
    publishNativeGossip: jest.fn().mockResolvedValue(undefined), getChainContext: jest.fn().mockReturnValue(''),
    generateLensesForAgents: jest.fn().mockResolvedValue(new Map()),
    dispatchParallel: jest.fn().mockResolvedValue({ taskIds: [], errors: [] }),
    dispatchParallelWithLenses: jest.fn().mockResolvedValue({ taskIds: [], errors: [] }),
    getTask: jest.fn().mockReturnValue(null), getPerfReader: jest.fn().mockReturnValue(null),
    scopeTracker: { hasOverlap: jest.fn().mockReturnValue({ overlaps: false }), register: jest.fn(), release: jest.fn() },
    pipeline: null,
  };
}

const saved = {
  mainAgent: ctx.mainAgent, nativeTaskMap: ctx.nativeTaskMap, nativeResultMap: ctx.nativeResultMap,
  nativeAgentConfigs: ctx.nativeAgentConfigs, booted: ctx.booted, boot: ctx.boot,
  nativeUtilityConfig: ctx.nativeUtilityConfig, skillEngine: (ctx as any).skillEngine,
  pendingConsensusRounds: ctx.pendingConsensusRounds, syncWorkersViaKeychain: ctx.syncWorkersViaKeychain,
};

let root: string;
let prevCwd: string;
let inbox: ClaudeInbox;
let clock: number;
beforeEach(() => {
  prevCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'native-mail-'));
  mkdirSync(join(root, '.gossip', 'skills'), { recursive: true });
  process.chdir(root);
  inbox = new ClaudeInbox(inboxDirFor(root));
  clock = Date.now() - 60_000;
  __resetForTest();
  ctx.mainAgent = makeMainAgent();
  ctx.nativeTaskMap = new Map();
  ctx.nativeResultMap = new Map();
  ctx.nativeAgentConfigs = new Map();
  ctx.pendingConsensusRounds = new Map();
  ctx.nativeUtilityConfig = null;
  (ctx as any).skillEngine = null;
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;
  ctx.syncWorkersViaKeychain = jest.fn().mockResolvedValue(undefined) as any;
  for (const id of ['native-a', 'native-b']) {
    ctx.nativeAgentConfigs.set(id, { model: 'claude-sonnet-4-6', instructions: 'You review.', description: 'r', skills: [] });
  }
});
afterEach(() => {
  Object.assign(ctx, saved);
  __resetForTest();
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

/** Distinct ms per append so ids sort in send order. */
const sendTo = (agent: string, text: string): string =>
  inbox.append(agentChatId(agent)!, text, clock++, { to: agent, from: 'orchestrator' }).id;
const promptItems = (content: Array<{ text: string }>): string[] =>
  content.filter((c) => c.text.startsWith('AGENT_PROMPT:')).map((c) => c.text);
const taskIdOf = (prompt: string): string => /AGENT_PROMPT:(\S+)/.exec(prompt)![1];
const tokenOf = (taskId: string): string => ctx.nativeTaskMap.get(taskId)!.relayToken!;
const relayOk = (taskId: string, result = 'done') => handleNativeRelay(taskId, result, undefined, undefined, tokenOf(taskId));
const newTaskId = (before: Set<string>): string => [...ctx.nativeTaskMap.keys()].find((k) => !before.has(k))!;

describe('native single dispatch', () => {
  it('embeds the mail before Task:, records it on the task, and marks nothing until the relay', async () => {
    const mine = sendTo('native-a', 'use the new helper');
    const other = sendTo('native-b', 'not for a');
    const res = await handleDispatchSingle('native-a', 'Audit the parser');
    const [prompt] = promptItems(res.content);
    expect(prompt).toContain('use the new helper');
    expect(prompt).not.toContain('not for a');
    expect(prompt.indexOf('--- END INBOX MAIL ---')).toBeLessThan(prompt.lastIndexOf('\n\n---\n\nTask: Audit the parser'));
    const taskId = taskIdOf(prompt);
    expect(ctx.nativeTaskMap.get(taskId)!.agentMailIds).toEqual([mine]);
    expect(inbox.get(mine)!.status).toBe('queued');

    await relayOk(taskId);
    expect(inbox.get(mine)).toMatchObject({ status: 'answered', delivered_via: `dispatch:${taskId}` });
    expect(inbox.get(other)!.status).toBe('queued');
  });

  it('an errored relay leaves the mail queued for the next dispatch', async () => {
    const id = sendTo('native-a', 'retry me');
    const taskId = taskIdOf(promptItems((await handleDispatchSingle('native-a', 'first')).content)[0]);
    await handleNativeRelay(taskId, '', 'agent crashed', undefined, tokenOf(taskId));
    expect(inbox.get(id)!.status).toBe('queued');
    const [again] = promptItems((await handleDispatchSingle('native-a', 'second')).content);
    expect(again).toContain('retry me');
  });

  it('a relay with a wrong token marks nothing', async () => {
    const id = sendTo('native-a', 'hello');
    const taskId = taskIdOf(promptItems((await handleDispatchSingle('native-a', 't')).content)[0]);
    await handleNativeRelay(taskId, 'done', undefined, undefined, 'wrong-token');
    expect(inbox.get(id)!.status).toBe('queued');
  });

  it('attach records nothing when the block did not make it into the prompt', () => {
    sendTo('native-a', 'hello');
    ctx.nativeTaskMap.set('tk1', { agentId: 'native-a', task: 't', startedAt: Date.now() });
    const mail = prepareAgentMail(inbox, 'native-a')!;
    expect(attachNativeAgentMail(mail, 'a prompt without the block', 'tk1')).toBe(false);
    expect(ctx.nativeTaskMap.get('tk1')!.agentMailIds).toBeUndefined();
  });
});

describe('native warm-cache path (production handleDispatchSingle)', () => {
  const LESSON_TASK = 'Rebuild the dist-mcp bundle inside a git worktree and confirm the binary suites pass';
  function seedLesson(): void {
    new MemoryWriter(root).writeLessonCard('_project', {
      signal: 'operational_lesson',
      findingId: 'aa11bb22-cc33dd44:orchestrator:f1',
      finding: 'dist-mcp binary suites failed inside a git worktree and were reported as a real regression',
      lesson: 'Never build or verify the dist-mcp bundle inside a git worktree — the nested zod is unreachable.',
      taskTokens: 'dist-mcp bundle worktree zod binary suites rebuild entrypoint',
      crossCutting: true,
    });
  }
  async function dispatchElided(task: string): Promise<{ taskId: string; prompt: string; warm: boolean }> {
    const before = new Set(ctx.nativeTaskMap.keys());
    const res = await handleDispatchSingle('native-a', task, undefined, undefined, undefined, undefined, undefined, undefined, 'elided');
    const taskId = newTaskId(before);
    const prompt = readFileSync(ctx.nativeTaskMap.get(taskId)!.promptPath!, 'utf8');
    return { taskId, prompt, warm: res.content[0].text.includes('warm-cached (skills) + live task') };
  }

  it('the warm prompt carries both the lessons and the mail; delivery waits for the relay', async () => {
    seedLesson();
    const cold = await dispatchElided(`${LESSON_TASK} (cold)`);
    expect(cold.warm).toBe(false);
    const id = sendTo('native-a', 'warm path mail');
    const warm = await dispatchElided(`${LESSON_TASK} (warm)`);
    expect(warm.warm).toBe(true);
    expect(warm.prompt).toContain('--- RECALLED LESSONS ---');
    expect(warm.prompt).toContain('warm path mail');
    expect(warm.prompt.indexOf('--- END RECALLED LESSONS ---')).toBeLessThan(warm.prompt.indexOf('--- INBOX MAIL ---'));
    expect(ctx.nativeTaskMap.get(warm.taskId)!.agentMailIds).toEqual([id]);
    expect(inbox.get(id)!.status).toBe('queued');
    await relayOk(warm.taskId);
    expect(inbox.get(id)!.status).toBe('answered');
  });

  it('keeps the lessons and drops only the mail when both would overflow the cap', async () => {
    seedLesson();
    await dispatchElided(`${LESSON_TASK} (cold)`);
    const cacheDir = join(root, '.gossip', 'dispatch-prompts', 'cache');
    const { readdirSync } = require('fs');
    const sectionFile = readdirSync(cacheDir).find((n: string) => n.endsWith('.txt'));
    const sectionLen = readFileSync(join(cacheDir, sectionFile), 'utf8').length;
    // Size the task so lessons fit and lessons + mail do not.
    const pad = (n: number): string => `${LESSON_TASK} ${'p'.repeat(Math.max(0, n))}`;
    const lessonLen = (t: string): number => renderLessonBlock(selectLessons(root, 'native-a', t)).length;
    const fixed = sectionLen + 2 + '\n\nTask: '.length;
    const target = MAX_ASSEMBLED_PROMPT_CHARS - 1000;
    const task = pad(target - fixed - lessonLen(LESSON_TASK) - LESSON_TASK.length - 1);
    expect(lessonLen(task)).toBeGreaterThan(0);
    const id = sendTo('native-a', 'm'.repeat(3000));

    const warm = await dispatchElided(task);
    expect(warm.warm).toBe(true);
    expect(warm.prompt).toContain('--- RECALLED LESSONS ---');
    expect(warm.prompt).not.toContain('--- INBOX MAIL ---');
    expect(ctx.nativeTaskMap.get(warm.taskId)!.agentMailIds).toBeUndefined();
    await relayOk(warm.taskId);
    expect(inbox.get(id)!.status).toBe('queued');
  });

  it('composeWarmBody: lessons + mail, else lessons, else base — and cold/warm byte identity', () => {
    sendTo('native-a', 'hello');
    const mail = prepareAgentMail(inbox, 'native-a')!;
    const parts = { identity: '## Identity\nagent_id: native-a', skills: 'SKILLS', task: 'T' };
    const tail = '\n\nTask: T';
    const { skillsSection } = splitAssembledPrompt(assemblePrompt(parts), tail);
    expect(skillsSection).not.toContain('INBOX MAIL');
    const cold = assemblePrompt({ ...parts, retrievedLessons: 'LESSONS', inboxMail: mail.block });
    expect(composeWarmBody(skillsSection, tail, 'LESSONS', mail.block)).toBe(cold);
    expect(composeWarmBody(skillsSection, tail, undefined, mail.block)).toBe(assemblePrompt({ ...parts, inboxMail: mail.block }));

    const room = MAX_ASSEMBLED_PROMPT_CHARS - (skillsSection + tail).length;
    const lessons = 'L'.repeat(room - 100);
    const withLessons = composeWarmBody(skillsSection, tail, lessons, mail.block);
    expect(withLessons).toContain(lessons);
    expect(withLessons).not.toContain(mail.block);
    expect(composeWarmBody(skillsSection, tail, 'L'.repeat(room + 1), mail.block)).toBe(skillsSection + tail);
  });
});

describe('native parallel and consensus dispatch', () => {
  it('parallel: mail is embedded, not marked at dispatch, and marked only for the task that relayed OK', async () => {
    const forA = sendTo('native-a', 'mail for a');
    const forB = sendTo('native-b', 'mail for b');
    const res: any = await handleDispatchParallel(
      [{ agent_id: 'native-a', task: 'task a' }, { agent_id: 'native-b', task: 'task b' }], false,
    );
    const prompts = promptItems(res.content);
    const pa = prompts.find((p) => p.includes('mail for a'))!;
    const pb = prompts.find((p) => p.includes('mail for b'))!;
    expect(pa).not.toContain('mail for b');
    expect(inbox.get(forA)!.status).toBe('queued');
    expect(inbox.get(forB)!.status).toBe('queued');

    await relayOk(taskIdOf(pa));
    const tb = taskIdOf(pb);
    await handleNativeRelay(tb, '', 'boom', undefined, tokenOf(tb));
    expect(inbox.get(forA)).toMatchObject({ status: 'answered', delivered_via: `dispatch:${taskIdOf(pa)}` });
    expect(inbox.get(forB)!.status).toBe('queued');
  });

  it('consensus: mail is embedded, not marked at dispatch, marked after a successful relay', async () => {
    const forA = sendTo('native-a', 'consensus mail for a');
    const res: any = await handleDispatchConsensus([
      { agent_id: 'native-a', task: 'review x' },
      { agent_id: 'native-b', task: 'review y' },
    ]);
    const pa = promptItems(res.content).find((p) => p.includes('consensus mail for a'))!;
    expect(pa).toBeDefined();
    const ta = taskIdOf(pa);
    expect(ctx.nativeTaskMap.get(ta)!.agentMailIds).toEqual([forA]);
    expect(inbox.get(forA)!.status).toBe('queued');
    await relayOk(ta, '<agent_finding type="finding" severity="low">x</agent_finding>');
    expect(inbox.get(forA)!.status).toBe('answered');
  });
});

describe('native relay → agent mail', () => {
  function register(taskId: string, token: string): void {
    ctx.nativeTaskMap.set(taskId, { agentId: 'native-a', task: 't', startedAt: Date.now(), relayToken: token });
  }
  const tagged = '<agent_message to="orchestrator" from="human" kind="chat">is X intended?</agent_message>';

  it('a validated result writes from=<task agent>, to=orchestrator, ref.task_id', async () => {
    register('tk-ok', 'tok123');
    await handleNativeRelay('tk-ok', `findings\n${tagged}`, undefined, undefined, 'tok123');
    const mail = inbox.list({ to: 'orchestrator' });
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ from: 'native-a', to: 'orchestrator', kind: 'chat', ref: { task_id: 'tk-ok' }, chat_id: 'agent-native-a' });
  });

  it('a quoted tag (mid-line or fenced) in the result is not mail', async () => {
    register('tk-q', 'tok123');
    await handleNativeRelay('tk-q', `Agents write ${tagged} to ask.\n\`\`\`\n${tagged}\n\`\`\``, undefined, undefined, 'tok123');
    expect(inbox.list()).toEqual([]);
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
    const q = sendTo('native-a', 'which branch?');
    register('tk-r', 'tok123');
    await handleNativeRelay('tk-r', `<agent_message in_reply_to="${q}">master</agent_message>`, undefined, undefined, 'tok123');
    expect(inbox.get(q)!.status).toBe('answered');
  });

  it('over-quota mail is dropped without failing the relay; human mail is still accepted', async () => {
    for (let i = 0; i < AGENT_MAIL_MAX_UNANSWERED_PER_SENDER; i++) {
      inbox.append('agent-native-a', `old ${i}`, clock++, { to: 'orchestrator', from: 'native-a' });
    }
    register('tk-quota', 'tok123');
    const res = await handleNativeRelay('tk-quota', '<agent_message>one too many</agent_message>', undefined, undefined, 'tok123');
    expect(res.content[0].text).toContain('tk-quota');
    expect(ctx.nativeResultMap.get('tk-quota')!.status).toBe('completed');
    expect(inbox.list({ to: 'orchestrator' }).map((e) => e.content)).not.toContain('one too many');
    expect(() => inbox.append('dash', 'human still gets through', clock++)).not.toThrow();
  });
});
