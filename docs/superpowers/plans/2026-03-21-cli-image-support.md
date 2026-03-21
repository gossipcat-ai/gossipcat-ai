# CLI Image Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/image` command to gossipcat CLI chat that reads images from the system clipboard and sends multimodal messages to the main agent's LLM.

**Architecture:** Clipboard reader (platform-specific) → image handler (format detection, validation, base64) → multimodal LLM message type → provider-specific formatting → MainAgent integration → chat REPL command. No relay/MCP/worker changes.

**Tech Stack:** TypeScript, Node `child_process.execFile`, Buffer API for magic bytes, Jest for testing.

**Spec:** `docs/superpowers/specs/2026-03-21-cli-image-support-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/types/src/tools.ts` | **EDIT** — Add `ImageContent`, `TextContent`, `ContentBlock` types; change `LLMMessage.content` to `string \| ContentBlock[]` |
| `apps/cli/src/clipboard.ts` | **NEW** — Platform-specific clipboard image reading (macOS/Linux/Windows) |
| `apps/cli/src/image-handler.ts` | **NEW** — Format detection (magic bytes), size validation, base64 encoding, dimension extraction |
| `packages/orchestrator/src/llm-client.ts` | **EDIT** — Add multimodal branch to all 4 provider message mappers + system message `typeof` guards |
| `packages/orchestrator/src/main-agent.ts` | **EDIT** — `handleMessage` accepts `string \| ContentBlock[]`, extracts text for dispatcher |
| `apps/cli/src/chat.ts` | **EDIT** — `/image` command in readline REPL |
| `tests/cli/image-handler.test.ts` | **NEW** — Image processing tests |
| `tests/cli/clipboard.test.ts` | **NEW** — Clipboard reading tests (mocked) |
| `tests/orchestrator/llm-client.test.ts` | **EDIT** — Multimodal message translation tests per provider |

---

### Task 1: Multimodal Types — Extend LLMMessage

**Files:**
- Modify: `packages/types/src/tools.ts:26-33`
- Test: `tests/types/tools.test.ts` (if exists, otherwise verify via compilation)

- [ ] **Step 1: Read the current types file**

Read `packages/types/src/tools.ts` to see the current `LLMMessage` definition.

- [ ] **Step 2: Add multimodal types before LLMMessage**

Insert before the `LLMMessage` interface (line 26):

```typescript
/** Image content block for multimodal messages */
export interface ImageContent {
  type: 'image';
  data: string;       // base64-encoded
  mediaType: string;  // "image/png", "image/jpeg", etc.
}

/** Text content block for multimodal messages */
export interface TextContent {
  type: 'text';
  text: string;
}

/** A content block — either text or image */
export type ContentBlock = TextContent | ImageContent;
```

- [ ] **Step 3: Update LLMMessage.content type**

Change `content: string;` to `content: string | ContentBlock[];` in the `LLMMessage` interface:

```typescript
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];  // string for backward compat, array for multimodal
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCall[];
}
```

- [ ] **Step 4: Export new types from package index**

In `packages/types/src/index.ts`, verify the exports cover the new types (they should via `export * from './tools'`).

- [ ] **Step 5: Run full test suite to verify backward compat**

Run: `npx jest --no-coverage`
Expected: All 166 tests pass — the union type `string | ContentBlock[]` is backward compatible.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/tools.ts
git commit -m "feat(types): add multimodal ContentBlock types to LLMMessage"
```

---

### Task 2: Image Handler — Format Detection + Base64

**Files:**
- Create: `apps/cli/src/image-handler.ts`
- Create: `tests/cli/image-handler.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/cli/image-handler.test.ts
import { processImage, detectImageFormat } from '../../../apps/cli/src/image-handler';
import type { ClipboardImage } from '../../../apps/cli/src/clipboard';

// Minimal valid PNG header (8 bytes magic + IHDR with 100x50)
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG magic
  0x00, 0x00, 0x00, 0x0D, // IHDR chunk length
  0x49, 0x48, 0x44, 0x52, // "IHDR"
  0x00, 0x00, 0x00, 0x64, // width: 100
  0x00, 0x00, 0x00, 0x32, // height: 50
  0x08, 0x06, 0x00, 0x00, 0x00, // bit depth, color type, etc.
]);

