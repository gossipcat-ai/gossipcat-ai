import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { TaskGraph, TaskGraphSync } from '@gossip/orchestrator';
import type { SyncMigrationConfig } from '@gossip/orchestrator/dist/task-graph-sync';
import { Keychain } from './keychain';
import { getUserId, getProjectId, getTeamUserId, getGitEmail } from './identity';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};

interface SupabaseConfig {
  url: string;
  projectRef: string;
  mode?: 'solo' | 'team';
  displayName?: string;
  projectIdVersion?: number;
  previousUserId?: string;
}

function loadSupabaseConfig(): SupabaseConfig | null {
  const configPath = join(process.cwd(), '.gossip', 'supabase.json');
  if (!existsSync(configPath)) return null;
  try { return JSON.parse(readFileSync(configPath, 'utf-8')); }
  catch { return null; }
}

function saveSupabaseConfig(config: SupabaseConfig): void {
  const gossipDir = join(process.cwd(), '.gossip');
  mkdirSync(gossipDir, { recursive: true });
  writeFileSync(join(gossipDir, 'supabase.json'), JSON.stringify(config, null, 2));
}

export async function runSyncCommand(args: string[]): Promise<void> {
  const flag = args[0];

  if (flag === '--setup') { await runSetup(); return; }
  if (flag === '--status') { showStatus(); return; }

  const config = loadSupabaseConfig();
  if (!config) {
    console.log(`${c.yellow}Supabase not configured.${c.reset} Run: gossipcat sync --setup`);
    return;
  }

  const keychain = new Keychain();
  const key = await keychain.getKey('supabase');
  if (!key) {
    console.log(`${c.red}No Supabase API key found in keychain.${c.reset} Run: gossipcat sync --setup`);
    return;
  }

  const cwd = process.cwd();
  const graph = new TaskGraph(cwd);

  let userId: string;
  let displayName: string | null = null;
  if (config.mode === 'team') {
    const teamSalt = await keychain.getKey('supabase-team-salt');
    if (!teamSalt) {
      console.log(`${c.red}Team mode requires teamSalt. Run: gossipcat sync --setup${c.reset}`);
      return;
    }
    const email = getGitEmail();
    if (!email) {
      console.log(`${c.red}Team mode requires a git email. Run: git config user.email "you@example.com"${c.reset}`);
      return;
    }
    userId = getTeamUserId(email, teamSalt);
    displayName = config.displayName || email;
  } else {
    userId = getUserId(cwd);
  }

  // Detect projectId migration
  let migration: SyncMigrationConfig | undefined;
  if (!config.projectIdVersion) {
    const { createHash } = require('crypto');
    const oldProjectId = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
    const newProjectId = getProjectId(cwd);
    if (oldProjectId !== newProjectId) {
      migration = { ...migration, oldProjectId };
      console.log(`${c.cyan}Migrating project identity to git remote-based hash...${c.reset}`);
    }
  }

  // Detect solo→team userId migration
  if (config.previousUserId) {
    migration = { ...migration, oldUserId: config.previousUserId };
    console.log(`${c.cyan}Migrating task history to team identity...${c.reset}`);
  }

  const sync = new TaskGraphSync(graph, config.url, key, userId, getProjectId(cwd), cwd, displayName, migration);

  console.log('Syncing to Supabase...');
  const result = await sync.sync();

  // After sync, mark migrations as done
  if (migration && !result.errors.length) {
    config.projectIdVersion = 2;
    delete config.previousUserId;
    saveSupabaseConfig(config);
  }

  if (result.errors.length) {
    console.log(`${c.yellow}Synced ${result.events} events with ${result.errors.length} errors:${c.reset}`);
    for (const err of result.errors) console.log(`  ${c.red}${err}${c.reset}`);
  } else {
    console.log(`${c.green}Synced ${result.events} events, ${result.scores} scores.${c.reset}`);
  }
}

function showStatus(): void {
  const config = loadSupabaseConfig();
  const graph = new TaskGraph(process.cwd());
  const meta = graph.getSyncMeta();

  console.log(`\n${c.bold}Sync Status${c.reset}\n`);
  console.log(`  Supabase: ${config ? `${c.green}configured${c.reset} (${config.url})` : `${c.dim}not configured${c.reset}`}`);
  console.log(`  Mode: ${config?.mode === 'team' ? `${c.cyan}team${c.reset}` : 'solo'}`);
  if (config?.displayName) console.log(`  Display name: ${config.displayName}`);
  console.log(`  Total events: ${graph.getEventCount()}`);
  console.log(`  Last sync: ${meta.lastSync || 'never'}`);
  console.log(`  Synced events: ${meta.lastSyncEventCount}`);
  console.log(`  Pending: ${graph.getEventCount() - meta.lastSyncEventCount}`);
  console.log('');
}

