#!/usr/bin/env node
const { join } = require('path');
const { existsSync, writeFileSync } = require('fs');

const root = join(__dirname, '..');
const mcpConfig = join(root, '.mcp.json');

if (existsSync(mcpConfig)) {
  return;
}

const config = {
  mcpServers: {
    gossipcat: {
      command: 'node',
      args: [join(root, 'dist-mcp', 'mcp-server.js')],
    },
  },
};

writeFileSync(mcpConfig, JSON.stringify(config, null, 2) + '\n');
console.log('Created .mcp.json — run `npm run build:mcp` next');
