/**
 * Pre-fetches a small set of lightweight boot assets so the browser HTTP
 * cache is warm before the hidden game scene starts asking for map/def JSON.
 *
 * No parsing happens here. Heavy GLBs intentionally stay out of this list:
 * `GameManager`/Babylon already load them, and waiting for a full HTTP
 * prefetch first turns a cold production visit into two serial waits.
 *
 * This warmup runs in the background; it should never be a user-visible
 * gate before login.
 */

export interface PreloadProgress {
  loaded: number;
  total: number;
  pct: number;
  status: string;
}

export type PreloadCallback = (p: PreloadProgress) => void;

const DEFAULT_MAP = 'kcmap';
const TOKEN_KEY = 'evilquest_token';

const DEF_FILES = [
  '/data/objects.json',
  '/data/items.json',
  '/data/npcs.json',
  '/data/gear-overrides.json',
];

const mapAssets = (map: string): string[] => [
  `/maps/${map}/meta.json`,
  `/maps/${map}/map.json?chunked=1`,
  `/maps/${map}/walls.json`,
  `/maps/${map}/biomes.json`,
];

/**
 * Fetch every asset in parallel. Failures are swallowed (logged only) so
 * a single 404 doesn't stall the whole boot — the real consumer code
 * already handles missing files defensively.
 *
 * Resolves once every fetch settles (fulfilled or rejected).
 */
export async function preloadAssets(onProgress?: PreloadCallback): Promise<void> {
  const token = localStorage.getItem(TOKEN_KEY) || '';
  const assets = [
    ...mapAssets(DEFAULT_MAP),
    ...DEF_FILES,
  ];

  let loaded = 0;
  const total = assets.length;
  const report = (status?: string) => {
    onProgress?.({
      loaded,
      total,
      pct: total > 0 ? loaded / total : 1,
      status: status ?? `Checking game cache (${loaded}/${total})`,
    });
  };

  report('Checking game cache');

  // Dev-mode short-circuit. `CharacterEntity` and `ChunkManager` both
  // append a `?v=<ts>` cache-bust query param to every GLB/JSON they
  // fetch in dev so editor saves show up after a hard refresh. Those
  // URLs don't match the plain URLs we'd warm here, so the preload
  // would be dead weight — the browser caches `/foo.glb` but the real
  // load fetches `/foo.glb?v=…`, a different cache key. Skip the
  // network round-trip entirely in dev; the SceneLoader path handles
  // its own fetches at game-init time.
  if (import.meta.env.DEV || !token) {
    loaded = total;
    report('Cache ready');
    return;
  }

  await Promise.all(
    assets.map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'same-origin',
        });
        // Drain the body so the response is fully cached. Without this,
        // some browsers keep the stream pending and `SceneLoader` may
        // still hit the network on its own fetch.
        if (res.ok) {
          await res.arrayBuffer();
        }
      } catch (e) {
        console.warn(`[AssetPreloader] Failed to prefetch ${url}:`, e);
      }
      loaded++;
      report();
    }),
  );

  report('Cache ready');
}
