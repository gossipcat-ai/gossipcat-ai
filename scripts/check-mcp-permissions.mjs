#!/usr/bin/env node
// Diff `tools:` frontmatter in .claude/agents/*.md against `allow:` entries
// in .claude/settings.json. Exits non-zero if any agent declares an MCP tool
// that isn't in the committed allowlist — Claude Code blocks tools missing
// from the project allowlist regardless of agent declarations, which silently
// disables them (see PR #384 / session 2026-05-14 gossip_remember incident).
//
// Usage:
//   node scripts/check-mcp-permissions.mjs            # human-readable
//   node scripts/check-mcp-permissions.mjs --json     # machine output
//   node scripts/check-mcp-permissions.mjs --strict   # also flag allowed-but-unused

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const REPO_ROOT = process.cwd();
const SETTINGS_PATH = join(REPO_ROOT, '.claude/settings.json');
const AGENTS_DIR = join(REPO_ROOT, '.claude/agents');

function parseFrontmatterTools(md) {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  const tools = [];
  let inTools = false;
  for (const line of match[1].split('\n')) {
    if (/^tools\s*:/.test(line)) { inTools = true; continue; }
    if (inTools) {
      const item = line.match(/^\s+-\s+(\S+)/);
      if (item) { tools.push(item[1]); continue; }
      if (line.trim() && !line.startsWith(' ')) break;
    }
  }
  return tools;
}

function loadAllowlist() {
  const raw = readFileSync(SETTINGS_PATH, 'utf-8');
  const cfg = JSON.parse(raw);
  return new Set(cfg?.permissions?.allow ?? []);
}

function loadAgents() {
  return readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      id: f.replace(/\.md$/, ''),
      tools: parseFrontmatterTools(readFileSync(join(AGENTS_DIR, f), 'utf-8')),
    }));
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const strict = args.includes('--strict');

  const allow = loadAllowlist();
  const agents = loadAgents();

  const declaredMcp = new Set();
  const missing = [];

  for (const agent of agents) {
    for (const tool of agent.tools) {
      if (!tool.startsWith('mcp__')) continue;
      declaredMcp.add(tool);
      if (!allow.has(tool)) missing.push({ agent: agent.id, tool });
    }
  }

  const unused = strict
    ? [...allow].filter(t => t.startsWith('mcp__') && !declaredMcp.has(t))
    : [];

  if (asJson) {
    process.stdout.write(JSON.stringify({ missing, unused }, null, 2) + '\n');
  } else {
    if (missing.length === 0) {
      process.stdout.write('OK — every MCP tool declared in .claude/agents/*.md is in .claude/settings.json allow:\n');
    } else {
      process.stdout.write(`SILENT-DISABLE RISK — ${missing.length} agent/tool pair(s) declared but not allowlisted:\n`);
      for (const m of missing) process.stdout.write(`  ${m.agent}  →  ${m.tool}\n`);
      process.stdout.write('\nFix: add the missing tool(s) to .claude/settings.json permissions.allow.\n');
    }
    if (strict && unused.length) {
      process.stdout.write(`\nINFO — ${unused.length} MCP tool(s) allowlisted but no agent declares them:\n`);
      for (const u of unused) process.stdout.write(`  ${u}\n`);
    }
  }

  return missing.length > 0 ? 1 : 0;
}

process.exit(main());
