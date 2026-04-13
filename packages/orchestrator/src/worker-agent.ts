/**
 * WorkerAgent — executes a sub-task using its LLM and requests tools via relay.
 *
 * Multi-turn tool loop with max 10 turns to prevent infinite loops.
 * Tool calls are sent as RPC_REQUEST to tool-server via relay.
 */

import { randomUUID } from 'crypto';
import { GossipAgent } from '@gossip/client';
import { MessageType, MessageEnvelope, Message, ToolDefinition, LLMMessage } from '@gossip/types';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { ILLMProvider } from './llm-client';
import {
  TaskStreamEvent,
  TaskStreamEventType,
} from './task-stream';

export type TaskCompleteCallback = (event: {
  agentId: string;
  taskId: string;
  toolCalls: number;
  durationMs: number;
  memoryQueryCalled: boolean;
}) => void;

const MAX_TOOL_TURNS = 15;
const TOOL_CALL_TIMEOUT_MS = 60_000;
import { log as _log } from './log';
const log = (agentId: string, msg: string) => _log(`worker:${agentId}`, msg);

/**
 * Extract tool calls from LLM text when native function calling fails.
 * Gemini frequently ignores functionDeclarations and emits text-based tool calls instead.
 * Handles: [TOOL_CALL]...[/TOOL_CALL], [TOOL_CODE]...[/TOOL_CODE], and function_call() syntax.
 */
function parseTextToolCalls(text: string, validTools: Set<string>): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

  // Pattern 1: [TOOL_CALL] or [TOOL_CODE] blocks (most common Gemini fallback)
  // Fix: require closing tag — don't match to EOF (prevents consuming entire response)
  const blockRe = /\[(?:TOOL_CALL|TOOL_CODE)\]([\s\S]*?)\[\/(?:TOOL_CALL|TOOL_CODE)\]/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(text)) !== null) {
    const content = match[1].trim();
    const parsed = parseToolContent(content, validTools);
    if (parsed) calls.push({ id: randomUUID().slice(0, 12), ...parsed });
  }

  // Pattern 2: ```tool_call or ```json blocks with tool/args structure
  if (calls.length === 0) {
    // Fix: only match ```tool_call fences, not generic ```json (avoids false positives on explanatory JSON)
    const fenceRe = /```tool_call\s*\n([\s\S]*?)```/g;
    while ((match = fenceRe.exec(text)) !== null) {
      const content = match[1].trim();
      const parsed = parseToolContent(content, validTools);
      if (parsed) calls.push({ id: randomUUID().slice(0, 12), ...parsed });
    }
  }

  // Pattern 3: function_name({...}) syntax — dynamic from validTools registry
  if (calls.length === 0 && validTools.size > 0) {
    const toolNames = Array.from(validTools).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const funcRe = new RegExp(`\\b(${toolNames})\\s*\\(\\s*(\\{[\\s\\S]*?\\})\\s*\\)`, 'g');
    while ((match = funcRe.exec(text)) !== null) {
      if (!validTools.has(match[1])) continue; // double-check
      try {
        const args = JSON.parse(match[2].replace(/,\s*([}\]])/g, '$1'));
        calls.push({ id: randomUUID().slice(0, 12), name: match[1], arguments: args });
      } catch { /* skip malformed */ }
    }
  }

  return calls;
}

