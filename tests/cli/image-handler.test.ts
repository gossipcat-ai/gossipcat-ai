import { processImage, detectImageFormat } from '../../apps/cli/src/image-handler';

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x32,
  0x08, 0x06, 0x00, 0x00, 0x00,
]);

const JPEG_HEADER = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);

const GIF_HEADER = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
  0x0A, 0x00, 0x14, 0x00,
]);

const WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
]);

describe('detectImageFormat', () => {
  it('detects PNG', () => expect(detectImageFormat(PNG_HEADER)).toBe('png'));
  it('detects JPEG', () => expect(detectImageFormat(JPEG_HEADER)).toBe('jpeg'));
  it('detects GIF', () => expect(detectImageFormat(GIF_HEADER)).toBe('gif'));
  it('detects WebP', () => expect(detectImageFormat(WEBP_HEADER)).toBe('webp'));
  it('returns null for unknown', () => expect(detectImageFormat(Buffer.from([0x00, 0x01, 0x02]))).toBeNull());
  it('returns null for empty', () => expect(detectImageFormat(Buffer.alloc(0))).toBeNull());
});

describe('processImage', () => {
  it('processes PNG with dimensions', () => {
    const result = processImage({ data: PNG_HEADER, format: 'png', size: PNG_HEADER.length });
    expect(result.format).toBe('png');
    expect(result.mediaType).toBe('image/png');
    expect(result.base64).toBe(PNG_HEADER.toString('base64'));
    expect(result.dimensions).toEqual({ width: 100, height: 50 });
  });

  it('processes GIF with dimensions', () => {
    const result = processImage({ data: GIF_HEADER, format: 'gif', size: GIF_HEADER.length });
    expect(result.dimensions).toEqual({ width: 10, height: 20 });
  });

  it('processes JPEG without dimensions', () => {
    const result = processImage({ data: JPEG_HEADER, format: 'jpeg', size: JPEG_HEADER.length });
    expect(result.mediaType).toBe('image/jpeg');
    expect(result.dimensions).toBeUndefined();
  });

  it('throws on oversized image', () => {
    const bigBuffer = Buffer.alloc(21 * 1024 * 1024);
    PNG_HEADER.copy(bigBuffer);
    expect(() => processImage({ data: bigBuffer, format: 'png', size: bigBuffer.length }))
      .toThrow(/exceeds.*20 MB/i);
  });
});
