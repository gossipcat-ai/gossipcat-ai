/**
 * `gossipcat code` — launch wrapper for Claude Code with the gossipcat channel.
 *
 * Execs `claude` with either:
 *   --channels server:<name>                        (when channel.allowlisted=true in .gossip/config.json)
 *   --dangerously-load-development-channels server:<name>  (default until allowlisted)
 *
 * The server <name> is resolved by inspecting .mcp.json (cwd) and ~/.claude.json mcpServers,
 * looking for the entry whose command runs the gossipcat mcp-serve binary. Falls back to
 * "gossipcat" with a printed note.
 *
 * All remaining argv are passed through to claude verbatim.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';

/** Safe charset for MCP server names: alphanumeric, hyphens, underscores, dots. */
const SAFE_SERVER_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

interface McpServersMap {
  [key: string]: {
    command?: string;
    args?: unknown[];
    [k: string]: unknown;
  };
}

/**
 * Parse a JSON file at `filePath`, catching all errors.
 * Returns null on any failure (missing file, bad JSON, wrong type).
 */
function safeReadJson(filePath: string): unknown {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Return true if the mcpServers entry looks like a gossipcat mcp-serve invocation.
 * Checks both the command itself and the args array.
 */
function isGossipMcpEntry(entry: { command?: string; args?: unknown[] }): boolean {
  const cmd = entry.command ?? '';
  const args = Array.isArray(entry.args) ? entry.args : [];

  // Direct invocation: command is the gossipcat binary
  if (typeof cmd === 'string' && /gossipcat/i.test(cmd)) return true;

  // node dist-mcp/mcp-server.js pattern (the canonical form in .mcp.json)
  if (args.some(a => typeof a === 'string' && /mcp-server\.(js|ts)$/.test(a))) return true;

  // npx gossipcat mcp-serve
  if (typeof cmd === 'string' && /npx/i.test(cmd)) {
    if (args.some(a => typeof a === 'string' && /gossipcat/i.test(a))) return true;
  }

  return false;
}

/**
 * Detect the MCP server name for gossipcat by reading .mcp.json and/or ~/.claude.json.
 * Returns [serverName, usingFallback].
 */
function detectServerName(cwd: string): [string, boolean] {
  const candidates: [string, unknown][] = [
    [join(cwd, '.mcp.json'), safeReadJson(join(cwd, '.mcp.json'))],
    [join(homedir(), '.claude.json'), safeReadJson(join(homedir(), '.claude.json'))],
  ];

  for (const [filePath, data] of candidates) {
    if (!data || typeof data !== 'object') continue;
    const root = data as Record<string, unknown>;

    // .mcp.json top-level { mcpServers: { <name>: {...} } }
    // ~/.claude.json nested: { mcpServers: { <name>: {...} } }
    const mcpServers = root['mcpServers'];
    if (!mcpServers || typeof mcpServers !== 'object') continue;

    const servers = mcpServers as McpServersMap;
    for (const [name, entry] of Object.entries(servers)) {
      if (!entry || typeof entry !== 'object') continue;
      if (isGossipMcpEntry(entry)) {
        // Validate the name before returning it (it will be passed to spawn args)
        if (SAFE_SERVER_NAME_RE.test(name)) {
          return [name, false];
        }
        // Name is present but unsafe — log and fall through
        process.stderr.write(
          `[gossipcat code] Warning: found gossipcat MCP entry in ${filePath} but server name "${name}" ` +
          `contains unsafe characters; falling back to "gossipcat".\n`
        );
      }
    }
  }

  return ['gossipcat', true];
}

/**
 * Read the channel.allowlisted flag from .gossip/config.json.
 * Defaults to false on any read/parse/type error.
 */
function isChannelAllowlisted(cwd: string): boolean {
  const configPath = join(cwd, '.gossip', 'config.json');
  try {
    const data = safeReadJson(configPath);
    if (!data || typeof data !== 'object') return false;
    const channel = (data as Record<string, unknown>)['channel'];
    if (!channel || typeof channel !== 'object') return false;
    const allowlisted = (channel as Record<string, unknown>)['allowlisted'];
    return allowlisted === true;
  } catch {
    return false;
  }
}

/**
 * Main entry point for `gossipcat code`.
 * @param argv - process.argv.slice(3) (everything after "gossipcat code")
 */
export function runCodeCommand(argv: string[]): void {
  const cwd = process.cwd();

  const [serverName, usingFallback] = detectServerName(cwd);
  if (usingFallback) {
    process.stderr.write(
      `[gossipcat code] Note: could not detect gossipcat MCP server name from .mcp.json or ~/.claude.json; ` +
      `using "gossipcat". If your server has a different name, ensure .mcp.json is present.\n`
    );
  }

  const allowlisted = isChannelAllowlisted(cwd);

  let claudeArgs: string[];
  if (allowlisted) {
    claudeArgs = ['--channels', `server:${serverName}`, ...argv];
  } else {
    process.stderr.write(
      `[gossipcat code] Note: using --dangerously-load-development-channels (custom channels are not yet ` +
      `on Anthropic's allowlist). Set channel.allowlisted=true in .gossip/config.json once allowlisted ` +
      `to switch to --channels.\n`
    );
    claudeArgs = ['--dangerously-load-development-channels', `server:${serverName}`, ...argv];
  }

  const child = spawn('claude', claudeArgs, { stdio: 'inherit' });

  child.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      process.stderr.write(
        `[gossipcat code] Error: "claude" is not on your PATH. ` +
        `Install Claude Code (https://claude.ai/download) and ensure the CLI is accessible.\n`
      );
    } else {
      process.stderr.write(`[gossipcat code] Error launching claude: ${err.message}\n`);
    }
    process.exit(1);
  });

  child.on('exit', (code: number | null, signal: string | null) => {
    if (signal) {
      process.kill(process.pid, signal as NodeJS.Signals);
    } else {
      process.exit(code ?? 0);
    }
  });
}
