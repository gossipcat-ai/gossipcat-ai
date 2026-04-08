import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

interface UpdateOptions {
  check_only: boolean;
  confirm: boolean;
}

interface UpdateResult {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

function getCurrentVersion(): string {
  try {
    // Walk up from this file to find package.json at the package root
    const pkgPath = resolve(__dirname, '..', '..', '..', '..', 'package.json');
    if (existsSync(pkgPath)) {
      return JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0';
    }
  } catch { /* fall through */ }
  return '0.0.0';
}

async function getLatestVersion(): Promise<string> {
  const res = await fetch('https://registry.npmjs.org/gossipcat/latest');
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
  const data = await res.json() as { version: string };
  return data.version;
}

function detectInstallMethod(): 'global' | 'git-clone' | 'local' {
  const packageRoot = resolve(__dirname, '..', '..', '..', '..');
  if (process.env.npm_config_global === 'true') return 'global';
  if (existsSync(join(packageRoot, '.git'))) return 'git-clone';
  return 'local';
}

function updateCommand(method: 'global' | 'git-clone' | 'local', version: string): string {
  if (method === 'global') return `npm install -g gossipcat@${version}`;
  if (method === 'git-clone') return `git pull && npm install && npm run build:mcp && npm run build:dashboard`;
  return `npm install gossipcat@${version}`;
}

export async function handleGossipUpdate({ check_only, confirm }: UpdateOptions): Promise<UpdateResult> {
  let current: string;
  let latest: string;

  try {
    current = getCurrentVersion();
  } catch {
    return { content: [{ type: 'text', text: 'Could not read current version from package.json.' }] };
  }

  try {
    latest = await getLatestVersion();
  } catch (err) {
    return { content: [{ type: 'text', text: `Could not reach npm registry: ${(err as Error).message}\n\nCheck your internet connection or visit https://www.npmjs.com/package/gossipcat manually.` }] };
  }

  const method = detectInstallMethod();
  const command = updateCommand(method, latest);

  // Already up to date
  if (current === latest) {
    return { content: [{ type: 'text', text: `gossipcat is up to date (v${current}).` }] };
  }

  const isDowngrade = latest < current;
  const direction = isDowngrade ? '(downgrade)' : '';
  const updateSummary = [
    `gossipcat update available ${direction}`,
    `  Current: v${current}`,
    `  Latest:  v${latest}`,
    `  Method:  ${method}`,
    `  Command: ${command}`,
  ].join('\n');

  if (check_only) {
    return { content: [{ type: 'text', text: updateSummary + '\n\nPass confirm: true to apply.' }] };
  }

  if (!confirm) {
    return {
      content: [{
        type: 'text',
        text: updateSummary + '\n\nTo apply: gossip_update(confirm: true)\nAfter updating, run /mcp reconnect in Claude Code.',
      }],
    };
  }

  // Apply the update
  try {
    execSync(command, { stdio: 'inherit', cwd: method === 'git-clone'
      ? resolve(__dirname, '..', '..', '..', '..')
      : process.cwd()
    });
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `Update command failed: ${(err as Error).message}\n\nTry running manually:\n  ${command}`,
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: `✓ Updated gossipcat v${current} → v${latest}\n\nRun /mcp reconnect in Claude Code to load the new version.`,
    }],
  };
}
