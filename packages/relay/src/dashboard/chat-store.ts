/**
 * chat-store.ts — durable write-through store for mirror chat history
 * (spec 2026-06-17-chat-write-through-store.md).
 *
 * ChatStore is a thin seam between the in-memory MirrorEventStore ring and a
 * persistent backend. The default (NullChatStore) is a no-op and preserves all
 * existing behavior. FileChatStore writes append-only JSONL under
 * <chatDir>/<chatId>.jsonl, one frame per line, with amortized truncation to
 * PERSIST_CAP lines to prevent unbounded disk growth.
 *
 * Security: FileChatStore re-validates every chatId against CHAT_ID_RE before
 * ANY path operation — defense-in-depth against path traversal even if the
 * caller is already validating. An invalid id is always a no-op (append/drop)
 * or returns [] (load). Never throws into the live bridge.
 *
 * Underscore-prefixed ids (e.g. '_provisional') are internal sentinels and are
 * NEVER persisted by append() or maybeRetain(). load() and drop() still work on
 * them so pre-existing sentinel files can be drained and cleaned up.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { MirrorFrame } from './api-bridge';

/** Same pattern as CHAT_ID_RE in api-bridge.ts — defense-in-depth re-check. */
const CHAT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Approximate max lines retained per .jsonl file. When a file exceeds 2× this
 * on append, it is truncated to the last PERSIST_CAP lines (amortized rewrite
 * — one rewrite per 2×PERSIST_CAP appends, not one per append).
 */
export const PERSIST_CAP = 1000;

/**
 * Maximum byte length of a single JSONL line that load() will parse.
 * Lines exceeding this are skipped (with a console.warn) as a defense-in-depth
 * guard against corrupted or adversarial oversized lines.
 */
const MAX_LINE_BYTES = 256 * 1024; // 256 KiB

export interface ChatStore {
  /** Durable write-through. Best-effort: MUST NOT throw into the live path. */
  append(chatId: string, frame: MirrorFrame): void;
  /** Hydrate a cold ring. Returns up to `max` most-recent frames in id order. */
  load(chatId: string, max: number): MirrorFrame[];
  /** Delete persisted history (provisional cleanup after drainInto). */
  drop(chatId: string): void;
  dispose(): void;
}

/** Default no-op — preserves current behavior + all existing tests. */
export class NullChatStore implements ChatStore {
  append(_chatId: string, _frame: MirrorFrame): void {}
  load(_chatId: string, _max: number): MirrorFrame[] { return []; }
  drop(_chatId: string): void {}
  dispose(): void {}
}

/** True when `obj` has the minimal shape of a MirrorFrame. */
function isMirrorFrameShaped(obj: unknown): obj is MirrorFrame {
  if (!obj || typeof obj !== 'object') return false;
  const f = obj as Record<string, unknown>;
  return (
    f.type === 'mirror' &&
    typeof f.chat_id === 'string' &&
    typeof f.role === 'string' &&
    typeof f.text === 'string' &&
    typeof f.ts === 'string' &&
    typeof f.id === 'number'
  );
}

/** Append-only JSONL per chat under <chatDir>/<chatId>.jsonl */
export class FileChatStore implements ChatStore {
  /**
   * Per-chat append counter. Used to gate maybeRetain() calls so we do not
   * read the file on every append (O(1) amortized instead of O(N)):
   *   - First append for a chatId in this process: one-time retention check
   *     (bounds a large pre-existing file from a prior run).
   *   - Subsequent appends: only call maybeRetain every PERSIST_CAP writes.
   */
  private readonly appendCounters = new Map<string, number>();

  constructor(private readonly chatDir: string) {}

  private isValidChatId(chatId: string): boolean {
    return CHAT_ID_RE.test(chatId);
  }

  private filePath(chatId: string): string {
    return join(this.chatDir, `${chatId}.jsonl`);
  }

  append(chatId: string, frame: MirrorFrame): void {
    if (!this.isValidChatId(chatId)) return;
    // Underscore-prefixed ids are internal sentinels (e.g. '_provisional') —
    // never persist them. load() / drop() may still operate on existing files.
    if (chatId.startsWith('_')) return;
    try {
      mkdirSync(this.chatDir, { recursive: true });
      const line = JSON.stringify(frame) + '\n';
      appendFileSync(this.filePath(chatId), line, 'utf8');

      // Amortized retention gate: avoid reading the file on every append.
      // On first append for this chatId (counter not yet set), do a one-time
      // check to bound any large pre-existing file from a prior process run.
      // After that, check every PERSIST_CAP appends.
      const prev = this.appendCounters.get(chatId);
      const count = (prev ?? 0) + 1;
      this.appendCounters.set(chatId, count);
      const isFirst = prev === undefined;
      if (isFirst || count % PERSIST_CAP === 0) {
        this.maybeRetain(chatId);
      }
    } catch (err) {
      // Disk/IO error — log once and swallow. Must never propagate into the live bridge.
      console.warn(`[chat-store] append failed for chatId=${chatId}:`, err);
    }
  }

  private maybeRetain(chatId: string): void {
    // Underscore-prefixed ids are internal sentinels — never persist them.
    if (chatId.startsWith('_')) return;
    try {
      const fp = this.filePath(chatId);
      const content = readFileSync(fp, 'utf8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      if (lines.length < 2 * PERSIST_CAP) return;
      // Truncate to last PERSIST_CAP lines using an atomic tmp→rename so a
      // crash mid-write never corrupts the live file.
      const kept = lines.slice(lines.length - PERSIST_CAP);
      const tmp = fp + '.tmp';
      writeFileSync(tmp, kept.join('\n') + '\n', 'utf8');
      renameSync(tmp, fp);
    } catch (err) {
      // Retention is best-effort; log so a persistent failure is observable.
      console.warn(`[chat-store] retain failed for chatId=${chatId}`, err);
    }
  }

  load(chatId: string, max: number): MirrorFrame[] {
    if (!this.isValidChatId(chatId)) return [];
    let content: string;
    try {
      content = readFileSync(this.filePath(chatId), 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return [];
      console.warn(`[chat-store] load failed for chatId=${chatId}:`, err);
      return [];
    }
    const lines = content.split('\n').filter((l) => l.length > 0);
    const frames: MirrorFrame[] = [];
    for (const line of lines) {
      // Defense-in-depth: skip lines that are unreasonably long before parsing.
      if (line.length > MAX_LINE_BYTES) {
        console.warn(`[chat-store] skipping oversized line (${line.length} bytes) for chatId=${chatId}`);
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (isMirrorFrameShaped(parsed)) {
          frames.push(parsed as MirrorFrame);
        } else {
          console.warn(`[chat-store] skipping malformed frame line for chatId=${chatId}`);
        }
      } catch {
        console.warn(`[chat-store] skipping unparseable line for chatId=${chatId}`);
      }
    }
    // Return the last `max` frames in id order (file is already in append order,
    // so slicing the tail keeps id-order correct).
    if (frames.length <= max) return frames;
    return frames.slice(frames.length - max);
  }

  drop(chatId: string): void {
    if (!this.isValidChatId(chatId)) return;
    try {
      unlinkSync(this.filePath(chatId));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.warn(`[chat-store] drop failed for chatId=${chatId}:`, err);
      }
      // ENOENT is fine — already gone.
    }
  }

  dispose(): void {}
}
