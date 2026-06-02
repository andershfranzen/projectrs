import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { sanitizeForumUpload, assertGifFrameCount, MAX_FORUM_GIF_FRAMES } from '../src/forumUploadSecurity';

describe('forum upload security', () => {
  test('rejects files that are not real images', async () => {
    const bytes = new TextEncoder().encode('<svg><script>alert(1)</script></svg>');
    await expect(sanitizeForumUpload({ bytes, browserMime: 'image/png' })).rejects.toThrow('Only PNG, JPEG, WebP, and GIF');
  });

  test('rejects browser mime values that do not match file signatures', async () => {
    const png = new Uint8Array(await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#b94a3f' },
    }).png().toBuffer());
    await expect(sanitizeForumUpload({ bytes: png, browserMime: 'image/jpeg' })).rejects.toThrow('does not match');
  });

  test('rewrites static images and returns canonical metadata', async () => {
    const png = new Uint8Array(await sharp({
      create: { width: 16, height: 12, channels: 4, background: '#b94a3f' },
    }).png().toBuffer());
    const result = await sanitizeForumUpload({ bytes: png, browserMime: 'image/png' });
    expect(result.mimeType).toBe('image/png');
    expect(result.ext).toBe('.png');
    expect(result.kind).toBe('image');
    expect(result.width).toBe(16);
    expect(result.height).toBe(12);
    expect(Array.from(result.bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test('validates gif uploads without converting them to static images', async () => {
    const gif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
      0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    ]);
    const result = await sanitizeForumUpload({ bytes: gif, browserMime: 'image/gif' });
    expect(result.mimeType).toBe('image/gif');
    expect(result.ext).toBe('.gif');
    expect(result.kind).toBe('gif');
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.bytes).toEqual(gif);
  });

  test('rejects animated GIFs with too many frames', () => {
    expect(() => assertGifFrameCount(MAX_FORUM_GIF_FRAMES)).not.toThrow();
    expect(() => assertGifFrameCount(MAX_FORUM_GIF_FRAMES + 1)).toThrow('frames');
  });
});
