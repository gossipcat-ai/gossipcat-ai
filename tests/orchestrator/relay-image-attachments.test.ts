import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { OpenAIProvider, GeminiProvider, AnthropicProvider } from '../../packages/orchestrator/src/llm-client';
import { LLMMessage } from '../../packages/types/src/tools';

/**
 * Verifies that when a multimodal message (text + base64 image block) is passed
 * to a provider client, the outgoing HTTP request carries the image as a proper,
 * provider-specific content part:
 *   - OpenAI chat/completions → content[] with { type:'image_url', image_url:{ url:'data:...' } }
 *   - Gemini generateContent  → parts[] with { inlineData: { mimeType, data } }
 *   - Anthropic messages       → content[] with { type:'image', source:{ type:'base64', ... } }
 *
 * This is the seam that carries `resolveTaskImages` output (ImageContent blocks)
 * onto the wire — the piece that was previously never exercised because the
 * relay only ever sent a plain-string task.
 */

const B64 = Buffer.from('fake-png-bytes').toString('base64');

const imageMessage: LLMMessage = {
  role: 'user',
  content: [
    { type: 'text', text: 'Describe this screenshot.' },
    { type: 'image', data: B64, mediaType: 'image/png' },
  ],
};

function captureBody(responseJson: unknown): { getBody: () => any } {
  let captured: any;
  global.fetch = vi.fn(async (_url: any, init?: RequestInit) => {
    captured = JSON.parse(init!.body as string);
    return new Response(JSON.stringify(responseJson), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return { getBody: () => captured };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('relay image attachments — provider wire-format construction', () => {
  it('OpenAI: image block → { type:"image_url", image_url:{ url:"data:image/png;base64,..." } }', async () => {
    const cap = captureBody({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const p = new OpenAIProvider('sk-test', 'gpt-5.2');
    await p.generate([imageMessage]);
    const body = cap.getBody();
    const parts = body.messages[0].content;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]).toEqual({ type: 'text', text: 'Describe this screenshot.' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } });
  });

  it('Gemini: image block → parts[] { inlineData: { mimeType, data } }', async () => {
    const cap = captureBody({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    const p = new GeminiProvider('ai-test', 'gemini-3.1-pro');
    await p.generate([imageMessage]);
    const body = cap.getBody();
    const parts = body.contents[0].parts;
    expect(parts[0]).toEqual({ text: 'Describe this screenshot.' });
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: B64 } });
  });

  it('Anthropic: image block → content[] { type:"image", source:{ type:"base64", media_type, data } }', async () => {
    const cap = captureBody({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const p = new AnthropicProvider('sk-ant-test', 'claude-opus-4-6');
    await p.generate([imageMessage]);
    const body = cap.getBody();
    const parts = body.messages[0].content;
    expect(parts[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } });
  });

  it('plain-string message is unchanged on the wire (no multimodal regression)', async () => {
    const cap = captureBody({ choices: [{ message: { content: 'ok' } }] });
    const p = new OpenAIProvider('sk-test', 'gpt-5.2');
    await p.generate([{ role: 'user', content: 'just text' }]);
    expect(cap.getBody().messages[0].content).toBe('just text');
  });
});
