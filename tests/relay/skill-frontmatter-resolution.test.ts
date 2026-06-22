/**
 * Tests for 3-tier skill resolution in readSkillFrontmatter (api-skills.ts).
 *
 * readSkillFrontmatter is private — tested indirectly via skillsGetHandler
 * which calls deriveEffectiveness → readSkillFrontmatter for each enabled slot.
 * The skill-index drives which agents/skills are iterated.
 */
import { skillsGetHandler } from '../../packages/relay/src/dashboard/api-skills';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/** Writes a minimal skill-index.json binding one skill slot for an agent. */
function writeSkillIndex(
  root: string,
  agentId: string,
  skill: string,
  boundAt = '2026-01-01T00:00:00Z',
): void {
  writeFileSync(
    join(root, '.gossip', 'skill-index.json'),
    JSON.stringify({
      [agentId]: {
        [skill]: {
          skill,
          enabled: true,
          source: 'manual',
          mode: 'permanent',
          version: 1,
          boundAt,
        },
      },
    }),
  );
}

describe('readSkillFrontmatter — 3-tier skill resolution via skillsGetHandler', () => {
  it('reads status from a project-tier skill (.gossip/skills/) when agent-local is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-skill-fm-'));
    mkdirSync(join(root, '.gossip', 'skills'), { recursive: true });
    mkdirSync(join(root, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true });

    // Only project-tier skill file — no agent-local copy
    writeFileSync(
      join(root, '.gossip', 'skills', 'data-integrity.md'),
      '---\nstatus: active\nbound_at: 2026-01-01T00:00:00Z\n---\n# Data Integrity\nProject-wide skill.\n',
    );
    writeSkillIndex(root, 'test-agent', 'data-integrity');

    const resp = await skillsGetHandler(root);
    const entry = resp.effectiveness.find(
      (e) => e.agentId === 'test-agent' && e.skill === 'data-integrity',
    );
    expect(entry).toBeDefined();
    // Before fix: status was null (agent-local not found, project-tier ignored)
    // After fix: status should be 'active'
    expect(entry!.status).toBe('active');
  });

  it('agent-local skill takes precedence over project-tier when both exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-skill-fm-'));
    mkdirSync(join(root, '.gossip', 'skills'), { recursive: true });
    mkdirSync(join(root, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true });

    // Project-tier: status pending
    writeFileSync(
      join(root, '.gossip', 'skills', 'error-handling.md'),
      '---\nstatus: pending\nbound_at: 2026-01-01T00:00:00Z\n---\n# Error Handling\n',
    );
    // Agent-local: status active (should win)
    writeFileSync(
      join(root, '.gossip', 'agents', 'test-agent', 'skills', 'error-handling.md'),
      '---\nstatus: active\nbound_at: 2026-02-01T00:00:00Z\n---\n# Error Handling (local)\n',
    );
    writeSkillIndex(root, 'test-agent', 'error-handling');

    const resp = await skillsGetHandler(root);
    const entry = resp.effectiveness.find(
      (e) => e.agentId === 'test-agent' && e.skill === 'error-handling',
    );
    expect(entry).toBeDefined();
    // Agent-local wins: status must be 'active', not 'pending'
    expect(entry!.status).toBe('active');
  });

  it('skill with NO frontmatter (just a heading) returns null status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-skill-fm-'));
    mkdirSync(join(root, '.gossip', 'skills'), { recursive: true });
    mkdirSync(join(root, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true });

    // Prose-only skill file, no frontmatter
    writeFileSync(
      join(root, '.gossip', 'skills', 'trust-boundaries.md'),
      '# Trust Boundaries\nThis skill has no YAML frontmatter.\n',
    );
    writeSkillIndex(root, 'test-agent', 'trust-boundaries');

    const resp = await skillsGetHandler(root);
    const entry = resp.effectiveness.find(
      (e) => e.agentId === 'test-agent' && e.skill === 'trust-boundaries',
    );
    // No frontmatter → no bound_at → deriveEffectiveness skips this entry
    // (boundAtMs is NaN/0, so the entry is not emitted)
    // The slot must NOT appear with a non-null status.
    if (entry) {
      expect(entry.status).toBeNull();
    }
    // If entry is undefined, that's also correct — no frontmatter, no bound_at parsed.
  });

  it('inline comment stripping: `status: pending  # note` parses as pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-skill-fm-'));
    mkdirSync(join(root, '.gossip', 'skills'), { recursive: true });
    mkdirSync(join(root, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true });

    writeFileSync(
      join(root, '.gossip', 'skills', 'input-validation.md'),
      '---\nstatus: pending  # needs more data\nbound_at: 2026-01-01T00:00:00Z\n---\n# Input Validation\n',
    );
    writeSkillIndex(root, 'test-agent', 'input-validation');

    const resp = await skillsGetHandler(root);
    const entry = resp.effectiveness.find(
      (e) => e.agentId === 'test-agent' && e.skill === 'input-validation',
    );
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('pending');
  });

  it('nonexistent skill (no file in any tier) returns null status / no entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-skill-fm-'));
    mkdirSync(join(root, '.gossip', 'skills'), { recursive: true });
    mkdirSync(join(root, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true });

    // No skill file written anywhere
    writeSkillIndex(root, 'test-agent', 'nonexistent-skill', '2026-01-01T00:00:00Z');

    const resp = await skillsGetHandler(root);
    const entry = resp.effectiveness.find(
      (e) => e.agentId === 'test-agent' && e.skill === 'nonexistent-skill',
    );
    // No file → resolveSkill returns null → readSkillFrontmatter returns null →
    // boundAt falls back to slot.boundAt → entry may still exist but status is null
    if (entry) {
      expect(entry.status).toBeNull();
    }
  });
});
