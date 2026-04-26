import { join } from 'path';
import {
  refreshNativeAgentFromDisk,
  modelTierFromId,
  type NativeAgentCacheEntry,
  type FsLike,
} from '../../apps/cli/src/native-agent-cache';

/**
 * In-memory FsLike fake. Records all reads / existence checks so tests can
 * assert what disk path was consulted, and lets each test seed a virtual file
 * tree without touching the real filesystem.
 *
 * Files can be specified as a plain string (default mtime: 1000ms) or as a
 * { content, mtimeMs } object when a test needs to control mtime explicitly
 * (mtime-skip guard tests).
 */
type FileEntry = string | { content: string; mtimeMs: number };

function makeFakeFs(files: Record<string, FileEntry>): FsLike {
  const get = (p: string): { content: string; mtimeMs: number } => {
    const v = files[p];
    if (typeof v === 'string') return { content: v, mtimeMs: 1000 };
    return v;
  };
  return {
    existsSync: (p: string) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p: string) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        throw new Error(`fake fs: ENOENT ${p}`);
      }
      return get(p).content;
    },
    statSync: (p: string) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        throw new Error(`fake fs: ENOENT ${p}`);
      }
      return { mtimeMs: get(p).mtimeMs };
    },
  };
}

const ROOT = '/proj';
// Build the fake-fs keys with the same `join` the production function uses,
// so the test fixture works cross-platform (path.join produces backslashes
// on Windows; hand-built '/proj/.claude/agents/foo.md' wouldn't match).
const CLAUDE_PATH = join(ROOT, '.claude', 'agents', 'foo.md');
const FALLBACK_PATH = join(ROOT, '.gossip', 'agents', 'foo', 'instructions.md');

const FRONTMATTER = [
  '---',
  'name: foo',
  'model: sonnet',
  'description: a foo',
  '---',
  '',
].join('\n');

