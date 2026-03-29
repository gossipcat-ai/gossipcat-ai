import { BootstrapGenerator } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// This is a test-only workaround to expose the private method for testing.
class TestableBootstrapGenerator extends BootstrapGenerator {
  public readAndVerifyNextSessionNotes(): string | null {
    // @ts-ignore
    return this.readNextSessionNotes();
  }
}

describe('BootstrapGenerator — Spec Features', () => {
  const testDir = join(tmpdir(), `gossip-bootstrap-spec-test-${Date.now()}`);
  const mcpPath = join(testDir, 'apps', 'cli', 'src');

  beforeAll(() => {
    mkdirSync(mcpPath, { recursive: true });
    // Create a dummy MCP server file with some tools
    writeFileSync(join(mcpPath, 'mcp-server-sdk.ts'), `
      server.tool('gossip_setup', ...);
      server.tool("gossip_plan", ...);
      // server.tool('gossip_run', ...); // Example of a commented-out tool
    `);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('verifyToolClaims', () => {
    it('should not modify content when no MCP server file exists', () => {
      const notesDir = join(testDir, 'no-mcp-file');
      mkdirSync(join(notesDir, '.gossip'), { recursive: true });
      writeFileSync(join(notesDir, '.gossip', 'next-session.md'), 'TODO: implement gossip_run');

      const gen = new TestableBootstrapGenerator(notesDir);
      const result = gen.readAndVerifyNextSessionNotes();

      expect(result).toBe('TODO: implement gossip_run');
    });

    it('should not modify content without tool-related keywords', () => {
      const notesDir = join(testDir, 'no-keywords');
      mkdirSync(join(notesDir, '.gossip'), { recursive: true });
      writeFileSync(join(notesDir, '.gossip', 'next-session.md'), 'Implement the gossip_plan feature.');

      const gen = new TestableBootstrapGenerator(notesDir);
      const result = gen.readAndVerifyNextSessionNotes();
      expect(result).not.toContain('~~');
    });

    it('should strike through a TODO item for a tool that exists (single quotes)', () => {
      const notesDir = join(testDir, 'todo-exists-single');
      mkdirSync(join(notesDir, '.gossip'), { recursive: true });
      writeFileSync(join(notesDir, '.gossip', 'next-session.md'), 'TODO: remaining work on gossip_setup');

      // The generator needs to be initialized with the root that contains `apps/cli/src...`
      const gen = new TestableBootstrapGenerator(testDir);
      // But we need to read the notes from the test-specific directory.
      // So we'll cheat and temporarily replace the notes path logic.
      const originalRead = gen['readNextSessionNotes'];
      gen['readNextSessionNotes'] = () => {
        const notesPath = join(notesDir, '.gossip', 'next-session.md');
        const content = readFileSync(notesPath, 'utf-8').trim();
        return gen['verifyToolClaims'](content);
      };

      const result = gen.readAndVerifyNextSessionNotes();

      gen['readNextSessionNotes'] = originalRead; // Restore

      expect(result).toContain('~~TODO: remaining work on gossip_setup~~');
      expect(result).toContain('*(verified: gossip_setup exists in MCP server)*');
    });

     it('should strike through a deferred item for a tool that exists (double quotes)', () => {
        const notesDir = join(testDir, 'todo-exists-double');
        mkdirSync(join(notesDir, '.gossip'), { recursive: true });
        writeFileSync(join(notesDir, '.gossip', 'next-session.md'), 'deferred: gossip_plan needs tests');

        const gen = new TestableBootstrapGenerator(testDir);
        const originalRead = gen['readNextSessionNotes'];
        gen['readNextSessionNotes'] = () => {
          const notesPath = join(notesDir, '.gossip', 'next-session.md');
          const content = readFileSync(notesPath, 'utf-8').trim();
          return gen['verifyToolClaims'](content);
        };
        const result = gen.readAndVerifyNextSessionNotes();
        gen['readNextSessionNotes'] = originalRead;

        expect(result).toContain('~~deferred: gossip_plan needs tests~~');
        expect(result).toContain('*(verified: gossip_plan exists in MCP server)*');
    });

    it('should NOT strike through a tool that is commented out in source', () => {
        const notesDir = join(testDir, 'commented-out');
        mkdirSync(join(notesDir, '.gossip'), { recursive: true });
        writeFileSync(join(notesDir, '.gossip', 'next-session.md'), 'needed: finish gossip_run tool');

        const gen = new TestableBootstrapGenerator(testDir);
        const originalRead = gen['readNextSessionNotes'];
        gen['readNextSessionNotes'] = () => {
          const notesPath = join(notesDir, '.gossip', 'next-session.md');
          const content = readFileSync(notesPath, 'utf-8').trim();
          return gen['verifyToolClaims'](content);
        };
        const result = gen.readAndVerifyNextSessionNotes();
        gen['readNextSessionNotes'] = originalRead;

        expect(result).not.toContain('~~');
    });

     it('should NOT strike through a tool that is not in the MCP file', () => {
        const notesDir = join(testDir, 'not-present');
        mkdirSync(join(notesDir, '.gossip'), { recursive: true });
        writeFileSync(join(notesDir, '.gossip', 'next-session.md'), 'TODO: implement gossip_collect');

        const gen = new TestableBootstrapGenerator(testDir);
        const originalRead = gen['readNextSessionNotes'];
        gen['readNextSessionNotes'] = () => {
          const notesPath = join(notesDir, '.gossip', 'next-session.md');
          const content = readFileSync(notesPath, 'utf-8').trim();
          return gen['verifyToolClaims'](content);
        };
        const result = gen.readAndVerifyNextSessionNotes();
        gen['readNextSessionNotes'] = originalRead;

        expect(result).not.toContain('~~');
    });

    it('should handle multiple verifiable tools on different lines', () => {
        const notesDir = join(testDir, 'multiple-tools');
        mkdirSync(join(notesDir, '.gossip'), { recursive: true });
        writeFileSync(join(notesDir, '.gossip', 'next-session.md'), `
- remaining: docs for gossip_setup
- TODO: fix bug in gossip_plan
- next: implement gossip_collect
        `);

        const gen = new TestableBootstrapGenerator(testDir);
        const originalRead = gen['readNextSessionNotes'];
        gen['readNextSessionNotes'] = () => {
          const notesPath = join(notesDir, '.gossip', 'next-session.md');
          const content = readFileSync(notesPath, 'utf-8').trim();
          return gen['verifyToolClaims'](content);
        };
        const result = gen.readAndVerifyNextSessionNotes();
        gen['readNextSessionNotes'] = originalRead;

        expect(result).toContain('~~- remaining: docs for gossip_setup~~');
        expect(result).toContain('~~- TODO: fix bug in gossip_plan~~');
        expect(result).not.toContain('~~- next: implement gossip_collect~~');
    });
  });

  describe('Bootstrap Tools Table', () => {
    it('should include gossip_run and gossip_run_complete in the tools table', () => {
      const dir = join(testDir, 'tools-table');
      mkdirSync(join(dir, '.gossip'), { recursive: true });
      writeFileSync(join(dir, '.gossip', 'config.json'), JSON.stringify({
        agents: { 'test-agent': { provider: 'local', model: 'qwen' } }
      }));
      const gen = new BootstrapGenerator(dir);
      const result = gen.generate();

      expect(result.prompt).toMatch(/\| `gossip_run\(agent_id, task\)`/);
      expect(result.prompt).toMatch(/\| `gossip_run_complete\(task_id, result\)`/);
    });
  });
});
