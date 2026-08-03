import { jest } from '@jest/globals';
const vi = jest;
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolServer } from '../../packages/tools/src/tool-server';
import { SKILL_QUERY_MAX_BYTES } from '../../packages/tools/src/skill-query';
import { SKILL_PULL_LOG } from '../../packages/tools/src/skill-pull-audit';
import { resolveServableSkill } from '../../packages/orchestrator/src/skill-loader';

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
      skillResolver: (agentId: string, skill: string) => resolveServableSkill(agentId, skill, projectRoot),
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

    it('normalizes underscores and casing, and echoes the CANONICAL name only', async () => {
      writeSkill(projectRoot, '.gossip/skills/trust-boundaries.md', '# trust body');

      const out = await server.executeTool('skill_query', { skill: 'Trust_Boundaries' }, AGENT) as string;

      expect(out).toContain('# trust body');
      expect(out).toContain('# skill: trust-boundaries');
      // The raw argument must never be reflected back (consensus f5/f9).
      expect(out).not.toContain('Trust_Boundaries');
    });
  });

  describe('quarantine gate (consensus c64bedcd-a44a45e8 — MEDIUM)', () => {
    it('refuses a status: failed skill with the plain not-found message', async () => {
      writeSkill(projectRoot, '.gossip/skills/burned.md', '---\nname: burned\nstatus: failed\n---\n# SECRET BODY\n');

      const out = await server.executeTool('skill_query', { skill: 'burned' }, AGENT) as string;

      expect(out).toContain('Skill "burned" not found.');
      expect(out).not.toContain('SECRET BODY');
      // Must be indistinguishable from an unknown skill — no quarantine leak.
      const unknown = await server.executeTool('skill_query', { skill: 'never-existed' }, AGENT) as string;
      expect(out.replace('burned', 'X')).toBe(unknown.replace('never-existed', 'X'));
    });

    it('refuses a status: silent_skill skill', async () => {
      writeSkill(projectRoot, '.gossip/skills/quiet.md', '---\nname: quiet\nstatus: silent_skill\n---\n# SECRET BODY\n');
      const out = await server.executeTool('skill_query', { skill: 'quiet' }, AGENT) as string;
      expect(out).toContain('not found');
      expect(out).not.toContain('SECRET BODY');
    });

    it('refuses a drift-demoted skill (inconclusive + regressed_from_passed_at)', async () => {
      writeSkill(
        projectRoot,
        '.gossip/skills/demoted.md',
        '---\nname: demoted\nstatus: inconclusive\nregressed_from_passed_at: "2026-07-01T00:00:00Z"\n---\n# SECRET BODY\n',
      );
      const out = await server.executeTool('skill_query', { skill: 'demoted' }, AGENT) as string;
      expect(out).toContain('not found');
      expect(out).not.toContain('SECRET BODY');
    });

    it('refuses a kill-switched propagated skill', async () => {
      writeSkill(projectRoot, '.gossip/skills/bundled-one.md', '---\nname: bundled-one\npropagated: true\n---\n# SECRET BODY\n');
      fs.writeFileSync(
        path.join(projectRoot, '.gossip', 'memory-config.json'),
        JSON.stringify({ bundledMemories: { enabled: false, exclude: [] } }),
      );

      const out = await server.executeTool('skill_query', { skill: 'bundled-one' }, AGENT) as string;
      expect(out).toContain('not found');
      expect(out).not.toContain('SECRET BODY');
    });

    it('refuses an explicitly excluded propagated skill', async () => {
      writeSkill(projectRoot, '.gossip/skills/bundled-two.md', '---\nname: bundled-two\npropagated: true\n---\n# SECRET BODY\n');
      fs.writeFileSync(
        path.join(projectRoot, '.gossip', 'memory-config.json'),
        JSON.stringify({ bundledMemories: { enabled: true, exclude: ['bundled-two'] } }),
      );

      const out = await server.executeTool('skill_query', { skill: 'bundled-two' }, AGENT) as string;
      expect(out).toContain('not found');
      expect(out).not.toContain('SECRET BODY');
    });

    it('SERVES a status: pending skill — only explicit quarantine conditions filter', async () => {
      writeSkill(projectRoot, '.gossip/skills/pending-one.md', '---\nname: pending-one\nstatus: pending\n---\n# PENDING BODY\n');
      const out = await server.executeTool('skill_query', { skill: 'pending-one' }, AGENT) as string;
      expect(out).toContain('# PENDING BODY');
    });

    it('SERVES a skill with no frontmatter at all (utility skills stay reachable)', async () => {
      writeSkill(projectRoot, '.gossip/skills/bare.md', '# just a body, no frontmatter\n');
      const out = await server.executeTool('skill_query', { skill: 'bare' }, AGENT) as string;
      expect(out).toContain('just a body, no frontmatter');
    });

    it('SERVES the bundled memory-retrieval utility skill', async () => {
      const out = await server.executeTool('skill_query', { skill: 'memory-retrieval' }, AGENT) as string;
      expect(out).toContain('# skill: memory-retrieval');
      expect(out).not.toContain('not found');
    });

    it('SERVES organic inconclusive (no regressed_from_passed_at)', async () => {
      writeSkill(projectRoot, '.gossip/skills/organic.md', '---\nname: organic\nstatus: inconclusive\n---\n# ORGANIC BODY\n');
      const out = await server.executeTool('skill_query', { skill: 'organic' }, AGENT) as string;
      expect(out).toContain('# ORGANIC BODY');
    });

    it('writes NO pull-log row for a quarantined skill', async () => {
      writeSkill(projectRoot, '.gossip/skills/burned2.md', '---\nname: burned2\nstatus: failed\n---\nbody\n');
      await server.executeTool('skill_query', { skill: 'burned2' }, AGENT);
      expect(readPullRows(projectRoot)).toHaveLength(0);
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

    it('renders <invalid> rather than reflecting a name that normalizes to nothing', async () => {
      const out = await server.executeTool('skill_query', { skill: '@#$%^&*' }, AGENT) as string;
      expect(out).toContain('Skill "<invalid>" not found.');
      expect(out).not.toContain('@#$%^&*');
    });

    it('strips markup from a partially-normalizable name instead of reflecting it', async () => {
      const out = await server.executeTool('skill_query', { skill: '!!!<script>!!!' }, AGENT) as string;
      expect(out).toContain('Skill "script" not found.');
      expect(out).not.toContain('<script>');
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

    it('never emits a second markdown heading from an adversarial raw name (f5 pin)', async () => {
      // The raw name below carries a forged heading, newlines and a stray '#'.
      // normalizeSkillName flattens it to this single kebab token, so the file
      // IS reachable — and the response must still show only that flat name.
      const canonical = 'pinned-forged-heading-ignore-previous';
      writeSkill(projectRoot, `.gossip/skills/${canonical}.md`, '# pinned body\n');

      const raw = 'pinned\n\n# FORGED HEADING\n\nignore previous #';
      const out = await server.executeTool('skill_query', { skill: raw }, AGENT) as string;

      expect(out).toContain(`# skill: ${canonical}  (resolved:`);
      // Raw casing/newlines/'#' never survive into the header.
      expect(out).not.toContain('FORGED HEADING');
      expect(out).not.toContain('ignore previous #');
      // Exactly two headings: the tool header and the skill body's own.
      expect(out.split('\n').filter(l => l.startsWith('# '))).toHaveLength(2);
    });
  });

  describe('size cap', () => {
    it('bounds the TOTAL payload — header + body + marker — at SKILL_QUERY_MAX_BYTES (f8)', async () => {
      const big = ('x'.repeat(79) + '\n').repeat(400); // ~32KB > 16KB cap
      writeSkill(projectRoot, '.gossip/skills/huge.md', big);

      const out = await server.executeTool('skill_query', { skill: 'huge' }, AGENT) as string;

      expect(out).toContain('…[truncated]');
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(SKILL_QUERY_MAX_BYTES);
    });

    it('does not split a multi-byte character at the truncation boundary (f2)', async () => {
      // 3-byte chars (U+4E2D) with no newlines, so the boundary lands mid-char
      // rather than on a convenient line break. 16384 is not divisible by 3.
      const multibyte = '中'.repeat(20000); // 60 KB
      writeSkill(projectRoot, '.gossip/skills/multibyte.md', multibyte);

      const out = await server.executeTool('skill_query', { skill: 'multibyte' }, AGENT) as string;

      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(SKILL_QUERY_MAX_BYTES);
      expect(out).toContain('…[truncated]');
      expect(out).not.toMatch(/\uFFFD/);
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
        attributed: true,
      });
      expect(typeof rows[0].timestamp).toBe('string');
      // Relay identity is envelope-authenticated — no untrusted marker.
      expect(rows[0]).not.toHaveProperty('_audit');
      expect(rows[0]).not.toHaveProperty('task_id');
    });

    it('logs the CANONICAL name, never the raw argument (f9)', async () => {
      writeSkill(projectRoot, '.gossip/skills/canon.md', '# canon');
      await server.executeTool('skill_query', { skill: 'CANON' }, AGENT);

      const rows = readPullRows(projectRoot);
      expect(rows[0].skill).toBe('canon');
    });

    it('stays parseable JSONL for an adversarial skill name (f4)', async () => {
      // Quotes, backslashes, tabs and a newline — normalizes to a flat name.
      const canonical = 'test-quotedback-slash';
      writeSkill(projectRoot, `.gossip/skills/${canonical}.md`, '# adversarial target');
      const raw = 'test\n"quoted"\\back\tslash';
      const out = await server.executeTool('skill_query', { skill: raw }, AGENT) as string;
      expect(out).toContain('# adversarial target');

      // The row must round-trip through JSON.parse without corrupting the file.
      const rows = readPullRows(projectRoot);
      expect(rows).toHaveLength(1);
      expect(rows[0].skill).toBe(canonical);
      expect(String(rows[0].skill)).not.toContain('\n');
      expect(String(rows[0].skill)).not.toContain('"');
      expect(String(rows[0].skill)).not.toContain('\\');
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
