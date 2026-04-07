import { findBundledRules, ensureRulesFile, readRulesContent, BootstrapGenerator } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('rules-loader', () => {
  const testDir = join(tmpdir(), `gossip-rules-test-${Date.now()}`);
  afterAll(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('findBundledRules locates the packaged default rules', () => {
    const p = findBundledRules();
    expect(p).not.toBeNull();
    expect(readFileSync(p!, 'utf-8')).toContain('Consensus Workflow');
  });

  it('readRulesContent falls back to bundled default when .gossip/rules.md is missing', () => {
    const dir = join(testDir, 'fallback');
    mkdirSync(dir, { recursive: true });
    const content = readRulesContent(dir);
    expect(content).not.toBeNull();
    expect(content!).toContain('Consensus Workflow');
    // No .gossip/rules.md should have been created by a pure read.
    expect(existsSync(join(dir, '.gossip', 'rules.md'))).toBe(false);
  });

  it('readRulesContent prefers project-local rules.md over bundled default', () => {
    const dir = join(testDir, 'local-override');
    mkdirSync(join(dir, '.gossip'), { recursive: true });
    writeFileSync(join(dir, '.gossip', 'rules.md'), '# Custom rules\nproject-specific marker');
    const content = readRulesContent(dir);
    expect(content).toContain('project-specific marker');
    expect(content).not.toContain('Consensus Workflow');
  });

  it('ensureRulesFile materializes .gossip/rules.md from bundled default on first run', () => {
    const dir = join(testDir, 'materialize');
    mkdirSync(dir, { recursive: true });
    const result = ensureRulesFile(dir);
    expect(result.created).toBe(true);
    expect(existsSync(join(dir, '.gossip', 'rules.md'))).toBe(true);
    expect(readFileSync(join(dir, '.gossip', 'rules.md'), 'utf-8')).toContain('Consensus Workflow');

    // Idempotent: second call doesn't recreate.
    const second = ensureRulesFile(dir);
    expect(second.created).toBe(false);
  });

  it('BootstrapGenerator injects rules content into team prompt with demoted headings', () => {
    const dir = join(testDir, 'integration');
    mkdirSync(join(dir, '.gossip'), { recursive: true });
    writeFileSync(join(dir, '.gossip', 'config.json'), JSON.stringify({
      main_agent: { provider: 'local', model: 'qwen' },
      agents: { 'test-agent': { provider: 'local', model: 'qwen', skills: ['testing'] } }
    }));
    // Materialize first (mimics boot path), then generate.
    ensureRulesFile(dir);
    expect(existsSync(join(dir, '.gossip', 'rules.md'))).toBe(true);

    const gen = new BootstrapGenerator(dir);
    const result = gen.generate();
    expect(result.prompt).toContain('## Operating Rules');
    expect(result.prompt).toContain('Consensus Workflow');
    // Embedded "## Team Setup" from rules should have been demoted to "### Team Setup"
    // so it doesn't collide with the outer bootstrap structure.
    expect(result.prompt).toContain('### Team Setup');
  });
});
