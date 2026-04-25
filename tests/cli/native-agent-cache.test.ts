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
 */
function makeFakeFs(files: Record<string, string>): FsLike {
  return {
    existsSync: (p: string) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p: string) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        throw new Error(`fake fs: ENOENT ${p}`);
      }
      return files[p];
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
    // .claude/agents/<id>.md with new instructions. Then call refresh again
    // — which is what doSyncWorkers does after writing .gossip/config.json.
    const fs2 = makeFakeFs({ [CLAUDE_PATH]: FRONTMATTER + 'UPDATED body' });
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