async function runSetup(): Promise<void> {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  console.log(`\n${c.bold}Supabase Sync Setup${c.reset}\n`);

  const existing = loadSupabaseConfig();
  if (existing) {
    console.log(`  Existing config: ${existing.url}`);
    const overwrite = await ask('  Overwrite? (y/N) ');
    if (overwrite.toLowerCase() !== 'y') { rl.close(); return; }
  }

  const url = await ask(`  Supabase URL (e.g. https://xxx.supabase.co): `);
  if (!url.startsWith('https://')) {
    console.log(`${c.red}URL must start with https://${c.reset}`);
    rl.close(); return;
  }

  const ref = url.replace('https://', '').replace('.supabase.co', '');
  const key = await ask(`  Supabase anon key: `);
  if (!key) { console.log(`${c.red}Key required.${c.reset}`); rl.close(); return; }

  console.log(`\n  Sync mode:`);
  console.log(`    ${c.bold}A)${c.reset} Solo — private, only your data (default)`);
  console.log(`    ${c.bold}B)${c.reset} Team — shared with teammates on this project`);
  const modeChoice = await ask('  > ');
  const isTeam = modeChoice.trim().toUpperCase() === 'B';

  if (isTeam) {
    const email = getGitEmail();
    if (!email) {
      console.log(`${c.red}Team mode requires a git email. Run: git config user.email "you@example.com"${c.reset}`);
      rl.close(); return;
    }

    // Check for existing team config
    const projectId = getProjectId(process.cwd());
    const checkRes = await fetch(`${url}/rest/v1/team_config?project_id=eq.${projectId}`, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
    });
    const existingTeam = await checkRes.json();

    let teamSalt: string;
    if (existingTeam.length > 0) {
      console.log(`  ${c.green}✓${c.reset} Found team: "${existingTeam[0].project_name || 'unnamed'}"`);
      teamSalt = existingTeam[0].team_salt;
    } else {
      const projectName = await ask('  Project name (e.g. myapp): ');
      const { randomBytes } = await import('crypto');
      teamSalt = randomBytes(32).toString('hex');
      // Use on_conflict to handle race where two members run setup simultaneously
      await fetch(`${url}/rest/v1/team_config?on_conflict=project_id`, {
        method: 'POST',
        headers: {
          'apikey': key, 'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=ignore-duplicates,return=representation',
        },
        body: JSON.stringify({
          project_id: projectId, team_salt: teamSalt,
          project_name: projectName || null,
        }),
      });
      // Re-fetch to get the actual salt (ours or the winner's)
      const refetchRes = await fetch(`${url}/rest/v1/team_config?project_id=eq.${projectId}`, {
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
      });
      const refetched = await refetchRes.json();
      if (!refetched.length) {
        console.log(`${c.red}Failed to fetch team config after creation. Check Supabase RLS policies.${c.reset}`);
        rl.close(); return;
      }
      teamSalt = refetched[0].team_salt;
      console.log(`  ${c.green}✓${c.reset} Team "${projectName}" created.`);
    }

    console.log(`\n  Your git email (${email}) will be visible to teammates.`);
    const consent = await ask('  Continue? (y/N) ');
    if (consent.trim().toLowerCase() !== 'y') { rl.close(); return; }

    // Save old solo userId for migration on first team sync (only if data was previously synced)
    const graph = new TaskGraph(process.cwd());
    const hasSyncedData = graph.getSyncMeta().lastSyncEventCount > 0;
    const oldSoloUserId = hasSyncedData ? getUserId(process.cwd()) : undefined;

    rl.close();

    const keychain = new Keychain();
    await keychain.setKey('supabase', key);
    await keychain.setKey('supabase-team-salt', teamSalt);
    saveSupabaseConfig({
      url, projectRef: ref, mode: 'team', displayName: email,
      ...(oldSoloUserId ? { previousUserId: oldSoloUserId } : {}),
    });

    console.log(`\n${c.green}Supabase configured (team mode).${c.reset}`);
    console.log(`  Config: .gossip/supabase.json`);
    console.log(`  Key + team salt: stored in keychain`);
    console.log(`\n  Run the migration SQL in your Supabase dashboard:`);
    console.log(`  ${c.dim}See docs/migrations/001-taskgraph-schema.sql${c.reset}`);
    console.log(`\n  Then run: ${c.cyan}gossipcat sync${c.reset} to sync existing events.\n`);
  } else {
    rl.close();

    const keychain = new Keychain();
    await keychain.setKey('supabase', key);
    saveSupabaseConfig({ url, projectRef: ref });

    console.log(`\n${c.green}Supabase configured.${c.reset}`);
    console.log(`  Config: .gossip/supabase.json`);
    console.log(`  Key: stored in keychain`);
    console.log(`\n  Run the migration SQL in your Supabase dashboard:`);
    console.log(`  ${c.dim}See docs/migrations/001-taskgraph-schema.sql${c.reset}`);
    console.log(`\n  Then run: ${c.cyan}gossipcat sync${c.reset} to sync existing events.\n`);
  }
}
