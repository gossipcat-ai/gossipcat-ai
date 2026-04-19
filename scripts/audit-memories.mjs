#!/usr/bin/env node
// Triage tool for institutional-knowledge-propagation §6.
// READ-ONLY. Scores memory files on a 0-3 rubric, classifies them into
// MODEL_INTRINSIC / PROTOCOL_BOUND / USER_SPECIFIC, counts provenance hits,
// and proposes a target destination (HANDBOOK | model-skill | DROP).
//
// Spec: docs/specs/2026-04-19-institutional-knowledge-propagation.md §6
//
// Usage:
//   node scripts/audit-memories.mjs [--dir <path>] [--json] [--candidates-only]
//                                   [--codenames a,b,c] [--help]
//
// Pure logic lives in ./audit-memories.lib.cjs so ts-jest can require it
// without flipping on Jest's experimental ESM mode.

import os from 'node:os';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./audit-memories.lib.cjs');

async function main() {
  const args = lib.parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(lib.HELP + '\n');
    return 0;
  }
  const dir = args.dir ?? lib.defaultMemoryDir(process.cwd(), os.homedir());
  let result;
  try {
    result = lib.auditDir(dir, { codenames: args.codenames, includeShipped: args.includeShipped });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }
  for (const w of result.warnings) process.stderr.write(w + '\n');
  let rows = result.rows;
  if (args.candidatesOnly) rows = rows.filter((r) => r.proposed_target !== 'DROP');
  if (args.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  } else {
    process.stdout.write(`# audit-memories — ${dir}\n`);
    process.stdout.write(`# rows: ${rows.length}\n`);
    process.stdout.write(lib.renderTable(rows) + '\n');
  }
  return 0;
}

main().then((code) => process.exit(code));