// Minimal JPEG header
const JPEG_HEADER = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);

// Minimal GIF header with dimensions 10x20
const GIF_HEADER = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
  0x0A, 0x00, // width: 10 (little-endian)
  0x14, 0x00, // height: 20 (little-endian)
]);

// Minimal WebP header
const WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x00, 0x00, 0x00, 0x00, // file size (placeholder)
  0x57, 0x45, 0x42, 0x50, // "WEBP"
]);

describe('detectImageFormat', () => {
  it('detects PNG', () => {
    expect(detectImageFormat(PNG_HEADER)).toBe('png');
  });

  it('detects JPEG', () => {
    expect(detectImageFormat(JPEG_HEADER)).toBe('jpeg');
  });

  it('detects GIF', () => {
    expect(detectImageFormat(GIF_HEADER)).toBe('gif');
  });

  it('detects WebP', () => {
    expect(detectImageFormat(WEBP_HEADER)).toBe('webp');
  });

  it('returns null for unknown format', () => {
    expect(detectImageFormat(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
  });

  it('returns null for empty buffer', () => {
    expect(detectImageFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe('processImage', () => {
  it('processes PNG with dimensions', () => {
    const image: ClipboardImage = { data: PNG_HEADER, format: 'png', size: PNG_HEADER.length };
    const result = processImage(image);

    expect(result.format).toBe('png');
    expect(result.mediaType).toBe('image/png');
    expect(result.base64).toBe(PNG_HEADER.toString('base64'));
    expect(result.sizeBytes).toBe(PNG_HEADER.length);
    expect(result.dimensions).toEqual({ width: 100, height: 50 });
  });

  it('processes GIF with dimensions', () => {
    const image: ClipboardImage = { data: GIF_HEADER, format: 'gif', size: GIF_HEADER.length };
    const result = processImage(image);

    expect(result.dimensions).toEqual({ width: 10, height: 20 });
  });

  it('processes JPEG without dimensions', () => {
    const image: ClipboardImage = { data: JPEG_HEADER, format: 'jpeg', size: JPEG_HEADER.length };
    const result = processImage(image);

    expect(result.format).toBe('jpeg');
    expect(result.mediaType).toBe('image/jpeg');
    expect(result.dimensions).toBeUndefined();
  });

  it('throws on oversized image', () => {
    const bigBuffer = Buffer.alloc(21 * 1024 * 1024); // 21 MB
    PNG_HEADER.copy(bigBuffer); // valid PNG header
    const image: ClipboardImage = { data: bigBuffer, format: 'png', size: bigBuffer.length };

    expect(() => processImage(image)).toThrow(/exceeds.*20 MB/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/cli/image-handler.test.ts --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Implement image-handler.ts**

```typescript
// apps/cli/src/image-handler.ts
import type { ClipboardImage, ImageFormat } from './clipboard';

export interface ProcessedImage {
  base64: string;
  mediaType: string;
  format: ImageFormat;
  sizeBytes: number;
  dimensions?: { width: number; height: number };
}

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB

const MEDIA_TYPES: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Detect image format from magic bytes. Returns null if unrecognized. */
export function detectImageFormat(data: Buffer): ImageFormat | null {
  if (data.length < 4) return null;
  // PNG: 89 50 4E 47
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return 'png';
  // JPEG: FF D8 FF
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return 'jpeg';
  // GIF: 47 49 46 38
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'gif';
  // WebP: RIFF....WEBP
  if (data.length >= 12 &&
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'webp';
  return null;
}

/** Extract dimensions from image header. Returns undefined if not extractable. */
function extractDimensions(data: Buffer, format: ImageFormat): { width: number; height: number } | undefined {
  if (format === 'png' && data.length >= 24) {
    return {
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  }
  if (format === 'gif' && data.length >= 10) {
    return {
      width: data.readUInt16LE(6),
      height: data.readUInt16LE(8),
    };
  }
  return undefined;
}

/** Process a clipboard image for LLM consumption. Throws if oversized. */
export function processImage(image: ClipboardImage): ProcessedImage {
  if (image.size > MAX_IMAGE_SIZE) {
    throw new Error(`Image exceeds 20 MB limit (${Math.round(image.size / 1024 / 1024)} MB). Resize before pasting.`);
  }

  return {
    base64: image.data.toString('base64'),
    mediaType: MEDIA_TYPES[image.format],
    format: image.format,
    sizeBytes: image.size,
    dimensions: extractDimensions(image.data, image.format),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/cli/image-handler.test.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/image-handler.ts tests/cli/image-handler.test.ts
git commit -m "feat(cli): add image handler with format detection, validation, base64"
```

---

### Task 3: Clipboard Reader — Platform-Specific

**Files:**
- Create: `apps/cli/src/clipboard.ts`
- Create: `tests/cli/clipboard.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/cli/clipboard.test.ts
import { detectImageFormat } from '../../../apps/cli/src/image-handler';

// We test the clipboard module by mocking execFile.
// The actual platform commands can't be tested in CI.

describe('detectImageFormat (integration)', () => {
  it('returns null for plain text buffer', () => {
    const textBuf = Buffer.from('Hello, world!', 'utf-8');
    expect(detectImageFormat(textBuf)).toBeNull();
  });

  it('returns null for buffer too short', () => {
    expect(detectImageFormat(Buffer.from([0x89]))).toBeNull();
  });
});

// Platform-specific clipboard tests would require mocking child_process.execFile.
// These are covered by the image-handler tests for format detection.
// The clipboard module itself is a thin wrapper around execFile.
describe('ClipboardImage type', () => {
  it('has expected shape', async () => {
    // Type-level check — just verify the module exports
    const mod = await import('../../../apps/cli/src/clipboard');
    expect(typeof mod.readClipboardImage).toBe('function');
  });
});
```

- [ ] **Step 2: Implement clipboard.ts**

```typescript
// apps/cli/src/clipboard.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import { detectImageFormat } from './image-handler';

const execFileAsync = promisify(execFile);

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export interface ClipboardImage {
  data: Buffer;
  format: ImageFormat;
  size: number;
}

/** Read image from system clipboard. Returns null if no image. */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const platform = process.platform;

  try {
    if (platform === 'darwin') return await readMacOS();
    if (platform === 'linux') return await readLinux();
    if (platform === 'win32') return await readWindows();
    throw new Error(`Unsupported platform: ${platform}`);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found') || msg.includes('ENOENT')) {
      if (platform === 'linux') throw new Error('xclip is not installed. Install it with: sudo apt install xclip');
      if (platform === 'darwin') throw new Error('pngpaste is not installed. Install it with: brew install pngpaste');
    }
    // No image in clipboard — not an error
    return null;
  }
}

async function readMacOS(): Promise<ClipboardImage | null> {
  try {
    // Try pngpaste first (outputs raw PNG to stdout)
    const { stdout } = await execFileAsync('pngpaste', ['-'], { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 });
    if (!stdout || stdout.length === 0) return null;
    const format = detectImageFormat(stdout as unknown as Buffer);
    if (!format) return null;
    return { data: stdout as unknown as Buffer, format, size: stdout.length };
  } catch {
    // pngpaste not installed or no image — return null
    return null;
  }
}

async function readLinux(): Promise<ClipboardImage | null> {
  const mimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  for (const mime of mimeTypes) {
    try {
      const { stdout } = await execFileAsync('xclip', ['-selection', 'clipboard', '-t', mime, '-o'], { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 });
      if (stdout && stdout.length > 0) {
        const format = detectImageFormat(stdout as unknown as Buffer);
        if (format) return { data: stdout as unknown as Buffer, format, size: stdout.length };
      }
    } catch {
      continue; // Try next MIME type
    }
  }
  return null;
}

async function readWindows(): Promise<ClipboardImage | null> {
  const script = `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) }`;
  const { stdout } = await execFileAsync('powershell', ['-command', script], { maxBuffer: 50 * 1024 * 1024 });
  if (!stdout || stdout.trim().length === 0) return null;
  const data = Buffer.from(stdout.trim(), 'base64');
  const format = detectImageFormat(data);
  if (!format) return null;
  return { data, format, size: data.length };
}
```

- [ ] **Step 3: Run tests**

Run: `npx jest tests/cli/clipboard.test.ts --no-coverage`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/clipboard.ts tests/cli/clipboard.test.ts
git commit -m "feat(cli): add clipboard reader with macOS/Linux/Windows support"
```

---

### Task 4: LLM Client — Multimodal Provider Formatting

**Files:**
- Modify: `packages/orchestrator/src/llm-client.ts:38,64-79,138-151,179-182,216`
- Modify: `tests/orchestrator/llm-client.test.ts`

- [ ] **Step 1: Write failing tests for multimodal message translation**

Append to `tests/orchestrator/llm-client.test.ts`:

```typescript
describe('Multimodal message formatting', () => {
  const multimodalMessage = {
    role: 'user' as const,
    content: [
      { type: 'image' as const, data: 'base64data', mediaType: 'image/png' },
      { type: 'text' as const, text: 'What is this?' },
    ],
  };

  // We test via the generate() method with mocked fetch.
  // Each provider should format the multimodal content correctly.

  it('AnthropicProvider formats multimodal content', async () => {
    let sentBody: any = null;
    global.fetch = jest.fn().mockImplementation(async (_url: string, opts: any) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'response' }], usage: { input_tokens: 1, output_tokens: 1 } }) };
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider('test-key', 'claude-3');
    await provider.generate([
      { role: 'system', content: 'You are helpful.' },
      multimodalMessage,
    ]);

    // System message should be a string
    expect(typeof sentBody.system).toBe('string');
    // User message should have Anthropic image format
    const userMsg = sentBody.messages[0];
    expect(userMsg.content[0].type).toBe('image');
    expect(userMsg.content[0].source.type).toBe('base64');
    expect(userMsg.content[0].source.data).toBe('base64data');
    expect(userMsg.content[1].type).toBe('text');
  });

  it('OpenAIProvider formats multimodal content', async () => {
    let sentBody: any = null;
    global.fetch = jest.fn().mockImplementation(async (_url: string, opts: any) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'response' } }] }) };
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('test-key', 'gpt-4o');
    await provider.generate([multimodalMessage]);

    const userMsg = sentBody.messages[0];
    expect(userMsg.content[0].type).toBe('image_url');
    expect(userMsg.content[0].image_url.url).toContain('data:image/png;base64,base64data');
    expect(userMsg.content[1].type).toBe('text');
  });

  it('GeminiProvider formats multimodal content', async () => {
    let sentBody: any = null;
    global.fetch = jest.fn().mockImplementation(async (_url: string, opts: any) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'response' }] } }] }) };
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider('test-key', 'gemini-pro');
    await provider.generate([multimodalMessage]);

    const userContent = sentBody.contents[0];
    expect(userContent.parts[0].inlineData.mimeType).toBe('image/png');
    expect(userContent.parts[0].inlineData.data).toBe('base64data');
    expect(userContent.parts[1].text).toBe('What is this?');
  });

  it('OllamaProvider formats multimodal content', async () => {
    let sentBody: any = null;
    global.fetch = jest.fn().mockImplementation(async (_url: string, opts: any) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ message: { content: 'response' } }) };
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider('llava');
    await provider.generate([multimodalMessage]);

    const userMsg = sentBody.messages[0];
    expect(userMsg.content).toBe('What is this?');
    expect(userMsg.images).toEqual(['base64data']);
  });

  it('providers handle string content unchanged', async () => {
    let sentBody: any = null;
    global.fetch = jest.fn().mockImplementation(async (_url: string, opts: any) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'r' }], usage: { input_tokens: 1, output_tokens: 1 } }) };
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider('test-key', 'claude-3');
    await provider.generate([
      { role: 'user', content: 'plain text' },
    ]);

    expect(sentBody.messages[0].content).toBe('plain text');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/llm-client.test.ts --no-coverage`
Expected: FAIL — multimodal content passed as raw array

- [ ] **Step 3: Update AnthropicProvider**

In `packages/orchestrator/src/llm-client.ts`:

1. Line 38 — add defensive typeof check:
```typescript
if (systemMsg) body.system = typeof systemMsg.content === 'string' ? systemMsg.content : '';
```

2. Update `toAnthropicMessage` (line 64-80):
```typescript
private toAnthropicMessage(m: LLMMessage): Record<string, unknown> {
  // Multimodal content — translate ContentBlock[] to Anthropic format
  if (typeof m.content !== 'string') {
    return {
      role: m.role,
      content: m.content.map(block =>
        block.type === 'image'
          ? { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } }
          : { type: 'text', text: block.text }
      ),
    };
  }
  // Existing paths — with typeof safety fallback for tool content
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const content: unknown[] = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    for (const tc of m.toolCalls) {
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
    }
    return { role: 'assistant', content };
  }
  return { role: m.role, content: m.content };
}
```

- [ ] **Step 4: Update OpenAIProvider**

Update `toOpenAIMessage` (line 138-151):
```typescript
private toOpenAIMessage(m: LLMMessage): Record<string, unknown> {
  if (typeof m.content !== 'string') {
    return {
      role: m.role,
      content: m.content.map(block =>
        block.type === 'image'
          ? { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } }
          : { type: 'text', text: block.text }
      ),
    };
  }
  if (m.role === 'tool') {
    return { role: 'tool', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content), tool_call_id: m.toolCallId };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant', content: m.content || null,
      tool_calls: m.toolCalls.map(tc => ({
        id: tc.id, type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}
```

- [ ] **Step 5: Update GeminiProvider**

Replace the inline map at line 179-182:
```typescript
const contents = messages.filter(m => m.role !== 'system').map(m => {
  const role = m.role === 'assistant' ? 'model' : 'user';
  if (typeof m.content !== 'string') {
    return {
      role,
      parts: m.content.map(block =>
        block.type === 'image'
          ? { inlineData: { mimeType: block.mediaType, data: block.data } }
          : { text: block.text }
      ),
    };
  }
  return { role, parts: [{ text: m.content }] };
});
```

Add system message defensive check at line 185:
```typescript
if (systemMsg) body.systemInstruction = { parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : '' }] };
```

- [ ] **Step 6: Update OllamaProvider**

Replace the inline map at line 216:
```typescript
messages: messages.map(m => {
  if (typeof m.content !== 'string') {
    const texts = m.content.filter(b => b.type === 'text').map(b => (b as any).text);
    const images = m.content.filter(b => b.type === 'image').map(b => (b as any).data);
    return {
      role: m.role === 'tool' ? 'user' : m.role,
      content: texts.join(' ') || '',
      ...(images.length ? { images } : {}),
    };
  }
  return { role: m.role === 'tool' ? 'user' : m.role, content: m.content };
}),
```

- [ ] **Step 7: Run tests**

Run: `npx jest tests/orchestrator/llm-client.test.ts --no-coverage`
Expected: All tests PASS (existing + new multimodal tests)

- [ ] **Step 8: Run full test suite**

Run: `npx jest --no-coverage`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add packages/orchestrator/src/llm-client.ts tests/orchestrator/llm-client.test.ts
git commit -m "feat(orchestrator): multimodal image support in all 4 LLM providers"
```

