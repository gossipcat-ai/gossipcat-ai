/**
 * Issue #698 part 3 — read-only bridge from Claude Code project skills
 * (`.claude/skills/<name>/SKILL.md`) into gossipcat skill resolution.
 *
 * The bridge adds ONE base to the resolution chain, ordered AFTER project-wide
 * `.gossip/skills` and BEFORE bundled `default-skills`. It is directory-per-
 * skill rather than flat, so these tests pin:
 *   1. resolution actually reaches the new layout (resolveSkill / resolveSharedSkill)
 *   2. precedence in both directions (loses to .gossip, beats bundled defaults)
 *   3. containment survives the extra path segment
 *   4. the shared quarantine predicate applies here too
 *   5. dispatch-time injection eligibility is UNCHANGED — pull-only
 */
import {
  resolveSkill,
  resolveSharedSkill,
  resolveServableSkill,
  listAvailableSkills,
  loadSkills,
} from '../../packages/orchestrator/src/skill-loader';
import { SkillIndex } from '../../packages/orchestrator/src/skill-index';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'gossip-claude-skills-')));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write `.claude/skills/<name>/SKILL.md` — the Claude Code project-skill layout. */
function writeClaudeSkill(name: string, body: string): string {
  const dir = join(tmpDir, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, body);
  return path;
}

/** Write `.gossip/skills/<name>.md` — the project-wide gossipcat base. */
function writeGossipSkill(name: string, body: string): string {
  const dir = join(tmpDir, '.gossip', 'skills');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, body);
  return path;
}

/** Write `.gossip/agents/<agent>/skills/<name>.md` — the agent-local base. */
function writeAgentSkill(agent: string, name: string, body: string): string {
  const dir = join(tmpDir, '.gossip', 'agents', agent, 'skills');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, body);
  return path;
}

