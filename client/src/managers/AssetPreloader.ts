/**
 * Pre-fetches every static asset the game needs on first frame so the
 * browser HTTP cache is warm before the user signs in. Once cached,
 * Babylon's `SceneLoader` and the various `fetch()` callsites inside
 * `GameManager` / `ChunkManager` get instant responses from cache.
 *
 * No parsing — we only populate the network cache. Parsing happens in
 * the real scene at `GameManager` construction time, which is much
 * cheaper than fetching multi-MB GLBs over the network.
 *
 * Asset list intentionally mirrors the hardcoded paths in
 * `CharacterEntity` (character + animations), `WorldObjectModels`
 * (trees, stumps, rocks), and `GameManager` (map data, defs).
 */

export interface PreloadProgress {
  loaded: number;
  total: number;
  pct: number;
  status: string;
}

export type PreloadCallback = (p: PreloadProgress) => void;

const CHARACTER_GLB = '/Character models/main character.glb';

const ANIMATION_GLBS = [
  '/Character models/new animations/idle.glb',
  '/Character models/new animations/walk.glb',
  '/Character models/new animations/turn in place.glb',
  '/Character models/new animations/attack_slash.glb',
  '/Character models/new animations/2h slash.glb',
  '/Character models/new animations/2h smash.glb',
  '/Character models/new animations/Punch.glb',
  '/Character models/new animations/kick.glb',
  '/Character models/new animations/woodcutting.glb',
  '/Character models/new animations/mining.glb',
];

const WORLD_OBJECT_GLBS = [
  '/models/sTree_1.glb',
  '/models/sTree_2.glb',
  '/models/stree_3.glb',
  '/models/sTree4.glb',
  '/models/stree_autumn.glb',
  '/models/oaktree2.glb',
  '/models/willow_tree.glb',
  '/models/DeadTreeLam.glb',
  '/models/stump1.glb',
  '/models/oakstump.glb',
  '/models/willowstump.glb',
  '/models/stump2.glb',
  '/models/depleted_rock.glb',
];

const DEFAULT_MAP = 'kcmap';

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
  const assets = [
    CHARACTER_GLB,
    ...ANIMATION_GLBS,
    ...WORLD_OBJECT_GLBS,
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
  if (import.meta.env.DEV) {
    loaded = total;
    report('Cache ready');
    return;
  }

  await Promise.all(
    assets.map(async (url) => {
      try {
        const res = await fetch(url);
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
