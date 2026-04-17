import { BootstrapGenerator } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('BootstrapGenerator', () => {
  const testDir = join(tmpdir(), `gossip-bootstrap-test-${Date.now()}`);
  afterAll(() => { rmSync(testDir, { recursive: true, force: true }); });

  describe('tier detection', () => {
    it('returns no-config tier when no config exists', () => {
      const dir = join(testDir, 'empty');
      mkdirSync(dir, { recursive: true });
      const gen = new BootstrapGenerator(dir);
      const result = gen.generate();
      expect(result.tier).toBe('no-config');
      expect(result.agentCount).toBe(0);
      expect(result.prompt).toContain('not configured yet');
    });

    it('returns no-memory tier when config exists but no memory', () => {
      const dir = join(testDir, 'config-only');
      mkdirSync(join(dir, '.gossip'), { recursive: true });
      writeFileSync(join(dir, '.gossip', 'config.json'), JSON.stringify({
        main_agent: { provider: 'local', model: 'qwen' },
        agents: { 'test-agent': { provider: 'local', model: 'qwen', skills: ['testing'] } }
      }));
      const gen = new BootstrapGenerator(dir);
      const result = gen.generate();
      expect(result.tier).toBe('no-memory');
      expect(result.agentCount).toBe(1);
      expect(result.prompt).toContain('test-agent');
      expect(result.prompt).toContain('No task history yet');
    });

    it('returns full tier when config and memory exist', () => {
      const dir = join(testDir, 'full');
      mkdirSync(join(dir, '.gossip', 'agents', 'test-agent', 'memory'), { recursive: true });
      writeFileSync(join(dir, '.gossip', 'config.json'), JSON.stringify({
        main_agent: { provider: 'local', model: 'qwen' },
        agents: { 'test-agent': { provider: 'local', model: 'qwen', preset: 'reviewer', skills: ['testing', 'code_review'] } }
      }));
      writeFileSync(join(dir, '.gossip', 'agents', 'test-agent', 'memory', 'tasks.jsonl'),
        '{"version":1,"taskId":"t1","task":"review code","skills":["testing"],"findings":0,"hallucinated":0,"scores":{"relevance":3,"accuracy":3,"uniqueness":3},"warmth":1,"importance":0.6,"timestamp":"2026-03-22T10:00:00Z"}\n' +
        '{"version":1,"taskId":"t2","task":"check tests","skills":["testing"],"findings":0,"hallucinated":0,"scores":{"relevance":3,"accuracy":3,"uniqueness":3},"warmth":1,"importance":0.6,"timestamp":"2026-03-22T11:00:00Z"}\n'
      );
      writeFileSync(join(dir, '.gossip', 'agents', 'test-agent', 'memory', 'MEMORY.md'),
        '# Agent Memory — test-agent\n\n## Knowledge\n- [security](knowledge/security.md) — relay auth patterns\n\n## Recent Tasks\n- 2026-03-22: review code\n'
      );
      const gen = new BootstrapGenerator(dir);
      const result = gen.generate();
      expect(result.tier).toBe('full');
      expect(result.agentCount).toBe(1);
      expect(result.prompt).toContain('test-agent');
      expect(result.prompt).toContain('2 tasks');
      expect(result.prompt).toContain('Dispatch Rules');
    });
  });

  describe('memory hygiene convention', () => {
    it('bootstrap output includes Memory Hygiene Convention heading in full tier', () => {
      const dir = join(testDir, 'hygiene-full');
      mkdirSync(join(dir, '.gossip'), { recursive: true });
      writeFileSync(join(dir, '.gossip', 'config.json'), JSON.stringify({
        main_agent: { provider: 'local', model: 'q' },
        agents: { 'a1': { provider: 'local', model: 'q', skills: ['t'] } }
      }));
      const gen = new BootstrapGenerator(dir);
      const result = gen.generate();
      expect(result.prompt).toContain('## Memory Hygiene Convention');
      expect(result.prompt).toContain('status: open');
      expect(result.prompt).toContain('status: shipped');
      expect(result.prompt).toContain('status: closed');
    });
  });

  describe('error handling', () => {
    it('falls back to no-config on malformed config JSON', () => {
      const dir = join(testDir, 'bad-json');
      mkdirSync(join(dir, '.gossip'), { recursive: true });
      writeFileSync(join(dir, '.gossip', 'config.json'), '{ broken json!!!');
      const gen = new BootstrapGenerator(dir);
      const result = gen.generate();
      expect(result.tier).toBe('no-config');
    });

    it('shows no task history when tasks.jsonl has malformed lines', () => {
      const dir = join(testDir, 'bad-tasks');
      mkdirSync(join(dir, '.gossip', 'agents', 'a1', 'memory'), { recursive: true });
      writeFileSync(join(dir, '.gossip', 'config.json'), JSON.stringify({
        main_agent: { provider: 'local', model: 'q' },
        agents: { 'a1': { provider: 'local', model: 'q', skills: ['testing'] } }
      }));
      writeFileSync(join(dir, '.gossip', 'agents', 'a1', 'memory', 'tasks.jsonl'),
        'NOT JSON\n{"version":1,"taskId":"ok","task":"t","skills":[],"findings":0,"hallucinated":0,"scores":{"relevance":3,"accuracy":3,"uniqueness":3},"warmth":1,"importance":0.6,"timestamp":"2026-03-22T00:00:00Z"}\nALSO BAD\n'
      );
      const gen = new BootstrapGenerator(dir);
      const result = gen.generate();
      expect(result.prompt).toContain('1 tasks'); // only the valid line counted
    });
  });

  describe('config migration', () => {
    it('copies gossip.agents.json to .gossip/config.json on first run', () => {
      const dir = join(testDir, 'migrate');
      mkdirSync(dir, { recursive: true });
      const config = { main_agent: { provider: 'local', model: 'q' }, agents: { 'a1': { provider: 'local', model: 'q', skills: ['t'] } } };
      writeFileSync(join(dir, 'gossip.agents.json'), JSON.stringify(config));

      const gen = new BootstrapGenerator(dir);
      gen.generate();

      expect(existsSync(join(dir, '.gossip', 'config.json'))).toBe(true);
      expect(existsSync(join(dir, 'gossip.agents.json'))).toBe(true); // old file preserved
    });

    it('does not overwrite existing .gossip/config.json', () => {
      const dir = join(testDir, 'no-overwrite');
      mkdirSync(join(dir, '.gossip'), { recursive: true });
      writeFileSync(join(dir, '.gossip', 'config.json'), '{"new": true}');
      writeFileSync(join(dir, 'gossip.agents.json'), '{"old": true}');

      const gen = new BootstrapGenerator(dir);
      gen.generate(); // should NOT overwrite

      const content = readFileSync(join(dir, '.gossip', 'config.json'), 'utf-8');
      expect(content).toContain('"new"');
    });
  });

  describe('tool claim verification', () => {
    it('annotates TODO lines when tool exists in MCP server', () => {
      const dir = join(testDir, 'verify-tools');
      mkdirSync(join(dir, '.gossip'), { recursive: true });
      mkdirSync(join(dir, 'apps', 'cli', 'src'), { recursive: true });

      // Write a config so bootstrap generates a full prompt
      writeFileSync(join(dir, '.gossip', 'config.json'), JSON.stringify({
        main_agent: { provider: 'local', model: 'q' },
        agents: { 'a1': { provider: 'local', model: 'q', skills: ['t'] } }
      }));

      // Write next-session.md with a TODO mentioning a tool
      writeFileSync(join(dir, '.gossip', 'next-session.md'),
        '## Remaining\n- gossip_foo — TODO: needs implementation\n- gossip_bar — pending feature\n'
      );

      // Write a fake MCP server source that registers gossip_foo but not gossip_bar
      writeFileSync(join(dir, 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
        "server.tool('gossip_foo', 'does stuff', {}, async () => {});\n" +
        "// gossip_bar is just mentioned in a comment\n"
      );

      const gen = new BootstrapGenerator(dir);
      const result = gen.generate();

      // gossip_foo should be annotated as shipped
      expect(result.prompt).toContain('verified: gossip_foo exists');
      // gossip_bar should NOT be annotated (only in a comment)
      expect(result.prompt).not.toContain('verified: gossip_bar');
      // gossip_bar line should still be present unmodified
      expect(result.prompt).toContain('gossip_bar — pending feature');
    });

    it('passes through content unchanged when MCP source is missing', () => {
      const dir = join(testDir, 'verify-no-mcp');
      mkdirSync(join(dir, '.gossip'), { recursive: true });

      writeFileSync(join(dir, '.gossip', 'config.json'), JSON.stringify({
        main_agent: { provider: 'local', model: 'q' },
        agents: { 'a1': { provider: 'local', model: 'q', skills: ['t'] } }
      }));

      writeFileSync(join(dir, '.gossip', 'next-session.md'),
        '- gossip_missing — TODO: build this\n'
      );
      // No apps/cli/src/mcp-server-sdk.ts — should pass through unchanged

      const gen = new BootstrapGenerator(dir);
      const result = gen.generate();
      expect(result.prompt).toContain('gossip_missing — TODO: build this');
      expect(result.prompt).not.toContain('*(verified:');
    });

    it('does not annotate lines without TODO/remaining/pending keywords', () => {
      const dir = join(testDir, 'verify-no-keyword');
      mkdirSync(join(dir, '.gossip'), { recursive: true });
      mkdirSync(join(dir, 'apps', 'cli', 'src'), { recursive: true });

      writeFileSync(join(dir, '.gossip', 'config.json'), JSON.stringify({
        main_agent: { provider: 'local', model: 'q' },
        agents: { 'a1': { provider: 'local', model: 'q', skills: ['t'] } }
      }));

      writeFileSync(join(dir, '.gossip', 'next-session.md'),
        '- SHIPPED: gossip_run works great\n'
      );

      writeFileSync(join(dir, 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
        "server.tool('gossip_run', 'run stuff', {}, async () => {});\n"
      );

      const gen = new BootstrapGenerator(dir);
      const result = gen.generate();
      // No TODO keyword, so no annotation even though tool exists
      expect(result.prompt).not.toContain('*(verified:');
      expect(result.prompt).toContain('SHIPPED: gossip_run works great');
    });
  });
});
