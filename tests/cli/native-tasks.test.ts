/**
 * Phase 1 tests for the dispatch-prompt storage helper.
 * Spec: docs/specs/2026-05-18-native-dispatch-skill-handle-pattern.md §A.
 *
 * Covers:
 *   - happy path (atomic write-to-temp + rename)
 *   - SAFE_NAME validation (rejects "..", control chars, oversize)
 *   - eviction by mtime (default 1h)
 *   - aggregate eldest-eviction at DISPATCH_PROMPT_CAP_BYTES
 *   - orphan prune on boot (unknown taskIds removed)
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  writeDispatchPrompt,
  cleanupExpiredDispatchPrompts,
  pruneOrphanDispatchPrompts,
  dispatchPromptPath,
  DISPATCH_PROMPT_CAP_BYTES,
} from '../../apps/cli/src/handlers/dispatch-prompt-storage';

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-native-tasks-'));
}

function setMtime(path: string, mtimeMs: number): void {
  const secs = mtimeMs / 1000;
  utimesSync(path, secs, secs);
}

describe('dispatch-prompt storage', () => {
  describe('writeDispatchPrompt', () => {
    it('writes the body to .gossip/dispatch-prompts/<taskId>.txt and returns absolute path', () => {
      const root = mkRoot();
      const path = writeDispatchPrompt(root, 'abc12345', 'hello world');
      expect(path).toBe(dispatchPromptPath(root, 'abc12345'));
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('hello world');
      // Atomic rename: no .tmp leftovers.
      const dir = join(root, '.gossip', 'dispatch-prompts');
      const leftovers = readdirSync(dir).filter(f => f.endsWith('.tmp'));
      expect(leftovers).toHaveLength(0);
    });

    it('rejects taskId containing ".." (path traversal)', () => {
      const root = mkRoot();
      expect(() => writeDispatchPrompt(root, '..evil', 'x')).toThrow(/SAFE_NAME/);
      expect(() => writeDispatchPrompt(root, 'a..b', 'x')).toThrow(/SAFE_NAME/);
    });

    it('rejects taskId with disallowed characters', () => {
      const root = mkRoot();
      expect(() => writeDispatchPrompt(root, 'a/b', 'x')).toThrow(/SAFE_NAME/);
      expect(() => writeDispatchPrompt(root, 'a b', 'x')).toThrow(/SAFE_NAME/);
      expect(() => writeDispatchPrompt(root, 'a\x00b', 'x')).toThrow(/SAFE_NAME/);
    });

    it('rejects empty taskId', () => {
      const root = mkRoot();
      expect(() => writeDispatchPrompt(root, '', 'x')).toThrow();
    });

    it('overwrites in place on repeated calls with the same taskId (atomic rename)', () => {
      const root = mkRoot();
      writeDispatchPrompt(root, 'tid', 'first');
      const second = writeDispatchPrompt(root, 'tid', 'second');
      expect(readFileSync(second, 'utf8')).toBe('second');
    });
  });

  describe('cleanupExpiredDispatchPrompts', () => {
    it('removes files older than maxAgeMs by mtime', () => {
      const root = mkRoot();
      const fresh = writeDispatchPrompt(root, 'fresh-id', 'F');
      const stale = writeDispatchPrompt(root, 'stale-id', 'S');
      // Backdate stale by 2 hours.
      setMtime(stale, Date.now() - 2 * 60 * 60 * 1000);

      const { evictedAge } = cleanupExpiredDispatchPrompts(root, 60 * 60 * 1000);
      expect(evictedAge).toBe(1);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(stale)).toBe(false);
    });

    it('enforces aggregate cap with eldest-eviction', () => {
      const root = mkRoot();
      // Three small files, but pass a tiny capBytes to force eviction.
      const a = writeDispatchPrompt(root, 'a', 'A'.repeat(100));
      const b = writeDispatchPrompt(root, 'b', 'B'.repeat(100));
      const c = writeDispatchPrompt(root, 'c', 'C'.repeat(100));
      // Make 'a' the eldest, 'c' the youngest.
      setMtime(a, Date.now() - 30 * 1000);
      setMtime(b, Date.now() - 20 * 1000);
      setMtime(c, Date.now() - 10 * 1000);

      const { evictedCap } = cleanupExpiredDispatchPrompts(root, 60 * 60 * 1000, 150);
      // capBytes=150: must drop at least 'a' (100 bytes) to fit two of the
      // remaining files would still be 200 > 150 so 'b' goes too.
      expect(evictedCap).toBeGreaterThanOrEqual(1);
      expect(existsSync(a)).toBe(false);
    });

    it('returns zero counts when the directory does not exist (fail-open)', () => {
      const root = mkRoot();
      const result = cleanupExpiredDispatchPrompts(root);
      expect(result).toEqual({ evictedAge: 0, evictedCap: 0 });
    });

    it('honors DISPATCH_PROMPT_CAP_BYTES default by NOT evicting under cap', () => {
      const root = mkRoot();
      const p = writeDispatchPrompt(root, 'tid', 'small');
      const { evictedCap } = cleanupExpiredDispatchPrompts(root, 60 * 60 * 1000, DISPATCH_PROMPT_CAP_BYTES);
      expect(evictedCap).toBe(0);
      expect(existsSync(p)).toBe(true);
    });
  });

  describe('pruneOrphanDispatchPrompts', () => {
    it('removes files whose taskId is NOT in the known set (crash recovery)', () => {
      const root = mkRoot();
      const known = writeDispatchPrompt(root, 'known-id', 'K');
      const orphan = writeDispatchPrompt(root, 'orphan-id', 'O');

      const { orphans } = pruneOrphanDispatchPrompts(root, new Set(['known-id']));
      expect(orphans).toBe(1);
      expect(existsSync(known)).toBe(true);
      expect(existsSync(orphan)).toBe(false);
    });

    it('also removes aged files even if their taskId IS known', () => {
      const root = mkRoot();
      const aged = writeDispatchPrompt(root, 'aged-id', 'A');
      setMtime(aged, Date.now() - 2 * 60 * 60 * 1000);

      const { aged: agedCount } = pruneOrphanDispatchPrompts(root, new Set(['aged-id']));
      expect(agedCount).toBe(1);
      expect(existsSync(aged)).toBe(false);
    });

    it('is a no-op when the directory does not exist', () => {
      const root = mkRoot();
      const result = pruneOrphanDispatchPrompts(root, new Set(['nothing']));
      expect(result).toEqual({ orphans: 0, aged: 0 });
    });
  });

  describe('atomic write semantics', () => {
    it('leaves no temp file behind after a successful write', () => {
      const root = mkRoot();
      writeDispatchPrompt(root, 'tid', 'x');
      const dir = join(root, '.gossip', 'dispatch-prompts');
      const files = readdirSync(dir);
      expect(files.every(f => !f.endsWith('.tmp'))).toBe(true);
    });

    it('written file size matches body byte length', () => {
      const root = mkRoot();
      const body = '🚀'.repeat(10); // multi-byte unicode
      const p = writeDispatchPrompt(root, 'tid', body);
      expect(statSync(p).size).toBe(Buffer.byteLength(body, 'utf8'));
    });
  });
});
