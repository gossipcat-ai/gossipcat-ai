import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { getGossipcatVersion } from '../version';

interface UpdateOptions {
  check_only: boolean;
  confirm: boolean;
}

interface UpdateResult {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

function getCurrentVersion(): string {
  // Delegate to the shared helper — it walks up from __dirname until it finds
  // a package.json with name === 'gossipcat', which works across dev, global
  // install, local dep, and bundled layouts. The old 4-up path walk fell
  // through to '0.0.0' whenever the install layout was anything other than
  // the monorepo dev checkout.
  const v = getGossipcatVersion();
  return v === 'unknown' ? '0.0.0' : v;
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
  // Scrub GOSSIPCAT_* vars from the spawned process env — PR #316 pattern.
  // A postinstall hook reading GOSSIPCAT_ORCHESTRATOR_ROLE could short-circuit
  // sandbox checks when run from an orchestrator session.
  const scrubbedEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(scrubbedEnv)) {
    if (/^GOSSIPCAT_/i.test(key)) delete scrubbedEnv[key];
  }
  try {
    execSync(command, {
      stdio: 'inherit',
      cwd: method === 'git-clone'
        ? resolve(__dirname, '..', '..', '..', '..')
        : process.cwd(),
      env: scrubbedEnv,
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
