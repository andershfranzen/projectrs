import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { TileType, BLOCKING_TILES, classifyTileType, WallEdge, DOOR_EDGE_NEIGHBOR, DEFAULT_WALL_HEIGHT, PROJECTILE_BLOCKING_WALL_HEIGHT, defaultKCTile, defaultGroundForMap, deriveUpperFloorTilesFromPlanes, deriveElevatedFloorTiles, hasProjectileGridLineOfSight, isShootOverProjectileFenceAssetId } from '@projectrs/shared';
import type { MapMeta, MapTransition, WallsFile, StairData, RoofData, KCMapFile, KCMapData, KCTile, PlacedObject } from '@projectrs/shared';
import { DEFAULT_MAX_SEARCH_TILES, findPathToTile, isFootprintBlocked, isFootprintWallBlocked, type PathingCollision } from './pathing/Pathing';

const MAPS_DIR = resolve(import.meta.dir, '../data/maps');

/**
 * Server-side map — loads terrain from KC editor JSON format (map.json).
 */
export class GameMap {
  readonly id: string;
  readonly meta: MapMeta;
  readonly width: number;
  readonly height: number;

  /** KC map data (tiles, heights, water levels) */
  private mapData: KCMapData;

  /** Placed objects from the editor (for deriving world object spawns) */
  readonly placedObjects: PlacedObject[] = [];

  /** Active editor chunks (64x64) — tiles outside active chunks are treated as impassable void */
  private activeChunks: Set<string> | null = null;

  /** Cached tile types for fast collision checks */
  private tileTypes: Uint8Array;

  /** Height values at vertices (width+1 x height+1) — flat cache from mapData.heights */
  private heightCache: Float32Array;

  /** Wall edge bitmasks per tile (width x height) */
  private walls: Uint8Array;
  /** Per-tile wall height overrides (sparse — only stores non-default) */
  private wallHeights: Map<number, number> = new Map();
  /** Wall edges whose visual asset is a low fence: blocks walking, not arrows. */
  private shootOverProjectileWallEdges: Uint8Array;
  /** Elevated floor heights (sparse) — covers heights from explicit walls.json
   *  data + texture-plane bridges over BLOCKING terrain (water/walls). */
  private floorHeights: Map<number, number> = new Map();
  /** Elevated walking surfaces from flat texture planes — superset of
   *  floorHeights. Includes ALL elevated planes (over walkable terrain too,
   *  e.g. building roofs and balcony platforms). Read by getEffectiveHeight
   *  with a player-Y gate to disambiguate "on the roof" vs "under the roof". */
  private elevatedFloorHeights: Map<number, number> = new Map();
  /** Tiles where the elevated surface should ALWAYS be the walking height,
   *  no Y gate. True bridges (over blocking terrain) and low ramps within
   *  2 units of the underlying terrain. Roofs over walkable terrain are
   *  NOT in this set — they need the Y gate to avoid teleporting players
   *  up when they walk under a building. */
  private bridgeFloorTiles: Set<number> = new Set();
  /** Stair data (sparse) */
  private stairs: Map<number, StairData> = new Map();
  /** Roof data (sparse) */
  private roofs: Map<number, RoofData> = new Map();
  /** Terrain holes (sparse) */
  private holes: Set<number> = new Set();
  /** Edge bits currently suppressed by open doors (`floor:tileIdx` → edge bitmask).
   *  Door state is floor-scoped so a ground-floor door cannot accidentally
   *  open or close a different door directly above it. */
  private openDoorEdges: Map<string, number> = new Map();

  /** Hashed transition lookup: tileKey -> MapTransition */
  private transitionMap: Map<number, MapTransition> = new Map();

  /** Pre-bound callbacks for NPC AI — avoids closure allocation per tick */
  readonly isBlockedCb: (x: number, z: number) => boolean;
  readonly isWallBlockedCb: (fx: number, fz: number, tx: number, tz: number) => boolean;

  /** Multi-floor layer data */
  private floorLayers: Map<number, {
    tiles: Map<number, number>;
    walls: Map<number, number>;
    wallHeights: Map<number, number>;
    floors: Map<number, number>;
    stairs: Map<number, StairData>;
    roofs: Map<number, RoofData>;
  }> = new Map();

  private floorLayer(floor: number) {
    const floorIdx = Math.floor(floor);
    if (floorIdx === 0) throw new Error('floorLayer() is only valid for non-zero floors');
    let layer = this.floorLayers.get(floorIdx);
    if (!layer) {
      layer = {
        tiles: new Map<number, number>(),
        walls: new Map<number, number>(),
        wallHeights: new Map<number, number>(),
        floors: new Map<number, number>(),
        stairs: new Map<number, StairData>(),
        roofs: new Map<number, RoofData>(),
      };
      this.floorLayers.set(floorIdx, layer);
    }
    return layer;
  }

  private doorEdgeKey(floor: number, tileIdx: number): string {
    return `${Math.floor(floor)}:${tileIdx}`;
  }

