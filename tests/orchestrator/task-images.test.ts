import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
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
    it('strips trailing punctuation abutting a path', () => {
      expect(detectImagePathsInText('look at (/a/b.png).')).toEqual(['/a/b.png']);
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
    it('surfaces per-image errors in the text even when a valid image is present', () => {
      const good = mk('good.png', PNG_MAGIC);
      const content = buildUserContent(
        'task',
        resolveTaskImages({ task: 'task', images: [good, '/nope/x.png'], provider: 'openai' }),
      ) as Array<TextContent | ImageContent>;
      expect((content[0] as TextContent).text).toMatch(/image attachment errors/);
      expect((content[0] as TextContent).text).toMatch(/file not found/);
    });
    it('surfaces errors as a plain string when NO image resolved (all rejected)', () => {
      const r = resolveTaskImages({ task: 'task', images: ['/nope/x.png'], provider: 'openai' });
      const content = buildUserContent('task', r);
      expect(typeof content).toBe('string');
      expect(content as string).toMatch(/image attachment errors/);
    });
  });
});
