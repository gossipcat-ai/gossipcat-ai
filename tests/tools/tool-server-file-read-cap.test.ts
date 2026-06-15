import { jest } from '@jest/globals';
const vi = jest;
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolServer } from '../../packages/tools/src/tool-server';

// MAX_FILE_READ_CHARS is 256 * 1024 = 262144. Mirror the constant here so
// the tests are self-documenting without importing internals.
const MAX_FILE_READ_CHARS = 256 * 1024;

// Mock GossipAgent to avoid actual relay connection
vi.mock('@gossip/client', () => ({
  GossipAgent: class {
    agentId = 'tool-server';
    async connect() {}
    async disconnect() {}
    on() {}
    async sendEnvelope() {}
  },
}));

describe('ToolServer file_read cap (MESSAGE_TOO_BIG guard)', () => {
  let server: ToolServer;
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-file-read-cap-'));
    server = new ToolServer({
      relayUrl: 'ws://localhost:0',
      projectRoot,
    });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('truncates a file larger than MAX_FILE_READ_CHARS and appends notice', async () => {
    // Write a file that is clearly over the cap once line-annotated.
    // fileRead prepends line numbers ("N\t") which adds overhead.
    // Use enough lines to ensure annotated output > MAX_FILE_READ_CHARS.
    // Each line: "a".repeat(79) + "\n" = 80 raw chars.
    // After annotation: "N\t" + "a".repeat(79) = 82-87 chars per line.
    // 3500 such lines = ~285 KB annotated → safely above the 256 KB cap.
    const lineCount = 3500;
    const lineContent = 'a'.repeat(79);
    const bigContent = (lineContent + '\n').repeat(lineCount);
    const bigPath = path.join(projectRoot, 'big.txt');
    fs.writeFileSync(bigPath, bigContent);

    const result = await server.executeTool('file_read', { path: 'big.txt' }, undefined);

    expect(typeof result).toBe('string');
    const resultStr = result as string;

    // Total length must not exceed cap + notice length (notice is ~150 chars max)
    expect(resultStr.length).toBeLessThanOrEqual(MAX_FILE_READ_CHARS + 200);

    // Must end with the truncation notice
    expect(resultStr).toContain('[file_read truncated:');
    // Notice must report original (annotated) length as a number
    expect(resultStr).toMatch(/file is \d+ chars/);
    expect(resultStr).toContain(`cap ${MAX_FILE_READ_CHARS}`);
    expect(resultStr).toContain('startLine/endLine');
  });

  it('returns small file content unchanged (no notice appended)', async () => {
    const smallContent = 'const x = 1;\nconst y = 2;\n';
    fs.writeFileSync(path.join(projectRoot, 'small.ts'), smallContent);

    const result = await server.executeTool('file_read', { path: 'small.ts' }, undefined);

    expect(typeof result).toBe('string');
    const resultStr = result as string;
    // fileRead annotates with line numbers — just check no notice and content present
    expect(resultStr).toContain('const x = 1;');
    expect(resultStr).toContain('const y = 2;');
    expect(resultStr).not.toContain('[file_read truncated:');
    // Small file well under cap
    expect(resultStr.length).toBeLessThan(MAX_FILE_READ_CHARS);
  });

  it('ranged read (startLine/endLine) of a large file returns small slice without truncation notice', async () => {
    // Write a large file with numbered lines so we can pin the range.
    // 10 000 lines × ~50 chars = ~500 KB raw — but we only read 5 lines.
    const lines: string[] = [];
    for (let i = 1; i <= 10000; i++) {
      lines.push(`line ${i}: ${'x'.repeat(40)}`);
    }
    const largeContent = lines.join('\n') + '\n';
    fs.writeFileSync(path.join(projectRoot, 'lines.txt'), largeContent);

    // Read only lines 1–5 — the annotated slice is tiny regardless of file size
    const result = await server.executeTool(
      'file_read',
      { path: 'lines.txt', startLine: 1, endLine: 5 },
      undefined,
    );

    expect(typeof result).toBe('string');
    const resultStr = result as string;
    expect(resultStr).toContain('line 1:');
    expect(resultStr).toContain('line 5:');
    // The slice is well under the cap — no notice should appear
    expect(resultStr).not.toContain('[file_read truncated:');
  });
});
