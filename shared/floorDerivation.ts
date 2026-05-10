/**
 * Derive walkable upper-floor tiles from elevated texture planes.
 *
 * Maps in our editor authored upper floors as decorative texture planes (the
 * "floor" you walk on visually) but didn't always populate explicit tile/floor
 * entries in walls.json's `floorLayers[N]`. Without those entries the server
 * treats every upper-floor tile as blocked (`isTileBlockedOnFloor`) and the
 * client builds no floor mesh for that layer.
 *
 * This helper takes the raw texture planes and infers per-floor walkable tile
 * coverage by:
 *  1. Filtering to "flat" planes (rotation.x ≈ ±π/2 — they're horizontal).
 *  2. Clustering by Y so each set of co-planar planes becomes one floor.
 *  3. Cluster index 0 is the ground level (handled by terrain), 1+ are upper
 *     floors. For each elevated plane, its tile-aligned bounding box is added
 *     to that floor's walkable set.
 *
 * Both the server (GameMap collision/path) and client (ChunkManager mesh
 * build) call this so they agree without hardcoded data files.
 */
export interface DerivedFloorTilesPlane {
  position?: { x?: number; y?: number; z?: number };
  rotation?: { x?: number; y?: number; z?: number };
  scale?: { x?: number; y?: number; z?: number };
  width?: number;
  height?: number;
}

/** Cluster the Y values of flat planes — adjacent values within `tol` group
 *  together. Each cluster also reports its `mode` (most common Y rounded to
 *  0.1) — we use that as the canonical floor-surface Y and reject planes
 *  outside a tight radius around it (window sills, steps, decorative ledges
 *  at intermediate heights would otherwise be marked walkable and produce
 *  weird paths). */
function clusterYs(ys: number[], tol = 0.6): { min: number; max: number; mode: number }[] {
  if (ys.length === 0) return [];
  const sorted = ys.slice().sort((a, b) => a - b);
  const groups: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = groups[groups.length - 1];
    if (sorted[i] - last[last.length - 1] < tol) last.push(sorted[i]);
    else groups.push([sorted[i]]);
  }
  return groups.map(g => {
    const buckets = new Map<number, number>();
    for (const y of g) {
      const k = Math.round(y * 10) / 10;
      buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }
    let mode = g[0], bestCount = 0;
    for (const [k, v] of buckets) {
      if (v > bestCount) { bestCount = v; mode = k; }
    }
    return { min: g[0], max: g[g.length - 1], mode };
  });
}

/**
 * @returns Map from floor index (1-based for upper floors) to a Map of tile
 *          indices (`z * width + x`) → Y height (the plane's elevation, used
 *          for wall base heights). Floor 0 (ground) is omitted — terrain
 *          handles it. When multiple planes cover the same tile at the same
 *          floor, the lower Y wins (player stands on the lowest surface).
 */
export function deriveUpperFloorTilesFromPlanes(
  planes: DerivedFloorTilesPlane[],
  mapWidth: number,
  mapHeight: number,
): Map<number, Map<number, number>> {
  const result = new Map<number, Map<number, number>>();
  if (!planes || planes.length === 0) return result;

  const flat = planes.filter(p => {
    const rx = p.rotation?.x ?? 0;
    return Math.abs(Math.abs(rx) - Math.PI / 2) < 0.1;
  });
  if (flat.length === 0) return result;

  const ys = flat.map(p => p.position?.y ?? 0);
  const clusters = clusterYs(ys);
  // Tight radius around each cluster's mode Y. Planes outside this band are
  // treated as decorative (window sills, steps, ledges) and not registered as
  // walkable on the cluster's floor.
  const MODE_RADIUS = 0.15;

  const yToFloor = (y: number): number => {
    for (let i = 0; i < clusters.length; i++) {
      if (Math.abs(y - clusters[i].mode) <= MODE_RADIUS) return i;
    }
    return -1; // not on any canonical floor surface — skip
  };

  for (const plane of flat) {
    const py = plane.position?.y ?? 0;
    const floor = yToFloor(py);
    if (floor <= 0) continue; // ground level (cluster 0) handled by terrain; -1 = not a canonical floor

    const px = plane.position?.x ?? 0;
    const pz = plane.position?.z ?? 0;
    const sx = plane.scale?.x ?? 1;
    const sy = plane.scale?.y ?? 1;
    const ry = plane.rotation?.y ?? 0;
    const hw = ((plane.width ?? 1) * sx) / 2;
    const hd = ((plane.height ?? 1) * sy) / 2;
    const cosR = Math.cos(ry);
    const sinR = Math.sin(ry);
    const corners = [
      { x: px + -hw * cosR - -hd * sinR, z: pz + -hw * sinR + -hd * cosR },
      { x: px + hw * cosR - -hd * sinR,  z: pz + hw * sinR + -hd * cosR },
      { x: px + hw * cosR - hd * sinR,   z: pz + hw * sinR + hd * cosR },
      { x: px + -hw * cosR - hd * sinR,  z: pz + -hw * sinR + hd * cosR },
    ];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of corners) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.z < minZ) minZ = c.z;
      if (c.z > maxZ) maxZ = c.z;
    }
    const tx0 = Math.max(0, Math.floor(minX));
    const tx1 = Math.min(mapWidth - 1, Math.floor(maxX));
    const tz0 = Math.max(0, Math.floor(minZ));
    const tz1 = Math.min(mapHeight - 1, Math.floor(maxZ));

    let map = result.get(floor);
    if (!map) {
      map = new Map();
      result.set(floor, map);
    }
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const idx = tz * mapWidth + tx;
        const existing = map.get(idx);
        if (existing === undefined || py < existing) map.set(idx, py);
      }
    }
  }

  return result;
}

