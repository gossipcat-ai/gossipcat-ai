/**
 * task-images — resolve local image files into multimodal message content for
 * relay (custom-provider) dispatches.
 *
 * Background: a relay dispatch delivers its task to the worker's LLM as a single
 * `{ role: 'user', content: <task string> }` message. Even when the task text
 * cites local PNG/JPEG paths, the model receives TEXT ONLY — no pixels. This
 * module turns explicit `images: string[]` (or paths auto-detected in the task
 * text) into base64 `ImageContent` blocks that the provider clients already know
 * how to render onto each API's wire format:
 *   - OpenAI (chat/completions): content array `{ type: 'image_url', image_url: { url: 'data:...' } }`
 *   - Gemini:                    parts `{ inlineData: { mimeType, data } }`
 *   - Anthropic:                 content `{ type: 'image', source: { type: 'base64', ... } }`
 *   - Ollama:                    message `images: [base64]`
 * (see llm-client.ts toOpenAIMessage / toGeminiMessage / toAnthropicMessage).
 *
 * Guardrails: at most {@link MAX_IMAGES} images, each at most
 * {@link MAX_IMAGE_BYTES}, PNG/JPEG only (extension + magic-byte sniff),
 * non-existent / unreadable paths surface a per-image error instead of being
 * silently dropped. Text-only providers ignore the field with a logged notice.
 */

import { readFileSync, statSync } from 'fs';
import { isAbsolute } from 'path';
import { ContentBlock, ImageContent } from '@gossip/types';
import { log as _log } from './log';

/** Maximum number of images attached to a single dispatch. */
export const MAX_IMAGES = 4;

/** Maximum size of a single image (~4 MB). Larger files are rejected. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Absolute-path image detector for auto-attach. Matches a non-whitespace run
 * ending in .png/.jpg/.jpeg (word boundary). Global so `String.match` returns
 * every hit; callers still filter to absolute paths and apply the MAX_IMAGES
 * cap. Mirrors the regex spelled out in the images feature spec.
 */
export const IMAGE_PATH_RE = /\S+\.(?:png|jpe?g)\b/g;

/** File-extension gate applied to explicit `images` entries. */
const IMAGE_EXT_RE = /\.(?:png|jpe?g)$/i;

/**
 * Providers whose API + models accept inline base64 images. Text-only providers
 * (deepseek-chat, openclaw, none) get the field ignored with a logged notice
 * rather than a request the provider would reject. The anthropic-native path
 * does NOT go through this relay module at all.
 */
const VISION_CAPABLE_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'grok', 'local']);

/** Whether a provider can accept inline images. Unknown / undefined → false. */
export function providerSupportsVision(provider?: string): boolean {
  return provider ? VISION_CAPABLE_PROVIDERS.has(provider) : false;
}

/**
 * Sniff PNG/JPEG from magic bytes — the only two formats we attach. Returns the
 * media type, or null when the content is neither (so a .png that is actually a
 * renamed PDF is rejected).
 */
function sniffImageMediaType(buf: Buffer): 'image/png' | 'image/jpeg' | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

export interface ResolvedTaskImages {
  /** Successfully-read images, ready to drop into a multimodal message. */
  blocks: ImageContent[];
  /** Per-image rejection reasons (surfaced in the task result, not silently dropped). */
  errors: string[];
  /** Informational notices (e.g. provider not vision-capable). */
  notices: string[];
  /** True when the candidate paths came from scanning the task text (no explicit field). */
  autoDetected: boolean;
}

/**
 * Extract absolute PNG/JPEG paths from free-form task text, de-duplicated and in
 * first-seen order. Relative paths are ignored (a relay worker's cwd is not the
 * orchestrator's, so only absolute paths are portable).
 */
