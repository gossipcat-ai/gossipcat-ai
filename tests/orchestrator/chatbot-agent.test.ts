import {
  ChatbotAgent,
  ChatbotTool,
  ChatStreamEvent,
} from '../../packages/orchestrator/src/chatbot-agent';
import type { ILLMProvider, LLMGenerateOptions } from '../../packages/orchestrator/src/llm-client';
import type { LLMResponse } from '../../packages/orchestrator/src/types';
import type { LLMMessage } from '@gossip/types';

/**
 * A provider that replays a scripted list of responses, one per generate()
 * call. Captures a deep snapshot of the `messages` array passed to EACH
 * generate() call so tests can assert message-shaping (f7 regression guard).
 */
function makeMockProvider(scripted: LLMResponse[]): ILLMProvider & {
  calls: number;
  lastOptions?: LLMGenerateOptions;
  messagesPerCall: LLMMessage[][];
} {
  return {
    calls: 0,
    lastOptions: undefined,
    messagesPerCall: [],
    async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
      this.lastOptions = options;
      // Deep-snapshot the messages so later in-place pushes don't mutate the capture.
      this.messagesPerCall.push(JSON.parse(JSON.stringify(messages)));
      // Clamp to last scripted entry so "always returns a tool call" works for the cap test.
      const idx = Math.min(this.calls, scripted.length - 1);
      this.calls += 1;
      return scripted[idx];
    },
  };
}

