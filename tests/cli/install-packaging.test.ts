/**
 * Tarball integrity regression guard — install-packaging.test.ts
 *
 * Verifies that the root package.json `files` array includes every artifact
 * required for a working npm install, and that those artifacts are
 * structurally sound (present, non-empty, contain expected markers).
 *
 * All assertions use fs.readFileSync / existsSync / statSync only.
 * No exec, no spawnSync, no network calls.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';

// Resolve project root from tests/cli/ → ../../
const PROJECT_ROOT = resolve(__dirname, '..', '..');

function pkgFiles(): string[] {
  const raw = readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw) as { files?: string[] };
  return pkg.files ?? [];
}

// ── package.json `files` membership ───────────────────────────────────────

describe('package.json `files` — required tarball entries', () => {
  let files: string[];

  beforeAll(() => {
    files = pkgFiles();
  });

  it('includes docs/HANDBOOK.md', () => {
    expect(files).toContain('docs/HANDBOOK.md');
  });

  it('includes docs/RULES.md', () => {
    // Source of truth for rules-content.ts (which reads it via readFileSync
    // with the same fallback chain as HANDBOOK.md). A missing entry here ships
    // a tarball whose generateRulesContent() throws on gossip_setup.
    expect(files).toContain('docs/RULES.md');
  });

  it('includes dist-mcp/', () => {
    expect(files).toContain('dist-mcp/');
  });

  it('includes dist-dashboard/', () => {
    expect(files).toContain('dist-dashboard/');
  });

  it('includes scripts/postinstall.js', () => {
    expect(files).toContain('scripts/postinstall.js');
  });
});

// ── docs/HANDBOOK.md integrity ────────────────────────────────────────────

describe('docs/HANDBOOK.md — file integrity', () => {
  const handbookPath = resolve(PROJECT_ROOT, 'docs', 'HANDBOOK.md');

  it('exists on disk', () => {
    expect(existsSync(handbookPath)).toBe(true);
  });

  it('is larger than 5 000 bytes (catches silent truncation)', () => {
    // Handbook is ~28 KB; a 5 KB floor catches accidental truncation or
    // replacement with a stub while still being generous enough not to
    // break when non-essential sections are trimmed.
    const { size } = statSync(handbookPath);
    expect(size).toBeGreaterThan(5000);
  });
});

// ── docs/RULES.md integrity ──────────────────────────────────────────────

describe('docs/RULES.md — file integrity', () => {
  const rulesPath = resolve(PROJECT_ROOT, 'docs', 'RULES.md');

  it('exists on disk', () => {
    expect(existsSync(rulesPath)).toBe(true);
  });

  it('contains the {{AGENT_LIST}} placeholder (substitution token present)', () => {
    const body = readFileSync(rulesPath, 'utf-8');
    expect(body).toContain('{{AGENT_LIST}}');
  });

  it('is larger than 3 000 bytes (catches silent truncation)', () => {
    const { size } = statSync(rulesPath);
    expect(size).toBeGreaterThan(3000);
  });
});

// ── scripts/postinstall.js integrity ─────────────────────────────────────

describe('scripts/postinstall.js — error-path regression guard', () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(resolve(PROJECT_ROOT, 'scripts', 'postinstall.js'), 'utf-8');
  });

  it('contains console.error (fatal error reporting path present)', () => {
    // Guards against a silent-warn revert where console.error is replaced
    // with console.log, masking install corruption from users.
    expect(source).toContain('console.error');
  });

  it('contains process.exit(1) (hard-exit on fatal install failure)', () => {
    // Guards against the error path being softened to a warning-only exit.
    // If dist-mcp/mcp-server.js is missing in a non-git-clone install, the
    // postinstall MUST exit non-zero so npm/npx surfaces the failure.
    expect(source).toContain('process.exit(1)');
  });
});
