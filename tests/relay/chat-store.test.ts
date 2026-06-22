/**
 * Tests for chat-store.ts — NullChatStore + FileChatStore (spec 2026-06-17).
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync, appendFileSync as fsAppend } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NullChatStore, FileChatStore, PERSIST_CAP } from '@gossip/relay/dashboard/chat-store';
import type { MirrorFrame } from '@gossip/relay/dashboard/api-bridge';

function makeFrame(id: number, chatId = 'chat1', text = `text-${id}`): MirrorFrame {
  return {
    type: 'mirror',
    chat_id: chatId,
    role: 'user',
    text,
    ts: new Date(1000 * id).toISOString(),
    id,
  };
}

describe('NullChatStore', () => {
  it('append is a no-op', () => {
    const s = new NullChatStore();
    expect(() => s.append('chat1', makeFrame(1))).not.toThrow();
  });

  it('load always returns []', () => {
    const s = new NullChatStore();
    s.append('chat1', makeFrame(1));
    expect(s.load('chat1', 100)).toEqual([]);
  });

  it('drop is a no-op', () => {
    const s = new NullChatStore();
    expect(() => s.drop('chat1')).not.toThrow();
  });

  it('dispose is a no-op', () => {
    const s = new NullChatStore();
    expect(() => s.dispose()).not.toThrow();
  });
});

describe('FileChatStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-store-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function store() {
    return new FileChatStore(dir);
  }

  // ── append + load round-trip ─────────────────────────────────────────────

  it('append + load round-trip preserves all frame fields', () => {
    const s = store();
    const f = makeFrame(1, 'chat1', 'hello world');
    s.append('chat1', f);
    const loaded = s.load('chat1', 100);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(f);
  });

  it('appends multiple frames and loads in id order', () => {
    const s = store();
    for (let i = 1; i <= 5; i++) s.append('chat1', makeFrame(i));
    const loaded = s.load('chat1', 100);
    expect(loaded).toHaveLength(5);
    expect(loaded.map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('load returns only the last `max` frames in id order', () => {
    const s = store();
    for (let i = 1; i <= 10; i++) s.append('chat1', makeFrame(i));
    const loaded = s.load('chat1', 3);
    expect(loaded).toHaveLength(3);
    expect(loaded.map((f) => f.id)).toEqual([8, 9, 10]);
  });

  it('load returns [] for ENOENT (chat never written)', () => {
    const s = store();
    expect(s.load('nonexistent', 100)).toEqual([]);
  });

  it('separate chatIds are stored independently', () => {
    const s = store();
    s.append('chatA', makeFrame(1, 'chatA', 'a1'));
    s.append('chatB', makeFrame(1, 'chatB', 'b1'));
    s.append('chatA', makeFrame(2, 'chatA', 'a2'));
    expect(s.load('chatA', 100).map((f) => f.id)).toEqual([1, 2]);
    expect(s.load('chatB', 100).map((f) => f.id)).toEqual([1]);
  });

  // ── malformed line skip ──────────────────────────────────────────────────

  it('skips malformed JSON lines without throwing', () => {
    const s = store();
    // Write one valid, one garbage, one valid frame directly to the file.
    const { appendFileSync } = require('fs');
    const path = join(dir, 'chat1.jsonl');
    appendFileSync(path, JSON.stringify(makeFrame(1)) + '\n');
    appendFileSync(path, 'not-json-at-all\n');
    appendFileSync(path, JSON.stringify(makeFrame(2)) + '\n');
    const loaded = s.load('chat1', 100);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((f) => f.id)).toEqual([1, 2]);
  });

  it('skips JSON lines that are not MirrorFrame-shaped', () => {
    const s = store();
    const { appendFileSync } = require('fs');
    const path = join(dir, 'chat1.jsonl');
    appendFileSync(path, JSON.stringify(makeFrame(1)) + '\n');
    appendFileSync(path, JSON.stringify({ type: 'reply', chat_id: 'chat1', ts: 'x' }) + '\n'); // missing role/text/id
    appendFileSync(path, JSON.stringify(makeFrame(2)) + '\n');
    const loaded = s.load('chat1', 100);
    expect(loaded).toHaveLength(2);
  });

  // ── retention / truncation ───────────────────────────────────────────────

  it('truncates to last PERSIST_CAP lines when file reaches 2*PERSIST_CAP', () => {
    const s = store();
    // Write exactly 2*PERSIST_CAP frames. The retention check fires at
    // count=2*PERSIST_CAP (gated counter) and at that point there are exactly
    // 2*PERSIST_CAP lines — above the < 2*PERSIST_CAP skip threshold — so
    // the file is truncated to PERSIST_CAP lines.
    for (let i = 1; i <= 2 * PERSIST_CAP; i++) s.append('chat1', makeFrame(i));
    const loaded = s.load('chat1', PERSIST_CAP + 500);
    // After truncation, exactly PERSIST_CAP frames remain.
    expect(loaded.length).toBe(PERSIST_CAP);
    // The retained frames should be the most recent ones.
    const ids = loaded.map((f) => f.id);
    expect(ids[0]).toBeGreaterThan(PERSIST_CAP);
    expect(ids[ids.length - 1]).toBe(2 * PERSIST_CAP);
  });

  it('retention still works across > 2*PERSIST_CAP appends (gated counter path)', () => {
    const s = store();
    // Append exactly 3*PERSIST_CAP frames. Retention checks fire at count=1,
    // count=PERSIST_CAP, count=2*PERSIST_CAP (triggers truncation to PERSIST_CAP),
    // and count=3*PERSIST_CAP (triggers another truncation — 2*PERSIST_CAP → PERSIST_CAP).
    // After all appends, the file is bounded to exactly PERSIST_CAP lines.
    const total = 3 * PERSIST_CAP;
    for (let i = 1; i <= total; i++) s.append('chat1', makeFrame(i));
    const loaded = s.load('chat1', total + 1000);
    // File must be bounded to PERSIST_CAP lines.
    expect(loaded.length).toBeLessThanOrEqual(PERSIST_CAP);
    // The last frame must be the very last appended.
    const ids = loaded.map((f) => f.id);
    expect(ids[ids.length - 1]).toBe(total);
  });

  it('after truncation file has exactly PERSIST_CAP lines, is valid JSONL, no .tmp left', () => {
    const s = store();
    // Trigger truncation by appending exactly 2*PERSIST_CAP frames (retention
    // check fires at count=2*PERSIST_CAP which is the gated PERSIST_CAP boundary).
    for (let i = 1; i <= 2 * PERSIST_CAP; i++) s.append('chat1', makeFrame(i));

    // Verify no .tmp file remains.
    const tmpPath = join(dir, 'chat1.jsonl.tmp');
    expect(existsSync(tmpPath)).toBe(false);

    // Load and confirm exactly PERSIST_CAP frames.
    const loaded = s.load('chat1', PERSIST_CAP + 9999);
    expect(loaded).toHaveLength(PERSIST_CAP);

    // All frames must parse as valid MirrorFrame (load already does this, but
    // double-check by confirming every id is a number > 0).
    expect(loaded.every((f) => typeof f.id === 'number' && f.id > 0)).toBe(true);
  });

  // ── _provisional / underscore sentinel guard ─────────────────────────────

  it('_provisional append writes NO file', () => {
    const s = store();
    s.append('_provisional', makeFrame(1, '_provisional'));
    const path = join(dir, '_provisional.jsonl');
    expect(existsSync(path)).toBe(false);
  });

  it('other underscore-prefixed ids write NO file', () => {
    const s = store();
    s.append('_internal', makeFrame(1, '_internal'));
    const path = join(dir, '_internal.jsonl');
    expect(existsSync(path)).toBe(false);
  });

  it('load on a pre-seeded _provisional.jsonl returns frames (drain path)', () => {
    // Simulate a file written by a prior process version before the fix.
    const path = join(dir, '_provisional.jsonl');
    writeFileSync(path, JSON.stringify(makeFrame(1, '_provisional')) + '\n');
    writeFileSync(path, JSON.stringify(makeFrame(2, '_provisional')) + '\n', { flag: 'a' });
    const s = store();
    const loaded = s.load('_provisional', 100);
    expect(loaded).toHaveLength(2);
  });

  it('drop still deletes a pre-seeded _provisional.jsonl', () => {
    const path = join(dir, '_provisional.jsonl');
    writeFileSync(path, JSON.stringify(makeFrame(1, '_provisional')) + '\n');
    expect(existsSync(path)).toBe(true);
    const s = store();
    s.drop('_provisional');
    expect(existsSync(path)).toBe(false);
  });

  // ── oversized line guard (MAX_LINE_BYTES) ────────────────────────────────

  it('load skips oversized lines and still returns surrounding well-formed frames', () => {
    const path = join(dir, 'chat1.jsonl');
    // A valid frame before the oversized line.
    fsAppend(path, JSON.stringify(makeFrame(1)) + '\n');
    // An oversized line (> 256 KiB).
    const bigLine = 'x'.repeat(256 * 1024 + 1);
    fsAppend(path, bigLine + '\n');
    // A valid frame after the oversized line.
    fsAppend(path, JSON.stringify(makeFrame(2)) + '\n');

    const s = store();
    const loaded = s.load('chat1', 100);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((f) => f.id)).toEqual([1, 2]);
  });

  // ── drop ─────────────────────────────────────────────────────────────────

  it('drop removes the file', () => {
    const s = store();
    s.append('chat1', makeFrame(1));
    const path = join(dir, 'chat1.jsonl');
    expect(existsSync(path)).toBe(true);
    s.drop('chat1');
    expect(existsSync(path)).toBe(false);
  });

  it('drop is a no-op when file does not exist (ENOENT)', () => {
    const s = store();
    expect(() => s.drop('nonexistent')).not.toThrow();
  });

  // ── chatId re-validation (path-traversal defense) ────────────────────────

  it('rejects chatId with ../ (path traversal) — append is no-op', () => {
    const s = store();
    s.append('../evil', makeFrame(1)); // must not create a file outside dir
    // No file should be created anywhere in dir.
    const { readdirSync } = require('fs');
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('rejects chatId with ../ — load returns []', () => {
    const s = store();
    expect(s.load('../evil', 100)).toEqual([]);
  });

  it('rejects chatId with leading / — append is no-op', () => {
    // CHAT_ID_RE requires alphanumeric/dash/underscore only, so '/' fails.
    const s = store();
    s.append('/etc/passwd', makeFrame(1));
    const { readdirSync } = require('fs');
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('rejects empty chatId', () => {
    const s = store();
    s.append('', makeFrame(1));
    expect(s.load('', 100)).toEqual([]);
    const { readdirSync } = require('fs');
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('rejects chatId longer than 128 characters', () => {
    const s = store();
    const longId = 'a'.repeat(129);
    s.append(longId, makeFrame(1));
    expect(s.load(longId, 100)).toEqual([]);
    const { readdirSync } = require('fs');
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('drop is no-op for invalid chatId', () => {
    const s = store();
    expect(() => s.drop('../evil')).not.toThrow();
  });

  it('accepts valid chatId with dashes and underscores', () => {
    const s = store();
    s.append('my-chat_id-123', makeFrame(1, 'my-chat_id-123'));
    const loaded = s.load('my-chat_id-123', 100);
    expect(loaded).toHaveLength(1);
  });

  it('load() reclaims a stale .tmp orphan left by a prior-run crash', () => {
    const s = store();
    s.append('chat1', makeFrame(1));
    // Simulate an orphan tmp left by a crash between writeFileSync and rename.
    const orphan = join(dir, 'chat1.jsonl.tmp');
    writeFileSync(orphan, 'garbage\n', 'utf8');
    expect(existsSync(orphan)).toBe(true);
    // Hydrating the chat cleans the orphan and still returns the real frames.
    const loaded = s.load('chat1', 100);
    expect(loaded).toHaveLength(1);
    expect(existsSync(orphan)).toBe(false);
  });
});
