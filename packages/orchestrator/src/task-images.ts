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
 *
 * ── Trust model (path policy) ────────────────────────────────────────────────
 * Image paths are UNTRUSTED input: they arrive from the dispatch caller (the
 * `images` field) or from free-form task prose (auto-detect). Two defenses apply:
 *
 *  1. Allowed-root confinement, fail-CLOSED. When a `projectRoot` is supplied,
 *     every candidate is confined to that root (`canonical === realRoot ||
 *     canonical.startsWith(realRoot + sep)`). A path that escapes — via `..`, an
 *     absolute path elsewhere, or a symlink pointing outside — is rejected with a
 *     per-image "path policy" error and is never read. If `projectRoot` is supplied
 *     but does not itself resolve, the policy is unenforceable, so EVERY candidate
 *     is rejected (fail closed) rather than silently read. This mirrors the repo's
 *     citation-root precedent (validate-resolution-root.ts): realpath BOTH sides,
 *     then a `startsWith(root + sep)` prefix test. When `projectRoot` is omitted the
 *     confinement check is skipped (legacy callers / unit fixtures); production
 *     dispatch always threads it through from `WorkerAgent.executeTask`.
 *
 *  2. Capped, TOCTOU-resistant reads — open FIRST, then validate the descriptor.
 *     A candidate is opened ONCE (`openSync(p, O_RDONLY|O_NONBLOCK)`), which pins
 *     the target inode; the confinement check then runs against the OPEN fd's real
 *     path (`/proc/self/fd/<fd>` on Linux, or a realpath+inode-equality fallback
 *     elsewhere), so a symlink swap between resolve and open (the realpath→open
 *     TOCTOU) cannot escape the root. Size, regular-file check, and the byte read
 *     all use that same fd, so a stat→read swap cannot smuggle a different or
 *     larger file. Reads are hard-capped at {@link MAX_IMAGE_BYTES} (+1 sentinel
 *     byte) so an under-reporting `fstat` can never cause an unbounded slurp.
 *
 * Log hygiene: `_log` lines hash candidate paths via {@link hashPath} so the MCP
 * stderr log never records absolute filesystem paths. Full paths DO remain in the
 * `errors[]` strings (surfaced in the operator-facing task context by design).
 */

import { openSync, fstatSync, readSync, closeSync, realpathSync, statSync, constants as fsConstants } from 'fs';
import { isAbsolute, normalize, sep } from 'path';
import { ContentBlock, ImageContent } from '@gossip/types';
import { log as _log } from './log';
import { hashPath } from './validate-resolution-root';

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

