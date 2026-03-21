# CLI Image Support — Design Spec

> Gossipcat CLI chat accepts images from clipboard via `/image` command, sending multimodal messages to the main agent's LLM.

**Date:** 2026-03-21
**Status:** Draft
**Scope:** CLI-only. The MCP path (Claude Code) already handles images natively — no changes needed there.

---

## Problem Statement

Gossipcat's CLI chat is text-only. Users can't share screenshots, UI mockups, or diagrams with their agent team. Claude Code users can paste images directly, but standalone `gossipcat` CLI users have no image input method.

## User Flow

1. User copies an image to system clipboard (screenshot, Cmd+C on a file, etc.)
2. Types `/image` in the gossipcat interactive chat
3. CLI reads clipboard, detects image format, shows confirmation:
   ```
   Image detected: PNG 1920x1080 (245 KB)
   Type your message (or press Enter to send image only):
   ```
4. User types a message or presses Enter for image-only
5. Image + text (or image alone) sent as a multimodal message to the main agent's LLM
6. Main agent responds — can describe, analyze, or dispatch text-based sub-tasks to workers

### Error Cases

**No image in clipboard:**
```
No image found in clipboard. Copy an image first, then run /image.
```

**Unsupported format:**
```
Unsupported image format. Supported: PNG, JPEG, GIF, WebP.
```

**Model doesn't support vision (local text-only models):**
```
Your orchestrator model (qwen2.5-coder) doesn't support images.
Switch to a vision-capable model in gossip.agents.json, or use a cloud provider.
```

### Scope Boundaries

- **Main agent only** sees the image. Workers receive text descriptions if the main agent decides to dispatch sub-tasks.
- **20 MB size cap** — reject images larger than 20 MB with a clear error before base64 encoding. This prevents OOM from a pasted 200 MB screenshot being held in memory as a 270 MB base64 string.
- **No image transport through the relay** — images stay in the CLI process.
- **No MCP changes** — Claude Code handles images natively and passes text descriptions to gossipcat MCP tools.

## Component 1: Clipboard Reader

**File:** `apps/cli/src/clipboard.ts`

Reads image data from the system clipboard using platform-specific commands.

### Platform Commands

| Platform | Command | Notes |
|----------|---------|-------|
| macOS | `osascript -e 'the clipboard as «class PNGf»'` or `pngpaste -` | `pngpaste` is cleaner; fall back to osascript |
| Linux | Try MIME types in order: `xclip -selection clipboard -t image/png -o`, then `image/jpeg`, then `image/gif`, then `image/webp`. Use first successful read. | Requires xclip installed |
| Windows | `powershell -command "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) }"` | Saves clipboard image to memory stream, outputs base64 PNG |

### Interface

```typescript
export interface ClipboardImage {
  data: Buffer;        // raw image bytes
  format: ImageFormat; // detected from magic bytes
  size: number;        // bytes
}

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

/**
 * Read image from system clipboard.
 * Returns null if clipboard has no image.
 * Throws on unsupported format.
 */
export async function readClipboardImage(): Promise<ClipboardImage | null>;

/**
 * Detect image format from magic bytes.
 * Returns null if not a recognized image format.
 */
export function detectImageFormat(data: Buffer): ImageFormat | null;
```

### Magic Bytes Detection

| Format | Magic Bytes |
|--------|-------------|
| PNG | `89 50 4E 47` |
| JPEG | `FF D8 FF` |
| GIF | `47 49 46 38` |
| WebP | `52 49 46 46` at offset 0 + `57 45 42 50` at offset 8 |

### Platform Detection

Use `process.platform`:
- `'darwin'` → macOS clipboard commands
- `'linux'` → xclip
- `'win32'` → PowerShell

If the clipboard tool is not installed (e.g., xclip on Linux), return a clear error:
```
xclip is not installed. Install it with: sudo apt install xclip
```

## Component 2: Image Handler

**File:** `apps/cli/src/image-handler.ts`

Validates the image, extracts metadata, and prepares it for the LLM API.

### Interface