---

### Task 5: MainAgent — Accept Multimodal Messages

**Files:**
- Modify: `packages/orchestrator/src/main-agent.ts:82-127`
- Modify: `tests/orchestrator/main-agent.test.ts`

- [ ] **Step 1: Read current handleMessage implementation**

Read `packages/orchestrator/src/main-agent.ts` lines 82-127 to see the full method.

- [ ] **Step 2: Update handleMessage signature and add text extraction**

Change the method signature and add text extraction at the top:

```typescript
async handleMessage(userMessage: string | ContentBlock[]): Promise<ChatResponse> {
  // Extract text for task decomposition (dispatcher needs text only)
  const textForDispatch = typeof userMessage === 'string'
    ? userMessage
    : userMessage.filter(b => b.type === 'text').map(b => (b as TextContent).text).join(' ') || 'Describe this image.';

  const plan = await this.dispatcher.decompose(textForDispatch);
  // ... rest uses textForDispatch for dispatch, userMessage for direct LLM calls
```

- [ ] **Step 3: Update all LLM generate calls to use userMessage for content**

In the "unassigned" branch (line 89-93), pass `userMessage` (may be `ContentBlock[]`) as `content`:
```typescript
{ role: 'user', content: userMessage },
```

In the "planning" branch (line 100-104), also pass `userMessage`.

