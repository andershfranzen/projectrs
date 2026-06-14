import { afterEach, describe, expect, test } from 'bun:test';
import { optionalAnimationFileExists } from './HumanoidAnimationTemplateCache';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = handler as typeof fetch;
}

describe('optional animation asset probing', () => {
  test('treats a missing optional GLB as absent', async () => {
    installFetch(() => new Response('Not Found', { status: 404 }));

    expect(await optionalAnimationFileExists('/Character models/new animations/run.glb')).toBe(false);
  });

  test('treats an HTML fallback as absent', async () => {
    installFetch(() => new Response('<!doctype html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));

    expect(await optionalAnimationFileExists('/Character models/new animations/run.glb')).toBe(false);
  });

  test('falls back to a ranged GET when HEAD is not allowed', async () => {
    const calls: string[] = [];
    installFetch((_input, init) => {
      calls.push(init?.method ?? 'GET');
      if (init?.method === 'HEAD') return new Response('Method Not Allowed', { status: 405 });
      return new Response(new Uint8Array([0]), {
        status: 206,
        headers: { 'Content-Type': 'model/gltf-binary' },
      });
    });

    expect(await optionalAnimationFileExists('/Character models/new animations/run.glb')).toBe(true);
    expect(calls).toEqual(['HEAD', 'GET']);
  });
});
