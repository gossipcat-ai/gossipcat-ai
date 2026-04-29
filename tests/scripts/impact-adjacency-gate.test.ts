/**
 * Tests for scripts/impact-adjacency-gate.mjs.
 *
 * Each case spins up a private tmpdir git repo, copies the gate script in,
 * commits a base, then commits the change-under-test on a feature branch.
 * The gate is run with GITHUB_BASE_REF pointing at the base commit so
 * `git diff --name-only <BASE>...HEAD` produces a deterministic diff.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';

const SCRIPT_SRC = path.resolve(
  __dirname,
  '..',
  '..',
  'scripts',
  'impact-adjacency-gate.mjs',
);

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iagate-'));
  execSync('git init -q -b master', { cwd: dir });
  execSync('git config user.email t@t.com && git config user.name t', { cwd: dir, shell: '/bin/sh' });
  // Copy the gate script to the same relative path as production.
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT_SRC, path.join(dir, 'scripts', 'impact-adjacency-gate.mjs'));
  // Seed an initial commit so we have a base ref.
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  execSync('git add -A && git commit -q -m base', { cwd: dir, shell: '/bin/sh' });
  return dir;
}

function baseSha(dir: string): string {
  return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
}

function commitAll(dir: string, msg: string): void {
  execSync(`git add -A && git commit -q -m ${JSON.stringify(msg)}`, { cwd: dir, shell: '/bin/sh' });
}

function runGate(dir: string, env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync('node', ['scripts/impact-adjacency-gate.mjs'], {
      cwd: dir,
      env: { ...process.env, PR_TITLE: '', PR_BODY: '', ...env, IMPACT_ADJACENCY_DRY_RUN: env.IMPACT_ADJACENCY_DRY_RUN ?? '0' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

describe('impact-adjacency-gate', () => {
  it('(a) no annotation in changed files → exit 0', () => {
    const dir = mkRepo();
    const base = baseSha(dir);
    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const x = 1;\n');
    commitAll(dir, 'plain change');
    const res = runGate(dir, { GITHUB_BASE_REF: base });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/OK/);
  });

  it('(b) annotated file + consensus-id in PR_TITLE + matching report → exit 0', () => {
    const dir = mkRepo();
    const base = baseSha(dir);
    fs.writeFileSync(
      path.join(dir, 'src.ts'),
      '// @gossip:impact-adjacent:map-lifecycle\nexport const x = 1;\n',
    );
    fs.mkdirSync(path.join(dir, '.gossip', 'consensus-reports'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.gossip', 'consensus-reports', 'abcdef12-34567890.json'),
      JSON.stringify({ consensus: true }) + '\n',
    );
    commitAll(dir, 'annotated');
    const res = runGate(dir, {
      GITHUB_BASE_REF: base,
      PR_TITLE: 'fix: thing (consensus-id: abcdef12-34567890)',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/OK/);
  });

  it('(c) annotated file + no consensus-id → exit 1', () => {
    const dir = mkRepo();
    const base = baseSha(dir);
    fs.writeFileSync(
      path.join(dir, 'src.ts'),
      '// @gossip:impact-adjacent:map-lifecycle\nexport const x = 1;\n',
    );
    commitAll(dir, 'annotated no consensus');
    const res = runGate(dir, { GITHUB_BASE_REF: base });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/require multi-agent consensus/);
  });

  it('(d) waived annotation only → exit 0 + waiver log line present', () => {
    const dir = mkRepo();
    const base = baseSha(dir);
    fs.writeFileSync(
      path.join(dir, 'src.ts'),
      '// @gossip:impact-adjacent:waived-pattern-mirror\nexport const x = 1;\n',
    );
    commitAll(dir, 'waived');
    const res = runGate(dir, { GITHUB_BASE_REF: base });
    expect(res.status).toBe(0);
    const waiver = fs.readFileSync(path.join(dir, '.gossip', 'waived-impact-adjacency.jsonl'), 'utf8');
    expect(waiver).toMatch(/"file":"src\.ts"/);
    expect(waiver).toMatch(/"sha":"[0-9a-f]{8}"/);
  });

  it('(e) bootstrap exemption: first run on gate file alone → exit 0; second run → exit 1', () => {
    const dir = mkRepo();
    // Annotate the gate file (and only the gate file) on a fresh commit.
    const gatePath = path.join(dir, 'scripts', 'impact-adjacency-gate.mjs');
    const orig = fs.readFileSync(gatePath, 'utf8');
    // Insert annotation AFTER the shebang line so node still parses it.
    const lines = orig.split('\n');
    const annotated = [lines[0], '// @gossip:impact-adjacent:bootstrap-paths', ...lines.slice(1)].join('\n');
    fs.writeFileSync(gatePath, annotated);
    commitAll(dir, 'gate self-annotate');
    const base = execSync('git rev-parse HEAD~1', { cwd: dir }).toString().trim();
    const first = runGate(dir, { GITHUB_BASE_REF: base });
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/bootstrap exemption/);
    const exempt = fs.readFileSync(path.join(dir, '.gossip', 'bootstrap-exemptions.jsonl'), 'utf8');
    expect(exempt).toMatch(/gate":"impact-adjacency/);
    // Second run must NOT re-exempt.
    const second = runGate(dir, { GITHUB_BASE_REF: base });
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/require multi-agent consensus/);
  });

  it('(f) annotation + consensus-id in PR_TITLE but matching <id>.json missing → exit 1', () => {
    const dir = mkRepo();
    const base = baseSha(dir);
    fs.writeFileSync(
      path.join(dir, 'src.ts'),
      '// @gossip:impact-adjacent:map-lifecycle\nexport const x = 1;\n',
    );
    commitAll(dir, 'annotated, no report file');
    const res = runGate(dir, {
      GITHUB_BASE_REF: base,
      PR_TITLE: 'fix: thing (consensus-id: abcdef12-34567890)',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/require multi-agent consensus/);
  });

  it('(g) annotation + consensus-id in PR_TITLE AND <id>.json exists → exit 0', () => {
    const dir = mkRepo();
    const base = baseSha(dir);
    fs.writeFileSync(
      path.join(dir, 'src.ts'),
      '// @gossip:impact-adjacent:map-lifecycle\nexport const x = 1;\n',
    );
    // Pre-create the consensus report file at the expected path.
    fs.mkdirSync(path.join(dir, '.gossip', 'consensus-reports'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.gossip', 'consensus-reports', 'abcdef12-34567890.json'),
      JSON.stringify({ consensus: true }) + '\n',
    );
    commitAll(dir, 'annotated with report');
    const res = runGate(dir, {
      GITHUB_BASE_REF: base,
      PR_TITLE: 'fix: thing (consensus-id: abcdef12-34567890)',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/OK/);
  });

  it('(h) base ref cannot be resolved → exit 1 with "could not resolve base ref"', () => {
    const dir = mkRepo();
    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const x = 1;\n');
    commitAll(dir, 'plain change');
    const res = runGate(dir, { GITHUB_BASE_REF: 'does-not-exist' });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/could not resolve base ref: does-not-exist/);
  });

  it('(i) bootstrap-exemption log with whitespace JSON keys is recognized via JSON.parse', () => {
    const dir = mkRepo();
    // Pre-seed the bootstrap-exemptions log with a whitespace-formatted JSON line.
    fs.mkdirSync(path.join(dir, '.gossip'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.gossip', 'bootstrap-exemptions.jsonl'),
      '{ "gate" : "impact-adjacency", "deployedAt": "2026-04-28T00:00:00Z" }\n',
    );
    // Now stage a gate-only-annotated change. With prior exemption recorded,
    // the second-time path should NOT re-exempt and should fall through to
    // the consensus-required failure.
    const gatePath = path.join(dir, 'scripts', 'impact-adjacency-gate.mjs');
    const orig = fs.readFileSync(gatePath, 'utf8');
    const lines = orig.split('\n');
    const annotated = [lines[0], '// @gossip:impact-adjacent:bootstrap-paths', ...lines.slice(1)].join('\n');
    fs.writeFileSync(gatePath, annotated);
    commitAll(dir, 'gate self-annotate after exemption already logged');
    const base = execSync('git rev-parse HEAD~1', { cwd: dir }).toString().trim();
    const res = runGate(dir, { GITHUB_BASE_REF: base });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/require multi-agent consensus/);
  });
});