/** True when `child` is `root` itself or lives beneath it (realpath'd, prefix test). */
function isWithinRoot(child: string, root: string): boolean {
  return child === root || child.startsWith(root + sep);
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
    // \S+ match greedily swallows a leading "(" etc.
    //
    // NOTE: only a LEADING-punctuation trim is needed. IMAGE_PATH_RE ends in
    // `\b` immediately after the png/jpg/jpeg run, and those are all word chars,
    // so a raw match ALWAYS ends on the extension — trailing punctuation (")",
    // ".", ",", …) is outside the match by construction. A trailing-trim would
    // be dead code; do not add one back.
    const m = raw.replace(/^[([{<'"]+/, '');
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
 *
 * `projectRoot` — when supplied, confines every image to that realpath'd root
 * (see the module trust-model docstring). Omit only for legacy callers / fixtures.
 */
export function resolveTaskImages(opts: {
  task: string;
  images?: string[];
  provider?: string;
  projectRoot?: string;
  logLabel?: string;
}): ResolvedTaskImages {
  const { task, images, provider, projectRoot } = opts;
  const label = opts.logLabel ?? 'task-images';
  const result: ResolvedTaskImages = { blocks: [], errors: [], notices: [], autoDetected: false };

  // Push a per-image error AND emit a path-HASHED log line. Full paths stay in
  // result.errors (operator-facing task context) but never reach _log.
  const addError = (userMsg: string, logMsg?: string): void => {
    result.errors.push(userMsg);
    _log(label, `attachment error — ${logMsg ?? userMsg}`);
  };
  const pathError = (p: string, reason: string): void => addError(`${p}: ${reason}`, `${hashPath(p)}: ${reason}`);

  // 1. Candidate paths — explicit field wins; else auto-detect from task text.
  let candidates: string[];
  if (images && images.length > 0) {
    candidates = images;
  } else {
    candidates = detectImagePathsInText(task);
    result.autoDetected = candidates.length > 0;
  }

  // 1b. Normalize + de-dup BOTH sources before the count cap so the same file
  // cited two ways (e.g. /a//b.png vs /a/b.png, or repeated in the explicit
  // field) counts once and does not burn a MAX_IMAGES slot twice.
  {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const c of candidates) {
      const n = normalize(c);
      if (seen.has(n)) continue;
      seen.add(n);
      deduped.push(n);
    }
    candidates = deduped;
  }
  if (candidates.length === 0) return result;

  // 2. Vision gate — text-only providers ignore the field with a logged notice.
  if (!providerSupportsVision(provider)) {
    const notice = `provider "${provider ?? 'unknown'}" is not vision-capable — ignoring ${candidates.length} image attachment(s)`;
    result.notices.push(notice);
    _log(label, notice);
    return result;
  }

  // 2b. Resolve the confinement root once (realpath'd). If projectRoot is given
  // but unresolvable, the policy CANNOT be enforced — fail CLOSED (reject every
  // candidate below), never fail open. A misconfigured / transiently-unavailable
  // root is safer as "all images rejected" than "all images accepted".
  let realRoot: string | undefined;
  let rootUnresolved = false;
  if (projectRoot) {
    try {
      realRoot = realpathSync(projectRoot);
    } catch {
      rootUnresolved = true;
      const notice = `image path policy: project root "${projectRoot}" did not resolve — rejecting all attachments (fail-closed)`;
      result.notices.push(notice);
      _log(label, `${notice} (${hashPath(projectRoot)})`);
    }
  }

  // 3. Enforce the count cap — reject the overflow loudly, don't silently truncate.
  let list = candidates;
  if (list.length > MAX_IMAGES) {
    // No single path in this message → nothing to hash; log as-is.
    addError(`too many images: ${list.length} supplied, max ${MAX_IMAGES} — dropping the last ${list.length - MAX_IMAGES}`);
    list = list.slice(0, MAX_IMAGES);
  }

  // 4. Read + validate each candidate. Open FIRST, then validate the pinned
  //    descriptor — never a path string that open() would re-resolve.
  for (const p of list) {
    if (!isAbsolute(p)) { pathError(p, 'not an absolute path'); continue; }
    if (!IMAGE_EXT_RE.test(p)) { pathError(p, 'unsupported extension (png/jpeg only)'); continue; }

    // Fail-closed: a supplied-but-unresolvable projectRoot means the confinement
    // policy cannot be enforced — reject rather than read (never fail open).
    if (rootUnresolved) {
      pathError(p, 'project root did not resolve — image attachment rejected (path policy, fail-closed)');
      continue;
    }

    // Open-first-then-validate closes the realpath→open TOCTOU: opening pins the
    // target inode, so the confinement check below runs against the descriptor we
    // actually hold, not a path string a concurrent symlink swap could re-point.
    // O_NONBLOCK avoids hanging on a FIFO/device a hostile path might name; we
    // reject non-regular files anyway. stat + read use the SAME fd so a stat→read
    // swap can't smuggle a different/larger file, and the read is hard-capped.
    let fd: number | undefined;
    try {
      try {
        fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      } catch {
        pathError(p, 'file not found');
        continue;
      }
      const st = fstatSync(fd);
      if (!st.isFile()) { pathError(p, 'not a regular file'); continue; }

      // Allowed-root confinement (path policy) — only when a root is configured.
      // Validate the PINNED fd's real path, not a re-resolvable string, so a
      // symlink swap between resolve and open (the realpath→open TOCTOU) can't
      // escape the root.
      if (realRoot) {
        let canonical: string;
        try {
          // Linux: /proc/self/fd/<fd> reflects the pinned descriptor exactly.
          canonical = realpathSync(`/proc/self/fd/${fd}`);
        } catch {
          // No /proc (e.g. macOS): fall back to realpath(p), then verify it
          // resolves to the SAME inode we hold open — a swap between open and here
          // surfaces as a dev/ino mismatch and is rejected.
          canonical = realpathSync(p);
          const cst = statSync(canonical);
          if (cst.dev !== st.dev || cst.ino !== st.ino) {
            pathError(p, 'path changed during open (possible symlink swap) — rejected (path policy)');
            continue;
          }
        }
        if (!isWithinRoot(canonical, realRoot)) {
          pathError(p, `resolves outside the allowed project root — image attachments must stay within ${realRoot} (path policy)`);
          continue;
        }
      }

      if (st.size > MAX_IMAGE_BYTES) {
        pathError(p, `too large (${(st.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`);
        continue;
      }
      // Read at most MAX_IMAGE_BYTES + 1 bytes. The +1 sentinel lets us detect a
      // file that is actually over-cap even if fstat under-reported its size.
      const buf = Buffer.allocUnsafe(MAX_IMAGE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead <= MAX_IMAGE_BYTES) {
        const n = readSync(fd, buf, bytesRead, (MAX_IMAGE_BYTES + 1) - bytesRead, null);
        if (n === 0) break; // EOF
        bytesRead += n;
      }
      if (bytesRead > MAX_IMAGE_BYTES) {
        pathError(p, `too large (exceeds ${MAX_IMAGE_BYTES / 1024 / 1024} MB read cap)`);
        continue;
      }
      const image = buf.subarray(0, bytesRead);
      const media = sniffImageMediaType(image);
      if (!media) { pathError(p, 'content is not valid PNG or JPEG'); continue; }
      result.blocks.push({ type: 'image', data: image.toString('base64'), mediaType: media });
    } catch (e) {
      pathError(p, `read failed (${(e as Error).message})`);
      continue;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  return result;
}

/**
 * Build the `content` for the initial user message from the task text and the
 * resolved images. Returns a plain string when no image blocks resolved
 * (byte-identical to the pre-feature behavior), otherwise a multimodal
 * ContentBlock[] with the task text first.
 *
 * Error-surfacing rule: per-image errors are appended to the prompt ONLY when the
 * candidates came from an EXPLICIT `images` field — the caller asked for those
 * attachments, so a rejection is worth surfacing in-context. AUTO-DETECTED
 * failures are log-only: a path-shaped token in pure prose that fails to resolve
 * must NOT mutate the prompt, or a plain text-only task stops being byte-identical
 * to the pre-feature behavior. (Auto-detect errors still live in `resolved.errors`
 * and are logged; they just don't splice into the message.)
 */
export function buildUserContent(task: string, resolved: ResolvedTaskImages): string | ContentBlock[] {
  const surfaceErrors = resolved.errors.length > 0 && !resolved.autoDetected;
  const errNote = surfaceErrors
    ? `\n\n[image attachment errors]\n- ${resolved.errors.join('\n- ')}`
    : '';
  if (resolved.blocks.length === 0) {
    return errNote ? task + errNote : task;
  }
  return [{ type: 'text', text: task + errNote }, ...resolved.blocks];
}