/** A realistic Claude Code SKILL.md: name + description frontmatter, NO status. */
function claudeFrontmatter(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: A user-authored Claude Code skill\n---\n\n${body}\n`;
}

describe('resolution reaches .claude/skills/<name>/SKILL.md', () => {
  it('resolveSkill resolves a Claude Code project skill', () => {
    const path = writeClaudeSkill('deploy-runbook', claudeFrontmatter('deploy-runbook', 'CLAUDE CODE BODY'));
    const resolved = resolveSkill('agent-a', 'deploy-runbook', tmpDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.content).toContain('CLAUDE CODE BODY');
    expect(resolved!.path).toBe(path);
  });

  it('resolveSharedSkill (no agent_id) resolves it too', () => {
    writeClaudeSkill('deploy-runbook', claudeFrontmatter('deploy-runbook', 'CLAUDE CODE BODY'));
    const resolved = resolveSharedSkill('deploy-runbook', tmpDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.content).toContain('CLAUDE CODE BODY');
  });

  it('normalizes the requested name before probing the directory segment', () => {
    writeClaudeSkill('deploy-runbook', claudeFrontmatter('deploy-runbook', 'CLAUDE CODE BODY'));
    expect(resolveSkill('agent-a', 'Deploy_Runbook', tmpDir)).not.toBeNull();
    expect(resolveServableSkill('agent-a', 'Deploy_Runbook', tmpDir).canonicalName).toBe('deploy-runbook');
  });

  it('a directory without SKILL.md does not resolve', () => {
    mkdirSync(join(tmpDir, '.claude', 'skills', 'empty-dir'), { recursive: true });
    expect(resolveSkill('agent-a', 'empty-dir', tmpDir)).toBeNull();
  });

  it('a flat .claude/skills/<name>.md is NOT the supported layout', () => {
    mkdirSync(join(tmpDir, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(tmpDir, '.claude', 'skills', 'flat-one.md'), 'FLAT BODY');
    expect(resolveSkill('agent-a', 'flat-one', tmpDir)).toBeNull();
  });

  it('not-found is unchanged when the skill exists in no base at all', () => {
    expect(resolveSkill('agent-a', 'nothing-anywhere-xyz', tmpDir)).toBeNull();
    expect(resolveSharedSkill('nothing-anywhere-xyz', tmpDir)).toBeNull();
    expect(resolveServableSkill('agent-a', 'nothing-anywhere-xyz', tmpDir)).toEqual({
      canonicalName: 'nothing-anywhere-xyz',
      skill: null,
    });
  });
});

describe('precedence', () => {
  it('.gossip/skills wins over .claude/skills for the same name', () => {
    const gossipPath = writeGossipSkill('shared-name', 'GOSSIP NATIVE BODY');
    writeClaudeSkill('shared-name', claudeFrontmatter('shared-name', 'CLAUDE CODE BODY'));

    for (const resolved of [resolveSkill('agent-a', 'shared-name', tmpDir), resolveSharedSkill('shared-name', tmpDir)]) {
      expect(resolved!.path).toBe(gossipPath);
      expect(resolved!.content).toContain('GOSSIP NATIVE BODY');
      expect(resolved!.content).not.toContain('CLAUDE CODE BODY');
    }
  });

  it('agent-local wins over both .gossip/skills and .claude/skills', () => {
    const agentPath = writeAgentSkill('agent-a', 'shared-name', 'AGENT LOCAL BODY');
    writeGossipSkill('shared-name', 'GOSSIP NATIVE BODY');
    writeClaudeSkill('shared-name', claudeFrontmatter('shared-name', 'CLAUDE CODE BODY'));

    const resolved = resolveSkill('agent-a', 'shared-name', tmpDir);
    expect(resolved!.path).toBe(agentPath);
    expect(resolved!.content).toContain('AGENT LOCAL BODY');
  });

  it('.claude/skills wins over a bundled default of the same name', () => {
    // `typescript` ships in packages/orchestrator/src/default-skills/.
    const bundled = resolveSkill('agent-a', 'typescript', tmpDir);
    expect(bundled).not.toBeNull();
    expect(bundled!.path).toContain('default-skills');

    const claudePath = writeClaudeSkill('typescript', claudeFrontmatter('typescript', 'CLAUDE CODE OVERRIDE'));
    const overridden = resolveSkill('agent-a', 'typescript', tmpDir);
    expect(overridden!.path).toBe(claudePath);
    expect(overridden!.content).toContain('CLAUDE CODE OVERRIDE');
  });
});

describe('containment holds for the directory-per-skill layout', () => {
  it.each([
    ['../evil', 'parent escape'],
    ['../../etc/passwd', 'deep parent escape'],
    ['foo/../../bar', 'mid-name escape'],
    ['/etc/passwd', 'absolute path'],
    ['.', 'dot'],
    ['..', 'dot dot'],
    ['', 'empty'],
  ])('rejects %s (%s) without escaping the base', (name) => {
    // Plant a file that a naive join would reach from `.claude/skills`.
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(join(tmpDir, '.claude', 'SKILL.md'), 'ESCAPED CONTENT');
    mkdirSync(join(tmpDir, '.claude', 'skills'), { recursive: true });

    const resolved = resolveSkill('agent-a', name, tmpDir);
    if (resolved) expect(resolved.content).not.toContain('ESCAPED CONTENT');
    expect(resolveServableSkill('agent-a', name, tmpDir).skill).toBeNull();
  });

  it('a traversal-shaped name normalizes to an inert in-base name, never an escape', () => {
    // `../evil` normalizes to `evil` — so it can only ever reach
    // `.claude/skills/evil/SKILL.md`, which is inside the base.
    writeClaudeSkill('evil', claudeFrontmatter('evil', 'IN BASE BODY'));
    const resolved = resolveSkill('agent-a', '../evil', tmpDir);
    expect(resolved!.path).toBe(join(tmpDir, '.claude', 'skills', 'evil', 'SKILL.md'));
    expect(resolved!.content).toContain('IN BASE BODY');
  });
});

describe('quarantine applies to the .claude/skills base', () => {
  it('a plain Claude Code skill (name/description, no status) is servable', () => {
    writeClaudeSkill('runbook', claudeFrontmatter('runbook', 'SERVABLE BODY'));
    const result = resolveServableSkill('agent-a', 'runbook', tmpDir);
    expect(result.skill).not.toBeNull();
    expect(result.skill!.content).toContain('SERVABLE BODY');
  });

  it('withholds a status: failed Claude Code skill', () => {
    writeClaudeSkill('burned', '---\nname: burned\nstatus: failed\n---\nSECRET\n');
    // Sanity: the bare resolver WOULD have served it — the gate is what stops it.
    expect(resolveSkill('agent-a', 'burned', tmpDir)).not.toBeNull();
    expect(resolveServableSkill('agent-a', 'burned', tmpDir).skill).toBeNull();
  });

  it('withholds a status: silent_skill Claude Code skill', () => {
    writeClaudeSkill('quiet', '---\nname: quiet\nstatus: silent_skill\n---\nSECRET\n');
    expect(resolveServableSkill('agent-a', 'quiet', tmpDir).skill).toBeNull();
  });

  it('the kill-switch applies — propagated skill under bundledMemories.enabled=false', () => {
    writeClaudeSkill('bundled', '---\nname: bundled\npropagated: true\n---\nSECRET\n');
    mkdirSync(join(tmpDir, '.gossip'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.gossip', 'memory-config.json'),
      JSON.stringify({ bundledMemories: { enabled: false, exclude: [] } }),
    );
    expect(resolveServableSkill('agent-a', 'bundled', tmpDir).skill).toBeNull();
  });

  it('the exclude list applies — propagated skill named in bundledMemories.exclude', () => {
    writeClaudeSkill('excluded-one', '---\nname: excluded-one\npropagated: true\n---\nSECRET\n');
    writeClaudeSkill('kept-one', '---\nname: kept-one\npropagated: true\n---\nKEPT BODY\n');
    mkdirSync(join(tmpDir, '.gossip'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.gossip', 'memory-config.json'),
      JSON.stringify({ bundledMemories: { enabled: true, exclude: ['excluded-one'] } }),
    );
    expect(resolveServableSkill('agent-a', 'excluded-one', tmpDir).skill).toBeNull();
    expect(resolveServableSkill('agent-a', 'kept-one', tmpDir).skill).not.toBeNull();
  });
});

describe('pull-only — dispatch-time injection eligibility is unchanged', () => {
  it('a .claude/skills entry is never injected on its own (no index slot, no roster entry)', () => {
    writeClaudeSkill('ambient-one', claudeFrontmatter('ambient-one', 'CLAUDE CODE BODY'));
    const index = new SkillIndex(tmpDir);

    // Empty roster + empty index: injection walks the roster, not the filesystem.
    const result = loadSkills('agent-a', [], tmpDir, index, 'a task mentioning ambient-one');
    expect(result.loaded).toEqual([]);
    expect(result.content).toBe('');
    expect(result.dropped).toEqual([]);

    // ...but the pull path serves it.
    expect(resolveServableSkill('agent-a', 'ambient-one', tmpDir).skill).not.toBeNull();
  });
});

describe('listAvailableSkills', () => {
  it('includes .claude/skills names that carry a SKILL.md', () => {
    writeClaudeSkill('deploy-runbook', claudeFrontmatter('deploy-runbook', 'BODY'));
    expect(listAvailableSkills('agent-a', tmpDir)).toContain('deploy-runbook');
  });

  it('excludes a subdirectory with no SKILL.md and a loose .md file', () => {
    writeClaudeSkill('real-one', claudeFrontmatter('real-one', 'BODY'));
    mkdirSync(join(tmpDir, '.claude', 'skills', 'no-skill-md'), { recursive: true });
    writeFileSync(join(tmpDir, '.claude', 'skills', 'loose.md'), 'not a skill dir');

    const skills = listAvailableSkills('agent-a', tmpDir);
    expect(skills).toContain('real-one');
    expect(skills).not.toContain('no-skill-md');
    expect(skills).not.toContain('loose');
  });

  it('still lists bundled defaults when no .claude/skills dir exists', () => {
    expect(listAvailableSkills('agent-a', tmpDir)).toContain('typescript');
  });
});