  constructor(mapId: string) {
    this.id = mapId;
    const dir = resolve(MAPS_DIR, mapId);

    // Load meta
    this.meta = JSON.parse(readFileSync(resolve(dir, 'meta.json'), 'utf-8')) as MapMeta;
    this.width = this.meta.width;
    this.height = this.meta.height;

    // Hash transitions for O(1) lookup
    for (const t of this.meta.transitions ?? []) {
      this.transitionMap.set(t.tileZ * this.width + t.tileX, t);
    }

    // Load KC map data
    const mapFile: KCMapFile = JSON.parse(readFileSync(resolve(dir, 'map.json'), 'utf-8'));
    this.mapData = mapFile.map;

    // Try loading tiles/heights from per-chunk files (falls back to map.json inline data)
    const defaultGround = defaultGroundForMap(this.mapData);
    const chunkedTiles = GameMap.loadChunkedTiles(dir, this.width, this.height, defaultGround);
    if (chunkedTiles) this.mapData.tiles = chunkedTiles;
    const chunkedHeights = GameMap.loadChunkedHeights(dir, this.width, this.height);
    if (chunkedHeights) this.mapData.heights = chunkedHeights;

    // Load placed objects from per-chunk files, falling back to map.json
    let rawObjects = mapFile.placedObjects ?? [];
    const objectsDir = resolve(dir, 'objects');
    if (existsSync(objectsDir)) {
      const chunked: typeof rawObjects = [];
      for (const file of readdirSync(objectsDir)) {
        if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
        try {
          const objs = JSON.parse(readFileSync(resolve(objectsDir, file), 'utf-8'));
          chunked.push(...objs);
        } catch { /* skip bad chunk files */ }
      }
      if (chunked.length > 0) rawObjects = chunked;
    }
    this.placedObjects = rawObjects.map(o => ({
      assetId: o.assetId,
      layerId: o.layerId || 'layer_0',
      name: o.name,
      examineText: o.examineText,
      interactions: Array.isArray(o.interactions) ? o.interactions : undefined,
      defaultOpen: o.defaultOpen === true,
      openDirection: o.openDirection === 1 ? 1 : -1,
      locked: o.locked === true,
      keyItemId: Number.isInteger(o.keyItemId) ? o.keyItemId : undefined,
      consumeKey: o.consumeKey === true,
      lockedMessage: typeof o.lockedMessage === 'string' ? o.lockedMessage : undefined,
      altarTier: Number.isInteger(o.altarTier) ? o.altarTier : undefined,
      position: o.position,
      rotation: o.rotation,
      scale: o.scale,
      trigger: o.trigger,
      verticalLinks: Array.isArray(o.verticalLinks) ? o.verticalLinks : undefined,
      interactionTiles: Array.isArray(o.interactionTiles) ? o.interactionTiles : undefined,
      interactionSides: o.interactionSides,
    }));

    // Load active chunks from editor data
    if (Array.isArray(mapFile.map.activeChunks)) {
      this.activeChunks = new Set(mapFile.map.activeChunks);
    }

    // Build height cache (flat Float32Array for fast access)
    const vw = this.width + 1;
    const vh = this.height + 1;
    this.heightCache = new Float32Array(vw * vh);
    for (let z = 0; z <= this.height; z++) {
      for (let x = 0; x <= this.width; x++) {
        this.heightCache[z * vw + x] = this.mapData.heights[z]?.[x] ?? 0;
      }
    }

    // Build tile type cache for collision
    this.tileTypes = new Uint8Array(this.width * this.height);
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        // Tiles in inactive chunks are impassable void
        if (this.activeChunks && !this.activeChunks.has(`${Math.floor(x / 64)},${Math.floor(z / 64)}`)) {
          this.tileTypes[z * this.width + x] = TileType.WALL;
          continue;
        }
        const tile = this.mapData.tiles[z]?.[x];
        if (!tile) {
          this.tileTypes[z * this.width + x] = defaultGround === 'void' ? TileType.WALL : TileType.GRASS;
          continue;
        }
        // Check if this tile is effectively water (painted or below water level)
        const corners = {
          tl: this.mapData.heights[z]?.[x] ?? 0,
          tr: this.mapData.heights[z]?.[x + 1] ?? 0,
          bl: this.mapData.heights[z + 1]?.[x] ?? 0,
          br: this.mapData.heights[z + 1]?.[x + 1] ?? 0,
        };
        const chunkX = Math.floor(x / 64);
        const chunkZ = Math.floor(z / 64);
        const chunkKey = `${chunkX},${chunkZ}`;
        const waterLevel = this.mapData.chunkWaterLevels[chunkKey] ?? this.mapData.waterLevel;

        this.tileTypes[z * this.width + x] = classifyTileType(tile, corners, waterLevel);
      }
    }

    // Load walls and building data
    this.walls = new Uint8Array(this.width * this.height);
    this.shootOverProjectileWallEdges = new Uint8Array(this.width * this.height);
    const wallsPath = resolve(dir, 'walls.json');
    if (existsSync(wallsPath)) {
      const wallsData: WallsFile = JSON.parse(readFileSync(wallsPath, 'utf-8'));
      const parseKey = (key: string): [number, number] | null => {
        const [xStr, zStr] = key.split(',');
        const x = parseInt(xStr);
        const z = parseInt(zStr);
        if (x >= 0 && x < this.width && z >= 0 && z < this.height) return [x, z];
        return null;
      };
      for (const [key, mask] of Object.entries(wallsData.walls)) {
        const coords = parseKey(key);
        if (coords) this.walls[coords[1] * this.width + coords[0]] = mask;
      }
      if (wallsData.wallHeights) {
        for (const [key, h] of Object.entries(wallsData.wallHeights)) {
          const coords = parseKey(key);
          if (coords) this.wallHeights.set(coords[1] * this.width + coords[0], h);
        }
      }
      if (wallsData.floors) {
        for (const [key, h] of Object.entries(wallsData.floors)) {
          const coords = parseKey(key);
          if (coords) this.floorHeights.set(coords[1] * this.width + coords[0], h);
        }
      }
      if (wallsData.roofs) {
        for (const [key, data] of Object.entries(wallsData.roofs)) {
          const coords = parseKey(key);
          if (coords) this.roofs.set(coords[1] * this.width + coords[0], data);
        }
      }
      if (wallsData.holes) {
        for (const key of Object.keys(wallsData.holes)) {
          const coords = parseKey(key);
          if (coords) this.holes.add(coords[1] * this.width + coords[0]);
        }
      }
      // Load floor layers
      if (wallsData.floorLayers) {
        for (const [floorStr, ld] of Object.entries(wallsData.floorLayers)) {
          const floorIdx = parseInt(floorStr);
          const layer = {
            tiles: new Map<number, number>(),
            walls: new Map<number, number>(),
            wallHeights: new Map<number, number>(),
            floors: new Map<number, number>(),
            stairs: new Map<number, StairData>(),
            roofs: new Map<number, RoofData>(),
          };
          if (ld.tiles) for (const [k, v] of Object.entries(ld.tiles)) { const c = parseKey(k); if (c) layer.tiles.set(c[1] * this.width + c[0], v as number); }
          if (ld.walls) for (const [k, v] of Object.entries(ld.walls)) { const c = parseKey(k); if (c) layer.walls.set(c[1] * this.width + c[0], v as number); }
          if (ld.wallHeights) for (const [k, v] of Object.entries(ld.wallHeights)) { const c = parseKey(k); if (c) layer.wallHeights.set(c[1] * this.width + c[0], v as number); }
          if (ld.floors) for (const [k, v] of Object.entries(ld.floors)) { const c = parseKey(k); if (c) layer.floors.set(c[1] * this.width + c[0], v as number); }
          if (ld.roofs) for (const [k, v] of Object.entries(ld.roofs)) { const c = parseKey(k); if (c) layer.roofs.set(c[1] * this.width + c[0], v as RoofData); }
          this.floorLayers.set(floorIdx, layer);
        }
      }
    }

    this.registerShootOverFenceWalls();

    // Register horizontal texture planes as walkable floors (bridges, platforms)
    this.registerTexturePlaneFloors(mapFile);

    // Pre-bind collision callbacks (avoids closure allocation in NPC AI hot loop)
    this.isBlockedCb = (x: number, z: number) => this.isBlocked(x, z);
    this.isWallBlockedCb = (fx: number, fz: number, tx: number, tz: number) => this.isWallBlocked(fx, fz, tx, tz);

    console.log(`Loaded map '${mapId}': ${this.width}x${this.height} tiles, waterLevel=${this.mapData.waterLevel}, ${this.floorLayers.size} upper floors`);
  }

  private markShootOverProjectileWallTile(x: number, z: number): void {
    if (x < 0 || x >= this.width || z < 0 || z >= this.height) return;
    const idx = z * this.width + x;
    const mask = this.walls[idx];
    if (mask === 0 || this.wallHeights.has(idx)) return;
    this.shootOverProjectileWallEdges[idx] |= mask;
  }

  private registerShootOverFenceWalls(): void {
    for (const placed of this.placedObjects) {
      if (!isShootOverProjectileFenceAssetId(placed.assetId)) continue;
      const tx = Math.floor(placed.position.x);
      const tz = Math.floor(placed.position.z);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          this.markShootOverProjectileWallTile(tx + dx, tz + dz);
        }
      }
    }
  }

  /** Detect horizontal texture planes and register them as walkable bridges
   *  + roof surfaces. Symmetric with the client (see ChunkManager) — both
   *  sides build their elevation maps from the same shared derivation so
   *  server and client agree on every tile's walking Y. */
  private registerTexturePlaneFloors(_mapFile: KCMapFile): void {
    const planes = this.mapData.texturePlanes || [];
    const derived = deriveElevatedFloorTiles(
      planes,
      this.width,
      this.height,
      (wx, wz) => this.getInterpolatedHeight(wx, wz),
      (idx) => BLOCKING_TILES.has(this.tileTypes[idx] as TileType),
    );

    let bridgeCount = 0;
    let roofCount = 0;
    for (const [idx, entry] of derived) {
      this.elevatedFloorHeights.set(idx, entry.y);
      if (entry.isBridge) {
        this.bridgeFloorTiles.add(idx);
        // Bridge over blocking terrain → upgrade to walkable + record as
        // floorHeights so collision/pathing treats it as ground at this Y.
        if (entry.wasBlocking) {
          this.tileTypes[idx] = TileType.STONE;
          const existing = this.floorHeights.get(idx);
          if (existing === undefined || entry.y < existing) {
            this.floorHeights.set(idx, entry.y);
          }
        }
        bridgeCount++;
      } else {
        roofCount++;
      }
    }
    if (bridgeCount + roofCount > 0) {
      console.log(`  Registered ${bridgeCount} bridge tiles + ${roofCount} elevated roof tiles from texture planes`);
    }

    // Derive upper-floor walkability from elevated texture planes. Maps were
    // authored with floor surfaces represented as decorative planes, but
    // walls.json's floorLayers[N].tiles is often empty — without entries
    // here, isTileBlockedOnFloor returns true for every upper-floor tile
    // (player can't walk there, NPCs can't path there).
    const upperFloors = deriveUpperFloorTilesFromPlanes(planes, this.width, this.height);
    let derivedTotal = 0;
    for (const [floorIdx, tileMap] of upperFloors) {
      let layer = this.floorLayers.get(floorIdx);
      if (!layer) {
        layer = {
          tiles: new Map<number, number>(),
          walls: new Map<number, number>(),
          wallHeights: new Map<number, number>(),
          floors: new Map<number, number>(),
          stairs: new Map<number, StairData>(),
          roofs: new Map<number, RoofData>(),
        };
        this.floorLayers.set(floorIdx, layer);
      }
      for (const [idx, y] of tileMap) {
        if (!layer.tiles.has(idx)) {
          layer.tiles.set(idx, y);
          derivedTotal++;
        }
      }
    }
    if (derivedTotal > 0) {
      console.log(`  Derived ${derivedTotal} upper-floor walkable tiles across ${upperFloors.size} floors from texture planes`);
    }
  }

  /** Get floor layer data (null = ground floor) */
  getFloorLayer(floor: number) {
    if (floor === 0) return null;
    return this.floorLayers.get(floor) ?? null;
  }

  getKnownFloors(): number[] {
    return [0, ...this.floorLayers.keys()].sort((a, b) => a - b);
  }

  /** Get wall bitmask at position for a specific floor */
  getWallOnFloor(x: number, z: number, floor: number): number {
    if (floor === 0) return this.getWall(x, z);
    const layer = this.floorLayers.get(floor);
    if (!layer) return 0;
    const idx = z * this.width + x;
    return layer.walls.get(idx) ?? 0;
  }

  /** Set wall bitmask at position for a specific floor. Runtime doors use
   *  this so upper-floor doors block upper-floor movement while closed. */
  setWallOnFloor(x: number, z: number, floor: number, mask: number): void {
    if (floor === 0) {
      this.setWall(x, z, mask);
      return;
    }
    if (x < 0 || x >= this.width || z < 0 || z >= this.height) return;
    const idx = z * this.width + x;
    const layer = this.floorLayer(floor);
    if (mask === 0) layer.walls.delete(idx);
    else layer.walls.set(idx, mask);
  }

  /** Check if a tile is walkable on a specific floor */
  isTileBlockedOnFloor(x: number, z: number, floor: number): boolean {
    if (floor === 0) return this.isBlocked(x, z);
    const layer = this.floorLayers.get(floor);
    if (!layer) return true;
    const idx = z * this.width + x;
    const hasTile = layer.tiles.has(idx);
    const hasFloor = layer.floors.has(idx);
    const hasStair = layer.stairs.has(idx);
    return !(hasTile || hasFloor || hasStair);
  }

  /** Wall blocking on an upper floor for a single tile+edge — same open-door
   *  bypass rule as floor 0, just without the floor-0 elevation gate. */
  private wallBlocksOnFloorAt(x: number, z: number, edge: number, floor: number): boolean {
    if (x < 0 || x >= this.width || z < 0 || z >= this.height) return false;
    const idx = z * this.width + x;
    if (((this.openDoorEdges.get(this.doorEdgeKey(floor, idx)) ?? 0) & edge) !== 0) return false;
    return (this.getWallOnFloor(x, z, floor) & edge) !== 0;
  }

  /** Check wall blocking for a specific floor */
  isWallBlockedOnFloor(fromX: number, fromZ: number, toX: number, toZ: number, floor: number): boolean {
    if (floor === 0) return this.isWallBlocked(fromX, fromZ, toX, toZ);
    const fx = Math.floor(fromX);
    const fz = Math.floor(fromZ);
    const tx = Math.floor(toX);
    const tz = Math.floor(toZ);
    const dx = tx - fx;
    const dz = tz - fz;

    const w = (x: number, z: number, edge: number) => this.wallBlocksOnFloorAt(x, z, edge, floor);

    if (dx === 0 && dz === -1) return w(fx, fz, WallEdge.N) || w(tx, tz, WallEdge.S);
    if (dx === 1 && dz === 0) return w(fx, fz, WallEdge.E) || w(tx, tz, WallEdge.W);
    if (dx === 0 && dz === 1) return w(fx, fz, WallEdge.S) || w(tx, tz, WallEdge.N);
    if (dx === -1 && dz === 0) return w(fx, fz, WallEdge.W) || w(tx, tz, WallEdge.E);

    if (dx === 1 && dz === -1) {
      if (w(fx, fz, WallEdge.N) || w(fx, fz, WallEdge.E)) return true;
      if (w(tx, tz, WallEdge.S) || w(tx, tz, WallEdge.W)) return true;
      if (w(fx + 1, fz, WallEdge.N) || w(fx, fz - 1, WallEdge.E)) return true;
      return false;
    }
    if (dx === -1 && dz === -1) {
      if (w(fx, fz, WallEdge.N) || w(fx, fz, WallEdge.W)) return true;
      if (w(tx, tz, WallEdge.S) || w(tx, tz, WallEdge.E)) return true;
      if (w(fx - 1, fz, WallEdge.N) || w(fx, fz - 1, WallEdge.W)) return true;
      return false;
    }
    if (dx === 1 && dz === 1) {
      if (w(fx, fz, WallEdge.S) || w(fx, fz, WallEdge.E)) return true;
      if (w(tx, tz, WallEdge.N) || w(tx, tz, WallEdge.W)) return true;
      if (w(fx + 1, fz, WallEdge.S) || w(fx, fz + 1, WallEdge.E)) return true;
      return false;
    }
    if (dx === -1 && dz === 1) {
      if (w(fx, fz, WallEdge.S) || w(fx, fz, WallEdge.W)) return true;
      if (w(tx, tz, WallEdge.N) || w(tx, tz, WallEdge.E)) return true;
      if (w(fx - 1, fz, WallEdge.S) || w(fx, fz + 1, WallEdge.W)) return true;
      return false;
    }
    return false;
  }

  /** Get stair on a specific floor */
  getStairOnFloor(x: number, z: number, floor: number): StairData | null {
    if (floor === 0) return this.getStair(x, z);
    const layer = this.floorLayers.get(floor);
    if (!layer) return null;
    return layer.stairs.get(z * this.width + x) ?? null;
  }

  /** Get height at a vertex coordinate */
  getVertexHeight(vx: number, vz: number): number {
    const vw = this.width + 1;
    if (vx < 0 || vx >= vw || vz < 0 || vz >= this.height + 1) return 0;
    return this.heightCache[vz * vw + vx];
  }

  /** Bilinear interpolation of height at fractional world coordinates */
  getInterpolatedHeight(x: number, z: number): number {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const fx = x - x0;
    const fz = z - z0;

    const h00 = this.getVertexHeight(x0, z0);
    const h10 = this.getVertexHeight(x0 + 1, z0);
    const h01 = this.getVertexHeight(x0, z0 + 1);
    const h11 = this.getVertexHeight(x0 + 1, z0 + 1);

    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;
    return h0 * (1 - fz) + h1 * fz;
  }

  getHeight(x: number, z: number): number {
    return this.getInterpolatedHeight(x, z);
  }

  isBlocked(x: number, z: number): boolean {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) return true;
    const idx = tz * this.width + tx;
    // Hole tiles are passable if they have a floor or stairs
    if (this.holes.has(idx)) {
      return !this.floorHeights.has(idx) && !this.stairs.has(idx);
    }
    // Elevated walkable surfaces (texture-plane floors/bridges/roofs) and
    // stairs override the underlying terrain tile type. A room authored as an
    // elevated plane sits on whatever floor-0 terrain was beneath it (often
    // water/void), and that terrain must NOT block walking on the surface
    // above. Mirrors the client's ChunkManager.isBlocked, which keys off
    // texturePlaneFloorTiles. Without this the server rejects every move the
    // client predicts inside an elevated room — only bridge tiles got their
    // tileType upgraded to STONE in registerTexturePlaneFloors; roof tiles
    // (>2 units up, e.g. a room up a staircase) did not — and the resulting
    // PATH_TRUNCATED + PLAYER_SYNC snap-back jitters the character.
    if (this.floorHeights.has(idx) || this.elevatedFloorHeights.has(idx) || this.stairs.has(idx)) {
      return false;
    }
    return BLOCKING_TILES.has(this.tileTypes[idx] as TileType);
  }

  getTileType(x: number, z: number): TileType {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) return TileType.WALL;
    return this.tileTypes[tz * this.width + tx] as TileType;
  }

  getWall(x: number, z: number): number {
    if (x < 0 || x >= this.width || z < 0 || z >= this.height) return 0;
    return this.walls[z * this.width + x];
  }

  setWall(x: number, z: number, mask: number): void {
    if (x < 0 || x >= this.width || z < 0 || z >= this.height) return;
    this.walls[z * this.width + x] = mask;
  }

  /** Mark edge bits on (x,z) as open by a door — overrides wall-blocking on every floor. */
  setOpenDoorEdges(x: number, z: number, edgeMask: number, open: boolean, floor: number = 0): void {
    if (x < 0 || x >= this.width || z < 0 || z >= this.height) return;
    const idx = z * this.width + x;
    const key = this.doorEdgeKey(floor, idx);
    const cur = this.openDoorEdges.get(key) ?? 0;
    const next = open ? (cur | edgeMask) : (cur & ~edgeMask);
    if (next === 0) this.openDoorEdges.delete(key);
    else this.openDoorEdges.set(key, next);
  }


  getWallHeight(x: number, z: number): number {
    const idx = z * this.width + x;
    return this.wallHeights.get(idx) ?? DEFAULT_WALL_HEIGHT;
  }

  private static projectileWallBlocksAtCallback(
    map: GameMap,
    x: number,
    z: number,
    edge: number,
    floor: number,
    projectileY: number,
  ): boolean {
    return map.projectileWallBlocksAt(x, z, edge, floor, projectileY);
  }

  private projectileWallBlocksAt(
    x: number,
    z: number,
    edge: number,
    floor: number,
    projectileY: number,
  ): boolean {
    if (x < 0 || x >= this.width || z < 0 || z >= this.height) return false;
    const floorIdx = Math.floor(floor);
    const idx = z * this.width + x;
    if (((this.openDoorEdges.get(this.doorEdgeKey(floorIdx, idx)) ?? 0) & edge) !== 0) return false;

    if (floorIdx === 0) {
      if ((this.walls[idx] & edge) === 0) return false;
      const explicitWallH = this.wallHeights.get(idx);
      if (explicitWallH === undefined && (this.shootOverProjectileWallEdges[idx] & edge) !== 0) return false;
      const wallH = explicitWallH ?? DEFAULT_WALL_HEIGHT;
      if (wallH < PROJECTILE_BLOCKING_WALL_HEIGHT) return false;
      const wallBaseH = this.floorHeights.get(idx) ?? this.getInterpolatedHeight(x + 0.5, z + 0.5);
      return projectileY < wallBaseH + wallH;
    }

    const layer = this.floorLayers.get(floorIdx);
    if (!layer || ((layer.walls.get(idx) ?? 0) & edge) === 0) return false;
    const wallH = layer.wallHeights.get(idx) ?? DEFAULT_WALL_HEIGHT;
    if (wallH < PROJECTILE_BLOCKING_WALL_HEIGHT) return false;
    const nb = DOOR_EDGE_NEIGHBOR[edge];
    const nIdx = (z + nb.dz) * this.width + (x + nb.dx);
    const wallBaseH = layer.floors.get(idx)
      ?? layer.tiles.get(idx)
      ?? layer.floors.get(nIdx)
      ?? layer.tiles.get(nIdx)
      ?? this.elevatedFloorHeights.get(idx)
      ?? this.elevatedFloorHeights.get(nIdx)
      ?? this.getInterpolatedHeight(x + 0.5, z + 0.5);
    return projectileY < wallBaseH + wallH;
  }

  /** Straight projectile LOS against wall edges. Unlike movement collision,
   *  low fence-height walls are clear so arrows can be shot over them. */
  hasProjectileLineOfSight(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    floor: number,
    fromY: number,
    toY: number,
  ): boolean {
    return hasProjectileGridLineOfSight(
      fromX,
      fromZ,
      toX,
      toZ,
      floor,
      fromY,
      toY,
      this,
      GameMap.projectileWallBlocksAtCallback,
    );
  }

  getFloorHeight(x: number, z: number): number | null {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) return null;
    return this.floorHeights.get(tz * this.width + tx) ?? null;
  }

  getStair(x: number, z: number): StairData | null {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) return null;
    return this.stairs.get(tz * this.width + tx) ?? null;
  }

  getRoof(x: number, z: number): RoofData | null {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) return null;
    return this.roofs.get(tz * this.width + tx) ?? null;
  }

  /** Elevated walking surface Y at this tile, or null if none (terrain only). */
  getElevatedFloorHeight(x: number, z: number): number | null {
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) return null;
    return this.elevatedFloorHeights.get(tz * this.width + tx) ?? null;
  }

  getWalkableHeightsAt(x: number, z: number): number[] {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) return [];
    const idx = tz * this.width + tx;
    const heights: number[] = [this.getInterpolatedHeight(x, z)];
    const add = (height: number | undefined | null): void => {
      if (height == null || !Number.isFinite(height)) return;
      if (!heights.some(existing => Math.abs(existing - height) < 0.1)) {
        heights.push(height);
      }
    };

    add(this.floorHeights.get(idx));
    add(this.elevatedFloorHeights.get(idx));
    const stair = this.stairs.get(idx);
    if (stair) {
      add(stair.baseHeight);
      add(stair.topHeight);
      add(this.getEffectiveHeightOnFloor(x, z, 0, Number.POSITIVE_INFINITY));
    }
    for (const [floor, layer] of this.floorLayers) {
      add(layer.floors.get(idx));
      add(layer.tiles.get(idx));
      const layerStair = layer.stairs.get(idx);
      if (layerStair) {
        add(layerStair.baseHeight);
        add(layerStair.topHeight);
        add(this.getEffectiveHeightOnFloor(x, z, floor, Number.POSITIVE_INFINITY));
      }
    }

    return heights.sort((a, b) => a - b);
  }

  getWalkableFloorTargetsAt(x: number, z: number): { floor: number; y: number }[] {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) return [];
    const targets: { floor: number; y: number }[] = [];
    const add = (floor: number, y: number | undefined | null): void => {
      if (y == null || !Number.isFinite(y)) return;
      const targetY = y;
      if (!targets.some(existing => existing.floor === floor && Math.abs(existing.y - targetY) < 0.1)) {
        targets.push({ floor, y: targetY });
      }
    };

    const idx = tz * this.width + tx;
    if (!this.holes.has(idx) && !BLOCKING_TILES.has(this.tileTypes[idx] as TileType)) {
      add(0, this.getInterpolatedHeight(x, z));
    }
    add(0, this.floorHeights.get(idx));
    if (this.bridgeFloorTiles.has(idx)) {
      add(0, this.elevatedFloorHeights.get(idx));
    }
    const stair = this.stairs.get(idx);
    if (stair) {
      add(0, stair.baseHeight);
      add(0, stair.topHeight);
      add(0, this.getEffectiveHeightOnFloor(x, z, 0, Number.POSITIVE_INFINITY));
    }
    for (const floor of this.floorLayers.keys()) {
      if (!this.isTileBlockedOnFloor(tx, tz, floor)) {
        add(floor, this.getEffectiveHeightOnFloor(x, z, floor, Number.POSITIVE_INFINITY));
      }
    }

    return targets.sort((a, b) => (a.y - b.y) || (a.floor - b.floor));
  }

  /** Get effective walking height at a position, accounting for floors and stairs */
  getEffectiveHeight(x: number, z: number): number {
    return this.getEffectiveHeightOnFloor(x, z, 0);
  }

  /** Get effective walking height at a position on a specific floor.
   *  `currentY` is the player's last-known Y — used to gate roof-tile
   *  reveal. Without it, walking under a building roof would teleport the
   *  player up onto the roof. With it, the roof only "sticks" once the
   *  player is already near that height (e.g. after climbing a stair). */
  getEffectiveHeightOnFloor(x: number, z: number, floor: number, currentY?: number): number {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    const idx = tz * this.width + tx;

    const stair = this.getStairOnFloor(tx, tz, floor);
    if (stair) {
      const fx = x - tx;
      const fz = z - tz;
      let t: number;
      switch (stair.direction) {
        case 'N': t = 1 - fz; break;
        case 'S': t = fz; break;
        case 'E': t = fx; break;
        case 'W': t = 1 - fx; break;
      }
      return stair.baseHeight + t * (stair.topHeight - stair.baseHeight);
    }

    if (floor === 0) {
      const floorH = this.getFloorHeight(x, z);
      if (floorH !== null) return floorH;
      // Elevated walking surfaces from texture planes (mirrors the client's
      // ChunkManager.getEffectiveHeight). Bridges always snap; roofs gate
      // on currentY so walking under a building doesn't teleport you up.
      const elevH = this.elevatedFloorHeights.get(idx);
      if (elevH !== undefined) {
        if (this.bridgeFloorTiles.has(idx)) return elevH;
        if (currentY !== undefined && currentY > elevH - 1.5) return elevH;
      }
      return this.getInterpolatedHeight(x, z);
    }

    const layer = this.floorLayers.get(floor);
    if (layer) {
      const idx = tz * this.width + tx;
      const layerHeight = layer.floors.get(idx) ?? layer.tiles.get(idx);
      if (layerHeight !== undefined) return layerHeight;
    }

    return this.getInterpolatedHeight(x, z);
  }

  /** Check if a wall at tile (x,z) actually blocks at the given player height.
   *  Each layer's walls are gated against that layer's floor band — a wall
   *  above the player's head must not block them. With no playerY supplied,
   *  only floor-0 walls are considered; upper-floor callers use
   *  isWallBlockedOnFloor so layer walls don't bleed into ground pathing. */
  private wallBlocksAtHeight(x: number, z: number, edge: number, playerY?: number): boolean {
    const idx = z * this.width + x;
    const wallH = this.wallHeights.get(idx) ?? DEFAULT_WALL_HEIGHT;
    // Open-door bypass: the door is on a wall whose base is either floor 0
    // (terrain) or an upper floor (elev). The player must be at one of
    // those levels — covers both a ground-floor door entered from outside
    // AND an upper-floor door used from the elevated walkway. Using a
    // single `floorH` with the elev fallback (as it used to) made ground-
    // floor doors fail when the tile ALSO had an upper-floor plane,
    // because the bypass then demanded upper-floor Y.
    const isOpenDoor = ((this.openDoorEdges.get(this.doorEdgeKey(0, idx)) ?? 0) & edge) !== 0;
    const groundBaseH = this.floorHeights.get(idx) ?? this.getInterpolatedHeight(x + 0.5, z + 0.5);
    const upperBaseH = this.elevatedFloorHeights.get(idx);
    const atGroundDoor = playerY == null || (playerY >= groundBaseH - 0.5 && playerY < groundBaseH + wallH);
    const atUpperDoor = playerY == null || (upperBaseH !== undefined && playerY >= upperBaseH - 0.5 && playerY < upperBaseH + wallH);
    if (isOpenDoor && (atGroundDoor || atUpperDoor)) return false;

    if ((this.getWall(x, z) & edge) !== 0) {
      if (playerY == null) return true;
      // Raw walls are floor-0 walls — their base is terrain (or a bridge-
      // upgraded floor 0), NOT the upper-floor texture plane. Using floorH
      // here would lift the wall up to `elev + wallH` on tiles that also
      // carry an upper floor, blocking upper-floor players from crossing a
      // wall that actually ends below their feet.
      const wallBaseH = this.floorHeights.get(idx) ?? this.getInterpolatedHeight(x + 0.5, z + 0.5);
      if (playerY < wallBaseH + wallH) return true;
    }
    if (this.floorLayers.size === 0 || playerY == null) return false;
    // Boundary walls are commonly authored on the tile that sits OUTSIDE the
    // upper-floor footprint, so the layer's floor/tile elevation lives on
    // the neighbour rather than this tile.
    const nb = DOOR_EDGE_NEIGHBOR[edge];
    const nIdx = (z + nb.dz) * this.width + (x + nb.dx);
    for (const layer of this.floorLayers.values()) {
      const bits = layer.walls.get(idx);
      if (bits == null || (bits & edge) === 0) continue;
      // layer.floors is usually empty in KC-authored maps; layer.tiles gets
      // seeded from texture planes covering the footprint.
      const layerFloorH = layer.floors.get(idx)
        ?? layer.tiles.get(idx)
        ?? layer.floors.get(nIdx)
        ?? layer.tiles.get(nIdx)
        ?? this.elevatedFloorHeights.get(idx)
        ?? this.elevatedFloorHeights.get(nIdx);
      if (layerFloorH === undefined) continue;
      const layerWallH = layer.wallHeights.get(idx) ?? wallH;
      if (playerY >= layerFloorH - 0.5 && playerY < layerFloorH + layerWallH) {
        return true;
      }
    }
    return false;
  }

  /** Check if movement from (fromX,fromZ) to (toX,toZ) is blocked by a wall edge.
   *  Checks BOTH the source tile's edge AND the destination tile's opposite edge,
   *  so a wall only needs to be defined on one side to block movement.
   *  Optional playerY: if provided, walls below the player's height don't block. */
  isWallBlocked(fromX: number, fromZ: number, toX: number, toZ: number, playerY?: number): boolean {
    const fx = Math.floor(fromX);
    const fz = Math.floor(fromZ);
    const tx = Math.floor(toX);
    const tz = Math.floor(toZ);

    const dx = tx - fx;
    const dz = tz - fz;

    // Cardinal: check source edge OR destination's opposite edge
    if (dx === 0 && dz === -1) return this.wallBlocksAtHeight(fx, fz, WallEdge.N, playerY) || this.wallBlocksAtHeight(tx, tz, WallEdge.S, playerY);
    if (dx === 1 && dz === 0) return this.wallBlocksAtHeight(fx, fz, WallEdge.E, playerY) || this.wallBlocksAtHeight(tx, tz, WallEdge.W, playerY);
    if (dx === 0 && dz === 1) return this.wallBlocksAtHeight(fx, fz, WallEdge.S, playerY) || this.wallBlocksAtHeight(tx, tz, WallEdge.N, playerY);
    if (dx === -1 && dz === 0) return this.wallBlocksAtHeight(fx, fz, WallEdge.W, playerY) || this.wallBlocksAtHeight(tx, tz, WallEdge.E, playerY);

    // Diagonal movement: check source, destination, AND both intermediate tiles
    // Moving NE (dx=1, dz=-1): also check (fx+1, fz) and (fx, fz-1)
    if (dx === 1 && dz === -1) {
      if (this.wallBlocksAtHeight(fx, fz, WallEdge.N, playerY) || this.wallBlocksAtHeight(fx, fz, WallEdge.E, playerY)) return true;
      if (this.wallBlocksAtHeight(tx, tz, WallEdge.S, playerY) || this.wallBlocksAtHeight(tx, tz, WallEdge.W, playerY)) return true;
      if (this.wallBlocksAtHeight(fx + 1, fz, WallEdge.N, playerY) || this.wallBlocksAtHeight(fx, fz - 1, WallEdge.E, playerY)) return true;
      return false;
    }
    if (dx === -1 && dz === -1) {
      if (this.wallBlocksAtHeight(fx, fz, WallEdge.N, playerY) || this.wallBlocksAtHeight(fx, fz, WallEdge.W, playerY)) return true;
      if (this.wallBlocksAtHeight(tx, tz, WallEdge.S, playerY) || this.wallBlocksAtHeight(tx, tz, WallEdge.E, playerY)) return true;
      if (this.wallBlocksAtHeight(fx - 1, fz, WallEdge.N, playerY) || this.wallBlocksAtHeight(fx, fz - 1, WallEdge.W, playerY)) return true;
      return false;
    }
    if (dx === 1 && dz === 1) {
      if (this.wallBlocksAtHeight(fx, fz, WallEdge.S, playerY) || this.wallBlocksAtHeight(fx, fz, WallEdge.E, playerY)) return true;
      if (this.wallBlocksAtHeight(tx, tz, WallEdge.N, playerY) || this.wallBlocksAtHeight(tx, tz, WallEdge.W, playerY)) return true;
      if (this.wallBlocksAtHeight(fx + 1, fz, WallEdge.S, playerY) || this.wallBlocksAtHeight(fx, fz + 1, WallEdge.E, playerY)) return true;
      return false;
    }
    if (dx === -1 && dz === 1) {
      if (this.wallBlocksAtHeight(fx, fz, WallEdge.S, playerY) || this.wallBlocksAtHeight(fx, fz, WallEdge.W, playerY)) return true;
      if (this.wallBlocksAtHeight(tx, tz, WallEdge.N, playerY) || this.wallBlocksAtHeight(tx, tz, WallEdge.E, playerY)) return true;
      if (this.wallBlocksAtHeight(fx - 1, fz, WallEdge.S, playerY) || this.wallBlocksAtHeight(fx, fz + 1, WallEdge.W, playerY)) return true;
      return false;
    }

    return false;
  }

  findSpawnPoint(): { x: number; z: number } {
    const sp = this.meta.spawnPoint;
    if (!this.isBlocked(sp.x, sp.z)) {
      return { x: sp.x, z: sp.z };
    }
    for (let r = 0; r < 15; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const x = sp.x + dx;
          const z = sp.z + dz;
          if (!this.isBlocked(x, z)) {
            return { x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5 };
          }
        }
      }
    }
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        if (!this.isBlocked(x, z)) {
          return { x: x + 0.5, z: z + 0.5 };
        }
      }
    }
    return { x: sp.x, z: sp.z };
  }

  getTransitions(): MapTransition[] {
    return this.meta.transitions;
  }

  getTransitionAt(x: number, z: number): MapTransition | null {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    return this.transitionMap.get(tz * this.width + tx) ?? null;
  }

  findPath(startX: number, startZ: number, goalX: number, goalZ: number): { x: number; z: number }[] {
    return this.findPathGeneric(startX, startZ, goalX, goalZ, this.isBlockedCb, this.isWallBlockedCb);
  }

  findPathOnFloor(startX: number, startZ: number, goalX: number, goalZ: number, floor: number): { x: number; z: number }[] {
    if (floor === 0) return this.findPath(startX, startZ, goalX, goalZ);
    return this.findPathGeneric(
      startX, startZ, goalX, goalZ,
      (x, z) => this.isTileBlockedOnFloor(x, z, floor),
      (fx, fz, tx, tz) => this.isWallBlockedOnFloor(fx, fz, tx, tz, floor),
    );
  }

  findPathForNpc(
    startX: number, startZ: number, goalX: number, goalZ: number,
    tileBlocked: (x: number, z: number) => boolean,
    maxSearchSteps: number = DEFAULT_MAX_SEARCH_TILES,
    wallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean,
  ): { x: number; z: number }[] {
    return this.findPathGeneric(startX, startZ, goalX, goalZ, tileBlocked, wallBlocked ?? this.isWallBlockedCb, maxSearchSteps);
  }

  /** True if any tile in a size-N footprint centered at (x,z) is blocked.
   *  Anchor convention matches getObjectFootprintTiles. Hot path — enumerates inline (no array alloc) since
   *  NPC AI calls this many times per A* expansion. */
  isNpcBlocked(x: number, z: number, size: number): boolean {
    return isFootprintBlocked(
      {
        width: this.width,
        height: this.height,
        isTileBlocked: (tileX, tileZ) => this.isBlocked(tileX, tileZ),
      },
      Math.floor(x),
      Math.floor(z),
      size,
    );
  }

  /** Wall-edge check for a size-N NPC moving its anchor from (fromX,fromZ)
   *  to (toX,toZ). For cardinals, checks the wall along the leading edge of
   *  the move (N edges total). For diagonals, OSRS rule: at least one of
   *  the two cardinal sub-paths (E-then-S or S-then-E) must be fully open.
   *  Allocation-free for cardinals; diagonals recurse exactly two levels
   *  (each into a cardinal), so the diagonal cost is 2 * cardinal cost. */
  isNpcWallBlocked(fromX: number, fromZ: number, toX: number, toZ: number, size: number): boolean {
    return isFootprintWallBlocked(
      {
        width: this.width,
        height: this.height,
        isTileBlocked: (tileX, tileZ) => this.isBlocked(tileX, tileZ),
        isWallBlocked: (fx, fz, tx, tz) => this.isWallBlocked(fx, fz, tx, tz),
      },
      Math.floor(fromX),
      Math.floor(fromZ),
      Math.floor(toX),
      Math.floor(toZ),
      size,
    );
  }

  /** Path for a size-N NPC. Each node represents an anchor position whose
   *  full footprint fits + can be reached from the previous step's anchor
   *  without crossing any wall edges. */
  findPathForSizedNpc(startX: number, startZ: number, goalX: number, goalZ: number, size: number): { x: number; z: number }[] {
    if (size <= 1) return this.findPath(startX, startZ, goalX, goalZ);
    return this.findPathGeneric(
      startX, startZ, goalX, goalZ,
      (x, z) => this.isNpcBlocked(x, z, size),
      (fx, fz, tx, tz) => this.isNpcWallBlocked(fx, fz, tx, tz, size),
    );
  }

  private findPathGeneric(
    startX: number, startZ: number, goalX: number, goalZ: number,
    tileBlocked: (x: number, z: number) => boolean,
    wallBlocked: (fx: number, fz: number, tx: number, tz: number) => boolean,
    maxSteps: number = DEFAULT_MAX_SEARCH_TILES,
  ): { x: number; z: number }[] {
    const collision: PathingCollision = {
      width: this.width,
      height: this.height,
      isTileBlocked: (tileX, tileZ) => tileBlocked(tileX, tileZ),
      isWallBlocked: (fx, fz, tx, tz) => wallBlocked(fx, fz, tx, tz),
    };
    return findPathToTile({ startX, startZ, goalX, goalZ, collision, maxSearchTiles: maxSteps });
  }

  // --- Chunked tile/height loading helpers ---

  private static readonly EDITOR_CHUNK_SIZE = 64;

  /** Load tiles from per-chunk files under tiles/. Returns null if directory doesn't exist. */
  private static loadChunkedTiles(mapDir: string, width: number, height: number, defaultGround: KCTile['ground'] = 'grass'): KCTile[][] | null {
    const tilesDir = resolve(mapDir, 'tiles');
    if (!existsSync(tilesDir)) return null;

    const tiles: KCTile[][] = [];
    for (let z = 0; z < height; z++) {
      const row: KCTile[] = [];
      for (let x = 0; x < width; x++) {
        row.push(defaultKCTile(defaultGround));
      }
      tiles.push(row);
    }

    try {
      for (const file of readdirSync(tilesDir)) {
        if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
        const match = file.match(/^chunk_(\d+)_(\d+)\.json$/);
        if (!match) continue;
        const cx = parseInt(match[1]);
        const cz = parseInt(match[2]);
        const startX = cx * GameMap.EDITOR_CHUNK_SIZE;
        const startZ = cz * GameMap.EDITOR_CHUNK_SIZE;

        const chunkData: Record<string, Partial<KCTile>> = JSON.parse(
          readFileSync(resolve(tilesDir, file), 'utf-8')
        );

        for (const [key, partial] of Object.entries(chunkData)) {
          const [localZStr, localXStr] = key.split(',');
          const z = startZ + parseInt(localZStr);
          const x = startX + parseInt(localXStr);
          if (z >= 0 && z < height && x >= 0 && x < width) {
            tiles[z][x] = { ...defaultKCTile(defaultGround), ...partial };
          }
        }
      }
    } catch { return null; }

    return tiles;
  }

  /** Load heights from per-chunk files under heights/. Returns null if directory doesn't exist. */
  private static loadChunkedHeights(mapDir: string, width: number, height: number): number[][] | null {
    const heightsDir = resolve(mapDir, 'heights');
    if (!existsSync(heightsDir)) return null;

    const heights: number[][] = [];
    for (let z = 0; z <= height; z++) {
      heights.push(new Array(width + 1).fill(0));
    }

    try {
      for (const file of readdirSync(heightsDir)) {
        if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
        const match = file.match(/^chunk_(\d+)_(\d+)\.json$/);
        if (!match) continue;
        const cx = parseInt(match[1]);
        const cz = parseInt(match[2]);
        const startX = cx * GameMap.EDITOR_CHUNK_SIZE;
        const startZ = cz * GameMap.EDITOR_CHUNK_SIZE;

        const chunkData: Record<string, number> = JSON.parse(
          readFileSync(resolve(heightsDir, file), 'utf-8')
        );

        for (const [key, val] of Object.entries(chunkData)) {
          const [localZStr, localXStr] = key.split(',');
          const z = startZ + parseInt(localZStr);
          const x = startX + parseInt(localXStr);
          if (z >= 0 && z <= height && x >= 0 && x <= width) {
            heights[z][x] = val;
          }
        }
      }
    } catch { return null; }

    return heights;
  }
}
