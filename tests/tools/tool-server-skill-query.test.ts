import { jest } from '@jest/globals';
const vi = jest;
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolServer } from '../../packages/tools/src/tool-server';
import { SKILL_QUERY_MAX_BYTES } from '../../packages/tools/src/skill-query';
import { SKILL_PULL_LOG } from '../../packages/tools/src/skill-pull-audit';
import { resolveSkill } from '../../packages/orchestrator/src/skill-loader';

// Mock GossipAgent to avoid an actual relay connection.
vi.mock('@gossip/client', () => ({
  GossipAgent: class {
    agentId = 'tool-server';
    async connect() {}
    async disconnect() {}
    on() {}
    async sendEnvelope() {}
  },
}));

const AGENT = 'agent-a';

function writeSkill(root: string, rel: string, body: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

function readPullRows(root: string): Array<Record<string, unknown>> {
  const logPath = path.join(root, '.gossip', SKILL_PULL_LOG);
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('ToolServer skill_query (issue #715 / #698 part 2)', () => {
  let server: ToolServer;
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-skill-query-')));
    fs.mkdirSync(path.join(projectRoot, '.gossip'), { recursive: true });
    server = new ToolServer({
      relayUrl: 'ws://localhost:0',
      projectRoot,
      allowedCallers: [AGENT],
      skillResolver: (agentId: string, skill: string) => resolveSkill(agentId, skill, projectRoot),
    });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('resolution across the three scopes', () => {
    it('resolves an agent-local skill and prefers it over a project-wide file of the same name', async () => {
      writeSkill(projectRoot, '.gossip/skills/shadowed.md', '# project-wide copy');
      const localPath = writeSkill(projectRoot, `.gossip/agents/${AGENT}/skills/shadowed.md`, '# agent-local copy');

      const out = await server.executeTool('skill_query', { skill: 'shadowed' }, AGENT) as string;

      expect(out).toContain('# agent-local copy');
      expect(out).not.toContain('# project-wide copy');
      expect(out).toContain(`# skill: shadowed  (resolved: ${localPath})`);
    });

    it('falls through to the project-wide scope when there is no agent-local file', async () => {
      const projPath = writeSkill(projectRoot, '.gossip/skills/project-only.md', '# project-wide body');

      const out = await server.executeTool('skill_query', { skill: 'project-only' }, AGENT) as string;

      expect(out).toContain('# project-wide body');
      expect(out).toContain(`(resolved: ${projPath})`);
    });

    it('falls through to the bundled default-skills directory last', async () => {
      const out = await server.executeTool('skill_query', { skill: 'implementation-discipline' }, AGENT) as string;

      expect(out).toContain('# skill: implementation-discipline');
      expect(out).toContain(path.join('default-skills', 'implementation-discipline.md'));
    });

    it('normalizes underscores and casing to the canonical kebab name', async () => {
      writeSkill(projectRoot, '.gossip/skills/trust-boundaries.md', '# trust body');

      const out = await server.executeTool('skill_query', { skill: 'Trust_Boundaries' }, AGENT) as string;

      expect(out).toContain('# trust body');
      // Header echoes the name as requested, matching gossip_skills(action:"get").
      expect(out).toContain('# skill: Trust_Boundaries');
    });
  });

  describe('not-found', () => {
    it('names every searched scope and does not throw', async () => {
      const out = await server.executeTool('skill_query', { skill: 'no-such-skill-xyz' }, AGENT) as string;

      expect(out).toContain('Skill "no-such-skill-xyz" not found.');
      expect(out).toContain(`.gossip/agents/${AGENT}/skills`);
      expect(out).toContain('.gossip/skills');
      expect(out).toContain('default-skills');
    });

    it('writes NO pull-log row for a miss', async () => {
      await server.executeTool('skill_query', { skill: 'no-such-skill-xyz' }, AGENT);
      expect(readPullRows(projectRoot)).toHaveLength(0);
    });
  });

  describe('trust boundary', () => {
    it('refuses without a caller identity rather than resolving for an anonymous caller', async () => {
      writeSkill(projectRoot, '.gossip/skills/anon.md', '# anon body');
      const out = await server.executeTool('skill_query', { skill: 'anon' }, undefined) as string;

      expect(out).toContain('requires a caller identity');
      expect(out).not.toContain('# anon body');
    });

    it('rejects an agent_id argument — identity comes from the envelope, never the args', async () => {
      await expect(
        server.executeTool('skill_query', { skill: 'anon', agent_id: 'other-agent' }, AGENT),
      ).rejects.toThrow(/Invalid args for tool "skill_query"/);
    });

    it('reports unavailable (not a crash) when no resolver is injected', async () => {
      const bare = new ToolServer({ relayUrl: 'ws://localhost:0', projectRoot });
      const out = await bare.executeTool('skill_query', { skill: 'anything' }, AGENT) as string;
      expect(out).toContain('skill_query unavailable');
    });
  });

  describe('size cap', () => {
    it('truncates content over SKILL_QUERY_MAX_BYTES and appends the marker', async () => {
      const big = ('x'.repeat(79) + '\n').repeat(400); // ~32KB > 16KB cap
      writeSkill(projectRoot, '.gossip/skills/huge.md', big);

      const out = await server.executeTool('skill_query', { skill: 'huge' }, AGENT) as string;

      expect(out).toContain('…[truncated]');
      const body = out.slice(out.indexOf('\n\n') + 2).replace(/\n…\[truncated\]$/, '');
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(SKILL_QUERY_MAX_BYTES);
    });

    it('leaves a small skill untouched', async () => {
      writeSkill(projectRoot, '.gossip/skills/small.md', '# small\n\nbody line\n');
      const out = await server.executeTool('skill_query', { skill: 'small' }, AGENT) as string;

      expect(out).toContain('body line');
      expect(out).not.toContain('…[truncated]');
    });
  });

  describe('pull observability (.gossip/skill-pulls.jsonl)', () => {
    it('appends one row per successful pull with the expected fields', async () => {
      const p = writeSkill(projectRoot, '.gossip/skills/logged.md', '# logged');
      await server.executeTool('skill_query', { skill: 'logged' }, AGENT);

      const rows = readPullRows(projectRoot);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        agent_id: AGENT,
        skill: 'logged',
        resolved_path: p,
        runtime: 'relay',
      });
      expect(typeof rows[0].timestamp).toBe('string');
      expect(rows[0]).not.toHaveProperty('task_id');
    });

    it('fails open — a log write error does not break the tool call', async () => {
      writeSkill(projectRoot, '.gossip/skills/failopen.md', '# failopen body');
      // Replace .gossip with a regular file so appendFileSync cannot create the log.
      fs.rmSync(path.join(projectRoot, '.gossip'), { recursive: true, force: true });
      fs.writeFileSync(path.join(projectRoot, '.gossip'), 'not a directory');

      // Resolution now misses the project-wide scope, so use a bundled default.
      const out = await server.executeTool('skill_query', { skill: 'implementation-discipline' }, AGENT) as string;
      expect(out).toContain('# skill: implementation-discipline');
    });
  });
});
