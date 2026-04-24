#!/usr/bin/env node
/**
 * Generates .mcp.json with the correct absolute path to mcp-server.js
 * for the current install method (global npm, local project dep, git clone).
 *
 * Never shipped in the package tarball — always regenerated per machine.
 */
const { join, resolve } = require('path');
const { existsSync, readFileSync, writeFileSync, statSync } = require('fs');

const scriptDir = __dirname;          // .../gossipcat/scripts/
const packageRoot = resolve(scriptDir, '..'); // .../gossipcat/
const mcpServerPath = join(packageRoot, 'dist-mcp', 'mcp-server.js');

// Detect install method:
//   global npm  → process.env.npm_config_global === 'true'
//   git clone   → .git exists at packageRoot (development)
//   local dep   → neither of the above
const isGlobal = process.env.npm_config_global === 'true';
const isGitClone = existsSync(join(packageRoot, '.git'));

// For git clones: skip writing if .mcp.json already exists. Still warn if the
// built server is older than package.json — stale-build warning is the most
// valuable signal on a developer re-running npm install after a pull.
if (isGitClone && existsSync(join(packageRoot, '.mcp.json'))) {
  if (existsSync(mcpServerPath)) {
    try {
      const serverMtime = statSync(mcpServerPath).mtime;
      const pkgMtime = statSync(join(packageRoot, 'package.json')).mtime;
      if (serverMtime < pkgMtime) {
        console.log("gossipcat: dist-mcp/ is older than package.json — run 'npm run build:mcp' to rebuild");
      }
    } catch (_) { /* stat failure is non-fatal */ }
  }
  console.log('gossipcat: .mcp.json already exists — skipping (git clone)');
  process.exit(0);
}

// For project-local installs: write .mcp.json into the consumer project root,
// not into node_modules/gossipcat. Walk up from __dirname until a package.json
// with a "workspaces" field is found OR filesystem root is reached.
let outputDir = packageRoot; // default: package dir (global or git clone)
if (!isGlobal && !isGitClone) {
  let found = false;
  // Start the walk ONE level ABOVE packageRoot so we skip gossipcat's own
  // package.json (which has a "workspaces" field for its own monorepo layout
  // and would otherwise match on iteration 1, writing .mcp.json into
  // node_modules/gossipcat/ instead of the consumer's project root).
  let dir = resolve(packageRoot, '..');
  while (true) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf8'));
        if (pkg.workspaces) {
          outputDir = dir;
          found = true;
          break;
        }
      } catch (_) { /* unparseable package.json — keep walking */ }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  if (!found) {
    // Fallback: two-level walk-up from node_modules (original heuristic)
    const nodeModulesDir = resolve(packageRoot, '..');
    const projectRoot = resolve(nodeModulesDir, '..');
    if (existsSync(join(projectRoot, 'package.json'))) {
      outputDir = projectRoot;
    } else {
      outputDir = process.cwd();
    }
  }
}

const mcpConfig = join(outputDir, '.mcp.json');

// Preserve existing user-added MCP server entries. An existing .mcp.json may
// carry servers other than gossipcat (e.g. another MCP tool the user has
// installed). Unconditional overwrite would silently clobber those entries
// on every npm install. Merge strategy:
//   - Parse existing file if present. On JSON error, skip the write (don't
//     destroy what we can't parse; user can fix manually).
//   - Preserve every top-level field via spread, preserve every existing
//     mcpServers entry, and refresh (or insert) the gossipcat entry.
let existing = {};
if (existsSync(mcpConfig)) {
  try {
    const raw = readFileSync(mcpConfig, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed;
    }
  } catch (_) {
    console.warn(`gossipcat: existing .mcp.json at ${mcpConfig} is malformed — skipping update to avoid clobbering user config`);
    process.exit(0);
  }
}

const existingServers =
  existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
    ? existing.mcpServers
    : {};

const config = {
  ...existing,
  mcpServers: {
    ...existingServers,
    gossipcat: {
      command: 'node',
      args: [mcpServerPath],
    },
  },
};

try {
  writeFileSync(mcpConfig, JSON.stringify(config, null, 2) + '\n');
  const method = isGlobal ? 'global npm' : isGitClone ? 'git clone' : 'local install';
  console.log(`gossipcat: wrote .mcp.json (${method}) → ${mcpServerPath}`);
} catch (e) {
  // Soft-fail on write errors: global npm installs often target root-owned dirs
  // where EACCES is expected. Hard-exiting here would abort `npm install -g`
  // for every user without sudo — users can re-run `gossipcat setup` after.
  // Regression guard: tests/cli/install-packaging.test.ts:133-140.
  console.warn(`gossipcat: postinstall could not write .mcp.json (${e.code || e.message}). Run 'gossipcat setup' after install to configure.`);
}

// Staleness check: warn if dist-mcp/ is older than package.json
if (existsSync(mcpServerPath)) {
  try {
    const serverMtime = statSync(mcpServerPath).mtime;
    const pkgMtime = statSync(join(packageRoot, 'package.json')).mtime;
    if (serverMtime < pkgMtime) {
      console.log("gossipcat: dist-mcp/ is older than package.json — run 'npm run build:mcp' to rebuild");
    }
  } catch (_) { /* stat failure is non-fatal */ }
}

if (!existsSync(mcpServerPath)) {
  if (isGitClone) {
    // Git clone: build is required — run it automatically
    const { execSync } = require('child_process');
    console.log('gossipcat: dist-mcp/mcp-server.js not built yet — running npm run build:mcp...');
    try {
      execSync('npm run build:mcp', { stdio: 'inherit', cwd: packageRoot });
    } catch (e) {
      console.error('gossipcat: build failed. Run "npm run build:mcp" manually to complete setup.');
      process.exit(1);
    }
  } else {
    console.error('gossipcat: FATAL — dist-mcp/mcp-server.js missing from package. Install is corrupted; reinstall with `npm install -g gossipcat` or clone the repo and run `npm install && npm run build:mcp`.');
    process.exit(1);
  }
}
