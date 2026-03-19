/**
 * WorkerAgent — executes a sub-task using its LLM and requests tools via relay.
 *
 * Multi-turn tool loop with max 10 turns to prevent infinite loops.
 * Tool calls are sent as RPC_REQUEST to tool-server via relay.
 */

import { randomUUID } from 'crypto';
import { GossipAgent } from '@gossip/client';
import { MessageType, MessageEnvelope, Message, ToolDefinition, LLMMessage } from '@gossip/types';
import { ILLMProvider } from './llm-client';

const MAX_TOOL_TURNS = 10;
const TOOL_CALL_TIMEOUT_MS = 30_000;

export class WorkerAgent {
  private agent: GossipAgent;
  private pendingToolCalls: Map<string, {
    resolve: (result: string) => void;
    reject: (err: Error) => void;
  }> = new Map();

  constructor(
    private agentId: string,
    private llm: ILLMProvider,
    relayUrl: string,
    private tools: ToolDefinition[]
  ) {
    this.agent = new GossipAgent({ agentId, relayUrl, reconnect: true });
  }

  async start(): Promise<void> {
    await this.agent.connect();
    this.agent.on('message', this.handleMessage.bind(this));
  }

  async stop(): Promise<void> {
    await this.agent.disconnect();
  }

  /**
   * Execute a task with the LLM, using multi-turn tool calling.
   * Returns the final text response.
   */
  async executeTask(task: string, context?: string): Promise<string> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are a skilled developer agent. Complete the assigned task using the available tools. Be concise and focused.${context ? `\n\nContext:\n${context}` : ''}`,
      },
      { role: 'user', content: task },
    ];

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const response = await this.llm.generate(messages, { tools: this.tools });

      if (!response.toolCalls?.length) {
        return response.text;
      }

      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.text || '',
        toolCalls: response.toolCalls,
      });

      // Execute each tool call via relay RPC
      for (const toolCall of response.toolCalls) {
        const result = await this.callTool(toolCall.name, toolCall.arguments);
        messages.push({
          role: 'tool',
          content: result,
          toolCallId: toolCall.id,
          name: toolCall.name,
        });
      }
    }

    return 'Max tool turns reached';
  }

  /** Send RPC_REQUEST to tool-server via relay */
  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const requestId = randomUUID();

    const resultPromise = new Promise<string>((resolve, reject) => {
      this.pendingToolCalls.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (this.pendingToolCalls.has(requestId)) {
          this.pendingToolCalls.delete(requestId);
          reject(new Error(`Tool call ${name} timed out`));
        }
      }, TOOL_CALL_TIMEOUT_MS);
    });

    const msg = Message.createRpcRequest(
      this.agentId,
      'tool-server',
      requestId,
      new TextEncoder().encode(JSON.stringify({ tool: name, args }))
    );
    await this.agent.sendEnvelope(msg.envelope);

    return resultPromise;
  }

  /** Handle incoming messages — resolve pending RPC tool calls */
  private handleMessage(_data: unknown, envelope: MessageEnvelope): void {
    if (envelope.t === MessageType.RPC_RESPONSE && envelope.rid_req) {
      const pending = this.pendingToolCalls.get(envelope.rid_req);
      if (pending) {
        this.pendingToolCalls.delete(envelope.rid_req);
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