function parseToolContent(content: string, validTools: Set<string>): { name: string; arguments: Record<string, unknown> } | null {
  // Try JSON first
  try {
    const cleaned = content.replace(/,\s*([}\]])/g, '$1');
    const parsed = JSON.parse(cleaned);
    const name = parsed.tool || parsed.name || parsed.function || parsed.tool_name;
    const args = parsed.args || parsed.arguments || parsed.parameters || parsed.tool_input || {};
    if (name && validTools.has(name)) return { name, arguments: args };
  } catch { /* not JSON */ }

  // Try YAML-like: tool: name\nargs:\n  key: value
  const toolMatch = content.match(/^tool:\s*["']?(\w+)["']?/m);
  if (toolMatch && validTools.has(toolMatch[1])) {
    const name = toolMatch[1];
    const args: Record<string, unknown> = {};
    // Extract key: value pairs after "args:"
    const argsSection = content.match(/args:\s*\n([\s\S]*)/);
    if (argsSection) {
      const lines = argsSection[1].split('\n');
      for (const line of lines) {
        const kv = line.match(/^\s+(\w+):\s*(.*)/);
        if (kv) {
          let val: unknown = kv[2].trim();
          // Strip quotes
          if (typeof val === 'string' && /^["'].*["']$/.test(val)) val = (val as string).slice(1, -1);
          args[kv[1]] = val;
        }
      }
    }
    return { name, arguments: args };
  }

  return null;
}

export class WorkerAgent {
  private agent: GossipAgent;
  private instructions: string;
  private gossipQueue: string[] = [];
  private static readonly MAX_GOSSIP_QUEUE = 20;

  /**
   * Per-task call budgets for introspection tools that have no business
   * being called repeatedly. memory_query is a one-shot recall (the
   * memory-retrieval skill says "one call per task is the floor"),
   * self_identity is a fact lookup. Without a cap, an agent that gets
   * confused can spin a turn loop calling these and burn the entire
   * MAX_TOOL_TURNS budget on noise. Reset at the top of executeTask.
   */
  private toolCallBudget: Map<string, number> = new Map();
  private static readonly TOOL_CALL_BUDGETS: Record<string, number> = {
    memory_query: 10,
    self_identity: 3,
  };
  /** Tracks whether the agent called memory_query during the current task. Reset per task. */
  private memoryQueryCalled = false;
  private pendingToolCalls: Map<string, {
    resolve: (result: string) => void;
    reject: (err: Error) => void;
  }> = new Map();

  private webSearchEnabled: boolean;
  private validToolNames: Set<string>;
  private onTaskComplete?: TaskCompleteCallback;

  constructor(
    private agentId: string,
    private llm: ILLMProvider,
    relayUrl: string,
    private tools: ToolDefinition[],
    instructions?: string,
    webSearch?: boolean,
    apiKey?: string,
  ) {
    this.webSearchEnabled = webSearch ?? false;
    this.validToolNames = new Set(tools.map(t => t.name));
    this.instructions = instructions || 'You are a skilled developer agent. Complete the assigned task using the available tools. Be concise and focused.\n\nIf you encounter a domain your skills don\'t cover, call suggest_skill(name, reason) — it helps the system learn. Don\'t stop working to suggest; note the gap and keep going.';
    this.agent = new GossipAgent({ agentId, relayUrl, apiKey, reconnect: true });
  }

  setOnTaskComplete(cb: TaskCompleteCallback): void {
    this.onTaskComplete = cb;
  }

  setInstructions(instructions: string): void {
    this.instructions = instructions;
  }

  getInstructions(): string {
    return this.instructions;
  }

  async subscribeToBatch(batchId: string): Promise<void> {
    await this.agent.subscribe(`batch:${batchId}`).catch(err =>
      console.error(`[${this.agentId}] Failed to subscribe to batch:${batchId}: ${err.message}`)
    );
  }

  async unsubscribeFromBatch(batchId: string): Promise<void> {
    await this.agent.unsubscribe(`batch:${batchId}`).catch(() => {});
  }

  async start(): Promise<void> {
    await this.agent.connect();
    log(this.agentId, 'connected to relay');
    this.agent.on('message', this.handleMessage.bind(this));
    this.agent.on('error', () => {
      log(this.agentId, 'RELAY ERROR — rejecting pending tool calls');
      this.rejectPendingToolCalls('Relay connection error');
    });
    this.agent.on('disconnect', () => {
      log(this.agentId, 'RELAY DISCONNECTED — rejecting pending tool calls');
      this.rejectPendingToolCalls('Relay disconnected');
    });
  }

  private rejectPendingToolCalls(reason: string): void {
    for (const [, pending] of this.pendingToolCalls) {
      pending.reject(new Error(reason));
    }
    this.pendingToolCalls.clear();
  }

  async stop(): Promise<void> {
    await this.agent.disconnect();
  }

  /**
   * Execute a task with the LLM, using multi-turn tool calling.
   * Returns the final text response.
   */
  async *executeTask(task: string, context?: string, skillsContent?: string, taskId?: string): AsyncGenerator<TaskStreamEvent, void, undefined> {
    const logAndYield = (message: string): TaskStreamEvent => {
        log(this.agentId, message);
        return { type: TaskStreamEventType.LOG, payload: message, timestamp: Date.now() };
    };

    yield logAndYield(`executeTask started — task: "${task.slice(0, 100)}..." webSearch=${this.webSearchEnabled} tools=${this.tools.length}`);
    this.gossipQueue = []; // clear gossip from previous task
    this.toolCallBudget = new Map(); // reset per-tool call budgets per task
    this.memoryQueryCalled = false; // reset memory_query tracking per task
    const startTime = Date.now();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallCount = 0;
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `${this.instructions}${skillsContent || ''}${context ? `\n\nContext:\n${context}` : ''}

## How to Work

1. **Plan first.** Before making any tool calls, think through what you need to do. Break the task into concrete steps in your head. State your plan briefly.

2. **Batch operations.** You can read and write MULTIPLE files in a single turn. Don't waste turns on one file at a time. For example:
   - Turn 1: Read 3-4 existing files to understand the codebase
   - Turn 2: Write 2-3 new files and modify 1-2 existing ones
   - Turn 3: Verify with file_tree or file_read, fix any issues
   That's a complete task in 3 turns. Aim for efficiency.

3. **Budget: ${MAX_TOOL_TURNS} tool turns.** Each LLM response that includes tool calls costs 1 turn, regardless of how many tools you call in that response. Use multiple tool calls per turn.

4. **Signal completion.** When you're done, respond with a concise summary (no tool calls) listing: files created/modified, technology choices made, and what the next step should be.

5. **Don't overengineer.** Use the simplest tech that works. If the task doesn't specify TypeScript, use plain JavaScript. If it doesn't specify a bundler, use CDN scripts or plain ES modules. If it doesn't specify a framework, use vanilla code. Don't add build complexity (npm, webpack, TypeScript config) unless explicitly requested.

6. **If you hit the same error twice, stop and report it.** Don't spend more turns fighting the same build/config/type error. Report what's blocking you so the orchestrator can help.

7. **Verify your work.** After writing files, use file_read to confirm correctness. If shell_exec is available AND a build script exists, run \`npm run build\` (NOT \`npm run dev\`). Note: shell_exec may be unavailable in scoped write mode — that's normal, just verify with file_read instead.

8. **Never delete files to debug.** If something isn't working, read the error message and fix the code. Don't remove components or files to "isolate the issue" — that's destructive and you can't undo it.

9. **Don't git commit unless asked.** The orchestrator manages git. Don't run git init, git add, or git commit on your own.

10. **Update your memory.** If the AGENT MEMORY section is present above, save what you learned: tech stack, file structure, patterns, gotchas. Use file_write to your memory directory. This helps you on future tasks.`,
      },
      { role: 'user', content: task },
    ];

    try {
      const WRAP_UP_AT = MAX_TOOL_TURNS - 4;  // warn with 4 turns left
      const FINAL_AT = MAX_TOOL_TURNS - 2;    // second-to-last turn: save all work (turn after this is for summary only)
      let lastToolSig = '';   // signature of last tool call for repetition detection
      let repeatCount = 0;    // consecutive identical tool calls
      let consecutiveErrors = 0; // consecutive turns where ALL tool calls return errors

      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        // Inject any pending gossip before the next LLM turn
        while (this.gossipQueue.length > 0) {
          const gossip = this.gossipQueue.shift()!;
          messages.push({
            role: 'user',
            content: `[Team Update — a teammate finished their task. Use this to avoid conflicts and build on their work.]\n<team-gossip>${gossip}</team-gossip>`,
          });
        }

        // Turn budget awareness
        if (turn === WRAP_UP_AT) {
          messages.push({
            role: 'user',
            content: `[System] ${MAX_TOOL_TURNS - turn} turns left. Finish writing any open files now. On your next response, you can make multiple tool calls to save everything at once.`,
          });
        } else if (turn === FINAL_AT) {
          messages.push({
            role: 'user',
            content: `[System] LAST turn. Save all remaining work in this response (use multiple tool calls). Then provide your completion summary with NO tool calls.`,
          });
        }

        yield logAndYield(`turn ${turn}/${MAX_TOOL_TURNS} — calling LLM (${messages.length} messages)`);
        const llmStart = Date.now();
        let response = await this.llm.generate(messages, {
          tools: this.tools,
          ...(this.webSearchEnabled ? { webSearch: true } : {}),
        });
        const llmMs = Date.now() - llmStart;

        if (response.usage) {
          totalInputTokens += response.usage.inputTokens;
          totalOutputTokens += response.usage.outputTokens;
        }

        yield logAndYield(`turn ${turn} — LLM returned in ${llmMs}ms: text=${response.text?.length ?? 0}chars, toolCalls=${response.toolCalls?.length ?? 0}, tokens=${response.usage?.inputTokens ?? '?'}in/${response.usage?.outputTokens ?? '?'}out`);

        // Fallback: if no native tool calls, parse text for [TOOL_CALL] blocks.
        if (!response.toolCalls?.length && response.text) {
          const textCalls = parseTextToolCalls(response.text, this.validToolNames);
          if (textCalls.length > 0) {
            yield logAndYield(`turn ${turn} — no native FC, but found ${textCalls.length} text-based tool calls: ${textCalls.map(tc => tc.name).join(', ')}`);
            response = { ...response, toolCalls: textCalls };
          }
        }

        if (response.text) {
            yield { type: TaskStreamEventType.PARTIAL_RESULT, payload: { text: response.text }, timestamp: Date.now() };
        }

        if (!response.toolCalls?.length) {
          yield logAndYield(`turn ${turn} — NO tool calls, exiting. Text preview: "${(response.text || '').slice(0, 200)}"`);
          this.onTaskComplete?.({ agentId: this.agentId, taskId: taskId ?? '', toolCalls: toolCallCount, durationMs: Date.now() - startTime, memoryQueryCalled: this.memoryQueryCalled });
          yield { type: TaskStreamEventType.FINAL_RESULT, payload: { result: response.text || '[No response from agent]', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, memoryQueryCalled: this.memoryQueryCalled }, timestamp: Date.now() };
          return;
        }

        // Detect repetitive tool calls
        const toolSig = response.toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.arguments, Object.keys(tc.arguments || {}).sort())}`).join('|');
        if (toolSig === lastToolSig) {
          repeatCount++;
          if (repeatCount >= 2) {
            yield logAndYield(`turn ${turn} — STUCK: repeating same tool calls ${repeatCount + 1}x, exiting`);
            this.onTaskComplete?.({ agentId: this.agentId, taskId: taskId ?? '', toolCalls: toolCallCount, durationMs: Date.now() - startTime, memoryQueryCalled: this.memoryQueryCalled });
            yield { type: TaskStreamEventType.FINAL_RESULT, payload: { result: response.text || 'Task completed (agent was repeating the same action).', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, memoryQueryCalled: this.memoryQueryCalled }, timestamp: Date.now() };
            return;
          }
        } else {
          lastToolSig = toolSig;
          repeatCount = 0;
        }

        let cleanedText = response.text || '';
        if (cleanedText.includes('[TOOL_CALL]') || cleanedText.includes('[TOOL_CODE]')) {
          cleanedText = cleanedText
            .replace(/\[(?:TOOL_CALL|TOOL_CODE)\][\s\S]*?(?:\[\/(?:TOOL_CALL|TOOL_CODE)\]|$)/g, '')
            .replace(/```(?:tool_call|json)?\s*\n[\s\S]*?```/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }
        messages.push({
          role: 'assistant',
          content: cleanedText,
          toolCalls: response.toolCalls,
        });

        yield logAndYield(`turn ${turn} — executing ${response.toolCalls.length} tool calls: ${response.toolCalls.map(tc => tc.name).join(', ')}`);
        let turnErrors = 0;
        for (const toolCall of response.toolCalls) {
          let result: string;
          try {
            const toolStart = Date.now();
            result = await this.callTool(toolCall.name, toolCall.arguments);
            yield logAndYield(`  tool ${toolCall.name} → ${Date.now() - toolStart}ms, ${result.length}chars${result.startsWith('Error:') ? ' ERROR: ' + result.slice(0, 100) : ''}`);
          } catch (err) {
            result = `Error: ${(err as Error).message}`;
            yield logAndYield(`  tool ${toolCall.name} → THREW: ${result.slice(0, 150)}`);
          }
          if (result.startsWith('Error:')) turnErrors++;
          messages.push({
            role: 'tool',
            content: result,
            toolCallId: toolCall.id,
            name: toolCall.name,
          });
          toolCallCount++;
          yield { type: TaskStreamEventType.PROGRESS, payload: { toolCalls: toolCallCount, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, currentTool: toolCall.name, turn, }, timestamp: Date.now() };
        }

        if (turnErrors === response.toolCalls.length) {
          consecutiveErrors++;
          yield logAndYield(`turn ${turn} — all ${response.toolCalls.length} tool calls errored (streak: ${consecutiveErrors})`);
          if (consecutiveErrors >= 3) {
            yield logAndYield(`turn ${turn} — ERROR LOOP: 3 consecutive all-error turns, exiting`);
            this.onTaskComplete?.({ agentId: this.agentId, taskId: taskId ?? '', toolCalls: toolCallCount, durationMs: Date.now() - startTime, memoryQueryCalled: this.memoryQueryCalled });
            yield { type: TaskStreamEventType.FINAL_RESULT, payload: { result: response.text || 'Task incomplete — agent stuck in error loop. Simplify the approach or check the error messages above.', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, memoryQueryCalled: this.memoryQueryCalled }, timestamp: Date.now() };
            return;
          }
        } else {
          consecutiveErrors = 0;
        }
      }

      yield logAndYield(`hit max turns (${MAX_TOOL_TURNS}), requesting summary. Total tool calls: ${toolCallCount}`);
      try {
        messages.push({ role: 'user', content: 'Your turn budget is exhausted. Summarize what you accomplished and what remains unfinished. List files created/modified.' });
        const summary = await this.llm.generate(messages);
        if (summary.usage) { totalInputTokens += summary.usage.inputTokens; totalOutputTokens += summary.usage.outputTokens; }
        this.onTaskComplete?.({ agentId: this.agentId, taskId: taskId ?? '', toolCalls: toolCallCount, durationMs: Date.now() - startTime, memoryQueryCalled: this.memoryQueryCalled });
        yield { type: TaskStreamEventType.FINAL_RESULT, payload: { result: summary.text || 'Task completed (turn budget exhausted).', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, memoryQueryCalled: this.memoryQueryCalled }, timestamp: Date.now() };
      } catch {
        this.onTaskComplete?.({ agentId: this.agentId, taskId: taskId ?? '', toolCalls: toolCallCount, durationMs: Date.now() - startTime, memoryQueryCalled: this.memoryQueryCalled });
        yield { type: TaskStreamEventType.FINAL_RESULT, payload: { result: 'Task incomplete — agent exhausted its turn budget.', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, memoryQueryCalled: this.memoryQueryCalled }, timestamp: Date.now() };
      }
    } catch (err) {
      const errorMessage = `FATAL ERROR in executeTask: ${(err as Error).message}`;
      yield logAndYield(errorMessage);
      this.onTaskComplete?.({ agentId: this.agentId, taskId: taskId ?? '', toolCalls: toolCallCount, durationMs: Date.now() - startTime, memoryQueryCalled: this.memoryQueryCalled });
      yield { type: TaskStreamEventType.ERROR, payload: { error: errorMessage }, timestamp: Date.now() };
    }
  }

  /** Send RPC_REQUEST to tool-server via relay */
  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // Per-task rate limit for introspection tools — see toolCallBudget doc.
    const cap = WorkerAgent.TOOL_CALL_BUDGETS[name];
    if (cap !== undefined) {
      const used = this.toolCallBudget.get(name) ?? 0;
      if (used >= cap) {
        return `Error: ${name} per-task budget exhausted (${cap} calls). The result of your previous ${name} call is in conversation history — re-read it instead of calling again.`;
      }
      this.toolCallBudget.set(name, used + 1);
    }

    // Track whether the agent used memory_query at least once during this task
    if (name === 'memory_query') {
      this.memoryQueryCalled = true;
    }

    const requestId = randomUUID();

    const resultPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingToolCalls.has(requestId)) {
          this.pendingToolCalls.delete(requestId);
          reject(new Error(`Tool call ${name} timed out`));
        }
      }, TOOL_CALL_TIMEOUT_MS);
      timer.unref(); // Fix: don't keep Node process alive for pending tool timeouts

      this.pendingToolCalls.set(requestId, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });

    const msg = Message.createRpcRequest(
      this.agentId,
      'tool-server',
      requestId,
      Buffer.from(msgpackEncode({ tool: name, args })) as unknown as Uint8Array
    );
    try {
      await this.agent.sendEnvelope(msg.envelope);
    } catch (err) {
      this.pendingToolCalls.delete(requestId);
      throw err;
    }

    return resultPromise;
  }

  /** Handle incoming messages — resolve pending RPC tool calls */
  private handleMessage(data: unknown, envelope: MessageEnvelope): void {
    // Handle gossip from batch channel
    if (envelope.t === MessageType.CHANNEL) {
      const payload = data as Record<string, unknown> | null;
      if (
        payload?.type === 'gossip' &&
        payload?.forAgentId === this.agentId &&
        typeof payload?.summary === 'string' && payload.summary.length > 0 // Fix: type-guard gossip payload
      ) {
        if (this.gossipQueue.length < WorkerAgent.MAX_GOSSIP_QUEUE) {
          this.gossipQueue.push(payload.summary);
        }
      }
      return;
    }

    // Existing RPC_RESPONSE handling (unchanged)
    if (envelope.t === MessageType.RPC_RESPONSE && envelope.rid_req) {
      const pending = this.pendingToolCalls.get(envelope.rid_req);
      if (pending) {
        this.pendingToolCalls.delete(envelope.rid_req);
        // `data` is the msgpack-decoded payload object emitted by GossipAgent.
        // Prefer it over raw `envelope.body` to avoid double-decoding issues.
        const payload = data as Record<string, unknown> | null;
        if (payload && typeof payload === 'object') {
          if (payload.error) {
            pending.reject(new Error(payload.error as string));
          } else {
            pending.resolve((payload.result as string) || '');
          }
        } else {
          // Fallback: decode body bytes as text (legacy path)
          const body = new TextDecoder().decode(envelope.body);
          try {
            const parsed = JSON.parse(body);
            if (parsed.error) {
              pending.reject(new Error(parsed.error));
            } else {
              pending.resolve(parsed.result || '');
            }
          } catch {
            pending.resolve(body);
          }
        }
      }
    }
  }
}
