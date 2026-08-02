/**
 * Tests for scripts/migrate-skill-index-modes.mjs (issue #675 stage 3).
 *
 * Pure logic lives in scripts/migrate-skill-index-modes.lib.cjs (CommonJS) so
 * ts-jest can require it without flipping on Jest's experimental ESM mode.
 * The .mjs is a thin CLI wrapper over the same library.
 *
 * Covers:
 *   1. Measured contextual slots flip; boundAt preserved, version bumped
 *   2. pending / insufficient_evidence slots stay permanent
 *   3. no-frontmatter, non-auto, already-contextual, missing-file slots stay
 *   4. --dry-run writes nothing
 *   5. Second run is a no-op (idempotent)
 *   6. Missing index errors with a clear message
 *   7. Unsafe agent/skill keys are never path-joined and never flipped
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require(path.resolve(__dirname, '..', '..', 'scripts', 'migrate-skill-index-modes.lib.cjs'));
const SCRIPT_MJS = path.resolve(__dirname, '..', '..', 'scripts', 'migrate-skill-index-modes.mjs');

const BOUND_AT = '2026-06-01T12:00:00.000Z';

type Slot = {
  skill: string;
  enabled: boolean;
  source: string;
  mode: string;
  version: number;
  boundAt: string;
};

function slot(overrides: Partial<Slot> = {}): Slot {
  return {
    skill: 'trust-boundaries',
    enabled: true,
    source: 'auto',
    mode: 'permanent',
    version: 3,
    boundAt: BOUND_AT,
    ...overrides,
  };
}

function skillMd(fields: string[]): string {
  return ['---', ...fields, '---', '', '## Body', '', 'text', ''].join('\n');
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-index-migrate-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeIndex(data: unknown): void {
  const dir = path.join(root, '.gossip');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill-index.json'), JSON.stringify(data, null, 2) + '\n');
}

function writeSkill(agent: string, name: string, content: string): void {
  const dir = path.join(root, '.gossip', 'agents', agent, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), content);
}

function readIndex(): Record<string, Record<string, Slot>> {
  return JSON.parse(fs.readFileSync(path.join(root, '.gossip', 'skill-index.json'), 'utf8'));
}

function runScript(args: string[] = []): string {
  return execFileSync('node', [SCRIPT_MJS, '--root', root, ...args], { encoding: 'utf8' });
}

// ── parseFrontmatterFields ────────────────────────────────────────────────

describe('parseFrontmatterFields', () => {
  it('reads mode and status from a leading frontmatter block', () => {
    const fm = lib.parseFrontmatterFields(skillMd(['name: x', 'mode: contextual', 'status: passed']));
    expect(fm).toEqual({ mode: 'contextual', status: 'passed' });
  });

  it('strips surrounding double and single quotes', () => {
    const fm = lib.parseFrontmatterFields(skillMd(['mode: "contextual"', "status: 'failed'"]));
    expect(fm).toEqual({ mode: 'contextual', status: 'failed' });
  });

  it('returns null when there is no frontmatter block', () => {
    expect(lib.parseFrontmatterFields('# memory-retrieval\n\nbody\n')).toBeNull();
  });

  it('reports absent fields as null', () => {
    expect(lib.parseFrontmatterFields(skillMd(['name: x']))).toEqual({ mode: null, status: null });
  });
});

// ── isSafeName ────────────────────────────────────────────────────────────

describe('isSafeName', () => {
  it.each(['opus-implementer', 'trust_boundaries', 'a.b-c_1'])('accepts %s', (name) => {
    expect(lib.isSafeName(name)).toBe(true);
  });

  it.each(['..', '.', '../escape', 'a/b', '', '__proto__/x', 'a\0b'])('rejects %j', (name) => {
    expect(lib.isSafeName(name)).toBe(false);
  });
});

// ── planMigration classification ──────────────────────────────────────────

describe('planMigration', () => {
  it('flips a measured contextual auto slot', () => {
    writeIndex({ 'opus-implementer': { 'trust-boundaries': slot() } });
    writeSkill('opus-implementer', 'trust-boundaries', skillMd(['mode: contextual', 'status: passed']));

    const plan = lib.planMigration(root);
    expect(plan.flips).toHaveLength(1);
    expect(plan.rows[0].action).toBe('flip');
  });

  it.each(['pending', 'insufficient_evidence'])('keeps a %s slot permanent', (status) => {
    writeIndex({ 'opus-implementer': { 'trust-boundaries': slot() } });
    writeSkill('opus-implementer', 'trust-boundaries', skillMd(['mode: contextual', `status: ${status}`]));

    const plan = lib.planMigration(root);
    expect(plan.flips).toHaveLength(0);
    expect(plan.rows[0].action).toBe('starved');
  });

  it.each(['passed', 'failed', 'silent_skill', 'inconclusive'])('treats %s as measured', (status) => {
    writeIndex({ 'opus-implementer': { 'trust-boundaries': slot() } });
    writeSkill('opus-implementer', 'trust-boundaries', skillMd(['mode: contextual', `status: ${status}`]));

    expect(lib.planMigration(root).flips).toHaveLength(1);
  });

  it('keeps a slot whose file declares no mode', () => {
    writeIndex({ 'opus-implementer': { 'trust-boundaries': slot() } });
    writeSkill('opus-implementer', 'trust-boundaries', skillMd(['name: x', 'status: passed']));

    const plan = lib.planMigration(root);
    expect(plan.flips).toHaveLength(0);
    expect(plan.rows[0].action).toBe('not_declared_contextual');
  });

  it('keeps a slot whose file has no frontmatter', () => {
    writeIndex({ 'haiku-researcher': { 'memory-retrieval': slot({ skill: 'memory-retrieval' }) } });
    writeSkill('haiku-researcher', 'memory-retrieval', '# memory-retrieval\n\nbody\n');

    const plan = lib.planMigration(root);
    expect(plan.flips).toHaveLength(0);
    expect(plan.rows[0].action).toBe('no_frontmatter');
  });

  it('keeps a slot whose skill file is missing', () => {
    writeIndex({ 'opus-implementer': { 'trust-boundaries': slot() } });

    const plan = lib.planMigration(root);
    expect(plan.flips).toHaveLength(0);
    expect(plan.rows[0].action).toBe('no_file');
  });

  it('never touches non-auto slots even when the file declares contextual', () => {
    writeIndex({ 'opus-implementer': { 'trust-boundaries': slot({ source: 'config' }) } });
    writeSkill('opus-implementer', 'trust-boundaries', skillMd(['mode: contextual', 'status: passed']));

    const plan = lib.planMigration(root);
    expect(plan.flips).toHaveLength(0);
    expect(plan.rows[0].action).toBe('not_auto');
  });

  it('reports already-contextual slots without flipping them', () => {
    writeIndex({ 'opus-implementer': { 'trust-boundaries': slot({ mode: 'contextual' }) } });
    writeSkill('opus-implementer', 'trust-boundaries', skillMd(['mode: contextual', 'status: passed']));

    const plan = lib.planMigration(root);
    expect(plan.flips).toHaveLength(0);
    expect(plan.rows[0].action).toBe('already_contextual');
  });

  it('rejects an unsafe agent key without reading from disk', () => {
    writeIndex({ '../escape': { 'trust-boundaries': slot() } });

    const plan = lib.planMigration(root);
    expect(plan.flips).toHaveLength(0);
    expect(plan.rows[0].action).toBe('unsafe_name');
  });

  it('rejects an unsafe skill key', () => {
    writeIndex({ 'opus-implementer': { '../../etc/passwd': slot() } });

    const plan = lib.planMigration(root);
    expect(plan.flips).toHaveLength(0);
    expect(plan.rows[0].action).toBe('unsafe_name');
  });

  it('throws a clear error when the index is missing', () => {
    expect(() => lib.planMigration(root)).toThrow(/skill index not found/);
  });

  it('throws a clear error when the index is not valid JSON', () => {
    fs.mkdirSync(path.join(root, '.gossip'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gossip', 'skill-index.json'), '{not json');
    expect(() => lib.planMigration(root)).toThrow(/not valid JSON/);
  });
});

// ── CLI behaviour ─────────────────────────────────────────────────────────

describe('migrate-skill-index-modes.mjs', () => {
  function seedMixedIndex(): void {
    writeIndex({
      'opus-implementer': {
        'trust-boundaries': slot(),
        'type-safety': slot({ skill: 'type-safety', version: 1 }),
      },
      'haiku-researcher': {
        'memory-retrieval': slot({ skill: 'memory-retrieval', version: 7 }),
      },
    });
    writeSkill('opus-implementer', 'trust-boundaries', skillMd(['mode: contextual', 'status: passed']));
    writeSkill('opus-implementer', 'type-safety', skillMd(['mode: contextual', 'status: pending']));
    writeSkill('haiku-researcher', 'memory-retrieval', '# memory-retrieval\n\nbody\n');
  }

  it('flips only the measured slot, preserving boundAt and bumping version', () => {
    seedMixedIndex();
    runScript();

    const after = readIndex();
    expect(after['opus-implementer']['trust-boundaries'].mode).toBe('contextual');
    expect(after['opus-implementer']['trust-boundaries'].version).toBe(4);
    expect(after['opus-implementer']['trust-boundaries'].boundAt).toBe(BOUND_AT);

    expect(after['opus-implementer']['type-safety'].mode).toBe('permanent');
    expect(after['opus-implementer']['type-safety'].version).toBe(1);
    expect(after['haiku-researcher']['memory-retrieval'].mode).toBe('permanent');
    expect(after['haiku-researcher']['memory-retrieval'].version).toBe(7);
  });

  it('preserves every other slot field verbatim', () => {
    seedMixedIndex();
    runScript();

    const s = readIndex()['opus-implementer']['trust-boundaries'];
    expect(s.skill).toBe('trust-boundaries');
    expect(s.enabled).toBe(true);
    expect(s.source).toBe('auto');
  });

  it('--dry-run writes nothing', () => {
    seedMixedIndex();
    const file = path.join(root, '.gossip', 'skill-index.json');
    const before = fs.readFileSync(file, 'utf8');

    const out = runScript(['--dry-run']);
    expect(out).toMatch(/DRY RUN/);
    expect(out).toMatch(/flips: 1/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('is idempotent — a second run flips nothing and leaves the file unchanged', () => {
    seedMixedIndex();
    runScript();
    const file = path.join(root, '.gossip', 'skill-index.json');
    const afterFirst = fs.readFileSync(file, 'utf8');

    const out = runScript();
    expect(out).toMatch(/nothing to migrate/);
    expect(fs.readFileSync(file, 'utf8')).toBe(afterFirst);
  });

  it('leaves no temp file behind', () => {
    seedMixedIndex();
    runScript();
    const leftovers = fs.readdirSync(path.join(root, '.gossip')).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('--json emits counts and rows', () => {
    seedMixedIndex();
    const parsed = JSON.parse(runScript(['--dry-run', '--json']));
    expect(parsed.dryRun).toBe(true);
    expect(parsed.counts.flip).toBe(1);
    expect(parsed.rows).toHaveLength(3);
  });

  it('exits non-zero with a clear error when the index is missing', () => {
    let code = 0;
    try {
      execFileSync('node', [SCRIPT_MJS, '--root', root], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err: any) {
      code = err.status;
      expect(String(err.stderr)).toMatch(/skill index not found/);
    }
    expect(code).toBe(1);
  });

  it('--help documents --dry-run and --root', () => {
    const out = execFileSync('node', [SCRIPT_MJS, '--help'], { encoding: 'utf8' });
    expect(out).toMatch(/--dry-run/);
    expect(out).toMatch(/--root/);
  });

  it('rejects an unknown argument', () => {
    let code = 0;
    try {
      execFileSync('node', [SCRIPT_MJS, '--bogus'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err: any) {
      code = err.status;
      expect(String(err.stderr)).toMatch(/unknown argument/);
    }
    expect(code).toBe(2);
  });
});
