import { describe, expect, test } from 'bun:test';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { maybeCompressResponse } from './compress';

const big = (n: number) => JSON.stringify({ data: 'x'.repeat(n) });

function reqWith(acceptEncoding: string | null, method = 'GET', extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { ...extra };
  if (acceptEncoding !== null) headers['Accept-Encoding'] = acceptEncoding;
  return new Request('http://localhost/maps/kcmap/map.json', { method, headers });
}

function json(body: string, cacheControl = 'no-cache'): Response {
  return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl } });
}

describe('maybeCompressResponse', () => {
  test('brotli-compresses a large JSON body and round-trips', async () => {
    const original = big(5000);
    const res = await maybeCompressResponse(reqWith('br, gzip'), json(original));
    expect(res.headers.get('content-encoding')).toBe('br');
    expect((res.headers.get('vary') ?? '').toLowerCase()).toContain('accept-encoding');
    const decoded = brotliDecompressSync(new Uint8Array(await res.arrayBuffer())).toString();
    expect(decoded).toBe(original);
  });

  test('falls back to gzip when brotli not accepted', async () => {
    const original = big(5000);
    const res = await maybeCompressResponse(reqWith('gzip'), json(original));
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString()).toBe(original);
  });

  test('skips when client accepts no encoding', async () => {
    const res = await maybeCompressResponse(reqWith(null), json(big(5000)));
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  test('skips bodies below the minimum size', async () => {
    const res = await maybeCompressResponse(reqWith('br'), json('{"ok":true}'));
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  test('skips non-compressible content types', async () => {
    const res = new Response(new Uint8Array(5000), { headers: { 'Content-Type': 'model/gltf-binary' } });
    const out = await maybeCompressResponse(reqWith('br'), res);
    expect(out.headers.get('content-encoding')).toBeNull();
  });

  test('skips non-200 responses', async () => {
    const res = new Response(big(5000), { status: 404, headers: { 'Content-Type': 'application/json' } });
    const out = await maybeCompressResponse(reqWith('br'), res);
    expect(out.headers.get('content-encoding')).toBeNull();
  });

  test('skips HEAD and Range requests', async () => {
    expect((await maybeCompressResponse(reqWith('br', 'HEAD'), json(big(5000)))).headers.get('content-encoding')).toBeNull();
    expect((await maybeCompressResponse(reqWith('br', 'GET', { Range: 'bytes=0-99' }), json(big(5000)))).headers.get('content-encoding')).toBeNull();
  });

  test('does not double-encode an already-encoded response', async () => {
    const res = new Response(big(5000), { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } });
    const out = await maybeCompressResponse(reqWith('br'), res);
    expect(out.headers.get('content-encoding')).toBe('gzip');
  });
});
