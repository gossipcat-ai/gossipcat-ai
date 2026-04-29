#!/usr/bin/env node
// Phase 1 of the impact-adjacency consensus gate
// (spec: docs/specs/2026-04-28-impact-adjacency-gate.md).
//
// Greps the PR diff for `// @gossip:impact-adjacent:<category>` annotations.
// If any annotated file is changed, requires:
//   - a consensus-id in the PR title/body, AND
//   - a corresponding `.gossip/consensus-reports/<id>.json` file present.
// `waived-pattern-mirror` annotations are logged and skipped.
// On first deploy of the gate file itself, exempts gate-only diffs once.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ANNOTATION_RE =
  /\/\/\s*@gossip:impact-adjacent:(map-lifecycle|ttl-semantics|config-writes|signal-pipeline|auth-boundaries|bootstrap-paths|shared-state-with-lifecycle|waived-pattern-mirror)\b/g;
const GATE_FILES = new Set([
  'scripts/impact-adjacency-gate.mjs',
  '.github/workflows/impact-adjacency-gate.yml',
]);
const ROOT = process.cwd();
const GOSSIP_DIR = path.join(ROOT, '.gossip');
const WAIVER_LOG = path.join(GOSSIP_DIR, 'waived-impact-adjacency.jsonl');
const REPORTS_DIR = path.join(GOSSIP_DIR, 'consensus-reports');
const BOOTSTRAP_LOG = path.join(GOSSIP_DIR, 'bootstrap-exemptions.jsonl');

const DRY_RUN = process.env.IMPACT_ADJACENCY_DRY_RUN === '1';
const PR_TITLE = process.env.PR_TITLE ?? '';
const PR_BODY = process.env.PR_BODY ?? '';
// IMPACT_ADJACENCY_BASE is preferred over GITHUB_BASE_REF because the latter
// collides with the runner's built-in env (the base BRANCH name, e.g. "master"),
// which can shadow the workflow's step-level override and make `git diff <ref>...HEAD`
// fail in shallow-or-otherwise-incomplete clones.
const BASE = process.env.IMPACT_ADJACENCY_BASE || process.env.GITHUB_BASE_REF || 'origin/master';

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}
function appendLine(p, obj) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
}
function headSha8() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT })
      .toString().trim().slice(0, 8);
  } catch { return ''; }
}
function changedFiles() {
  // Fail closed: if `git diff` cannot resolve the base ref, exit 1 instead
  // of returning an empty list (silent fail-open lets annotated PRs slip).
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${BASE}...HEAD`], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    process.stderr.write(`could not resolve base ref: ${BASE}\n`);
    process.exit(1);
  }
}
function annotationsIn(file) {
  // Path-traversal hardening: even though `git diff --name-only` should only
  // emit repo-relative paths, defensively reject anything that resolves
  // outside ROOT (e.g. crafted paths via `..`, or symlinks).
  const abs = path.join(ROOT, file);
  let resolved;
  try {
    resolved = fs.existsSync(abs) ? fs.realpathSync(abs) : path.resolve(abs);
  } catch {
    return [];
  }
  const rootResolved = (() => {
    try { return fs.realpathSync(ROOT); } catch { return path.resolve(ROOT); }
  })();
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return [];
  }
  if (!fs.existsSync(abs)) return [];
  const txt = safeRead(abs);
  const cats = new Set();
  for (const m of txt.matchAll(ANNOTATION_RE)) cats.add(m[1]);
  return [...cats];
}
// Phase 1: PR title/body must contain a consensus-id matching the regex.
// File-existence verification (Phase 2) requires consensus reports to be
// available to CI; .gossip/ is currently gitignored, so the per-id JSON files
// are local-only. Until consensus receipts get a tracked storage (separate
// public ledger or gh artifact), Phase 1 is declarative: the gate trusts the
// PR description. Forge protection is a Phase 2 concern.
function consensusIdInPr() {
  const re = /consensus[\s\-_:]?id[: ]+([0-9a-f]{8}-[0-9a-f]{8})/i;
  const m = PR_TITLE.match(re) || PR_BODY.match(re);
  if (m) return { matched: true, id: m[1].toLowerCase() };
  return { matched: false, id: null };
}
function gateNotInBase() {
  // First-deploy signal: gate workflow file does not exist on the merge base.
  // Once merged, subsequent runs see it on master and bootstrap exemption
  // never re-fires. This is a more honest "first deploy" check than counting
  // gate-file-only diffs.
  try {
    execFileSync('git', ['cat-file', '-e', `${BASE}:.github/workflows/impact-adjacency-gate.yml`], {
      cwd: ROOT, stdio: 'ignore',
    });
    return false;
  } catch { return true; }
}
function bootstrapAlreadyExempted() {
  const txt = safeRead(BOOTSTRAP_LOG);
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.gate === 'impact-adjacency') return true;
    } catch { /* skip malformed silently */ }
  }
  return false;
}

// Test/fixture files routinely embed annotation strings as string literals
// (e.g. tests/scripts/impact-adjacency-gate.test.ts writes them into tmp git
// repos). Skip them to avoid false-positive matches.
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|fixtures?)\//;

function main() {
  const files = changedFiles();
  const annotated = [];
  const waivedOnly = [];
  for (const f of files) {
    if (TEST_PATH_RE.test(f)) continue;
    const cats = annotationsIn(f);
    if (cats.length === 0) continue;
    if (cats.length === 1 && cats[0] === 'waived-pattern-mirror') {
      waivedOnly.push(f);
    } else {
      annotated.push({ file: f, categories: cats.filter((c) => c !== 'waived-pattern-mirror') });
    }
  }
  const sha = headSha8();
  const ts = new Date().toISOString();

  for (const f of waivedOnly) {
    appendLine(WAIVER_LOG, { file: f, sha, ts });
  }

  // Bootstrap exemption: fires once when the gate is first deployed (workflow
  // file absent on merge base) and never exempted before in the log.
  const annotatedFiles = annotated.map((a) => a.file);
  if (annotated.length > 0 && gateNotInBase() && !bootstrapAlreadyExempted()) {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    appendLine(BOOTSTRAP_LOG, {
      gate: 'impact-adjacency',
      deployedAt: ts,
      expiresAt,
      headSha: sha,
    });
    process.stdout.write('OK (bootstrap exemption — gate first deploy)\n');
    process.exit(0);
  }

  if (annotated.length === 0) {
    process.stdout.write('OK (no annotated files)\n');
    process.exit(0);
  }

  const idResult = consensusIdInPr();
  if (idResult.matched) {
    process.stdout.write(`OK (annotated: ${annotatedFiles.join(', ')}, consensus-id: ${idResult.id})\n`);
    process.exit(0);
  }

  process.stderr.write(
    `Files marked @gossip:impact-adjacent:* require multi-agent consensus. ` +
      `Run gossip_dispatch(mode:'consensus', ...) and add consensus-id to the PR description.\n` +
      `Annotated files: ${annotatedFiles.join(', ')}\n`,
  );
  process.exit(1);
}

main();
