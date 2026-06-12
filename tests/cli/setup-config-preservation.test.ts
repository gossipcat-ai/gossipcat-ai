/**
 * gossip_setup transactionality + config preservation + status resilience.
 *
 * Covers consensus 6eed37aa-dfba43ca findings:
 *  - f15 (MEDIUM): validateConfig must run BEFORE any native .claude/agents/<id>.md
 *    file is written, so a validation failure leaves no orphan phantom-subagent
 *    files and does not block re-registering the id as custom.
 *  - f16 (MEDIUM): the rebuilt config must preserve unknown top-level fields
 *    (consensus.siblingRoots, utility_model, autoDiscoverWorktrees, …) across a
 *    re-run in BOTH merge and replace modes.
 *  - f19 (LOW): gossip_status must not throw when .gossip/config.json is
 *    malformed — it renders a fix hint instead.
 *
 * The merge/preservation logic and the status fix-hint are tested as pure
 * functions (mergeSetupConfig / buildMalformedConfigHint), mirroring the
 * setup-response.test.ts precedent. The f15 ordering invariant — which is
 * inline in the giant gossip_setup handler — is guarded by source inspection,
 * the same technique used by install-packaging.test.ts for postinstall.js.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { mergeSetupConfig, buildMalformedConfigHint } from '../../apps/cli/src/setup-response';
import { validateConfig } from '../../apps/cli/src/config';

const PROJECT_ROOT = resolve(__dirname, '..', '..');

describe('mergeSetupConfig — top-level field preservation (f16)', () => {
  const mainAgent = { provider: 'anthropic', model: 'claude-opus-4-6' };

  it('preserves consensus.siblingRoots and utility_model in merge mode', () => {
    const existingConfig = {
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: { 'old-agent': { provider: 'anthropic', model: 'claude-haiku-4-5' } },
      consensus: { siblingRoots: ['../sibling-repo'] },
      utility_model: { provider: 'native', model: 'haiku' },
      autoDiscoverWorktrees: true,
    };
    const merged = mergeSetupConfig({
      existingConfig,
      mainAgent,
      existingAgents: existingConfig.agents,
      newAgents: { 'new-agent': { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
    }) as typeof existingConfig & { agents: Record<string, unknown> };

    // Unknown/other top-level fields survive untouched.
    expect(merged.consensus).toEqual({ siblingRoots: ['../sibling-repo'] });
    expect(merged.utility_model).toEqual({ provider: 'native', model: 'haiku' });
    expect(merged.autoDiscoverWorktrees).toBe(true);
    // main_agent is overwritten from the request.
    expect(merged.main_agent).toEqual(mainAgent);
    // merge keeps the prior agent AND adds the new one.
    expect(Object.keys(merged.agents).sort()).toEqual(['new-agent', 'old-agent']);
  });

  it('preserves unrelated top-level fields in replace mode (empty existingAgents)', () => {
    const existingConfig = {
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: { 'old-agent': { provider: 'anthropic', model: 'claude-haiku-4-5' } },
      consensus: { siblingRoots: ['../sibling-repo'], autoResolveOnRoundClose: true },
      orchestratorOwnedGlobs: ['.gossip/**'],
    };
    // replace mode passes existingAgents: {} (team replaced) but keeps the
    // existingConfig spread for other top-level fields.
    const merged = mergeSetupConfig({
      existingConfig,
      mainAgent,
      existingAgents: {},
      newAgents: { 'fresh-agent': { provider: 'anthropic', model: 'claude-opus-4-6' } },
    }) as typeof existingConfig & { agents: Record<string, unknown> };

    // The team is replaced — old agent is gone, only the fresh one remains.
    expect(Object.keys(merged.agents)).toEqual(['fresh-agent']);
    // Other top-level fields are still preserved in replace mode.
    expect(merged.consensus).toEqual({ siblingRoots: ['../sibling-repo'], autoResolveOnRoundClose: true });
    expect(merged.orchestratorOwnedGlobs).toEqual(['.gossip/**']);
  });

  it('produces a config that validateConfig accepts when inputs are valid', () => {
    const merged = mergeSetupConfig({
      existingConfig: { consensus: { siblingRoots: ['../x'] } },
      mainAgent,
      existingAgents: {},
      newAgents: {},
    });
    expect(() => validateConfig(merged)).not.toThrow();
  });
});

describe('buildMalformedConfigHint — status resilience (f19)', () => {
  it('renders a fix-or-delete hint with the path and parse message', () => {
    const hint = buildMalformedConfigHint('/proj/.gossip/config.json', 'Unexpected token } in JSON');
    expect(hint).toContain('config.json is malformed');
    expect(hint).toContain('Unexpected token } in JSON');
    expect(hint).toContain('fix or delete /proj/.gossip/config.json');
  });
});

describe('gossip_setup handler — validate-before-write ordering (f15)', () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(resolve(PROJECT_ROOT, 'apps', 'cli', 'src', 'mcp-server-sdk.ts'), 'utf-8');
  });

  it('does not writeFileSync the native .md inside the agent loop', () => {
    // The loop must STAGE writes (pendingNativeWrites), not perform them. A
    // direct writeFileSync of `${agent.id}.md` inside the loop would re-introduce
    // the orphan-file leak on a validation failure.
    expect(source).toContain('pendingNativeWrites');
    // No writeFileSync of an `<id>.md` agent file may appear with the loop's
    // per-agent `${agent.id}.md` template — those are flushed post-validation.
    expect(source).not.toMatch(/writeFileSync\(join\(agentsDir, `\$\{agent\.id\}\.md`\)/);
  });

  it('flushes staged native .md writes only after validateConfig succeeds', () => {
    // Ordering guarantee: validateConfig(config) must appear in the source
    // BEFORE the pendingNativeWrites flush loop. If validation fails it returns
    // early, so the flush never runs and no orphan .md is written.
    const validateIdx = source.indexOf('validateConfig(config)');
    const flushIdx = source.indexOf('for (const w of pendingNativeWrites)');
    expect(validateIdx).toBeGreaterThan(-1);
    expect(flushIdx).toBeGreaterThan(-1);
    expect(flushIdx).toBeGreaterThan(validateIdx);
  });

  it('guards the gossip_status agent-list loadConfig in try/catch (f19)', () => {
    // loadConfig in the agent-list section must be wrapped so a malformed
    // config.json renders buildMalformedConfigHint instead of throwing the
    // whole status tool.
    expect(source).toMatch(/try\s*{[\s\S]*?loadConfig\(configPath\)[\s\S]*?}\s*catch[\s\S]*?buildMalformedConfigHint/);
  });
});