```typescript
export interface ProcessedImage {
  base64: string;           // base64-encoded image data
  mediaType: string;        // "image/png", "image/jpeg", etc.
  format: ImageFormat;      // "png", "jpeg", "gif", "webp"
  sizeBytes: number;        // original file size
  dimensions?: {            // optional — extracted if possible
    width: number;
    height: number;
  };
}

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB

/**
 * Process a clipboard image for LLM consumption.
 * Validates format and size, base64-encodes, extracts dimensions.
 * Throws if image exceeds MAX_IMAGE_SIZE (checked BEFORE base64 encoding
 * to avoid allocating a ~33% larger buffer for an image we'll reject).
 */
export function processImage(image: ClipboardImage): ProcessedImage;
```

### Dimension Extraction

For PNG and GIF, dimensions are in the header — parse without external dependencies:
- **PNG:** width at bytes 16-19, height at bytes 20-23 (IHDR chunk)
- **GIF:** width at bytes 6-7, height at bytes 8-9 (little-endian)
- **JPEG:** requires scanning for SOF0 marker — more complex, skip dimensions for JPEG
- **WebP:** skip dimensions

Dimensions are optional metadata for the user-facing confirmation message. Not required for LLM calls.

### Media Type Mapping

```typescript
const MEDIA_TYPES: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
```

## Component 3: LLM Message Types — Multimodal Extension

**File:** `packages/types/src/tools.ts` (edit — this is where `LLMMessage` is defined, at line 27)

Extend `LLMMessage.content` to support multimodal content blocks while remaining backward compatible.

### Type Changes

```typescript
export interface ImageContent {
  type: 'image';
  data: string;       // base64-encoded
  mediaType: string;  // "image/png", "image/jpeg", etc.
}

export interface TextContent {
  type: 'text';
  text: string;
}

export type ContentBlock = TextContent | ImageContent;

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];  // string for backward compat, array for multimodal
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCall[];
}
```

### Multimodal Content Constraints

