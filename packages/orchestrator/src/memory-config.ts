import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { log } from './log';

export interface MemoryConfig {
  bundledMemories: {
    enabled: boolean;
    exclude: string[];
  };
}

const DEFAULTS: MemoryConfig = {
  bundledMemories: {
    enabled: true,
    exclude: [],
  },
};

/**
 * Load memory-config.json from <projectRoot>/.gossip/memory-config.json.
 *
 * - Missing file  → returns defaults silently.
 * - Malformed JSON → logs warning to stderr, returns defaults (never throws).
 * - Valid file     → merges with defaults so partial configs are safe.
 *
 * This config is the kill-switch for institutional-knowledge propagation (ikp §4):
 * `bundledMemories.enabled: false` suppresses all skills flagged `propagated: true`.
 * `bundledMemories.exclude: ["skill-name"]` suppresses listed propagated skills.
 */
export function loadMemoryConfig(projectRoot: string): MemoryConfig {
  const configPath = resolve(projectRoot, '.gossip', 'memory-config.json');
  if (!existsSync(configPath)) {
    return { ...DEFAULTS, bundledMemories: { ...DEFAULTS.bundledMemories } };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err: any) {
    log('memory-config', `WARNING: failed to read ${configPath}: ${err?.message ?? err} — using defaults`);
    return { ...DEFAULTS, bundledMemories: { ...DEFAULTS.bundledMemories } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    log('memory-config', `WARNING: malformed JSON in ${configPath}: ${err?.message ?? err} — using defaults`);
    return { ...DEFAULTS, bundledMemories: { ...DEFAULTS.bundledMemories } };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log('memory-config', `WARNING: ${configPath} must be a JSON object — using defaults`);
    return { ...DEFAULTS, bundledMemories: { ...DEFAULTS.bundledMemories } };
  }

  const obj = parsed as Record<string, unknown>;
  const bm = obj.bundledMemories;

  if (typeof bm !== 'object' || bm === null || Array.isArray(bm)) {
    return { ...DEFAULTS, bundledMemories: { ...DEFAULTS.bundledMemories } };
  }

  const bmObj = bm as Record<string, unknown>;

  const enabled = typeof bmObj.enabled === 'boolean' ? bmObj.enabled : DEFAULTS.bundledMemories.enabled;
  const exclude = Array.isArray(bmObj.exclude)
    ? bmObj.exclude.filter((x): x is string => typeof x === 'string')
    : DEFAULTS.bundledMemories.exclude;

  return { bundledMemories: { enabled, exclude } };
}
