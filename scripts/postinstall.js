#!/usr/bin/env node
/**
 * Generates .mcp.json with the correct absolute path to mcp-server.js
 * for the current install method (global npm, local project dep, git clone).
 *
 * Never shipped in the package tarball — always regenerated per machine.
 */
const { join, resolve } = require('path');
const { existsSync, writeFileSync } = require('fs');

const scriptDir = __dirname;          // .../gossipcat/scripts/
const packageRoot = resolve(scriptDir, '..'); // .../gossipcat/
const mcpServerPath = join(packageRoot, 'dist-mcp', 'mcp-server.js');

// Detect install method:
//   global npm  → process.env.npm_config_global === 'true'
//   git clone   → .git exists at packageRoot (development)
//   local dep   → neither of the above
const isGlobal = process.env.npm_config_global === 'true';
const isGitClone = existsSync(join(packageRoot, '.git'));

// For git clones: skip if .mcp.json already exists (developer already set up)
if (isGitClone && existsSync(join(packageRoot, '.mcp.json'))) {
  console.log('gossipcat: .mcp.json already exists — skipping (git clone)');
  process.exit(0);
}

// For project-local installs: write .mcp.json into the consumer project root,
// not into node_modules/gossipcat. Detect consumer root by walking up from
// node_modules to the directory that contains it.
let outputDir = packageRoot; // default: package dir (global or git clone)
if (!isGlobal && !isGitClone) {
  // node_modules/gossipcat → node_modules → project root
  const nodeModulesDir = resolve(packageRoot, '..');   // node_modules/
  const projectRoot = resolve(nodeModulesDir, '..');   // project root
  if (existsSync(join(nodeModulesDir, '..', 'package.json'))) {
    outputDir = projectRoot;
  }
}

const mcpConfig = join(outputDir, '.mcp.json');

const config = {
  mcpServers: {
    gossipcat: {
      command: 'node',
      args: [mcpServerPath],
    },
  },
};

writeFileSync(mcpConfig, JSON.stringify(config, null, 2) + '\n');

const method = isGlobal ? 'global npm' : isGitClone ? 'git clone' : 'local install';
console.log(`gossipcat: wrote .mcp.json (${method}) → ${mcpServerPath}`);

if (!existsSync(mcpServerPath)) {
  if (isGitClone) {
    console.log('gossipcat: dist-mcp/mcp-server.js not built yet — run: npm run build:mcp');
  } else {
    console.error('gossipcat: FATAL — dist-mcp/mcp-server.js missing from package. Install is corrupted.');
    process.exit(1);
  }
}
