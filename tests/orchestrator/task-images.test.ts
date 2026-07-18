// Mock 'fs' by spreading the real module and wrapping fstatSync in a jest.fn so
// it becomes configurable (Node's real fs.fstatSync is non-configurable, so
// jest.spyOn cannot redefine it). Everything else delegates to the real fs, so
// file I/O in these tests is genuine; only fstatSync is overridable per-call
// (used to simulate an under-reporting fstat for the read-cap belt test).
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, fstatSync: jest.fn(actual.fstatSync) };
});

import * as fs from 'fs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveTaskImages,
  buildUserContent,
  detectImagePathsInText,
  providerSupportsVision,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
} from '../../packages/orchestrator/src/task-images';
import { ImageContent, TextContent } from '../../packages/types/src/tools';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('task-images — image attachment resolution for relay dispatch', () => {
  let dir: string;
  const mk = (name: string, body: Buffer): string => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'task-images-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe('providerSupportsVision', () => {
    it.each(['openai', 'google', 'anthropic', 'grok', 'local'])('is true for vision provider %s', (p) => {
      expect(providerSupportsVision(p)).toBe(true);
    });
    it.each(['deepseek', 'openclaw', 'none', undefined, ''])('is false for text-only / unknown provider %s', (p) => {
      expect(providerSupportsVision(p as any)).toBe(false);
    });
  });

  describe('detectImagePathsInText (auto-detect regex)', () => {
    it('extracts absolute png/jpg/jpeg paths from prose', () => {
      const text = 'Compare /a/b/shot.png with /x/y/before.jpeg and /p/q/after.jpg please';
      expect(detectImagePathsInText(text)).toEqual(['/a/b/shot.png', '/x/y/before.jpeg', '/p/q/after.jpg']);
    });
    it('ignores relative paths and non-image extensions', () => {
      const text = 'see ./local.png and notes.txt and /abs/doc.pdf';
      expect(detectImagePathsInText(text)).toEqual([]);
    });
    it('de-duplicates repeated paths, first-seen order', () => {
      const text = '/a/b.png then again /a/b.png and /c/d.png';
      expect(detectImagePathsInText(text)).toEqual(['/a/b.png', '/c/d.png']);
    });
    it('strips leading bracket/quote punctuation abutting a path (trailing handled by \\b)', () => {
      // The regex ends in `\b` right after the extension, so the raw match never
      // includes trailing punctuation — only a leading trim is needed.
      expect(detectImagePathsInText('look at (/a/b.png).')).toEqual(['/a/b.png']);
      expect(detectImagePathsInText('see "/x/y.jpeg", then')).toEqual(['/x/y.jpeg']);
      expect(detectImagePathsInText('[/p/q.jpg];')).toEqual(['/p/q.jpg']);
    });
  });

  describe('base64 block construction', () => {
    it('reads a PNG and produces an image/png base64 block', () => {
      const p = mk('a.png', Buffer.concat([PNG_MAGIC, Buffer.from('rest')]));
      const r = resolveTaskImages({ task: 't', images: [p], provider: 'openai' });
      expect(r.errors).toEqual([]);
      expect(r.blocks).toHaveLength(1);
      expect(r.blocks[0]).toEqual<ImageContent>({
        type: 'image',
        mediaType: 'image/png',
        data: Buffer.concat([PNG_MAGIC, Buffer.from('rest')]).toString('base64'),
      });
    });
    it('reads a JPEG (.jpg) and produces an image/jpeg base64 block', () => {
      const p = mk('a.jpg', Buffer.concat([JPEG_MAGIC, Buffer.from('body')]));
      const r = resolveTaskImages({ task: 't', images: [p], provider: 'google' });
      expect(r.errors).toEqual([]);
      expect(r.blocks[0].mediaType).toBe('image/jpeg');
    });
  });

  describe('auto-detect from task text when no explicit images field', () => {
    it('attaches an absolute path found in the task text', () => {
      const p = mk('shot.png', PNG_MAGIC);
      const r = resolveTaskImages({ task: `Look at ${p} and describe it`, provider: 'openai' });
      expect(r.autoDetected).toBe(true);
      expect(r.blocks).toHaveLength(1);
    });
    it('explicit images field wins over text auto-detect', () => {
      const inText = mk('intext.png', PNG_MAGIC);
      const explicit = mk('explicit.png', PNG_MAGIC);
      const r = resolveTaskImages({ task: `mentions ${inText}`, images: [explicit], provider: 'openai' });
      expect(r.autoDetected).toBe(false);
      expect(r.blocks).toHaveLength(1);
      // explicit file content is identical here; assert it did NOT auto-detect a 2nd
      expect(r.blocks).toHaveLength(1);
    });
  });

  describe('guardrails', () => {
    it('non-existent path → per-image error, not a silent drop', () => {
      const r = resolveTaskImages({ task: 't', images: ['/nope/missing.png'], provider: 'openai' });
      expect(r.blocks).toEqual([]);
      expect(r.errors[0]).toMatch(/missing\.png: file not found/);
    });
    it('unsupported extension → per-image error', () => {
      const p = mk('a.gif', Buffer.from([0x47, 0x49, 0x46, 0x38]));
      const r = resolveTaskImages({ task: 't', images: [p], provider: 'openai' });
      expect(r.errors[0]).toMatch(/unsupported extension/);
    });
    it('mislabeled content (.png that is not a PNG) → magic-byte rejection', () => {
      const p = mk('fake.png', Buffer.from('%PDF-1.4 not an image'));
      const r = resolveTaskImages({ task: 't', images: [p], provider: 'openai' });
      expect(r.blocks).toEqual([]);
      expect(r.errors[0]).toMatch(/not valid PNG or JPEG/);
    });
    it('oversize image (> MAX_IMAGE_BYTES) → rejected with size error', () => {
      const big = Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_IMAGE_BYTES + 1 - PNG_MAGIC.length, 0)]);
      const p = mk('big.png', big);
      const r = resolveTaskImages({ task: 't', images: [p], provider: 'openai' });
      expect(r.blocks).toEqual([]);
      expect(r.errors[0]).toMatch(/too large/);
    });
    it('more than MAX_IMAGES → overflow rejected, first MAX_IMAGES kept', () => {
      const paths = Array.from({ length: MAX_IMAGES + 2 }, (_, i) => mk(`i${i}.png`, PNG_MAGIC));
      const r = resolveTaskImages({ task: 't', images: paths, provider: 'openai' });
      expect(r.blocks).toHaveLength(MAX_IMAGES);
      expect(r.errors.some(e => /too many images/.test(e))).toBe(true);
    });
    it('auto-detect also capped at MAX_IMAGES', () => {
      const paths = Array.from({ length: MAX_IMAGES + 1 }, (_, i) => mk(`d${i}.png`, PNG_MAGIC));
      const r = resolveTaskImages({ task: `imgs ${paths.join(' ')}`, provider: 'openai' });
      expect(r.blocks.length).toBeLessThanOrEqual(MAX_IMAGES);
    });
  });

  describe('vision gate', () => {
    it('text-only provider ignores images with a notice, no blocks', () => {
      const p = mk('a.png', PNG_MAGIC);
      const r = resolveTaskImages({ task: 't', images: [p], provider: 'deepseek' });
      expect(r.blocks).toEqual([]);
      expect(r.notices[0]).toMatch(/not vision-capable/);
    });
    it('undefined provider ignored with a notice', () => {
      const p = mk('a.png', PNG_MAGIC);
      const r = resolveTaskImages({ task: 't', images: [p] });
      expect(r.blocks).toEqual([]);
      expect(r.notices).toHaveLength(1);
    });
  });

  describe('buildUserContent', () => {
    it('returns the plain task string when no images resolved (backward compatible)', () => {
      const r = resolveTaskImages({ task: 'plain task', provider: 'openai' });
      expect(buildUserContent('plain task', r)).toBe('plain task');
    });
    it('returns a multimodal ContentBlock[] with text first, then image blocks', () => {
      const p = mk('a.png', PNG_MAGIC);
      const r = resolveTaskImages({ task: 'describe', images: [p], provider: 'openai' });
      const content = buildUserContent('describe', r);
      expect(Array.isArray(content)).toBe(true);
      const arr = content as Array<TextContent | ImageContent>;
      expect(arr[0].type).toBe('text');
      expect((arr[0] as TextContent).text).toContain('describe');
      expect(arr[1].type).toBe('image');
    });
    it('surfaces EXPLICIT per-image errors in the text even when a valid image is present', () => {
      const good = mk('good.png', PNG_MAGIC);
      const content = buildUserContent(
        'task',
        resolveTaskImages({ task: 'task', images: [good, '/nope/x.png'], provider: 'openai' }),
      ) as Array<TextContent | ImageContent>;
      expect((content[0] as TextContent).text).toMatch(/image attachment errors/);
      expect((content[0] as TextContent).text).toMatch(/file not found/);
    });
    it('surfaces EXPLICIT errors as a plain string when NO image resolved (all rejected)', () => {
      const r = resolveTaskImages({ task: 'task', images: ['/nope/x.png'], provider: 'openai' });
      const content = buildUserContent('task', r);
      expect(typeof content).toBe('string');
      expect(content as string).toMatch(/image attachment errors/);
    });
    it('does NOT surface AUTO-DETECTED errors in the prompt — byte-identical prose task', () => {
      // A path-shaped token in prose that fails to resolve is auto-detect, not an
      // explicit request. The prompt must stay byte-identical (log-only errors).
      const task = 'Investigate /nope/ghost.png and report back';
      const r = resolveTaskImages({ task, provider: 'openai' });
      expect(r.autoDetected).toBe(true);
      expect(r.errors.some(e => /file not found/.test(e))).toBe(true);
      const content = buildUserContent(task, r);
      expect(typeof content).toBe('string');
      expect(content).toBe(task); // byte-identical
      expect(content as string).not.toMatch(/image attachment errors/);
    });
    it('does NOT surface AUTO-DETECTED errors even when a valid image is present', () => {
      const good = mk('good.png', PNG_MAGIC);
      const task = `Compare ${good} with /nope/missing.png`;
      const r = resolveTaskImages({ task, provider: 'openai' });
      expect(r.autoDetected).toBe(true);
      const content = buildUserContent(task, r) as Array<TextContent | ImageContent>;
      expect((content[0] as TextContent).text).toBe(task);
      expect((content[0] as TextContent).text).not.toMatch(/image attachment errors/);
      expect(content[1].type).toBe('image');
    });
  });

  describe('capped / TOCTOU-resistant read', () => {
    afterEach(() => (fs.fstatSync as jest.Mock).mockClear());
    it('rejects when bytes read exceed the cap even if fstat under-reports (belt-and-suspenders)', () => {
      // Real file is > cap, but a lying fstat reports it small so the size gate
      // passes. The capped read must still detect the over-cap file.
      const over = Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_IMAGE_BYTES + 8 - PNG_MAGIC.length, 0)]);
      const p = mk('lying.png', over);
      (fs.fstatSync as jest.Mock).mockReturnValueOnce({ isFile: () => true, size: 128 });
      const r = resolveTaskImages({ task: 't', images: [p], provider: 'openai' });
      expect(r.blocks).toEqual([]);
      expect(r.errors[0]).toMatch(/read cap/);
    });
    it('accepts a file exactly at the cap boundary', () => {
      const atCap = Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_IMAGE_BYTES - PNG_MAGIC.length, 0)]);
      const p = mk('atcap.png', atCap);
      const r = resolveTaskImages({ task: 't', images: [p], provider: 'openai' });
      expect(r.errors).toEqual([]);
      expect(r.blocks).toHaveLength(1);
    });
  });

  describe('allowed-root confinement (path policy)', () => {
    it('accepts an image that resolves within projectRoot', () => {
      const good = mk('inroot.png', PNG_MAGIC);
      const r = resolveTaskImages({ task: 't', images: [good], provider: 'openai', projectRoot: dir });
      expect(r.errors).toEqual([]);
      expect(r.blocks).toHaveLength(1);
    });
    it('rejects an image that resolves OUTSIDE projectRoot (sibling dir)', () => {
      const outside = mkdtempSync(join(tmpdir(), 'task-images-outside-'));
      try {
        const evil = join(outside, 'evil.png');
        writeFileSync(evil, PNG_MAGIC);
        const r = resolveTaskImages({ task: 't', images: [evil], provider: 'openai', projectRoot: dir });
        expect(r.blocks).toEqual([]);
        expect(r.errors[0]).toMatch(/path policy/);
        expect(r.errors[0]).toMatch(/outside the allowed project root/);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
    it('rejects a `..` traversal escape out of projectRoot', () => {
      const outside = mkdtempSync(join(tmpdir(), 'task-images-outside-'));
      try {
        writeFileSync(join(outside, 'escape.png'), PNG_MAGIC);
        // sub/../../<outside>/escape.png style escape via an explicit relative-ish
        // absolute path that normalizes out of the root.
        const sub = join(dir, 'sub');
        mkdirSync(sub);
        const escape = join(sub, '..', '..', outside.split('/').pop()!, 'escape.png');
        const r = resolveTaskImages({ task: 't', images: [escape], provider: 'openai', projectRoot: dir });
        expect(r.blocks).toEqual([]);
        expect(r.errors[0]).toMatch(/path policy/);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
    it('rejects a symlink inside the root that points OUTSIDE it', () => {
      const outside = mkdtempSync(join(tmpdir(), 'task-images-outside-'));
      try {
        const target = join(outside, 'real.png');
        writeFileSync(target, PNG_MAGIC);
        const link = join(dir, 'link.png');
        symlinkSync(target, link);
        const r = resolveTaskImages({ task: 't', images: [link], provider: 'openai', projectRoot: dir });
        expect(r.blocks).toEqual([]);
        expect(r.errors[0]).toMatch(/path policy/);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
    it('skips the policy (no rejection) when projectRoot is omitted — legacy callers', () => {
      const outside = mkdtempSync(join(tmpdir(), 'task-images-outside-'));
      try {
        const p = join(outside, 'x.png');
        writeFileSync(p, PNG_MAGIC);
        const r = resolveTaskImages({ task: 't', images: [p], provider: 'openai' });
        expect(r.errors).toEqual([]);
        expect(r.blocks).toHaveLength(1);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe('dedup — both explicit and auto-detect sources', () => {
    it('de-dups a repeated explicit path (counts once)', () => {
      const p = mk('dup.png', PNG_MAGIC);
      const r = resolveTaskImages({ task: 't', images: [p, p], provider: 'openai' });
      expect(r.blocks).toHaveLength(1);
    });
    it('normalizes before de-dup (/a//b.png === /a/b.png) so cap is not double-charged', () => {
      const p = mk('norm.png', PNG_MAGIC);
      const doubled = p.replace('/norm.png', '//norm.png'); // extra slash, same file
      const r = resolveTaskImages({ task: 't', images: [p, doubled], provider: 'openai' });
      expect(r.blocks).toHaveLength(1);
    });
  });

  describe('log hygiene — hashed paths in _log output', () => {
    it('never writes a raw absolute path to _log; uses hashPath (sha256:) instead', () => {
      const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const secret = '/nope/super-secret-dir/leak-me.png';
        resolveTaskImages({ task: 't', images: [secret], provider: 'openai' });
        const logged = spy.mock.calls.map(c => String(c[0])).join('');
        expect(logged).toContain('attachment error');
        expect(logged).toContain('sha256:');       // hashed
        expect(logged).not.toContain(secret);      // raw path never logged
        expect(logged).not.toContain('leak-me');   // no path fragment either
      } finally {
        spy.mockRestore();
      }
    });
  });
});
