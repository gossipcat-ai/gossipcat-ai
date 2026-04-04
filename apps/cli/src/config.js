"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findConfigPath = findConfigPath;
exports.loadConfig = loadConfig;
exports.validateConfig = validateConfig;
exports.configToAgentConfigs = configToAgentConfigs;
const fs_1 = require("fs");
const path_1 = require("path");
function findConfigPath(projectRoot) {
    const root = projectRoot || process.cwd();
    const candidates = [
        (0, path_1.resolve)(root, '.gossip', 'config.json'),
        (0, path_1.resolve)(root, 'gossip.agents.json'),
        (0, path_1.resolve)(root, 'gossip.agents.yaml'),
        (0, path_1.resolve)(root, 'gossip.agents.yml'),
    ];
    for (const p of candidates) {
        if ((0, fs_1.existsSync)(p))
            return p;
    }
    return null;
}
function loadConfig(configPath) {
    const raw = (0, fs_1.readFileSync)(configPath, 'utf-8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error(`Failed to parse config at ${configPath}. Use JSON format for gossip.agents.json.`);
    }
    return validateConfig(parsed);
}
const VALID_PROVIDERS = ['anthropic', 'openai', 'google', 'local', 'native'];
const CLAUDE_MODEL_MAP = {
    opus: { provider: 'anthropic', model: 'claude-opus-4-6' },
    sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    haiku: { provider: 'anthropic', model: 'claude-haiku-4-5' },
};
function validateConfig(raw) {
    if (!raw.main_agent)
        throw new Error('Config missing "main_agent" field');
    if (!raw.main_agent.provider)
        throw new Error('Config missing "main_agent.provider"');
    if (!raw.main_agent.model)
        throw new Error('Config missing "main_agent.model"');
    if (!VALID_PROVIDERS.includes(raw.main_agent.provider)) {
        throw new Error(`Invalid provider "${raw.main_agent.provider}". Must be one of: ${VALID_PROVIDERS.join(', ')}`);
    }
    if (raw.utility_model) {
        if (!raw.utility_model.provider)
            throw new Error('Config "utility_model" missing provider');
        if (!raw.utility_model.model)
            throw new Error('Config "utility_model" missing model');
        if (!VALID_PROVIDERS.includes(raw.utility_model.provider)) {
            throw new Error(`Invalid utility_model provider "${raw.utility_model.provider}". Must be one of: ${VALID_PROVIDERS.join(', ')}`);
        }
        if (raw.utility_model.provider === 'native') {
            const validNativeModels = Object.keys(CLAUDE_MODEL_MAP);
            if (!validNativeModels.includes(raw.utility_model.model)) {
                throw new Error(`Invalid native utility_model model "${raw.utility_model.model}". Must be one of: ${validNativeModels.join(', ')}`);
            }
        }
    }
    if (raw.agents) {
        for (const [id, agent] of Object.entries(raw.agents)) {
            if (!agent.provider)
                throw new Error(`Agent "${id}" missing provider`);
            if (!VALID_PROVIDERS.includes(agent.provider)) {
                throw new Error(`Agent "${id}" has invalid provider "${agent.provider}"`);
            }
            if (!agent.skills || !Array.isArray(agent.skills) || agent.skills.length === 0) {
                throw new Error(`Agent "${id}" must have at least one skill`);
            }
        }
    }
    return raw;
}
function configToAgentConfigs(config) {
    return Object.entries(config.agents || {}).map(([id, agent]) => ({
        id,
        provider: agent.provider,
        model: agent.model,
        preset: agent.preset,
        skills: agent.skills,
    }));
}
//# sourceMappingURL=config.js.map