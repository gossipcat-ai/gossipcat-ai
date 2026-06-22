#!/usr/bin/env node
// Rule-book coverage gate.
//
// Fails CI when an operational signal name exists in code but is neither
// documented in an operator-facing doc nor explicitly exempted.
//
// Closes the PR #629 gap: 3 signals added to OPERATIONAL_SIGNAL_NAMES but not
// documented. Now enforced automatically on every CI run.
//
// Pure logic lives in ./rulebook-coverage-gate.lib.cjs so ts-jest can require
// it without flipping on Jest's experimental ESM mode.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./rulebook-coverage-gate.lib.cjs');

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// DOCS_EXEMPT — signals that need no operator-facing doc entry.
// Each entry MUST have an inline reason comment explaining why it is low-level
// plumbing that an operator never acts on directly.
//
// DO NOT blanket-exempt. A signal already appearing in the docs must be left
// OUT of this set — being documented alone satisfies the gate.
// ---------------------------------------------------------------------------
const DOCS_EXEMPT = new Set([
  'task_completed',              // internal task-lifecycle counter; operators see aggregate pass-rates, not this raw event
  'task_tool_turns',             // telemetry for per-task tool-call count; no operator action needed
  'signal_retracted',            // pipeline bookkeeping when a signal is corrected; surfaced only in audit logs
  'task_timeout',                // low-level relay timeout counter; operators act on agent scores, not this raw event
  'task_empty',                  // relay returned empty result; treated as a task_timeout variant internally
  'citation_fabricated',         // operational pipeline signal; fabricated-citation case already actionable via the documented hallucination_caught workflow
  'consensus_round_retracted',   // internal consensus-engine retraction marker; no direct operator remediation
  'transport_failure',           // low-level relay transport error; operators see agent reliability via scores
  'worktree_isolation_failed',   // sandbox-level plumbing; surfaced via boundary_escape signal in operator-visible scoring
  'auto_verify_attempted',       // internal auto-verification telemetry; no operator action step
  'auto_verify_skipped_misconfigured', // internal telemetry when auto-verify config is absent; operators fix config, not this signal
  'unverified',                  // per-finding "cross-reviewer couldn't check" plumbing signal; the UNVERIFIED finding-STATUS is documented in the consensus workflow; the raw signal is internal bookkeeping
]);

// ---------------------------------------------------------------------------
// Operator-facing docs to scan. Signal name as a substring → documented.
// ---------------------------------------------------------------------------
const DOC_PATHS = [
  path.join(ROOT, 'docs', 'HANDBOOK.md'),
  path.join(ROOT, '.claude', 'rules', 'gossipcat.md'),
  path.join(ROOT, 'CLAUDE.md'),
];

const SIGNAL_SOURCE = path.join(
  ROOT,
  'packages',
  'orchestrator',
  'src',
  'consensus-types.ts',
);

function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function safeReadDoc(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    process.stderr.write(`rulebook-coverage-gate: cannot read ${p}\n`);
    process.exit(1);
  }
}

function main() {
  const sourceText = safeRead(SIGNAL_SOURCE);
  if (!sourceText) {
    process.stderr.write(
      `rulebook-coverage-gate: cannot read ${SIGNAL_SOURCE}\n`,
    );
    process.exit(1);
  }

  const signalNames = lib.extractOperationalSignalNames(sourceText);
  if (signalNames.length === 0) {
    process.stderr.write(
      `rulebook-coverage-gate: no signal names found in ${SIGNAL_SOURCE} — ` +
        `check that OPERATIONAL_SIGNAL_NAMES = new Set([...]) is still present.\n`,
    );
    process.exit(1);
  }

  const docsText = DOC_PATHS.map(safeReadDoc).join('\n');

  const missing = lib.findUndocumentedSignals(signalNames, docsText, DOCS_EXEMPT);

  if (missing.length > 0) {
    process.stderr.write(
      `\nrulebook-coverage-gate: ${missing.length} signal(s) are neither documented nor exempted:\n\n`,
    );
    for (const name of missing) {
      process.stderr.write(`  ✗ ${name}\n`);
    }
    process.stderr.write(
      `\nRemediation: for each signal above, either:\n` +
        `  1. Document it in docs/HANDBOOK.md or .claude/rules/gossipcat.md\n` +
        `     (the signal name must appear as a substring — backtick-wrapping counts)\n` +
        `  2. Add it to DOCS_EXEMPT in scripts/rulebook-coverage-gate.mjs with a\n` +
        `     one-line inline reason comment (why no operator-facing doc is needed).\n\n`,
    );
    process.exit(1);
  }

  const exemptCount = signalNames.filter((n) => DOCS_EXEMPT.has(n)).length;
  const docCount = signalNames.length - exemptCount;
  process.stdout.write(
    `rulebook-coverage-gate: OK — checked ${signalNames.length} signal(s): ` +
      `${docCount} documented, ${exemptCount} exempted (plumbing).\n`,
  );
  process.exit(0);
}

main();