export function detectImagePathsInText(task: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const matches = task.match(IMAGE_PATH_RE) ?? [];
  for (const raw of matches) {
    // Trim bracket/quote punctuation that commonly abuts a path in prose — the
    // \S+ match greedily swallows a leading "(" and trailing ")." etc.
    const m = raw.replace(/^[([{<'"]+/, '').replace(/[)\]}>.,;:'"]+$/, '');
    if (!isAbsolute(m)) continue;
    if (!IMAGE_EXT_RE.test(m)) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    found.push(m);
  }
  return found;
}

/**
 * Resolve the images for a dispatch: explicit `images` field takes precedence;
 * otherwise up to {@link MAX_IMAGES} absolute paths are auto-detected from the
 * task text. Applies all guardrails and returns base64 image blocks plus any
 * per-image errors / notices.
 */
export function resolveTaskImages(opts: {
  task: string;
  images?: string[];
  provider?: string;
  logLabel?: string;
}): ResolvedTaskImages {
  const { task, images, provider } = opts;
  const label = opts.logLabel ?? 'task-images';
  const result: ResolvedTaskImages = { blocks: [], errors: [], notices: [], autoDetected: false };

  // 1. Candidate paths — explicit field wins; else auto-detect from task text.
  let candidates: string[];
  if (images && images.length > 0) {
    candidates = images;
  } else {
    candidates = detectImagePathsInText(task);
    result.autoDetected = candidates.length > 0;
  }
  if (candidates.length === 0) return result;

  // 2. Vision gate — text-only providers ignore the field with a logged notice.
  if (!providerSupportsVision(provider)) {
    const notice = `provider "${provider ?? 'unknown'}" is not vision-capable — ignoring ${candidates.length} image attachment(s)`;
    result.notices.push(notice);
    _log(label, notice);
    return result;
  }

  // 3. Enforce the count cap — reject the overflow loudly, don't silently truncate.
  let list = candidates;
  if (list.length > MAX_IMAGES) {
    result.errors.push(`too many images: ${list.length} supplied, max ${MAX_IMAGES} — dropping the last ${list.length - MAX_IMAGES}`);
    list = list.slice(0, MAX_IMAGES);
  }

  // 4. Read + validate each candidate.
  for (const p of list) {
    if (!isAbsolute(p)) { result.errors.push(`${p}: not an absolute path`); continue; }
    if (!IMAGE_EXT_RE.test(p)) { result.errors.push(`${p}: unsupported extension (png/jpeg only)`); continue; }
    let size: number;
    try {
      const st = statSync(p);
      if (!st.isFile()) { result.errors.push(`${p}: not a regular file`); continue; }
      size = st.size;
    } catch {
      result.errors.push(`${p}: file not found`);
      continue;
    }
    if (size > MAX_IMAGE_BYTES) {
      result.errors.push(`${p}: too large (${(size / 1024 / 1024).toFixed(1)} MB, max ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`);
      continue;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(p);
    } catch (e) {
      result.errors.push(`${p}: read failed (${(e as Error).message})`);
      continue;
    }
    const media = sniffImageMediaType(buf);
    if (!media) { result.errors.push(`${p}: content is not valid PNG or JPEG`); continue; }
    result.blocks.push({ type: 'image', data: buf.toString('base64'), mediaType: media });
  }

  for (const e of result.errors) _log(label, `attachment error — ${e}`);
  return result;
}

/**
 * Build the `content` for the initial user message from the task text and the
 * resolved images. Returns a plain string when no image blocks resolved
 * (byte-identical to the pre-feature behavior), otherwise a multimodal
 * ContentBlock[] with the task text first. Per-image errors are appended to the
 * text so a rejected attachment is visible in the agent's context / result
 * rather than silently dropped.
 */
export function buildUserContent(task: string, resolved: ResolvedTaskImages): string | ContentBlock[] {
  const errNote = resolved.errors.length > 0
    ? `\n\n[image attachment errors]\n- ${resolved.errors.join('\n- ')}`
    : '';
  if (resolved.blocks.length === 0) {
    return errNote ? task + errNote : task;
  }
  return [{ type: 'text', text: task + errNote }, ...resolved.blocks];
}
