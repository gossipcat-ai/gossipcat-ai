/**
 * gossip_skill_query — native-runtime on-demand skill fetch (issue #715 / #698 part 2).
 *
 * The handler is inline in the giant mcp-server-sdk.ts registration block, so
 * its structural invariants (registered, read-only schema, agent_id gate wired,
 * granted to generated native agents) are guarded by source inspection — the
 * same technique setup-config-preservation.test.ts uses for the f15 ordering
 * invariant. The payload itself is a pure function and is tested directly.
 */
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { resolveSkill, resolveServableSkill } from '@gossip/orchestrator';
import { formatSkillPayload, formatSkillNotFound } from '@gossip/tools';
import { isReservedAgentId } from '../../apps/cli/src/reserved-ids';

const PROJECT_ROOT = resolve(__dirname, '..', '..');
const SDK_SOURCE = readFileSync(join(PROJECT_ROOT, 'apps', 'cli', 'src', 'mcp-server-sdk.ts'), 'utf8');

/** Slice the source of the gossip_skill_query registration block. */
function skillQueryBlock(): string {
  const start = SDK_SOURCE.indexOf("'gossip_skill_query',");
  expect(start).toBeGreaterThan(-1);
  // The block ends at the next `server.tool(` registration.
  const nextTool = SDK_SOURCE.indexOf('server.tool(', start);
  return SDK_SOURCE.slice(start, nextTool === -1 ? SDK_SOURCE.length : nextTool);
}

describe('gossip_skill_query registration', () => {
  it('is registered as an MCP tool', () => {
    expect(SDK_SOURCE).toContain("server.tool(\n    'gossip_skill_query',");
  });

  it('declares only agent_id and skill — no mutating args in the schema', () => {
    const block = skillQueryBlock();
    const argLine = block.match(/async \(\{([^}]*)\}\)/);
    expect(argLine).not.toBeNull();
    const args = argLine![1].split(',').map(s => s.trim()).filter(Boolean).sort();
    expect(args).toEqual(['agent_id', 'skill']);
    // Nothing that could bind, unbind, enable, or regenerate a skill.
    for (const mutating of ['enabled', 'action', 'category', 'skills:', 'force']) {
      expect(block).not.toContain(mutating);
    }
  });

  it('is read-only — no bind/unbind/develop/index mutation in the handler body', () => {
    const block = skillQueryBlock();
    for (const mutator of ['.bind(', '.unbind(', 'getSkillIndex', 'SkillEngine', 'writeFileSync']) {
      expect(block).not.toContain(mutator);
    }
  });

  it('applies the same agent_id regex + reserved-id gate as gossip_remember', () => {
    const block = skillQueryBlock();
    expect(block).toContain('/^[a-zA-Z0-9_-]{1,64}$/.test(agent_id)');
    expect(block).toContain('isReservedAgentId(agent_id)');
  });

  it('records a pull row on success only (after the not-found early return)', () => {
    const block = skillQueryBlock();
    const notFoundIdx = block.indexOf('formatSkillNotFound');
    const recordIdx = block.indexOf('recordSkillPull');
    expect(notFoundIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(notFoundIdx);
    expect(block).toContain("runtime: 'native'");
  });

  it('routes through resolveServableSkill — the quarantine-gated resolver, never the bare one', () => {
    const block = skillQueryBlock();
    expect(block).toContain('resolveServableSkill(agent_id, skill, projectRoot)');
    expect(block).not.toMatch(/\bresolveSkill\(/);
  });

  it('echoes only the canonical name — the raw skill arg never reaches output (f5/f9)', () => {
    const block = skillQueryBlock();
    expect(block).toContain('formatSkillNotFound(canonicalName, agent_id)');
    expect(block).toContain('formatSkillPayload(canonicalName, resolved)');
    expect(block).toContain('skill: canonicalName,');
  });

  it('tags native pull rows as self-attested (f11)', () => {
    expect(skillQueryBlock()).toContain('attributed: false');
  });

  it('injects the gated resolver into the relay ToolServer, not the bare resolveSkill', () => {
    expect(SDK_SOURCE).toContain('m.resolveServableSkill(agentId, skill, process.cwd())');
  });

  it('is granted to every native agent gossip_setup generates', () => {
    expect(SDK_SOURCE).toContain(
      "const tools = ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'mcp__gossipcat__gossip_remember', 'mcp__gossipcat__gossip_skill_query'];",
    );
  });
});

describe('gossip_skill_query agent_id gate behaviour', () => {
  const GATE = /^[a-zA-Z0-9_-]{1,64}$/;

  it.each([
    ['../evil', 'path traversal'],
    ['agent/../../etc', 'nested traversal'],
    ['', 'empty'],
    ['a'.repeat(65), 'over length'],
    ['agent id', 'whitespace'],
    ['agent.id', 'dot'],
  ])('rejects %s (%s)', (id) => {
    expect(GATE.test(id)).toBe(false);
  });

  it('accepts a normal agent id', () => {
    expect(GATE.test('opus-implementer')).toBe(true);
    expect(isReservedAgentId('opus-implementer')).toBe(false);
  });

  it('rejects reserved underscore-prefixed ids other than _project', () => {
    expect(isReservedAgentId('_internal')).toBe(true);
  });
});

describe('gossip_skill_query payload matches gossip_skills(action:"get")', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'gossip-skill-query-mcp-')));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces the byte-identical header + body that action:"get" returns', () => {
    const dir = join(tmpDir, '.gossip', 'agents', 'agent-a', 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'my-skill.md'), '# My Skill\n\nbody\n');

    const resolved = resolveSkill('agent-a', 'my-skill', tmpDir);
    expect(resolved).not.toBeNull();

    // This is the exact expression mcp-server-sdk.ts uses for action:"get".
    const getOutput = `# skill: my-skill  (resolved: ${resolved!.path})\n\n${resolved!.content}`;
    expect(formatSkillPayload('my-skill', resolved!)).toBe(getOutput);
  });

  it('names all three searched scopes on a miss', () => {
    const msg = formatSkillNotFound('nope', 'agent-a');
    expect(msg).toContain('.gossip/agents/agent-a/skills');
    expect(msg).toContain('.gossip/skills');
    expect(msg).toContain('default-skills');
  });
});