describe('refreshNativeAgentFromDisk', () => {
  it('writes a fresh cache entry from .claude/agents/<id>.md (no prior entry)', () => {
    const cache = new Map<string, NativeAgentCacheEntry>();
    const fs = makeFakeFs({ [CLAUDE_PATH]: FRONTMATTER + 'INITIAL body' });

    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6', role: 'reviewer', skills: ['code_review'] },
      cache,
      ROOT,
      fs
    );

    const entry = cache.get('foo');
    expect(entry).toBeDefined();
    expect(entry!.instructions).toBe('INITIAL body');
    expect(entry!.model).toBe('sonnet');
    expect(entry!.description).toBe('reviewer');
    expect(entry!.skills).toEqual(['code_review']);
  });

  // The core regression: gossipcat-ai/gossipcat-ai#266. Before the fix, the
  // refresh path was guarded by `!cache.has(id)`, so an existing entry would
  // never be updated even when the on-disk source had changed. Dispatch kept
  // emitting the stale instructions.
  it('overwrites an existing cache entry on subsequent calls (the #266 regression)', () => {
    const cache = new Map<string, NativeAgentCacheEntry>();
    const fs1 = makeFakeFs({ [CLAUDE_PATH]: FRONTMATTER + 'INITIAL body' });

    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6', role: 'reviewer', skills: ['code_review'] },
      cache,
      ROOT,
      fs1
    );
    expect(cache.get('foo')!.instructions).toBe('INITIAL body');

    // Simulate what gossip_setup mode:"merge" does on disk: rewrite the
    // .claude/agents/<id>.md with new instructions. mtime advances because
    // the writer touched the file. Then call refresh again — which is what
    // doSyncWorkers does after writing .gossip/config.json.
    const fs2 = makeFakeFs({
      [CLAUDE_PATH]: { content: FRONTMATTER + 'UPDATED body', mtimeMs: 2000 },
    });
    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6', role: 'reviewer', skills: ['code_review'] },
      cache,
      ROOT,
      fs2
    );

    expect(cache.get('foo')!.instructions).toBe('UPDATED body');
  });

  it('strips frontmatter from .claude/agents/<id>.md', () => {
    const cache = new Map<string, NativeAgentCacheEntry>();
    const fs = makeFakeFs({
      [CLAUDE_PATH]: FRONTMATTER + 'body line 1\nbody line 2',
    });

    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6' },
      cache,
      ROOT,
      fs
    );

    expect(cache.get('foo')!.instructions).toBe('body line 1\nbody line 2');
    expect(cache.get('foo')!.instructions).not.toContain('---');
    expect(cache.get('foo')!.instructions).not.toContain('description:');
  });

  it('falls back to .gossip/agents/<id>/instructions.md when .claude/agents is absent', () => {
    const cache = new Map<string, NativeAgentCacheEntry>();
    const fs = makeFakeFs({ [FALLBACK_PATH]: 'fallback instructions' });

    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6' },
      cache,
      ROOT,
      fs
    );

    expect(cache.get('foo')!.instructions).toBe('fallback instructions');
  });

  it('writes an empty-instructions entry when neither source file exists', () => {
    const cache = new Map<string, NativeAgentCacheEntry>();
    const fs = makeFakeFs({});

    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6', role: 'reviewer', skills: ['code_review'] },
      cache,
      ROOT,
      fs
    );

    // Matches the prior inline behavior: downstream code expects the entry
    // to exist for any config-defined native agent, even if disk is empty.
    expect(cache.get('foo')).toEqual({
      model: 'sonnet',
      instructions: '',
      description: 'reviewer',
      skills: ['code_review'],
    });
  });

  it('prefers role over preset for description when both are present', () => {
    const cache = new Map<string, NativeAgentCacheEntry>();
    const fs = makeFakeFs({ [CLAUDE_PATH]: FRONTMATTER + 'b' });

    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6', role: 'r', preset: 'p' },
      cache,
      ROOT,
      fs
    );

    expect(cache.get('foo')!.description).toBe('r');
  });

  // Guard 2: empty-file clobber. The maintainer flagged a HIGH-severity race
  // where doSyncWorkers reads .claude/agents/<id>.md while a writer has
  // truncated it to 0 bytes (mid-write window). Without this guard, the
  // empty read would overwrite a previously-good cache entry, and the next
  // dispatch would emit an empty system prompt.
  it('preserves prev cache entry when on-disk file is empty (mid-write race)', () => {
    const cache = new Map<string, NativeAgentCacheEntry>();
    const fs1 = makeFakeFs({ [CLAUDE_PATH]: FRONTMATTER + 'GOOD body' });
    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6', role: 'reviewer', skills: ['code_review'] },
      cache,
      ROOT,
      fs1
    );
    expect(cache.get('foo')!.instructions).toBe('GOOD body');

    // Simulate mid-write race: writer truncated file to empty (frontmatter
    // gone, body gone). mtime advances because the writer touched the file.
    const fs2 = makeFakeFs({ [CLAUDE_PATH]: { content: '', mtimeMs: 2000 } });
    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6', role: 'reviewer', skills: ['code_review'] },
      cache,
      ROOT,
      fs2
    );

    // Cache must NOT be overwritten with empty instructions — preserve prev.
    expect(cache.get('foo')!.instructions).toBe('GOOD body');
  });

  // Guard 3: missing-file clobber. The maintainer flagged the same race
  // pattern with atomic-replace writers (writer unlinks old file before
  // renaming temp into place). Without this guard, the brief existsSync=false
  // window would overwrite a good entry with empty.
  it('preserves prev cache entry when source file disappears between syncs', () => {
    const cache = new Map<string, NativeAgentCacheEntry>();
    const fs1 = makeFakeFs({ [CLAUDE_PATH]: FRONTMATTER + 'GOOD body' });
    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6', role: 'reviewer', skills: ['code_review'] },
      cache,
      ROOT,
      fs1
    );
    expect(cache.get('foo')!.instructions).toBe('GOOD body');

    // Simulate atomic-replace mid-window: source file is briefly absent.
    const fs2 = makeFakeFs({});
    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6', role: 'reviewer', skills: ['code_review'] },
      cache,
      ROOT,
      fs2
    );

    // Cache must NOT be overwritten with empty instructions — preserve prev.
    expect(cache.get('foo')!.instructions).toBe('GOOD body');
  });

  // Guard 1: mtime-skip. The maintainer flagged a MEDIUM perf concern about
  // refresh storm — syncWorkersViaKeychain fires from 7 callsites and the
  // mutex coalesces concurrent calls but not sequential ones. So every
  // dispatch was triggering N synchronous readFileSync calls even when
  // nothing had changed on disk. The mtime guard short-circuits the read
  // when the source file's mtime equals the cached entry's mtime.
  it('skips readFileSync when source mtime is unchanged since last refresh (perf)', () => {
    const cache = new Map<string, NativeAgentCacheEntry>();

    // Spy on readFileSync to assert it is NOT called on the second refresh.
    let readCount = 0;
    let statCount = 0;
    const baseFs = makeFakeFs({
      [CLAUDE_PATH]: { content: FRONTMATTER + 'STABLE body', mtimeMs: 1500 },
    });
    const fs: FsLike = {
      existsSync: baseFs.existsSync,
      readFileSync: (p: string, enc: 'utf-8') => {
        readCount++;
        return baseFs.readFileSync(p, enc);
      },
      statSync: (p: string) => {
        statCount++;
        return baseFs.statSync(p);
      },
    };

    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6', role: 'reviewer', skills: ['code_review'] },
      cache,
      ROOT,
      fs
    );
    expect(readCount).toBe(1);
    expect(statCount).toBe(1);
    expect(cache.get('foo')!.instructions).toBe('STABLE body');
    expect(cache.get('foo')!.cachedMtimeMs).toBe(1500);

    // Second refresh with the same file (same mtime) should hit the mtime
    // guard: statSync still runs (cheap), readFileSync does NOT.
    refreshNativeAgentFromDisk(
      { id: 'foo', model: 'claude-sonnet-4-6', role: 'reviewer', skills: ['code_review'] },
      cache,
      ROOT,
      fs
    );
    expect(readCount).toBe(1);
    expect(statCount).toBe(2);
    expect(cache.get('foo')!.instructions).toBe('STABLE body');
  });
});

describe('modelTierFromId', () => {
  it('maps opus models to "opus"', () => {
    expect(modelTierFromId('claude-opus-4-7')).toBe('opus');
  });

  it('maps haiku models to "haiku"', () => {
    expect(modelTierFromId('claude-haiku-4-5')).toBe('haiku');
  });

  it('defaults everything else to "sonnet"', () => {
    expect(modelTierFromId('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelTierFromId('gemini-2.5-pro')).toBe('sonnet');
    expect(modelTierFromId('')).toBe('sonnet');
  });
});