**CRITICAL (from multi-agent review):** In `synthesize()` call (around line 121), pass `textForDispatch` NOT `userMessage`:
```typescript
// Before: const text = await this.synthesize(userMessage, results);
// After:
const text = await this.synthesize(textForDispatch, results);
```
`synthesize()` uses template literal interpolation (`Original task: ${originalTask}`). If `userMessage` is `ContentBlock[]`, this produces `"Original task: [object Object]"`. `textForDispatch` is always a string.

- [ ] **Step 4: Add import for ContentBlock types**

```typescript
import { ContentBlock, TextContent } from '@gossip/types';
```

- [ ] **Step 5: Run tests**

Run: `npx jest tests/orchestrator/main-agent.test.ts --no-coverage`
Expected: All existing tests pass (they pass `string`, which is still valid)

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/main-agent.ts
git commit -m "feat(orchestrator): MainAgent.handleMessage accepts multimodal ContentBlock[]"
```

---

### Task 6: Chat Integration — /image Command

**Files:**
- Modify: `apps/cli/src/chat.ts:1-8,145-170`

- [ ] **Step 1: Add imports at the top of chat.ts**

```typescript
import { ContentBlock } from '@gossip/types';
```

- [ ] **Step 2: Add /image handler inside the readline 'line' event**

Inside `rl.on('line', async (line) => { ... })`, after the exit check (line 151) and before the `mainAgent.handleMessage(input)` call (line 159), add:

```typescript
if (input === '/image') {
  try {
    const { readClipboardImage } = await import('./clipboard');
    const { processImage } = await import('./image-handler');

    const image = await readClipboardImage();
    if (!image) {
      console.log(`\n${c.yellow}  No image found in clipboard. Copy an image first, then run /image.${c.reset}\n`);
      rl.prompt();
      return;
    }

    const processed = processImage(image);
    const dimStr = processed.dimensions
      ? ` ${processed.dimensions.width}x${processed.dimensions.height}`
      : '';
    console.log(`\n${c.green}  Image detected: ${processed.format.toUpperCase()}${dimStr} (${Math.round(processed.sizeBytes / 1024)} KB)${c.reset}`);

    rl.question(`${c.dim}  Message (Enter for image only): ${c.reset}`, async (message) => {
      const content: ContentBlock[] = [
        { type: 'image', data: processed.base64, mediaType: processed.mediaType },
      ];
      const text = message?.trim() || 'Describe this image.';
      content.push({ type: 'text', text });

      process.stdout.write(`${c.dim}  thinking...${c.reset}`);
      try {
        const response = await mainAgent.handleMessage(content);
        process.stdout.write('\r\x1b[K');
        await renderResponse(response, text, mainAgent);
      } catch (err) {
        process.stdout.write('\r\x1b[K');
        console.log(`\n${c.yellow}  Error: ${(err as Error).message}${c.reset}\n`);
      }
      rl.prompt();
    });
  } catch (err) {
    console.log(`\n${c.yellow}  Error: ${(err as Error).message}${c.reset}\n`);
    rl.prompt();
  }
  return;
}
```

- [ ] **Step 3: Run full test suite**

Run: `npx jest --no-coverage`
Expected: All tests pass

- [ ] **Step 4: Build MCP to verify no compile errors**

Run: `npm run build:mcp`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/chat.ts
git commit -m "feat(cli): add /image command for clipboard image input"
```

---

### Task 7: Final Integration Test + Cleanup

**Files:**
- All files from tasks 1-6

- [ ] **Step 1: Run full test suite**

Run: `npx jest --no-coverage`
Expected: All tests pass

- [ ] **Step 2: Build MCP server**

Run: `npm run build:mcp`
Expected: Build succeeds

- [ ] **Step 3: Verify TypeScript compilation**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 4: Final commit if any loose changes**

```bash
git status
```

---

## Execution Order

Tasks 1 must go first (types are used by everything). Tasks 2-3 are independent. Task 4 depends on Task 1. Task 5 depends on Tasks 1+4. Task 6 depends on Tasks 1-5. Task 7 runs last.

```
Task 1 (Types) ──→ Task 2 (Image Handler) ──┐
                   Task 3 (Clipboard) ───────┤
                   Task 4 (LLM Client) ──────┼──→ Task 5 (MainAgent) ──→ Task 6 (Chat) ──→ Task 7 (Integration)
```