function makeTool(name: string, runImpl?: (args: Record<string, unknown>) => Promise<unknown>): ChatbotTool & { run: jest.Mock } {
  const run = jest.fn(runImpl ?? (async () => ({ ok: true })));
  return {
    name,
    description: `desc ${name}`,
    inputSchema: { type: 'object', properties: {} },
    run,
  };
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('ChatbotAgent.turnStream', () => {
  it('(a) no-tool turn yields [token, done] with the answer text', async () => {
    const provider = makeMockProvider([{ text: 'hello world' }]);
    const agent = new ChatbotAgent({ llm: provider, tools: [], systemPrompt: 'sys' });

    const events = await collect(agent.turnStream('hi', []));

    expect(events).toEqual([
      { type: 'token', text: 'hello world' },
      { type: 'done', text: 'hello world' },
    ]);
    expect(provider.calls).toBe(1);
  });

  it('(b) allowed-tool turn yields [tool_use, tool_result, token, done] and runs the tool with args', async () => {
    const tool = makeTool('gossip_scores', async () => ({ top: 'agent-x' }));
    const provider = makeMockProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'gossip_scores', arguments: { window: '24h' } }] },
      { text: 'the top agent is agent-x' },
    ]);
    const agent = new ChatbotAgent({ llm: provider, tools: [tool], systemPrompt: 'sys' });

    const events = await collect(agent.turnStream('who is top?', []));

    expect(events).toEqual([
      { type: 'tool_use', name: 'gossip_scores', args: { window: '24h' } },
      { type: 'tool_result', name: 'gossip_scores', result: { top: 'agent-x' } },
      { type: 'token', text: 'the top agent is agent-x' },
      { type: 'done', text: 'the top agent is agent-x' },
    ]);
    expect(tool.run).toHaveBeenCalledTimes(1);
    expect(tool.run).toHaveBeenCalledWith({ window: '24h' });
    expect(provider.calls).toBe(2);
  });

  it('(c) ALLOWLIST: a tool call for a name not in cfg.tools yields error and NEVER executes', async () => {
    const allowed = makeTool('gossip_scores');
    const provider = makeMockProvider([
      // model tries to call a tool that is NOT in the allowlist
      { text: '', toolCalls: [{ id: 'c1', name: 'gossip_dispatch', arguments: { evil: true } }] },
      { text: 'done after rejection' },
    ]);
    const agent = new ChatbotAgent({ llm: provider, tools: [allowed], systemPrompt: 'sys' });

    const events = await collect(agent.turnStream('do something bad', []));

    expect(events).toContainEqual({ type: 'error', message: 'tool not allowed: gossip_dispatch' });
    // No tool_use / tool_result EVENTS for the rejected call.
    expect(events.some(e => e.type === 'tool_use')).toBe(false);
    expect(events.some(e => e.type === 'tool_result')).toBe(false);
    // The single allowed tool was never invoked.
    expect(allowed.run).not.toHaveBeenCalled();

    // f9: even though it was rejected, the model gets feedback — the 2nd
    // generate() call must see an error tool-result tied to the call.id, so
    // the assistant tool_use isn't left dangling.
    const secondCallMsgs = provider.messagesPerCall[1];
    const errResult = secondCallMsgs.find(m => m.role === 'tool' && m.toolCallId === 'c1');
    expect(errResult).toBeDefined();
    expect(errResult!.content).toContain('tool not allowed: gossip_dispatch');
  });

  it('(f1) MULTI-TOOL: two allowed calls in one response → ordered events AND ONE assistant message carrying BOTH calls (f7 regression guard)', async () => {
    const a = makeTool('tool_a', async () => ({ a: 1 }));
    const b = makeTool('tool_b', async () => ({ b: 2 }));
    const provider = makeMockProvider([
      {
        text: '',
        toolCalls: [
          { id: 'ca', name: 'tool_a', arguments: { x: 1 } },
          { id: 'cb', name: 'tool_b', arguments: { y: 2 } },
        ],
      },
      { text: 'both done' },
    ]);
    const agent = new ChatbotAgent({ llm: provider, tools: [a, b], systemPrompt: 'sys' });

    const events = await collect(agent.turnStream('do both', []));

    expect(events).toEqual([
      { type: 'tool_use', name: 'tool_a', args: { x: 1 } },
      { type: 'tool_result', name: 'tool_a', result: { a: 1 } },
      { type: 'tool_use', name: 'tool_b', args: { y: 2 } },
      { type: 'tool_result', name: 'tool_b', result: { b: 2 } },
      { type: 'token', text: 'both done' },
      { type: 'done', text: 'both done' },
    ]);
    expect(a.run).toHaveBeenCalledTimes(1);
    expect(b.run).toHaveBeenCalledTimes(1);

    // f7: the 2nd generate() must receive EXACTLY ONE assistant message that
    // carries BOTH tool calls — never two separate assistant messages.
    const secondCallMsgs = provider.messagesPerCall[1];
    const assistantMsgs = secondCallMsgs.filter(m => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0].toolCalls).toEqual([
      { id: 'ca', name: 'tool_a', arguments: { x: 1 } },
      { id: 'cb', name: 'tool_b', arguments: { y: 2 } },
    ]);
    // …followed by one tool-result message per call.id.
    const toolMsgs = secondCallMsgs.filter(m => m.role === 'tool');
    expect(toolMsgs.map(m => m.toolCallId)).toEqual(['ca', 'cb']);
  });

  it('(f3) MIXED: one allowed + one disallowed in the same response → allowed runs, disallowed errors and is never executed', async () => {
    const ok = makeTool('tool_ok', async () => ({ ok: true }));
    const provider = makeMockProvider([
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'tool_ok', arguments: {} },
          { id: 'c2', name: 'tool_bad', arguments: {} },
        ],
      },
      { text: 'wrapped up' },
    ]);
    const agent = new ChatbotAgent({ llm: provider, tools: [ok], systemPrompt: 'sys' });

    const events = await collect(agent.turnStream('mixed', []));

    // allowed tool produced use+result events and actually ran
    expect(events).toContainEqual({ type: 'tool_use', name: 'tool_ok', args: {} });
    expect(events).toContainEqual({ type: 'tool_result', name: 'tool_ok', result: { ok: true } });
    expect(ok.run).toHaveBeenCalledTimes(1);
    // disallowed tool errored and never ran (no event for it)
    expect(events).toContainEqual({ type: 'error', message: 'tool not allowed: tool_bad' });
    expect(events.some(e => e.type === 'tool_use' && (e as { name: string }).name === 'tool_bad')).toBe(false);

    // both call.ids get a tool-result in the next request (one real, one error)
    const secondCallMsgs = provider.messagesPerCall[1];
    const toolMsgs = secondCallMsgs.filter(m => m.role === 'tool');
    expect(toolMsgs.map(m => m.toolCallId).sort()).toEqual(['c1', 'c2']);
    const badResult = toolMsgs.find(m => m.toolCallId === 'c2');
    expect(badResult!.content).toContain('tool not allowed: tool_bad');
  });

  it('(f4) history is forwarded between the system prompt and the new user message', async () => {
    const provider = makeMockProvider([{ text: 'answer' }]);
    const agent = new ChatbotAgent({ llm: provider, tools: [], systemPrompt: 'sys' });
    const history: LLMMessage[] = [
      { role: 'user', content: 'prev question' },
      { role: 'assistant', content: 'prev answer' },
    ];

    await collect(agent.turnStream('new question', history));

    const msgs = provider.messagesPerCall[0];
    expect(msgs).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'prev question' },
      { role: 'assistant', content: 'prev answer' },
      { role: 'user', content: 'new question' },
    ]);
  });

  it('(f5/d) cap: model always returns one tool call → stops after maxToolCallsPerTurn executions, full ordered sequence', async () => {
    const tool = makeTool('gossip_status', async () => ({ ok: true }));
    const provider = makeMockProvider([
      { text: '', toolCalls: [{ id: 'loop', name: 'gossip_status', arguments: {} }] },
    ]);
    const agent = new ChatbotAgent({
      llm: provider,
      tools: [tool],
      systemPrompt: 'sys',
      maxToolCallsPerTurn: 3,
    });

    const events = await collect(agent.turnStream('spin', []));

    // f5: assert the FULL ordered event sequence — 3 tool rounds then the
    // f11 cap token + done.
    expect(events).toEqual([
      { type: 'tool_use', name: 'gossip_status', args: {} },
      { type: 'tool_result', name: 'gossip_status', result: { ok: true } },
      { type: 'tool_use', name: 'gossip_status', args: {} },
      { type: 'tool_result', name: 'gossip_status', result: { ok: true } },
      { type: 'tool_use', name: 'gossip_status', args: {} },
      { type: 'tool_result', name: 'gossip_status', result: { ok: true } },
      { type: 'token', text: '(tool-call limit reached)' },
      { type: 'done', text: '(tool-call limit reached)' },
    ]);
    expect(tool.run).toHaveBeenCalledTimes(3);
    expect(provider.calls).toBe(3);
  });

  it('(f8) cap counts EXECUTIONS not generate ROUNDS: one response with N calls consumes N of the budget', async () => {
    const tool = makeTool('gossip_status', async () => ({ ok: true }));
    // Each response carries TWO tool calls; with a cap of 3 executions the
    // budget is exhausted DURING the 2nd round (after 4 runs >= 3), so the
    // model is never asked a 3rd time.
    const provider = makeMockProvider([
      {
        text: '',
        toolCalls: [
          { id: 'a', name: 'gossip_status', arguments: {} },
          { id: 'b', name: 'gossip_status', arguments: {} },
        ],
      },
    ]);
    const agent = new ChatbotAgent({
      llm: provider,
      tools: [tool],
      systemPrompt: 'sys',
      maxToolCallsPerTurn: 3,
    });

    const events = await collect(agent.turnStream('spin', []));

    // 2 rounds × 2 calls = 4 executions, then cap. NOT 3 rounds.
    expect(tool.run).toHaveBeenCalledTimes(4);
    expect(provider.calls).toBe(2);
    const last = events[events.length - 1];
    expect(last).toEqual({ type: 'done', text: '(tool-call limit reached)' });
  });

  it('(f6) explicit empty toolCalls:[] → final-answer path (token + done)', async () => {
    const tool = makeTool('gossip_status');
    const provider = makeMockProvider([{ text: 'just an answer', toolCalls: [] }]);
    const agent = new ChatbotAgent({ llm: provider, tools: [tool], systemPrompt: 'sys' });

    const events = await collect(agent.turnStream('hi', []));

    expect(events).toEqual([
      { type: 'token', text: 'just an answer' },
      { type: 'done', text: 'just an answer' },
    ]);
    expect(tool.run).not.toHaveBeenCalled();
    expect(provider.calls).toBe(1);
  });

  it('(e) error: provider.generate throws → yields error and does not throw out of the generator', async () => {
    const provider: ILLMProvider = {
      async generate(): Promise<LLMResponse> {
        throw new Error('boom');
      },
    };
    const agent = new ChatbotAgent({ llm: provider, tools: [], systemPrompt: 'sys' });

    const events = await collect(agent.turnStream('hi', []));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect((events[0] as { type: 'error'; message: string }).message).toContain('boom');
  });

  it('(f2) tool.run throws → yields error and the generator does not throw', async () => {
    const tool = makeTool('gossip_status', async () => {
      throw new Error('tool blew up');
    });
    const provider = makeMockProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'gossip_status', arguments: {} }] },
    ]);
    const agent = new ChatbotAgent({ llm: provider, tools: [tool], systemPrompt: 'sys' });

    const events = await collect(agent.turnStream('go', []));

    // tool_use was emitted, then the throw surfaced as an error event.
    expect(events).toContainEqual({ type: 'tool_use', name: 'gossip_status', args: {} });
    const err = events.find(e => e.type === 'error') as { type: 'error'; message: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.message).toContain('tool blew up');
    // No tool_result for the failed run.
    expect(events.some(e => e.type === 'tool_result')).toBe(false);
  });
});
