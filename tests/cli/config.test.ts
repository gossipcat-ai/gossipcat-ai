import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateConfig, findConfigPath, VALID_MAIN_PROVIDERS } from '../../apps/cli/src/config';
import { CREATE_PROVIDER_CASES } from '../../packages/orchestrator/src/llm-client';

describe('Config Validation', () => {
  it('accepts valid config', () => {
    const config = validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: {
        arch: { provider: 'anthropic', model: 'claude', skills: ['typescript'] }
      }
    });
    expect(config.main_agent.provider).toBe('anthropic');
  });

  it('rejects missing main_agent', () => {
    expect(() => validateConfig({})).toThrow('main_agent');
  });

  it('rejects missing main_agent.provider', () => {
    expect(() => validateConfig({ main_agent: { model: 'x' } })).toThrow('provider');
  });

  it('rejects invalid provider', () => {
    expect(() => validateConfig({ main_agent: { provider: 'invalid', model: 'x' } })).toThrow('Invalid main_agent provider');
  });

  it('rejects agent with no skills', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude' },
      agents: { a: { provider: 'anthropic', model: 'claude', skills: [] } }
    })).toThrow('at least one skill');
  });

  it('accepts config without agents (main agent only)', () => {
    const config = validateConfig({ main_agent: { provider: 'anthropic', model: 'claude' } });
    expect(config.agents).toBeUndefined();
  });

  it('accepts utility_model with native provider and valid model', () => {
    const config = validateConfig({
      main_agent: { provider: 'google', model: 'gemini-2.5-pro' },
      utility_model: { provider: 'native', model: 'haiku' },
    });
    expect(config.utility_model?.provider).toBe('native');
    expect(config.utility_model?.model).toBe('haiku');
  });

  it('rejects native utility_model with invalid model tier', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'google', model: 'gemini-2.5-pro' },
      utility_model: { provider: 'native', model: 'gpt-4' },
    })).toThrow('native');
  });

  it('accepts utility_model with relay provider (existing behavior)', () => {
    const config = validateConfig({
      main_agent: { provider: 'google', model: 'gemini-2.5-pro' },
      utility_model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
    expect(config.utility_model?.provider).toBe('anthropic');
  });

  // Schema↔runtime alignment regression — VALID_PROVIDERS in config.ts must
  // accept every value the gossip_setup Zod enum accepts, otherwise some
  // values pass schema but fail validateConfig (or vice versa). The
  // documented zero-config token on Claude Code host is "none"; "native" is
  // valid only for utility_model and per-agent overrides (NOT main_agent).
  it('accepts main_provider "none" (Claude Code host zero-config)', () => {
    const config = validateConfig({
      main_agent: { provider: 'none', model: 'native' },
    });
    expect(config.main_agent.provider).toBe('none');
  });

  it('rejects main_provider "native" (regression: createProvider has no native branch)', () => {
    // 'native' as main_agent.provider would reach createProvider() in
    // packages/orchestrator/src/llm-client.ts which has no `case 'native'`,
    // throwing "Unknown provider: native" at boot. validateConfig must catch
    // this at config-load time. 'native' remains valid for utility_model and
    // per-agent overrides where the design supports it.
    expect(() => validateConfig({
      main_agent: { provider: 'native', model: 'sonnet' },
    })).toThrow('Invalid main_agent provider "native"');
  });

  it('accepts main_provider "local"', () => {
    const config = validateConfig({
      main_agent: { provider: 'local', model: 'llama3' },
    });
    expect(config.main_agent.provider).toBe('local');
  });

  // Parity check between schema (validateConfig) and runtime (createProvider).
  // Captures the original drift bug as a permanent regression test: every
  // provider that validateConfig accepts for main_agent MUST be a provider
  // that createProvider knows how to construct. If a future change adds a
  // provider to one list but not the other, this test fails immediately.
  it('main_agent providers form a subset of createProvider runtime cases', () => {
    // VALID_MAIN_PROVIDERS comes from apps/cli/src/config.ts (schema-side).
    // CREATE_PROVIDER_CASES comes from packages/orchestrator/src/llm-client.ts
    // (runtime-side, kept aligned with the createProvider switch). Importing
    // both ensures this test fails the moment either source-of-truth drifts —
    // no third hardcoded list to forget to update.
    for (const p of VALID_MAIN_PROVIDERS) {
      expect(CREATE_PROVIDER_CASES).toContain(p);
    }
    // And the schema must actually accept each one (smoke test).
    for (const p of VALID_MAIN_PROVIDERS) {
      const config = validateConfig({ main_agent: { provider: p, model: 'x' } });
      expect(config.main_agent.provider).toBe(p);
    }
  });
});

describe('findConfigPath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gossip-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no config files exist', () => {
    expect(findConfigPath(tmpDir)).toBeNull();
  });

  it('finds gossip.agents.json when present', () => {
    const filePath = join(tmpDir, 'gossip.agents.json');
    writeFileSync(filePath, '{}');
    expect(findConfigPath(tmpDir)).toBe(filePath);
  });

  it('prefers .gossip/config.json over gossip.agents.json', () => {
    const gossipDir = join(tmpDir, '.gossip');
    mkdirSync(gossipDir, { recursive: true });
    const preferredPath = join(gossipDir, 'config.json');
    writeFileSync(preferredPath, '{}');
    writeFileSync(join(tmpDir, 'gossip.agents.json'), '{}');
    expect(findConfigPath(tmpDir)).toBe(preferredPath);
  });

  it('falls back to gossip.agents.json when .gossip/config.json is absent', () => {
    const filePath = join(tmpDir, 'gossip.agents.json');
    writeFileSync(filePath, '{}');
    expect(findConfigPath(tmpDir)).toBe(filePath);
  });
});
