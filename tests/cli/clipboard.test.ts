import { detectImageFormat } from '../../apps/cli/src/image-handler';

describe('clipboard module', () => {
  it('exports readClipboardImage function', async () => {
    const mod = await import('../../apps/cli/src/clipboard');
    expect(typeof mod.readClipboardImage).toBe('function');
  });

  it('detectImageFormat returns null for plain text', () => {
    expect(detectImageFormat(Buffer.from('Hello, world!'))).toBeNull();
  });

  it('detectImageFormat returns null for short buffer', () => {
    expect(detectImageFormat(Buffer.from([0x89]))).toBeNull();
  });
});
