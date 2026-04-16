import { jest } from '@jest/globals';
const vi = jest;
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { join } from 'path';
import { ToolServer } from '../../packages/tools/src/tool-server';

// We need to test the enforcement without a live relay.
// ToolServer.executeTool is public, so we can call it directly.
// But ToolServer constructor requires a relay connection.
// Instead, test the enforcement logic by creating the server
// and calling assignScope/assignRoot + executeTool directly.

// Mock GossipAgent to avoid actual relay connection
vi.mock('@gossip/client', () => ({
  GossipAgent: class {
    agentId = 'tool-server';
    async connect() {}
    async disconnect() {}
    on() {}
    async sendEnvelope() {}
  },
}));

describe('ToolServer scope enforcement', () => {
  let server: ToolServer;
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-test-'));
    server = new ToolServer({
      relayUrl: 'ws://localhost:0',
      projectRoot,
    });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('scoped agents', () => {
    const agentId = 'agent-scoped';

    beforeEach(() => {
      server.assignScope(agentId, 'packages/relay/');
      fs.mkdirSync(join(projectRoot, 'packages/relay'), { recursive: true });
    });

    it('blocks file_write outside scope', async () => {
      await expect(
        server.executeTool('file_write', { path: 'packages/tools/foo.ts', content: 'x' }, agentId)
      ).rejects.toThrow(/outside scope/);
    });

    it('allows file_write within scope', async () => {
      // This will fail at the file level (no actual file), but NOT at the scope level
      // So we just verify it doesn't throw a scope error
      try {
        await server.executeTool('file_write', { path: 'packages/relay/foo.ts', content: 'x' }, agentId);
      } catch (err) {
        expect((err as Error).message).not.toContain('outside scope');
      }
    });

    it('blocks shell_exec for scoped agents', async () => {
      await expect(
        server.executeTool('shell_exec', { command: 'ls' }, agentId)
      ).rejects.toThrow(/shell_exec is restricted in scoped write mode/);
    });

    it('blocks git_commit for scoped agents', async () => {
      await expect(
        server.executeTool('git_commit', { message: 'test' }, agentId)
      ).rejects.toThrow(/Git commit blocked/);
    });

    it('blocks file_read outside scope', async () => {
      await expect(
        server.executeTool('file_read', { path: 'packages/tools/bar.ts' }, agentId)
      ).rejects.toThrow(/outside scope/);
    });

    it('blocks file_write to sibling prefix without trailing slash', async () => {
      // Test that scope 'packages/relay/' doesn't allow 'packages/relay2/evil.ts'
      // (This should work since assignScope normalizes trailing slash)
      await expect(
        server.executeTool('file_write', { path: 'packages/relay2/evil.ts', content: 'x' }, agentId)
      ).rejects.toThrow(/outside scope/);
    });

    it('blocks git_branch for scoped agents', async () => {
      await expect(
        server.executeTool('git_branch', { name: 'evil-branch' }, agentId)
      ).rejects.toThrow(/Git branch blocked/);
    });

    it('blocks file_write using path traversal to escape scope', async () => {
      await expect(
        server.executeTool('file_write', { path: 'packages/relay/../tools/evil.ts', content: 'x' }, agentId)
      ).rejects.toThrow(/outside scope/);
    });

    it('relative path still resolves against projectRoot', async () => {
      server.assignScope('agent-scoped-writer', 'some-scope-dir');
      fs.mkdirSync(join(projectRoot, 'some-scope-dir'));
      await server.executeTool(
        'file_write',
        { path: 'some-scope-dir/file.txt', content: 'scoped' },
        'agent-scoped-writer'
      );
      expect(fs.existsSync(join(projectRoot, 'some-scope-dir', 'file.txt'))).toBe(true);
    });
  });

  describe('worktree agents', () => {
    beforeEach(() => {
      server.assignRoot('agent-2', '/tmp/gossip-wt-abc/');
    });

    it('blocks file_write outside worktree root', async () => {
      await expect(
        server.executeTool('file_write', { path: '/other/path/foo.ts', content: 'x' }, 'agent-2')
      ).rejects.toThrow(/outside worktree root|outside project root or agent root/);
    });

    it('allows shell_exec for worktree agents', async () => {
      // shell_exec may fail but should NOT throw a scope error
      try {
        await server.executeTool('shell_exec', { command: 'ls' }, 'agent-2');
      } catch (err) {
        expect((err as Error).message).not.toContain('blocked');
      }
    });

    it('blocks shell commands with path traversal', async () => {
      await expect(
        server.executeTool('shell_exec', { command: 'cat ../../etc/passwd' }, 'agent-2')
      ).rejects.toThrow(/Shell command blocked/);
    });

    it.each([
      ['git config core.hooksPath /tmp/evil'],
      ['rm -rf ./.git/hooks/pre-commit'],
      ['echo "evil" > .git/config'],
    ])('blocks shell command manipulating git internals: %s', async (command: string) => {
      await expect(
        server.executeTool('shell_exec', { command }, 'agent-2')
      ).rejects.toThrow(/Shell command blocked/);
    });
  });

  describe('symlink + case-insensitive hardening', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(projectRoot, 'packages/relay'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, 'packages/tools'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'packages/tools/secret.ts'), 'secret');
      server.assignScope('agent-1', 'packages/relay/');
    });

    it('blocks file_read through a symlink that escapes scope', async () => {
      // Plant a symlink inside scope pointing at an out-of-scope file
      const linkPath = path.join(projectRoot, 'packages/relay/escape.ts');
      fs.symlinkSync(path.join(projectRoot, 'packages/tools/secret.ts'), linkPath);
      await expect(
        server.executeTool('file_read', { path: 'packages/relay/escape.ts' }, 'agent-1')
      ).rejects.toThrow(/outside scope/);
    });

    it('blocks file_write through a symlinked parent that escapes scope', async () => {
      // Symlink an in-scope directory name to an out-of-scope directory
      const linkDir = path.join(projectRoot, 'packages/relay/bounce');
      fs.symlinkSync(path.join(projectRoot, 'packages/tools'), linkDir);
      await expect(
        server.executeTool('file_write', { path: 'packages/relay/bounce/evil.ts', content: 'x' }, 'agent-1')
      ).rejects.toThrow(/outside scope/);
    });

    it('blocks case-folded sibling-prefix bypass on case-insensitive fs', async () => {
      // On darwin/win32 the OS treats RELAY and relay as the same directory;
      // case-sensitive startsWith would have let `RELAY2/evil.ts` through.
      await expect(
        server.executeTool('file_write', { path: 'packages/RELAY2/evil.ts', content: 'x' }, 'agent-1')
      ).rejects.toThrow(/outside scope/);
    });
  });

  describe('file_delete worktree root hardening', () => {
    beforeEach(() => {
      const wtRoot = path.join(projectRoot, 'wt');
      fs.mkdirSync(wtRoot, { recursive: true });
      server.assignRoot('agent-wt', wtRoot);
    });

    it('blocks file_delete to a sibling-prefix root', async () => {
      // Root is `<projectRoot>/wt`; a path like `<projectRoot>/wt2/file.ts`
      // must not be accepted via bare startsWith.
      const siblingRoot = path.join(projectRoot, 'wt2');
      fs.mkdirSync(siblingRoot, { recursive: true });
      const victim = path.join(siblingRoot, 'file.ts');
      fs.writeFileSync(victim, 'x');
      await expect(
        server.executeTool('file_delete', { path: victim }, 'agent-wt')
      ).rejects.toThrow(/outside worktree root|outside project root or agent root/);
    });
  });

  describe('fail-closed enforcement', () => {
    it('blocks write tools if agent is in writeAgents but has no scope/root', async () => {
      // Simulate state inconsistency: write agent with no scope
      (server as any).writeAgents.add('agent-no-scope');
      await expect(
        server.executeTool('file_write', { path: 'any/file.ts', content: 'x' }, 'agent-no-scope')
      ).rejects.toThrow(/is a write agent but has no scope\/root registered/);
    });
  });

  describe('runtime arg validation', () => {
    it('rejects unknown tool name', async () => {
      await expect(
        server.executeTool('not_a_tool', { x: 1 })
      ).rejects.toThrow(/Unknown tool/);
    });

    it('rejects file_write missing required `content` field', async () => {
      await expect(
        server.executeTool('file_write', { path: 'foo.ts' })
      ).rejects.toThrow(/Invalid args for tool "file_write".*content/);
    });

    it('rejects file_read with non-string path', async () => {
      await expect(
        server.executeTool('file_read', { path: 123 })
      ).rejects.toThrow(/Invalid args for tool "file_read"/);
    });

    it('rejects file_write with empty path', async () => {
      await expect(
        server.executeTool('file_write', { path: '', content: 'x' })
      ).rejects.toThrow(/Invalid args for tool "file_write".*path/);
    });

    it('rejects shell_exec args array of non-strings', async () => {
      await expect(
        server.executeTool('shell_exec', { command: 'ls', args: [1, 2, 3] })
      ).rejects.toThrow(/Invalid args for tool "shell_exec"/);
    });

    it('rejects unknown extra field via .strict()', async () => {
      await expect(
        server.executeTool('file_read', { path: 'foo.ts', evil: 'extra' })
      ).rejects.toThrow(/Invalid args for tool "file_read"/);
    });
  });

  describe('release', () => {
    it('released agents bypass enforcement', async () => {
      server.assignScope('agent-1', 'packages/relay/');
      server.releaseAgent('agent-1');
      // After release, scope enforcement should not apply
      try {
        await server.executeTool('file_write', { path: 'packages/tools/foo.ts', content: 'x' }, 'agent-1');
      } catch (err) {
        expect((err as Error).message).not.toContain('outside scope');
      }
    });
  });

  describe('union-of-roots (agent worktree) -- CWD DIVERGENCE FIX', () => {
    // Previously, worktree-mode agents were gated correctly at enforceWriteScope
    // (against agentRoots) but then FileTools → Sandbox.validatePath re-checked
    // against projectRoot only, rejecting every absolute worktree path because
    // worktrees live under os.tmpdir() by construction. These tests verify the
    // fix: validatePath accepts path if it resolves inside projectRoot OR any
    // entry in allowedRoots, while preserving all existing security properties
    // (symlink resolve, trailing-slash root compare, case-fold on darwin/win32).
    let wtRoot: string;
    let agentId: string;

    beforeEach(() => {
      // Use a real directory under os.tmpdir() so we exercise the same
      // "root lives outside projectRoot" geometry production has.
      wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-wt-'));
      agentId = 'agent-wt-union';
      server.assignRoot(agentId, wtRoot);
    });

    afterEach(() => {
      try { fs.rmSync(wtRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('a) allows absolute path inside agent worktree root', async () => {
      // Pre-create the intermediate `sub/` dir so canonicalizeForBoundary in
      // enforceWriteScope can resolve symlinks on an existing ancestor; this
      // keeps the test focused on the Sandbox-layer union-of-roots fix rather
      // than tangling with the scope-layer walk-to-ancestor behavior.
      fs.mkdirSync(path.join(wtRoot, 'sub'), { recursive: true });
      const target = path.join(wtRoot, 'sub', 'file.txt');
      const result = await server.executeTool(
        'file_write',
        { path: target, content: 'hello' },
        agentId,
      );
      expect(result).toContain('Written');
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target, 'utf-8')).toBe('hello');
    });

    it('b) rejects absolute path outside both roots', async () => {
      await expect(
        server.executeTool(
          'file_write',
          { path: '/etc/passwd', content: 'evil' },
          agentId,
        ),
      ).rejects.toThrow(/outside worktree root|outside project root or agent root/);
    });

    // REWRITTEN TEST
    it('c) relative path resolves against agentRoot when in worktree mode', async () => {
      const innerFile = path.join(wtRoot, 'inside-wt.txt');
      fs.writeFileSync(innerFile, 'wt-content');
      const content = await server.executeTool(
        'file_read',
        { path: 'inside-wt.txt' },
        agentId,
      );
      expect(content).toContain('wt-content');
    });

    it('d) blocks sibling-prefix bypass against worktree root', async () => {
      // Root is `<tmp>/gossip-wt-XXXX`; create a sibling under the same
      // parent named `<same>XYZ` and verify a write into it is rejected
      // even though the name shares a prefix with the assigned root.
      const siblingRoot = wtRoot + 'XYZ';
      fs.mkdirSync(siblingRoot, { recursive: true });
      const victim = path.join(siblingRoot, 'file.txt');
      try {
        await expect(
          server.executeTool(
            'file_write',
            { path: victim, content: 'x' },
            agentId,
          ),
        ).rejects.toThrow(/outside worktree root|outside project root or agent root/);
      } finally {
        fs.rmSync(siblingRoot, { recursive: true, force: true });
      }
    });

    it('e) blocks symlink escape planted inside worktree', async () => {
      // Create a symlink inside the worktree pointing at an out-of-root
      // directory (here: /etc). A write through the symlink must be
      // rejected because validatePath follows the symlink before the
      // membership check.
      const link = path.join(wtRoot, 'bounce');
      try {
        fs.symlinkSync('/etc', link);
      } catch {
        // On some CI filesystems symlink creation may fail; skip gracefully.
        return;
      }
      await expect(
        server.executeTool(
          'file_write',
          { path: path.join(link, 'evil.txt'), content: 'x' },
          agentId,
        ),
      ).rejects.toThrow(/outside worktree root|outside project root or agent root/);
    });

    it('f) agent without assigned root falls back to projectRoot-only check', async () => {
      // A non-write agent with no scope/root should behave exactly as
      // before — absolute paths outside projectRoot get rejected by the
      // Sandbox, even though allowedRoots defaults to [].
      await expect(
        server.executeTool(
          'file_read',
          { path: '/etc/hosts' },
          'agent-no-root',
        ),
      ).rejects.toThrow(/outside project root/);
    });

    // NEW TESTS START HERE

    it('worktree agent: file_write with relative path lands in agentRoot, not projectRoot', async () => {
      await server.executeTool(
        'file_write',
        { path: 'output.txt', content: 'hello' },
        agentId,
      );
      expect(fs.existsSync(join(wtRoot, 'output.txt'))).toBe(true);
      expect(fs.existsSync(join(projectRoot, 'output.txt'))).toBe(false);
    });

    it('worktree agent: file_read with relative path reads from agentRoot', async () => {
      fs.writeFileSync(join(wtRoot, 'input.txt'), 'wt-content');
      fs.writeFileSync(join(projectRoot, 'input.txt'), 'pr-content');
      const content = await server.executeTool(
        'file_read',
        { path: 'input.txt' },
        agentId,
      );
      expect(content).toContain('wt-content');
    });

    it('worktree agent: absolute path to projectRoot file still works (union preserved)', async () => {
      fs.writeFileSync(join(projectRoot, 'pr-file.txt'), 'pr-content');
      const content = await server.executeTool(
        'file_read',
        { path: join(projectRoot, 'pr-file.txt') },
        agentId,
      );
      expect(content).toContain('pr-content');
    });

    it('sequential agent (no root): relative path resolves against projectRoot', async () => {
      const sequentialAgentId = 'agent-seq';
      // This agent has no assigned root or scope
      await server.executeTool(
        'file_write',
        { path: 'seq-output.txt', content: 'seq' },
        sequentialAgentId
      );
      expect(fs.existsSync(join(projectRoot, 'seq-output.txt'))).toBe(true);
    });

    it('scoped agent: relative path still resolves against projectRoot', async () => {
      const scopedAgentId = 'agent-scoped-2';
      const scopeDir = 'some-scope-dir-2';
      server.assignScope(scopedAgentId, scopeDir);
      fs.mkdirSync(join(projectRoot, scopeDir), { recursive: true });
      await server.executeTool(
        'file_write',
        { path: `${scopeDir}/file.txt`, content: 'scoped' },
        scopedAgentId,
      );
      expect(fs.existsSync(join(projectRoot, scopeDir, 'file.txt'))).toBe(true);
    });
  });
});