**Only `role: 'user'` messages may have `content: ContentBlock[]`.** All other roles (`system`, `assistant`, `tool`) must use `content: string`. This constraint is enforced at the call site (chat.ts creates the multimodal message), not in the type system, to keep the type simple. Providers must assert `typeof content === 'string'` before passing content to API fields that only accept strings (e.g., Anthropic's `body.system`).

**Backward compatibility:** All existing code passes `content: string`, which continues to work. Only the `/image` command creates `content: ContentBlock[]` messages. Every `typeof msg.content === 'string'` check in existing provider code will correctly take the string path for all existing messages.

## Component 4: LLM Client — Provider-Specific Image Formatting

**File:** `packages/orchestrator/src/llm-client.ts` (edit)

Each provider's `generate()` method must translate the common multimodal format to the API-specific format.

### Anthropic (Claude)

```typescript
// Input: content: [{ type: 'image', data: '...', mediaType: 'image/png' }, { type: 'text', text: '...' }]
// Output:
{
  role: 'user',
  content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
    { type: 'text', text: '...' }
  ]
}
```

### OpenAI (GPT)

```typescript
// Output:
{
  role: 'user',
  content: [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
    { type: 'text', text: '...' }
  ]
}
```

### Google (Gemini)

```typescript
// Output (Gemini uses 'parts' instead of 'content'):
{
  role: 'user',
  parts: [
    { inlineData: { mimeType: 'image/png', data: '...' } },
    { text: '...' }
  ]
}
```

### Ollama (Local)

```typescript
// Output (Ollama uses separate 'images' array):
{
  role: 'user',
  content: '...',
  images: ['<base64>']
}
```

**Vision check for Ollama:** Ollama does not have a standardized error code for unsupported vision. Wrap the API call in a try/catch. If the error message contains keywords like "image", "vision", "multimodal", or "not supported", surface a clear message: `"Model '${model}' doesn't support images. Use a vision model like llava or llama3.2-vision."` For other errors, rethrow as-is. This is a catch-all heuristic — not fragile string matching.

### Translation Logic

Each provider already has a message-formatting function (e.g., `toAnthropicMessage`, `toOpenAIMessage`). Update each to check `typeof msg.content`:

```typescript
// Example: Anthropic's toAnthropicMessage (currently at llm-client.ts:79)
function toAnthropicMessage(m: LLMMessage): any {
  if (typeof m.content !== 'string') {
    // Multimodal — translate ContentBlock[] to Anthropic format
    return {
      role: m.role,
      content: m.content.map(block =>
        block.type === 'image'
          ? { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } }
          : { type: 'text', text: block.text }
      ),
    };
  }
  // Existing string path — unchanged
  return { role: m.role, content: m.content };
}
```

The same pattern applies to each provider's existing formatting function. The `typeof` check is the branch point — string content takes the existing path, array content takes the new multimodal path.

**System message safety:** Providers that extract system messages into a separate field must add a defensive `typeof` check:
- **Anthropic** (line 38): `body.system = typeof systemMsg.content === 'string' ? systemMsg.content : ''`
- **Gemini** (line 185): `body.systemInstruction = { parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : '' }] }`

Since only `role: 'user'` messages carry multimodal content (see Component 3 constraints), `systemMsg.content` is always a string in practice — but the defensive check prevents breakage if this invariant is ever violated.

**CRITICAL: All provider message mappers must `typeof`-check content for ALL messages (multi-agent review finding).**

The `typeof m.content !== 'string'` check must be the FIRST branch in every provider's message mapper — not just for user messages. Reason: `handleMessage` in `main-agent.ts` has a planning branch (lines 105-113) that passes `userMessage` (which may be `ContentBlock[]`) to `this.llm.generate()` in an intermediate LLM call. If the Gemini provider's mapper doesn't check `typeof`, it will produce `{ text: [object Object] }` and silently corrupt the message.

**The rule:** Every message mapper (`toAnthropicMessage`, `toOpenAIMessage`, Gemini's inline map, Ollama's mapper) must:
1. Check `typeof m.content !== 'string'` first
2. If array: translate `ContentBlock[]` to provider-specific multimodal format
3. If string: take existing path unchanged

This applies to ALL message roles, not just `role: 'user'`. While only user messages should carry `ContentBlock[]` in practice, the `typeof` guard makes every provider resilient to accidental array content in any role.

**Tool message branches specifically:** The `role === 'tool'` branches in `toAnthropicMessage` (line 68) and `toOpenAIMessage` (line 140) pass `m.content` raw. Add `typeof m.content === 'string' ? m.content : JSON.stringify(m.content)` as a safety fallback. Same for the Ollama mapper at line 216.

## Component 5: Chat Integration

**File:** `apps/cli/src/chat.ts` (edit)

Intercept the `/image` command in the existing readline-based REPL loop (line 145: `rl.on('line', ...)`).

### Architecture Note (Issue #5 fix)

The chat loop uses Node's `readline` interface, NOT `@clack/prompts`. We cannot use `p.text()` inside a readline handler — they conflict over stdin. Instead, use `rl.question()` for the follow-up message prompt, which is compatible with the existing readline session.

### Flow

Inside the existing `rl.on('line', async (line) => { ... })` handler, add before the `mainAgent.handleMessage(input)` call:

```typescript
if (input === '/image') {
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

  // Use rl.question (compatible with readline) instead of p.text (clack)
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
  return; // Don't fall through to normal message handling
}
```

## Component 6: MainAgent — Accept Multimodal Messages (Issue #1, #6 fix)

**File:** `packages/orchestrator/src/main-agent.ts` (edit)

### Signature Change

`handleMessage` currently accepts `string`. Change to accept `string | ContentBlock[]`:

```typescript
async handleMessage(userMessage: string | ContentBlock[]): Promise<ChatResponse> {
```

### Internal Plumbing

The image does NOT flow through the TaskDispatcher. The dispatcher only needs text to decompose tasks. The image is only used at the LLM call level.

```typescript
async handleMessage(userMessage: string | ContentBlock[]): Promise<ChatResponse> {
  // Extract text for task decomposition (dispatcher needs text only)
  const textForDispatch = typeof userMessage === 'string'
    ? userMessage
    : userMessage.filter(b => b.type === 'text').map(b => (b as TextContent).text).join(' ') || 'Describe this image.';

  const plan = await this.dispatcher.decompose(textForDispatch);
  this.dispatcher.assignAgents(plan);

  // Handle unassigned tasks directly with main LLM
  const unassigned = plan.subTasks.filter(st => !st.assignedAgent);
  if (unassigned.length === plan.subTasks.length) {
    const response = await this.llm.generate([
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },  // pass full multimodal content to LLM
    ]);
    return this.parseResponse(response.text);
  }

  // For dispatched tasks, workers get text descriptions only
  // (main agent sees the image, describes it, workers get the description)
  // ... rest unchanged, uses textForDispatch for worker task descriptions
}
```

The key insight: `userMessage` (which may contain the image) goes directly to the main LLM. The `textForDispatch` (text-only extraction) goes to the dispatcher for task decomposition. Workers never see the raw image.

## Known Limitations (from multi-agent review)

- **OpenAI `detail` parameter:** OpenAI's image_url content block accepts `detail: 'low' | 'high' | 'auto'` which affects token cost. We default to `auto` (omit the parameter). Users can override via future config if needed.
- **Gemini tool message bug (pre-existing):** The Gemini provider maps `role: 'tool'` to `role: 'user'` which is incorrect for the Gemini API. This is a pre-existing bug outside the scope of this spec, but the `typeof content` guard added for multimodal support will prevent it from getting worse.

## Conversation History (Issue #8 fix)

Image messages in chat history accumulate large base64 strings in memory. After the main agent responds to an image message, replace the image content blocks in the history with a text placeholder:

```typescript
// After getting the LLM response, replace the image in history:
// Before: [{ type: 'image', data: '<large base64>', mediaType: '...' }, { type: 'text', text: '...' }]
// After:  [{ type: 'text', text: '[Image: PNG 1920x1080]' }, { type: 'text', text: '...' }]
```

This way subsequent messages reference the image by description, not by carrying the full base64 data. The image is seen once by the LLM and then summarized.

## GIF Handling (Issue #10 fix)

Animated GIFs are accepted and passed through as-is to the LLM API. Most vision APIs (Anthropic, OpenAI, Gemini) process only the first frame of animated GIFs — this is acceptable behavior. No frame extraction is needed on our side.

## Files Changed/Created

| File | Action | Component |
|------|--------|-----------|
| `apps/cli/src/clipboard.ts` | Create | Platform-specific clipboard reading |
| `apps/cli/src/image-handler.ts` | Create | Format detection, validation, base64, dimensions |
| `apps/cli/src/chat.ts` | Edit | `/image` command in readline REPL |
| `packages/types/src/tools.ts` | Edit | Add ImageContent, TextContent, ContentBlock types |
| `packages/orchestrator/src/llm-client.ts` | Edit | Multimodal formatting per provider (toAnthropicMessage, etc.) |
| `packages/orchestrator/src/main-agent.ts` | Edit | Accept `string \| ContentBlock[]` in handleMessage, extract text for dispatcher |
| `tests/cli/clipboard.test.ts` | Create | Clipboard reading tests (mock execFile per platform) |
| `tests/cli/image-handler.test.ts` | Create | Image processing tests (magic bytes, base64, dimensions) |
| `tests/orchestrator/llm-client.test.ts` | Edit | Multimodal message translation tests per provider |

## Security Constraints

- **No image data passes through the relay** — stays in CLI process, sent directly to LLM API
- **No image storage** — image is held in memory only for the duration of the API call
- **No external clipboard tools executed with untrusted input** — clipboard commands are hardcoded, not user-parameterized
- **Base64 encoding only** — no image manipulation libraries that could have vulnerabilities

## Testing Strategy

- **Clipboard reader:** Mock `execFile` calls per platform, verify format detection from magic bytes
- **Image handler:** Feed known PNG/JPEG/GIF/WebP buffers, verify base64 output, dimensions, media type
- **LLM client:** Verify multimodal message translation for each provider (Anthropic, OpenAI, Google, Ollama formats)
- **Chat integration:** Mock clipboard + LLM, verify `/image` command flow end-to-end
- **Error cases:** No image in clipboard, unsupported format, non-vision model, oversized image (>20MB), corrupted image (valid magic bytes but truncated data)
- **Provider typeof guards:** Verify that ContentBlock[] in non-user messages (tool, assistant) is handled safely by every provider — should never produce `[object Object]` in output
- **Linux clipboard:** Test MIME type fallback chain (PNG → JPEG → GIF → WebP)
- **Conversation history:** Verify image placeholder replaces base64 after response
