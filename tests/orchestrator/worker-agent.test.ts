import { ILLMProvider } from '@gossip/orchestrator';
import { LLMMessage, ToolDefinition } from '@gossip/types';

/**
 * Test the WorkerAgent's multi-turn tool loop logic.
 * We test the core loop behavior with a mock LLM, without connecting to a real relay.
 */

// Simulate the worker's executeTask loop logic in isolation
async function simulateToolLoop(
  llm: ILLMProvider,
  tools: ToolDefinition[],
  task: string,
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  maxTurns = 10
): Promise<string> {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'You are a developer agent.' },
    { role: 'user', content: task },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await llm.generate(messages, { tools });

    if (!response.toolCalls?.length) {
      return response.text;
    }

    messages.push({
      role: 'assistant',
      content: response.text || '',
      toolCalls: response.toolCalls,
    });

    for (const toolCall of response.toolCalls) {
      const result = await callTool(toolCall.name, toolCall.arguments);
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

describe('WorkerAgent tool loop', () => {
  const tools: ToolDefinition[] = [
    { name: 'read_file', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } } } },
  ];

  it('returns final text when no tool calls', async () => {
    const llm: ILLMProvider = {
      async generate() { return { text: 'Done!' }; },
    };

    const result = await simulateToolLoop(llm, tools, 'hello', async () => '');
    expect(result).toBe('Done!');
  });

  it('executes tool calls and returns final response', async () => {
    let callCount = 0;
    const llm: ILLMProvider = {
      async generate(_messages: LLMMessage[]) {
        callCount++;
        if (callCount === 1) {
          return {
            text: 'Reading file...',
            toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: '/tmp/test.ts' } }],
          };
        }
        return { text: 'File contains: hello world' };
      },
    };

    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool = async (name: string, args: Record<string, unknown>) => {
      toolCalls.push({ name, args });
      return 'hello world';
    };

    const result = await simulateToolLoop(llm, tools, 'read /tmp/test.ts', callTool);
    expect(result).toBe('File contains: hello world');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({ name: 'read_file', args: { path: '/tmp/test.ts' } });
  });

  it('handles multi-turn tool use', async () => {
    let callCount = 0;
    const llm: ILLMProvider = {
      async generate() {
        callCount++;
        if (callCount <= 3) {
          return {
            text: `Turn ${callCount}`,
            toolCalls: [{ id: `call_${callCount}`, name: 'read_file', arguments: { path: `/file${callCount}` } }],
          };
        }
        return { text: 'All done after 3 tool calls' };
      },
    };

    let toolCallCount = 0;
    const callTool = async () => { toolCallCount++; return `result ${toolCallCount}`; };

    const result = await simulateToolLoop(llm, tools, 'process files', callTool);
    expect(result).toBe('All done after 3 tool calls');
    expect(toolCallCount).toBe(3);
  });

  it('stops at max tool turns', async () => {
    const llm: ILLMProvider = {
      async generate() {
        return {
          text: 'more work',
          toolCalls: [{ id: 'call', name: 'read_file', arguments: { path: '/loop' } }],
        };
      },
    };

    const result = await simulateToolLoop(llm, tools, 'infinite loop', async () => 'result', 3);
    expect(result).toBe('Max tool turns reached');
  });

  it('handles multiple tool calls in single turn', async () => {
    let callCount = 0;
    const llm: ILLMProvider = {
      async generate() {
        callCount++;
        if (callCount === 1) {
          return {
            text: 'Reading both files...',
            toolCalls: [
              { id: 'call_1', name: 'read_file', arguments: { path: '/file1' } },
              { id: 'call_2', name: 'read_file', arguments: { path: '/file2' } },
            ],
          };
        }
        return { text: 'Got both files' };
      },
    };

    const paths: string[] = [];
    const callTool = async (_name: string, args: Record<string, unknown>) => {
      paths.push(args.path as string);
      return `content of ${args.path}`;
    };

    const result = await simulateToolLoop(llm, tools, 'read two files', callTool);
    expect(result).toBe('Got both files');
    expect(paths).toEqual(['/file1', '/file2']);
  });
});
