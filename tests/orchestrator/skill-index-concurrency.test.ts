import { SkillIndex } from '@gossip/orchestrator';
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Regression suite for #714 — the long-lived MCP-server SkillIndex clobbering
 * writes made by other processes (dashboard binds, migration scripts).
 */
describe('SkillIndex cross-process safety', () => {
  let testDir: string;
  let indexPath: string;
  let seq = 0;

  beforeEach(() => {
    testDir = join(tmpdir(), `gossip-skill-index-concurrency-${Date.now()}-${seq++}`);
    mkdirSync(join(testDir, '.gossip'), { recursive: true });
    indexPath = join(testDir, '.gossip', 'skill-index.json');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const readIndex = () => JSON.parse(readFileSync(indexPath, 'utf-8'));

  describe('lost update', () => {
    it('keeps both bindings when two instances write the same file', () => {
      const a = new SkillIndex(testDir);
      const b = new SkillIndex(testDir);

      a.bind('agent-a', 'typescript');
      b.bind('agent-b', 'security-audit');

      const onDisk = readIndex();
      expect(onDisk['agent-a']?.typescript).toBeDefined();
      expect(onDisk['agent-b']?.['security-audit']).toBeDefined();
    });

    it('keeps both bindings when the two instances target the same agent', () => {
      const a = new SkillIndex(testDir);
      const b = new SkillIndex(testDir);

      a.bind('agent-a', 'typescript');
      b.bind('agent-a', 'security-audit');

      const onDisk = readIndex();
      expect(Object.keys(onDisk['agent-a']).sort()).toEqual(['security-audit', 'typescript']);
    });

    it('serves a later external bind through the read accessors', () => {
      const longLived = new SkillIndex(testDir);
      longLived.bind('agent-a', 'typescript');

      new SkillIndex(testDir).bind('agent-a', 'security-audit');

      expect(longLived.getEnabledSkills('agent-a').sort()).toEqual(['security-audit', 'typescript']);
      expect(longLived.getSlot('agent-a', 'security-audit')).toBeDefined();
      expect(longLived.getAgentIds()).toEqual(['agent-a']);
    });
  });

  describe('external edit preservation', () => {
    /** Simulates the #709 migration flipping an auto slot to contextual mode. */
    const flipModeExternally = (agentId: string, skill: string) => {
      const data = readIndex();
      data[agentId][skill].mode = 'contextual';
      data[agentId][skill].version += 1;
      writeFileSync(indexPath, JSON.stringify(data, null, 2) + '\n');
      return data[agentId][skill].boundAt as string;
    };

    it('preserves an externally flipped mode across an unrelated bind', () => {
      const longLived = new SkillIndex(testDir);
      longLived.bind('agent-a', 'typescript', { source: 'auto', mode: 'permanent' });

      flipModeExternally('agent-a', 'typescript');
      longLived.bind('agent-b', 'security-audit');

      const onDisk = readIndex();
      expect(onDisk['agent-a'].typescript.mode).toBe('contextual');
      expect(onDisk['agent-b']?.['security-audit']).toBeDefined();
    });

    it('does not rotate boundAt on slots a refresh merely re-reads', () => {
      const longLived = new SkillIndex(testDir);
      longLived.bind('agent-a', 'typescript', { source: 'auto', mode: 'permanent' });

      const boundAtBefore = flipModeExternally('agent-a', 'typescript');
      longLived.bind('agent-b', 'security-audit');

      expect(readIndex()['agent-a'].typescript.boundAt).toBe(boundAtBefore);
      expect(longLived.getSlot('agent-a', 'typescript')?.boundAt).toBe(boundAtBefore);
    });

    it('reports the externally flipped mode from getSkillMode', () => {
      const longLived = new SkillIndex(testDir);
      longLived.bind('agent-a', 'typescript', { source: 'auto', mode: 'permanent' });
      expect(longLived.getSkillMode('agent-a', 'typescript')).toBe('permanent');

      flipModeExternally('agent-a', 'typescript');

      expect(longLived.getSkillMode('agent-a', 'typescript')).toBe('contextual');
    });

    it('versions a re-bind from the on-disk version, not the stale one', () => {
      const longLived = new SkillIndex(testDir);
      longLived.bind('agent-a', 'typescript', { source: 'auto', mode: 'permanent' });

      flipModeExternally('agent-a', 'typescript'); // version 1 → 2

      expect(longLived.bind('agent-a', 'typescript').version).toBe(3);
    });

    it('leaves in-memory state intact when the file is deleted externally', () => {
      const longLived = new SkillIndex(testDir);
      longLived.bind('agent-a', 'typescript');

      rmSync(indexPath);

      expect(longLived.getEnabledSkills('agent-a')).toEqual(['typescript']);
    });
  });

  describe('atomic save', () => {
    it('leaves no temp file behind', () => {
      const index = new SkillIndex(testDir);
      index.bind('agent-a', 'typescript');
      index.bind('agent-b', 'security-audit');
      index.unbind('agent-b', 'security-audit');

      expect(readdirSync(join(testDir, '.gossip'))).toEqual(['skill-index.json']);
    });

    it('writes pretty-printed JSON with a trailing newline', () => {
      const index = new SkillIndex(testDir);
      index.bind('agent-a', 'typescript');

      const raw = readFileSync(indexPath, 'utf-8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2) + '\n');
      expect(new SkillIndex(testDir).getIndex()).toEqual(index.getIndex());
    });
  });

  describe('corrupt index handling', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
      stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    const corruptFiles = () =>
      readdirSync(join(testDir, '.gossip')).filter(f => f.includes('.corrupt-'));

    it('starts empty, backs the file up, and warns on stderr', () => {
      writeFileSync(indexPath, '{ this is not json');

      const index = new SkillIndex(testDir);

      expect(index.getIndex()).toEqual({});
      expect(corruptFiles()).toHaveLength(1);
      expect(existsSync(indexPath)).toBe(false);
      const warning = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(warning).toContain('not valid JSON');
      expect(warning).toContain('.corrupt-');
    });

    it('preserves the corrupt bytes in the backup', () => {
      writeFileSync(indexPath, '{ this is not json');

      new SkillIndex(testDir);

      const backup = corruptFiles()[0];
      expect(readFileSync(join(testDir, '.gossip', backup), 'utf-8')).toBe('{ this is not json');
    });

    it('does not throw from the constructor', () => {
      writeFileSync(indexPath, 'not json at all');

      expect(() => new SkillIndex(testDir)).not.toThrow();
    });

    it('recovers into a usable index after quarantine', () => {
      writeFileSync(indexPath, '<<<garbage>>>');

      const index = new SkillIndex(testDir);
      index.bind('agent-a', 'typescript');

      expect(readIndex()['agent-a'].typescript.enabled).toBe(true);
    });

    describe('isCorrupt()', () => {
      it('reports unparseable JSON so callers can refuse to overwrite', () => {
        writeFileSync(indexPath, '{"foo":');
        expect(new SkillIndex(testDir).isCorrupt()).toBe(true);
      });

      it('reports a non-object index shape', () => {
        writeFileSync(indexPath, '[1,2,3]');
        expect(new SkillIndex(testDir).isCorrupt()).toBe(true);
      });

      it('is false for a healthy or absent index', () => {
        expect(new SkillIndex(testDir).isCorrupt()).toBe(false);
        new SkillIndex(testDir).bind('agent-a', 'typescript');
        expect(new SkillIndex(testDir).isCorrupt()).toBe(false);
      });

      it('clears once a good index is written over the quarantined one', () => {
        writeFileSync(indexPath, '{"foo":');
        const index = new SkillIndex(testDir);

        index.bind('agent-a', 'typescript');

        expect(index.isCorrupt()).toBe(false);
      });
    });
  });
});
