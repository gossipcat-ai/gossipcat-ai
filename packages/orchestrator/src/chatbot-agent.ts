/**
 * ChatbotAgent — read-only "ask the dashboard anything" engine (MVP-0, P1).
 *
 * Self-contained turn loop over an injected ILLMProvider with a CURATED
 * read-only tool allowlist. The allowlist is a hard security gate: a tool name
 * returned by the model that is not in `cfg.tools` is rejected BEFORE any
 * execution (fail-closed) — see §3.2 of the MVP-0 spec.
 *
 * Non-progressive (§3.5b): `ILLMProvider.generate` is non-streaming, so the
 * final answer is emitted once as a `token` event then `done`. Tool events
 * still stream live. The generator NEVER throws — the whole body is wrapped in
 * try/catch and surfaces failures as an `error` event.
 */

import type { ILLMProvider, LLMGenerateOptions } from './llm-client';
import type { LLMMessage, ToolDefinition } from '@gossip/types';

/** A single read-only tool exposed to the chatbot. `run` wraps a read-only data fn. */
export interface ChatbotTool {
  name: string;
  description: string;
  inputSchema: ToolDefinition['parameters'];
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface ChatbotAgentConfig {
  llm: ILLMProvider;
  /** THE allowlist — the only tools the loop can ever invoke. */
  tools: ChatbotTool[];
  systemPrompt: string;
  /**
   * DoS guard — max total tool EXECUTIONS across the whole turn before forcing
   * a final text turn. Counts individual tool runs, NOT generate() rounds: a
   * single provider response with N tool calls consumes N of this budget.
   * Default 6.
   */
  maxToolCallsPerTurn?: number;
}

export type ChatStreamEvent =
  | { type: 'tool_use'; name: string; args: unknown }
  | { type: 'tool_result'; name: string; result: unknown }
  | { type: 'token'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

const DEFAULT_MAX_TOOL_CALLS = 6;

export class ChatbotAgent {
  constructor(private cfg: ChatbotAgentConfig) {}

  async *turnStream(message: string, history: LLMMessage[]): AsyncGenerator<ChatStreamEvent> {
    try {
      const maxCalls = this.cfg.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS;

      // Build the allowlist map + tool schemas once. Only these schemas are
      // ever handed to the provider, and only these names can be executed.
      const toolMap = new Map<string, ChatbotTool>();
      for (const t of this.cfg.tools) toolMap.set(t.name, t);
      const toolDefs: ToolDefinition[] = this.cfg.tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }));
      const options: LLMGenerateOptions = { tools: toolDefs };

      const messages: LLMMessage[] = [
        { role: 'system', content: this.cfg.systemPrompt },
        ...history,
        { role: 'user', content: message },
      ];

      // Total tool EXECUTIONS across the whole turn (DoS guard), NOT the number
      // of generate() rounds — one response with N tool calls consumes N.
      let executions = 0;

      // Bound the generate() rounds too, so a model that streams one tool call
      // per round can't outlast the execution cap by alternating forever.
      while (executions < maxCalls) {
        const resp = await this.cfg.llm.generate(messages, options);

        if (resp.toolCalls?.length) {
          // f7: a single provider response must serialize to EXACTLY ONE
          // assistant turn carrying ALL its tool calls, followed by the
          // matching tool-result turns. Building N separate assistant messages
          // (one per call) produces an invalid Anthropic request and breaks
          // OpenAI alternation. So we accumulate, then push once after the
          // inner loop.
          const assistantToolCalls: NonNullable<LLMMessage['toolCalls']> = [];
          const toolResults: LLMMessage[] = [];

          for (const call of resp.toolCalls) {
            // Every requested call — allowed or not — must produce a
            // tool_result tied to call.id, or the next provider request is an
            // invalid dangling tool_use (and the model never gets feedback).
            assistantToolCalls.push({ id: call.id, name: call.name, arguments: call.arguments });

            const tool = toolMap.get(call.name);
            // Allowlist gate (fail-closed): unknown name → error event +
            // error tool-result, tool is NEVER executed.
            if (!tool) {
              yield { type: 'error', message: `tool not allowed: ${call.name}` };
              toolResults.push({
                role: 'tool',
                content: `error: tool not allowed: ${call.name}`,
                toolCallId: call.id,
                name: call.name,
              });
              executions += 1;
              continue;
            }

            yield { type: 'tool_use', name: call.name, args: call.arguments };
            const result = await tool.run(call.arguments);
            yield { type: 'tool_result', name: call.name, result };
            toolResults.push({
              role: 'tool',
              content: typeof result === 'string' ? result : JSON.stringify(result),
              toolCallId: call.id,
              name: call.name,
            });
            executions += 1;
          }

          // ONE assistant turn with all N tool calls, then the tool-result
          // turns (one per call.id) — valid for both Anthropic and OpenAI.
          messages.push({
            role: 'assistant',
            content: resp.text ?? '',
            toolCalls: assistantToolCalls,
          });
          for (const tr of toolResults) messages.push(tr);

          continue;
        }

        // No tool calls — final answer (non-progressive: one token chunk, then done).
        if (resp.text) yield { type: 'token', text: resp.text };
        yield { type: 'done', text: resp.text };
        return;
      }

      // Execution budget exhausted without a final text turn — surface the
      // limit message as a token so streaming consumers render it, then done.
      const limitMessage = '(tool-call limit reached)';
      yield { type: 'token', text: limitMessage };
      yield { type: 'done', text: limitMessage };
    } catch (err) {
      yield { type: 'error', message: String(err) };
      return;
    }
  }
}
