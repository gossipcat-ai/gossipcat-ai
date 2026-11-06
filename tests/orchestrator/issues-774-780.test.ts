import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { isReasoningModel, OpenAIProvider, createProvider } from '@gossip/orchestrator';

/** Local OpenAI-compatible server answering after delayMs with status/body. */
async function serve(status: number, body: object, delayMs = 0, seen?: object[]) {
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      seen?.push(JSON.parse(data || '{}'));
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      }, delayMs);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() };
}

const ok = { choices: [{ message: { content: 'hi' } }] };

describe('gossipcat issues 774-780', () => {
  const realFetch = globalThis.fetch;
  beforeAll(() => { globalThis.fetch = realFetch; });

  it('#774 sees reasoning models behind a gateway and omits temperature', async () => {
    expect(isReasoningModel('openai/gpt-5.5')).toBe(true);
    expect(isReasoningModel('openai/gpt-4o')).toBe(false);
    const seen: Array<Record<string, unknown>> = [];
    const s = await serve(200, ok, 0, seen);
    await new OpenAIProvider('k', 'openai/gpt-5.5', undefined, s.url).generate([{ role: 'user', content: 'x' }], { temperature: 0 });
    s.close();
    expect(seen[0]).not.toHaveProperty('temperature');
  });

  it('#775 gives a custom base_url the long timeout', () => {
    const local = createProvider('openai', 'm', 'k', undefined, 'http://127.0.0.1:1/v1') as unknown as { timeoutMs: number };
    const cloud = createProvider('openai', 'm', 'k') as unknown as { timeoutMs: number };
    expect(local.timeoutMs).toBe(600_000);
    expect(cloud.timeoutMs).toBe(120_000);
  });

  it('#777 names the fix for a context-size rejection', async () => {
    const s = await serve(400, { error: { type: 'exceed_context_size_error', n_ctx: 8192 } });
    await expect(new OpenAIProvider('k', 'm', undefined, s.url).generate([{ role: 'user', content: 'x' }]))
      .rejects.toThrow(/CONTEXT_WINDOW_EXCEEDED.*--ctx-size/);
    s.close();
  });
});
