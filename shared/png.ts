export interface PngDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const IHDR_CHUNK_TYPE_OFFSET = 12;
const IHDR_WIDTH_OFFSET = 16;

function readUInt32BE(bytes: ArrayLike<number>, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000)
    + (((bytes[offset + 1] ?? 0) << 16) >>> 0)
    + (((bytes[offset + 2] ?? 0) << 8) >>> 0)
    + ((bytes[offset + 3] ?? 0) >>> 0)
  ) >>> 0;
}

export function readPngDimensions(bytes: ArrayLike<number> & { length: number }): PngDimensions | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  if (
    bytes[IHDR_CHUNK_TYPE_OFFSET] !== 0x49
    || bytes[IHDR_CHUNK_TYPE_OFFSET + 1] !== 0x48
    || bytes[IHDR_CHUNK_TYPE_OFFSET + 2] !== 0x44
    || bytes[IHDR_CHUNK_TYPE_OFFSET + 3] !== 0x52
  ) {
    return null;
  }
  const width = readUInt32BE(bytes, IHDR_WIDTH_OFFSET);
  const height = readUInt32BE(bytes, IHDR_WIDTH_OFFSET + 4);
  if (width === 0 || height === 0) return null;
  return { width, height };
}
