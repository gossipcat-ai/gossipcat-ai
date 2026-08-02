#!/usr/bin/env node
// Issue #675 stage 3 — flip-only-measured skill-index mode migration.
//
// Auto-bound skills were historically pinned to `mode: "permanent"` at both
// bind sites regardless of what the generated skill file declared. Those bind
// sites now honour the declared mode; this script migrates the slots already
// written to `.gossip/skill-index.json`.
//
// Only slots whose skill file declares `mode: contextual` AND has a real
// effectiveness verdict are flipped. Slots still accumulating evidence
// (status pending / insufficient_evidence) stay permanent. `boundAt` is
// preserved byte-for-byte — it anchors the effectiveness measurement window.
//
// Usage:
//   node scripts/migrate-skill-index-modes.mjs [--root <path>] [--dry-run] [--json]
//
// Pure logic lives in ./migrate-skill-index-modes.lib.cjs so ts-jest can
// require it without flipping on Jest's experimental ESM mode.

import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./migrate-skill-index-modes.lib.cjs');

function main() {
  let args;
  try {
    args = lib.parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n${lib.HELP}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(lib.HELP + '\n');
    return 0;
  }

  const root = args.root ?? process.cwd();
  let plan;
  try {
    plan = lib.planMigration(root);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ dryRun: args.dryRun, counts: plan.counts, rows: plan.rows }, null, 2) + '\n');
  } else {
    process.stdout.write(lib.renderReport(plan, { dryRun: args.dryRun }) + '\n');
  }

  if (args.dryRun) return 0;
  if (plan.flips.length === 0) {
    if (!args.json) process.stdout.write('nothing to migrate — index unchanged\n');
    return 0;
  }

  lib.applyFlips(plan);
  try {
    lib.writeIndex(root, plan.data);
  } catch (err) {
    process.stderr.write(`error: failed to write skill index: ${err.message}\n`);
    return 1;
  }
  if (!args.json) process.stdout.write(`wrote ${lib.indexPath(root)} (${plan.flips.length} flipped)\n`);
  return 0;
}

process.exit(main());
