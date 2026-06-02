import sharp from 'sharp';

export type ForumUploadKind = 'image' | 'gif';
export type ForumUploadValidation = {
  bytes: Uint8Array;
  ext: '.png' | '.jpg' | '.webp' | '.gif';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  kind: ForumUploadKind;
  width: number;
  height: number;
  sizeBytes: number;
};

const MAX_STATIC_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_GIF_BYTES = 15 * 1024 * 1024;
const MAX_FORUM_IMAGE_DIMENSION = 4096;
const MAX_FORUM_IMAGE_PIXELS = MAX_FORUM_IMAGE_DIMENSION * MAX_FORUM_IMAGE_DIMENSION;

// GIFs are stored verbatim (not re-encoded). The pixel cap bounds a single
// frame, but a GIF with thousands of tiny frames still passes that check while
// hammering viewers' browsers on render. Cap the frame count too.
export const MAX_FORUM_GIF_FRAMES = 500;

export function assertGifFrameCount(pages: number): void {
  if (pages > MAX_FORUM_GIF_FRAMES) {
    throw new Error(`Animated GIFs may have at most ${MAX_FORUM_GIF_FRAMES} frames.`);
  }
}

// sharp/libvips decode + re-encode is CPU heavy and shares this process with the
// game world and sockets. Bound how many run at once so a burst of uploads
// can't starve live players. Excess calls queue and run as slots free up.
const MAX_CONCURRENT_IMAGE_OPS = 4;
let activeImageOps = 0;
const imageOpQueue: Array<() => void> = [];

function acquireImageSlot(): Promise<void> {
  if (activeImageOps < MAX_CONCURRENT_IMAGE_OPS) {
    activeImageOps++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => imageOpQueue.push(resolve));
}

function releaseImageSlot(): void {
  const next = imageOpQueue.shift();
  if (next) next();        // hand the slot straight to the next waiter
  else activeImageOps--;   // no waiter: free the slot
}

function bytesStartWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function detectUploadType(bytes: Uint8Array): Pick<ForumUploadValidation, 'ext' | 'mimeType' | 'kind'> | null {
  if (bytes.length < 12) return null;
  if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: '.png', mimeType: 'image/png', kind: 'image' };
  if (bytesStartWith(bytes, [0xff, 0xd8, 0xff])) return { ext: '.jpg', mimeType: 'image/jpeg', kind: 'image' };
  if (
    bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46])
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return { ext: '.webp', mimeType: 'image/webp', kind: 'image' };
  if (
    bytesStartWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    || bytesStartWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) return { ext: '.gif', mimeType: 'image/gif', kind: 'gif' };
  return null;
}

function assertUploadSize(kind: ForumUploadKind, size: number): void {
  const limit = kind === 'gif' ? MAX_GIF_BYTES : MAX_STATIC_IMAGE_BYTES;
  if (size <= 0 || size > limit) throw new Error('Upload is too large.');
}

function assertBrowserMimeMatches(browserMime: string, actualMime: ForumUploadValidation['mimeType']): void {
  if (!browserMime) return;
  if (browserMime === actualMime) return;
  if (browserMime === 'image/jpg' && actualMime === 'image/jpeg') return;
  throw new Error('Upload type does not match its contents.');
}

async function readImageDimensions(bytes: Uint8Array, kind: ForumUploadKind): Promise<{ width: number; height: number }> {
  const metadata = await sharp(bytes, { limitInputPixels: MAX_FORUM_IMAGE_PIXELS, animated: kind === 'gif' }).metadata();
  if (kind === 'gif') assertGifFrameCount(metadata.pages ?? 1);
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) throw new Error('Upload is not a valid image.');
  if (width > MAX_FORUM_IMAGE_DIMENSION || height > MAX_FORUM_IMAGE_DIMENSION || width * height > MAX_FORUM_IMAGE_PIXELS) {
    throw new Error(`Images must be ${MAX_FORUM_IMAGE_DIMENSION}x${MAX_FORUM_IMAGE_DIMENSION} or smaller.`);
  }
  return { width, height };
}

async function rewriteStaticImage(bytes: Uint8Array, mimeType: ForumUploadValidation['mimeType']): Promise<Uint8Array> {
  const image = sharp(bytes, { limitInputPixels: MAX_FORUM_IMAGE_PIXELS, animated: false }).rotate();
  if (mimeType === 'image/png') return new Uint8Array(await image.png().toBuffer());
  if (mimeType === 'image/jpeg') return new Uint8Array(await image.jpeg({ quality: 88, mozjpeg: true }).toBuffer());
  if (mimeType === 'image/webp') return new Uint8Array(await image.webp({ quality: 88 }).toBuffer());
  return bytes;
}

export async function sanitizeForumUpload(input: {
  bytes: Uint8Array;
  browserMime: string;
}): Promise<ForumUploadValidation> {
  await acquireImageSlot();
  try {
    return await sanitizeForumUploadImpl(input);
  } finally {
    releaseImageSlot();
  }
}

async function sanitizeForumUploadImpl(input: {
  bytes: Uint8Array;
  browserMime: string;
}): Promise<ForumUploadValidation> {
  const detected = detectUploadType(input.bytes);
  if (!detected) throw new Error('Only PNG, JPEG, WebP, and GIF uploads are allowed.');
  assertBrowserMimeMatches(input.browserMime, detected.mimeType);
  assertUploadSize(detected.kind, input.bytes.length);
  const dimensions = await readImageDimensions(input.bytes, detected.kind);
  const outputBytes = detected.kind === 'gif' ? input.bytes : await rewriteStaticImage(input.bytes, detected.mimeType);
  assertUploadSize(detected.kind, outputBytes.length);
  return {
    ...detected,
    ...dimensions,
    bytes: outputBytes,
    sizeBytes: outputBytes.length,
  };
}