/**
 * Derive elevated walking surfaces from flat texture planes — the data both
 * server and client need so their `getEffectiveHeight` calculations agree.
 *
 * Authoring convention: a flat (rotation.x ≈ ±π/2) texture plane above the
 * terrain represents a walkable surface — bridges over water/walls, building
 * roofs you can climb onto, balcony platforms, etc. Each tile inside the
 * plane's footprint gets the plane's Y as a candidate elevation.
 *
 * `isBridge` distinguishes "must always snap up" surfaces (bridges over
 * blocking terrain, or low ramps within 2 units of ground) from "snap only
 * if the player is already near that height" surfaces (high roofs over
 * walkable terrain — clicking under one shouldn't teleport you up).
 * Consumers gate roof tiles on the player's current Y; bridge tiles bypass
 * the gate.
 *
 * `wasBlocking` is reported so the server can upgrade the underlying tile
 * type from BLOCKING (water/wall) to walkable.
 */
export interface ElevatedTileEntry {
  /** Plane's Y elevation. Lowest plane wins when multiple stack on a tile. */
  y: number;
  /** True if this tile should always snap to `y` regardless of player Y
   *  (bridges over blocking terrain, low ramps). */
  isBridge: boolean;
  /** True if the underlying tile type was BLOCKING (server should upgrade). */
  wasBlocking: boolean;
}

export interface ElevatedTileSourcePlane extends DerivedFloorTilesPlane {
  /** width × scale.x = plane's full width before rotation */
  width?: number;
  /** height × scale.y = plane's full depth before rotation */
  height?: number;
}

export function deriveElevatedFloorTiles(
  planes: ElevatedTileSourcePlane[],
  mapWidth: number,
  mapHeight: number,
  /** Terrain height at world (x+0.5, z+0.5). Used to skip planes at/below
   *  terrain and to compute the bridge-vs-roof threshold. */
  getTerrainHeight: (worldX: number, worldZ: number) => number,
  /** Optional: returns true if the tile's CURRENT type is BLOCKING (water,
   *  wall, etc). Used to mark bridge tiles and to let callers upgrade the
   *  tile type. Pass `undefined` if you don't track tile types per-tile. */
  isTileBlocking?: (tileIdx: number) => boolean,
): Map<number, ElevatedTileEntry> {
  const result = new Map<number, ElevatedTileEntry>();
  if (!planes || planes.length === 0) return result;

  for (const plane of planes) {
    const rx = plane.rotation?.x ?? 0;
    const isFlat = Math.abs(Math.abs(rx) - Math.PI / 2) < 0.1;
    if (!isFlat) continue;

    const px = plane.position?.x ?? 0;
    const py = plane.position?.y ?? 0;
    const pz = plane.position?.z ?? 0;
    const sx = plane.scale?.x ?? 1;
    const sy = plane.scale?.y ?? 1;
    const ry = plane.rotation?.y ?? 0;

    const hw = ((plane.width ?? 1) * sx) / 2;
    const hd = ((plane.height ?? 1) * sy) / 2;
    const cosR = Math.cos(ry);
    const sinR = Math.sin(ry);
    const corners = [
      { x: px + -hw * cosR - -hd * sinR, z: pz + -hw * sinR + -hd * cosR },
      { x: px + hw * cosR - -hd * sinR,  z: pz + hw * sinR + -hd * cosR },
      { x: px + hw * cosR - hd * sinR,   z: pz + hw * sinR + hd * cosR },
      { x: px + -hw * cosR - hd * sinR,  z: pz + -hw * sinR + hd * cosR },
    ];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of corners) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.z < minZ) minZ = c.z;
      if (c.z > maxZ) maxZ = c.z;
    }
    const tx0 = Math.max(0, Math.floor(minX));
    const tx1 = Math.min(mapWidth - 1, Math.floor(maxX));
    const tz0 = Math.max(0, Math.floor(minZ));
    const tz1 = Math.min(mapHeight - 1, Math.floor(maxZ));

    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        // Require the tile's CENTER to be inside the plane's rotated
        // footprint. Without this, a plane whose AABB barely clips into
        // a tile would still register the whole tile as elevated +
        // bridge — leading to "ghost step" tiles that snap the player
        // up by 2.7 units when they walk through. We use the inverse
        // rotation to map the tile center into the plane's local frame
        // and check |x| ≤ hw, |z| ≤ hd.
        const tcx = tx + 0.5, tcz = tz + 0.5;
        const lx = (tcx - px) * cosR + (tcz - pz) * sinR;
        const lz = -(tcx - px) * sinR + (tcz - pz) * cosR;
        if (Math.abs(lx) > hw || Math.abs(lz) > hd) continue;

        const idx = tz * mapWidth + tx;
        const terrainH = getTerrainHeight(tcx, tcz);
        if (py <= terrainH) continue;

        const wasBlocking = isTileBlocking ? isTileBlocking(idx) : false;
        // Bridge: over blocking terrain OR within 2 units of terrain
        // (walkways/ramps the player can step onto naturally without a
        // height gate). Anything higher is a roof — gate it on player Y.
        const isBridge = wasBlocking || py < terrainH + 2.0;

        const existing = result.get(idx);
        if (existing === undefined || py < existing.y) {
          result.set(idx, { y: py, isBridge, wasBlocking });
        }
      }
    }
  }

  return result;
}
