"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const config_1 = require("../../apps/cli/src/config");
describe('Config Validation', () => {
    it('accepts valid config', () => {
        const config = (0, config_1.validateConfig)({
            main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
            agents: {
                arch: { provider: 'anthropic', model: 'claude', skills: ['typescript'] }
            }
        });
        expect(config.main_agent.provider).toBe('anthropic');
    });
    it('rejects missing main_agent', () => {
        expect(() => (0, config_1.validateConfig)({})).toThrow('main_agent');
    });
    it('rejects missing main_agent.provider', () => {
        expect(() => (0, config_1.validateConfig)({ main_agent: { model: 'x' } })).toThrow('provider');
    });
    it('rejects invalid provider', () => {
        expect(() => (0, config_1.validateConfig)({ main_agent: { provider: 'invalid', model: 'x' } })).toThrow('Invalid provider');
    });
    it('rejects agent with no skills', () => {
        expect(() => (0, config_1.validateConfig)({
            main_agent: { provider: 'anthropic', model: 'claude' },
            agents: { a: { provider: 'anthropic', model: 'claude', skills: [] } }
        })).toThrow('at least one skill');
    });
    it('accepts config without agents (main agent only)', () => {
        const config = (0, config_1.validateConfig)({ main_agent: { provider: 'anthropic', model: 'claude' } });
        expect(config.agents).toBeUndefined();
    });
});
describe('findConfigPath', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = (0, path_1.join)((0, os_1.tmpdir)(), `gossip-test-${Date.now()}`);
        (0, fs_1.mkdirSync)(tmpDir, { recursive: true });
    });
    afterEach(() => {
        (0, fs_1.rmSync)(tmpDir, { recursive: true, force: true });
    });
    it('returns null when no config files exist', () => {
        expect((0, config_1.findConfigPath)(tmpDir)).toBeNull();
    });
    it('finds gossip.agents.json when present', () => {
        const filePath = (0, path_1.join)(tmpDir, 'gossip.agents.json');
        (0, fs_1.writeFileSync)(filePath, '{}');
        expect((0, config_1.findConfigPath)(tmpDir)).toBe(filePath);
    });
    it('prefers .gossip/config.json over gossip.agents.json', () => {
        const gossipDir = (0, path_1.join)(tmpDir, '.gossip');
        (0, fs_1.mkdirSync)(gossipDir, { recursive: true });
        const preferredPath = (0, path_1.join)(gossipDir, 'config.json');
        (0, fs_1.writeFileSync)(preferredPath, '{}');
        (0, fs_1.writeFileSync)((0, path_1.join)(tmpDir, 'gossip.agents.json'), '{}');
        expect((0, config_1.findConfigPath)(tmpDir)).toBe(preferredPath);
    });
    it('falls back to gossip.agents.json when .gossip/config.json is absent', () => {
        const filePath = (0, path_1.join)(tmpDir, 'gossip.agents.json');
        (0, fs_1.writeFileSync)(filePath, '{}');
        expect((0, config_1.findConfigPath)(tmpDir)).toBe(filePath);
    });
});
//# sourceMappingURL=config.test.js.map