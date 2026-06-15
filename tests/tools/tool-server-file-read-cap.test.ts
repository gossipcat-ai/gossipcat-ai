import { jest } from '@jest/globals';
const vi = jest;
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolServer } from '../../packages/tools/src/tool-server';

// MAX_FILE_READ_BYTES is 512 * 1024 = 524288. Mirror the constant here so
// the tests are self-documenting without importing internals. The cap is
// BYTE-based (the WS maxPayload limit is in bytes), so a multi-byte file can
// exceed it with far fewer chars.
const MAX_FILE_READ_BYTES = 512 * 1024;

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

  it('truncates a file larger than MAX_FILE_READ_BYTES and appends notice', async () => {
    // Write a file that is clearly over the byte cap once line-annotated.
    // fileRead prepends line numbers ("N\t") which adds overhead.
    // Each line: "a".repeat(79) + "\n" = 80 raw bytes (ASCII).
    // After annotation: "N\t" + "a".repeat(79) = 82-87 bytes per line.
    // 7000 such lines = ~580 KB annotated → above the 512 KB cap.
    const lineCount = 7000;
    const lineContent = 'a'.repeat(79);
    const bigContent = (lineContent + '\n').repeat(lineCount);
    const bigPath = path.join(projectRoot, 'big.txt');
    fs.writeFileSync(bigPath, bigContent);

    const result = await server.executeTool('file_read', { path: 'big.txt' }, undefined);

    expect(typeof result).toBe('string');
    const resultStr = result as string;

    // Total UTF-8 bytes must not exceed cap + the small notice (~100 bytes).
    expect(Buffer.byteLength(resultStr, 'utf8')).toBeLessThanOrEqual(MAX_FILE_READ_BYTES + 300);
    // The truncated BODY (before the notice) must be bounded to the cap itself.
    const body = resultStr.split('\n\n[file_read truncated:')[0];
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_FILE_READ_BYTES);

    // Must end with the byte-reporting truncation notice
    expect(resultStr).toContain('[file_read truncated:');
    expect(resultStr).toMatch(/\d+ bytes \(cap/);
    expect(resultStr).toContain(`cap ${MAX_FILE_READ_BYTES}`);
    expect(resultStr).toContain('startLine/endLine');
  });

  it('truncates a multi-byte file that exceeds the BYTE cap with fewer chars (emoji)', async () => {
    // Each 😀 is 4 UTF-8 bytes. 100 per line + "\n" = ~401 bytes/line; line-number
    // annotation adds a few more. 1500 lines ≈ 610 KB bytes but only ~150K chars —
    // the OLD char cap (256K chars) would have MISSED this; the byte cap catches it.
    const emojiLine = '😀'.repeat(100) + '\n';
    const content = Array.from({ length: 1500 }, () => emojiLine).join('');
    fs.writeFileSync(path.join(projectRoot, 'emoji.txt'), content);

    const result = await server.executeTool('file_read', { path: 'emoji.txt' }, undefined);
    const resultStr = result as string;

    expect(resultStr).toContain('[file_read truncated:');
    expect(resultStr).toMatch(/\d+ bytes \(cap/);
    expect(resultStr).toContain(`cap ${MAX_FILE_READ_BYTES}`);
    // Byte-bounded, no split multi-byte char (no U+FFFD) in the body before the notice.
    expect(Buffer.byteLength(resultStr, 'utf8')).toBeLessThanOrEqual(MAX_FILE_READ_BYTES + 300);
    const body = resultStr.split('\n\n[file_read truncated:')[0];
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_FILE_READ_BYTES);
    expect(body).not.toMatch(/�/);
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
    expect(Buffer.byteLength(resultStr, 'utf8')).toBeLessThan(MAX_FILE_READ_BYTES);
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
