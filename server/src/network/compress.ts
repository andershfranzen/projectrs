import { gzipSync, brotliCompressSync, constants as zlib } from 'node:zlib';

/**
 * Negotiated HTTP compression for the single fetch choke point.
 *
 * Bun.serve compresses nothing by default, so the client downloaded the 2.3MB
 * JS bundle, 400KB+ map.json, and every per-chunk/def JSON uncompressed. This
 * brotli/gzip's compressible text responses, cutting those ~70%.
 *
 * Compressed bodies for long-cache static assets (hashed JS/CSS) are memoized
 * so the big bundle is only compressed once, not per request. Dynamic JSON
 * (no-cache map/chunk data) is compressed fresh each time at a faster quality.
 */

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|manifest\+json|xml|wasm)|image\/svg\+xml)/i;
// Below this, framing/header overhead outweighs any savings.
const MIN_BYTES = 1024;
const COMPRESSED_CACHE_MAX = 256;

const compressedCache = new Map<string, Uint8Array>();

function pickEncoding(accept: string): 'br' | 'gzip' | null {
  if (/(?:^|,)\s*br(?:\s*;|\s*,|\s*$)/i.test(accept)) return 'br';
  if (/(?:^|,)\s*gzip(?:\s*;|\s*,|\s*$)/i.test(accept)) return 'gzip';
  return null;
}

// Immutable, or max-age of at least ~1000s — worth caching the compressed body.
function isLongCache(cacheControl: string): boolean {
  if (/\bimmutable\b/i.test(cacheControl)) return true;
  const m = /\bmax-age=(\d+)/i.exec(cacheControl);
  return m ? Number(m[1]) >= 1000 : false;
}

function compress(body: Uint8Array, enc: 'br' | 'gzip', best: boolean): Uint8Array {
  if (enc === 'br') {
    return brotliCompressSync(body, {
      params: {
        [zlib.BROTLI_PARAM_QUALITY]: best ? 11 : 5,
        [zlib.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
      },
    });
  }
  return gzipSync(body, { level: best ? 9 : 6 });
}

export async function maybeCompressResponse(req: Request, res: Response): Promise<Response> {
  if (res.status !== 200 || req.method === 'HEAD') return res;
  // Range responses can't be transparently compressed.
  if (req.headers.has('range')) return res;
  if (res.headers.get('content-encoding')) return res;
  if (!COMPRESSIBLE.test(res.headers.get('content-type') ?? '')) return res;

  const enc = pickEncoding(req.headers.get('accept-encoding') ?? '');
  if (!enc) return res;

  const longCache = isLongCache(res.headers.get('cache-control') ?? '');
  const cacheKey = `${enc}:${new URL(req.url).pathname}`;

  let out = longCache ? compressedCache.get(cacheKey) : undefined;
  if (!out) {
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength < MIN_BYTES) {
      // Too small to compress; return the already-buffered body.
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    out = compress(body, enc, longCache);
    if (longCache) {
      if (compressedCache.size >= COMPRESSED_CACHE_MAX) compressedCache.clear();
      compressedCache.set(cacheKey, out);
    }
  }

  const headers = new Headers(res.headers);
  headers.set('content-encoding', enc);
  headers.set('content-length', String(out.byteLength));
  headers.append('vary', 'Accept-Encoding');
  // zlib returns a Node Buffer (Uint8Array<ArrayBufferLike>); valid Response
  // body at runtime, but the DOM lib's BodyInit type doesn't model it.
  return new Response(out as unknown as BodyInit, { status: res.status, statusText: res.statusText, headers });
}
