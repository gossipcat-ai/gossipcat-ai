import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateConfig, findConfigPath } from '../../apps/cli/src/config';

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
    expect(() => validateConfig({ main_agent: { provider: 'invalid', model: 'x' } })).toThrow('Invalid provider');
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
  // documented zero-config token on Claude Code host is "none"; the
  // Claude-Code-subagent utility path uses "native". Both must be runtime-valid.
  it('accepts main_provider "none" (Claude Code host zero-config)', () => {
    const config = validateConfig({
      main_agent: { provider: 'none', model: 'native' },
    });
    expect(config.main_agent.provider).toBe('none');
  });

  it('accepts main_provider "native"', () => {
    const config = validateConfig({
      main_agent: { provider: 'native', model: 'sonnet' },
    });
    expect(config.main_agent.provider).toBe('native');
  });

  it('accepts main_provider "local"', () => {
    const config = validateConfig({
      main_agent: { provider: 'local', model: 'llama3' },
    });
    expect(config.main_agent.provider).toBe('local');
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