describe('gossip_skill_query quarantine gate (native path)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'gossip-skill-query-quarantine-')));
    mkdirSync(join(tmpDir, '.gossip', 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (name: string, body: string) =>
    writeFileSync(join(tmpDir, '.gossip', 'skills', `${name}.md`), body);

  it('withholds a status: failed skill from the native path too', () => {
    write('burned', '---\nname: burned\nstatus: failed\n---\nSECRET\n');
    // Sanity: the bare resolver WOULD have served it — the gate is what stops it.
    expect(resolveSkill('agent-a', 'burned', tmpDir)).not.toBeNull();
    expect(resolveServableSkill('agent-a', 'burned', tmpDir).skill).toBeNull();
  });

  it('withholds a kill-switched propagated skill', () => {
    write('bundled', '---\nname: bundled\npropagated: true\n---\nSECRET\n');
    writeFileSync(
      join(tmpDir, '.gossip', 'memory-config.json'),
      JSON.stringify({ bundledMemories: { enabled: false, exclude: [] } }),
    );
    expect(resolveServableSkill('agent-a', 'bundled', tmpDir).skill).toBeNull();
  });

  it('serves a pending skill and a no-frontmatter skill', () => {
    write('pending-one', '---\nname: pending-one\nstatus: pending\n---\nBODY\n');
    write('bare', 'no frontmatter here\n');
    expect(resolveServableSkill('agent-a', 'pending-one', tmpDir).skill).not.toBeNull();
    expect(resolveServableSkill('agent-a', 'bare', tmpDir).skill).not.toBeNull();
  });

  it('returns the canonical name even when the skill is withheld or unknown', () => {
    write('burned2', '---\nname: burned2\nstatus: failed\n---\nSECRET\n');
    expect(resolveServableSkill('agent-a', 'BURNED_2', tmpDir).canonicalName).toBe('burned-2');
    expect(resolveServableSkill('agent-a', 'Unknown_Thing', tmpDir)).toEqual({
      canonicalName: 'unknown-thing',
      skill: null,
    });
  });
});
