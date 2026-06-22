#!/usr/bin/env npx tsx
/**
 * One-shot migration: backfill `category` on existing empty-category consensus
 * signals in `.gossip/agent-performance.jsonl` by running the shared
 * `extractCategories()` keyword matcher over each signal's `evidence` and
 * `finding` text.
 *
 * Context — issue #148: four signal-write sites in consensus-engine.ts were
 * writing `category: ''` until PR #150 fixed them. The reader
 * (performance-reader.getCountersSince) silently skips any row with
 * `!s.category`, so ~2560 historical signals are invisible to the
 * MIN_EVIDENCE=120 gate. This script recovers whatever keyword-bearing
 * evidence still parses.
 *
 * Usage:
 *   npx tsx scripts/backfill-signal-categories.ts --dry-run
 *   npx tsx scripts/backfill-signal-categories.ts --apply
 *
 * --dry-run: print recovery stats only, do not touch the file
 * --apply:   write back in place; original saved to <path>.bak-<timestamp>
 *
 * Skip-list: signal types with no category semantics are left empty.
 *   unverified, signal_retracted, consensus_verified, consensus_round_retracted
 */

import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join } from 'path';
import { extractCategories } from '../packages/orchestrator/src/category-extractor';

const SKIP_SIGNALS = new Set([
  'unverified',
  'signal_retracted',
  'consensus_verified',
  'consensus_round_retracted',
]);

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const apply = process.argv.includes('--apply');
  if (!dryRun && !apply) {
    console.error('Usage: backfill-signal-categories.ts --dry-run | --apply');
    process.exit(1);
  }

  const path = join(process.cwd(), '.gossip', 'agent-performance.jsonl');
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n');

  let total = 0;
  let eligibleEmpty = 0;
  let recovered = 0;
  let stillEmpty = 0;
  const byType: Record<string, { eligible: number; recovered: number }> = {};
  const byCategory: Record<string, number> = {};

  const outLines: string[] = [];

  for (const line of lines) {
    if (!line.trim()) { outLines.push(line); continue; }

    let rec: any;
    try { rec = JSON.parse(line); } catch { outLines.push(line); continue; }

    if (rec.type !== 'consensus') { outLines.push(line); continue; }
    total++;

    const hasCategory = typeof rec.category === 'string' && rec.category.trim().length > 0;
    if (hasCategory) { outLines.push(line); continue; }

    if (SKIP_SIGNALS.has(rec.signal)) { outLines.push(line); continue; }

    const sigType = rec.signal || '<unknown>';
    byType[sigType] = byType[sigType] || { eligible: 0, recovered: 0 };
    byType[sigType].eligible++;
    eligibleEmpty++;

    const evidence: string = rec.evidence || '';
    const finding: string = rec.finding || '';
    // Try evidence first (reviewer text), then finding (original author text).
    const cats = extractCategories(evidence);
    const pick = cats[0] || extractCategories(finding)[0];

    if (pick) {
      recovered++;
      byType[sigType].recovered++;
      byCategory[pick] = (byCategory[pick] || 0) + 1;
      rec.category = pick;
      rec.category_backfilled_at = new Date().toISOString();
      outLines.push(JSON.stringify(rec));
    } else {
      stillEmpty++;
      outLines.push(line);
    }
  }

  console.log(`\nTotal consensus signals: ${total}`);
  console.log(`Eligible (empty + categorizable signal type): ${eligibleEmpty}`);
  console.log(`Recovered: ${recovered} (${eligibleEmpty > 0 ? ((recovered / eligibleEmpty) * 100).toFixed(1) : 0}%)`);
  console.log(`Still empty after backfill: ${stillEmpty}`);

  console.log('\nRecovery by signal type:');
  for (const [sig, stats] of Object.entries(byType).sort((a, b) => b[1].eligible - a[1].eligible)) {
    const pct = stats.eligible > 0 ? ((stats.recovered / stats.eligible) * 100).toFixed(0) : '0';
    console.log(`  ${sig.padEnd(30)} ${String(stats.recovered).padStart(5)} / ${String(stats.eligible).padEnd(5)}  (${pct}%)`);
  }

  console.log('\nRecovered categories:');
  for (const [cat, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(20)} ${n}`);
  }

  if (dryRun) {
    console.log('\n[dry-run] no file written.');
    return;
  }

  const backup = `${path}.bak-${Date.now()}`;
  copyFileSync(path, backup);
  console.log(`\nBackup: ${backup}`);
  writeFileSync(path, outLines.join('\n'));
  console.log(`Wrote: ${path}`);
}

main();
