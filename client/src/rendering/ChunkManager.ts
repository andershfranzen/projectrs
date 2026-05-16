import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { Vector3, Quaternion, Matrix, TmpVectors } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo';
import '@babylonjs/loaders/glTF';
import { worldAABB } from './MeshBounds';
import { CHUNK_SIZE, CHUNK_LOAD_RADIUS, TILE_SIZE, TileType, BLOCKING_TILES, WallEdge, DEFAULT_WALL_HEIGHT, groundTypeToTileType, shouldTileRenderWater, classifyTileType } from '@projectrs/shared';
import { ASSET_TO_OBJECT_DEF, BLOCKING_DECOR_ASSETS, STAIR_ASSET_CONFIG, rotateStairDirection, deriveUpperFloorTilesFromPlanes, deriveElevatedFloorTiles, isFlatPlane, forEachTileInPlaneFootprint, GROUND_TYPE_ID, GROUND_TYPE_NONE } from '@projectrs/shared';
import { clamp, sampleNoise, groundColor, getNoiseExtra, getSlopeShade, getTileAverageHeight, getVertexAO as sharedGetVertexAO, getVertexWaterProximity as sharedGetVertexWaterProximity, CLIFF_R, CLIFF_G, CLIFF_B, DESERT_SLOPE_TYPES, computeCutPolygons, bilerpCorners, transformOverlayUV, fullTileRingForSplit, legacyCutAngleFromSplit } from '@projectrs/shared';
import type { UVPoint } from '@projectrs/shared';
import type { RGB } from '@projectrs/shared';
import type { MapMeta, WallsFile, StairData, RoofData, FloorLayerData, KCMapFile, KCMapData, KCTile, GroundType, PlacedObject, TexturePlane } from '@projectrs/shared';

// --- Building mesh types ---

interface FloorMeshSet {
  wall: Mesh | null;
  roof: Mesh | null;
  floor: Mesh | null;
  stairs: Mesh | null;
}

interface ChunkMeshes {
  ground: Mesh;
  overlays: Mesh[];
  water: Mesh | null;
  paddyWater: Mesh | null;
  cliff: Mesh | null;
  ceiling: Mesh | null;
  wall: Mesh | null;
  roof: Mesh | null;
  floor: Mesh | null;
  stairs: Mesh | null;
  upperFloors: Map<number, FloorMeshSet>;
}

interface FloorLayerClientData {
  walls: Map<number, number>;
  wallHeights: Map<number, number>;
  floors: Map<number, number>;
  stairs: Map<number, StairData>;
  roofs: Map<number, RoofData>;
  /** Implicit walkable tiles for upper floors — derived from elevated texture
   *  planes when walls.json doesn't have explicit floor entries. Value is the
   *  Y height (used by walls for base height). Texture planes provide the
   *  visual surface so we don't render brown floor planes for these tiles. */
  tiles: Map<number, number>;
}

export interface MinimapTileSnapshot {
  tiles: Uint8Array;
  /** Per-tile GroundType ID (see GROUND_TYPE_ID in shared). 0xff = no data,
   *  caller falls back to the broader TileType for color. Lets the minimap
   *  distinguish sand vs drysand vs sandstone — TileType collapses these. */
  grounds: Uint8Array;
  walls: Uint8Array;
  roofs: Uint8Array;
  textured: Uint8Array;
  voidTiles: Uint8Array;
  /** RGB triplets per tile; only meaningful where `hasOverride[idx] === 1`. */
  overrideColors: Uint8Array;
  hasOverride: Uint8Array;
  size: number;
  startX: number;
  startZ: number;
}

/**
 * Client-side chunk manager.
 * Loads KC editor map.json via HTTP, builds/destroys chunk terrain
 * meshes based on player position.
 */
export class ChunkManager {
  private scene: Scene;
  private mapId: string = '';
  private meta: MapMeta | null = null;

  // KC map data
  private mapData: KCMapData | null = null;
  private mapWidth: number = 0;
  private mapHeight: number = 0;
  private activeChunks: Set<string> | null = null; // editor 64x64 chunks

  // Cached flat arrays for fast access
  private heights: Float32Array | null = null;
  private tileTypes: Uint8Array | null = null;

  // Building data
  private walls: Uint8Array | null = null;
  private wallHeights: Map<number, number> = new Map();
  private floorHeights: Map<number, number> = new Map();
  private stairData: Map<number, StairData> = new Map();
  private roofData: Map<number, RoofData> = new Map();
  private holeTiles: Set<number> = new Set();
  private texturePlaneFloorTiles: Set<number> = new Set(); // floors from texture planes (don't render floor mesh)
  /** Edge bits currently suppressed by open doors. Bypasses wall-blocking on any
   *  floor layer so an open door clears the path even when an upper-floor wall
   *  is painted on the same tile/edge. */
  private openDoorEdges: Map<number, number> = new Map();

  // Multi-floor layer data (floor 1+)
  private floorLayerData: Map<number, FloorLayerClientData> = new Map();
  private currentFloor: number = 0;

  // Active chunk meshes
  private chunks: Map<string, ChunkMeshes> = new Map();
  private lastChunkX: number = -999;
  private lastChunkZ: number = -999;

  // Shared materials
  private groundMat: StandardMaterial | null = null;
  private waterMat: StandardMaterial | null = null;
  private cliffMat: StandardMaterial | null = null;
  private wallMat: StandardMaterial | null = null;
  private roofMat: StandardMaterial | null = null;
  private floorMat: StandardMaterial | null = null;
  private stairMat: StandardMaterial | null = null;
  private paddyWaterMat: StandardMaterial | null = null;

  private loaded: boolean = false;

  // On-demand per-editor-chunk loading
  private chunkedMode: boolean = false;
  private loadedEditorChunks: Set<string> = new Set();
  private loadingEditorChunks: Set<string> = new Set();
  private pendingGameChunks: Set<string> = new Set();
  private queuedGameChunks: Set<string> = new Set();
  private desiredGameChunks: Set<string> = new Set();
  private keepGameChunks: Set<string> = new Set();

  // Water texture + animation
  private waterTexture: Texture | null = null;
  private waterStartTime: number = 0;

  // Object shadow influences (vertex grid, 1.0 = full brightness, 0.0 = full shadow)
  private shadowInf: Float32Array | null = null;

  // Placed objects and texture planes from KC editor
  private placedObjectNodes: TransformNode[] = [];
  /** Spatial index: "tileX,tileZ" → placed object node (only interactable objects) */
  private placedObjectGrid: Map<string, TransformNode> = new Map();
  /** Raw placed object data indexed by chunk key "cx,cz" */
  private placedObjectsByChunk: Map<string, PlacedObject[]> = new Map();
  /** Tile-index blockers for thin-instanced decor (bushes); mirrored server-side. */
  private decorBlockedTiles: Set<number> = new Set();
  private decorBlockedTilesByChunk: Map<string, number[]> = new Map();
  /** Instantiated placed object nodes per chunk */
  private chunkPlacedNodes: Map<string, TransformNode[]> = new Map();
  /** Animation groups per chunk */
  private chunkAnimGroups: Map<string, AnimationGroup[]> = new Map();
  /** Chunks currently loading placed objects (prevents double-load) */
  private loadingObjectChunks: Set<string> = new Set();
  /** FIFO of object chunks waiting for instantiation. Keeps many chunks from
   *  resuming into mesh creation in the same frame after their assets load. */
  private objectChunkQueue: string[] = [];
  private queuedObjectChunks: Set<string> = new Set();
  private objectChunkQueueScheduled: boolean = false;
  private readonly objectChunkFrameBudgetMs: number = 6;
  /** Chunks the server has confirmed have no placed objects (404 from per-chunk
   *  fetch). Persists across chunk eviction so we never re-fetch a known-empty
   *  chunk in the same session. */
  private chunksKnownEmpty: Set<string> = new Set();
  private _lastStairLog: number = -1;
  /** Elevated texture plane floor heights (only applied when player is already at that height via stairs) */
  private elevatedFloorHeights: Map<number, number> = new Map();
  /** Bridge tiles — elevated texture planes over originally-blocking terrain (always snap to height) */
  private bridgeFloorTiles: Set<number> = new Set();
  /** Tiles where at least one non-noRoof flat plane sits in `elevatedFloor-
   *  Heights`. Tiles registered ONLY by `noRoof` planes are absent here, so
   *  isUnderRoof's Signal A treats them as outdoor (bridges, terraces). */
  private nonNoRoofElevatedTiles: Set<number> = new Set();
  /** Tiles covered by any flat `noRoof` plane. Vetoes isUnderRoof Signal B —
   *  a roof-like placed object's bbox-stamped roofObjectGrid entry over the
   *  same tile would otherwise misfire indoor mode under a balcony/terrace. */
  private noRoofPlaneTiles: Set<number> = new Set();
  /** Placed stair ramp zones for proximity-based height interpolation */
  private placedStairRamps: { cx: number; cz: number; baseY: number; topY: number; direction: 'N' | 'S' | 'E' | 'W'; halfLength: number }[] = [];
  /** Spatial index of roof objects: "tileX,tileZ" → roof entries with floor tag + Y height */
  private roofObjectGrid: Map<string, { node: TransformNode; floor: number; y: number }[]> = new Map();
  /** Callback fired when a chunk's placed objects finish loading */
  private onChunkObjectsLoaded: ((chunkKey: string) => void) | null = null;
  private texturePlaneMeshes: Mesh[] = [];
  private texturePlanesByChunk: Map<string, Mesh[]> = new Map();
  private textureOverlayMeshesByChunk: Map<string, Mesh[]> = new Map();
  private assetRegistry: Map<string, { path: string }> = new Map();
  private loadedModelCache: Map<string, TransformNode | null> = new Map();
  private modelAnimationGroups: Map<string, AnimationGroup[]> = new Map();
  private activeAnimationGroups: AnimationGroup[] = [];
  private textureCache: Map<string, Texture> = new Map();
  private textureRegistry: Map<string, { path: string }> = new Map();
  private textureAvgColors: Map<string, [number, number, number]> = new Map();
  private textureAvgColorLoading: Set<string> = new Set();
  /** Per-tile painted color derived from flat texture planes. Topmost plane
   *  wins on overlap — `y` is tracked so later stamps can compare elevations. */
  private tilePaintedEntries: Map<number, { color: [number, number, number]; y: number }> = new Map();
  /** Flat texture planes grouped by textureId — lets refresh-on-load touch
   *  only the planes affected by the texture that just finished sampling. */
  private flatPlanesByTexture: Map<string, TexturePlane[]> = new Map();
  private onMinimapDataChanged: (() => void) | null = null;
  /** Coalesces a burst of texture-load callbacks into one invalidation. */
  private minimapDirty: boolean = false;
  private overlayMatCache: Map<string, StandardMaterial> = new Map();
  private templateBaseMatrices: Map<string, { sourceMesh: Mesh; baseMatrix: Matrix }[]> = new Map();
  private chunkThinInstSources: Map<string, Mesh[]> = new Map();

  /** Increments on every loadMap call. After each await inside loadMap, the
   *  function checks `this.loadMapToken === myToken` and returns early if a
   *  newer load has started. Without this, the initial loadMap('kcmap') in
   *  GameManager constructor races with handleMapChange's loadMap(actualMap),
   *  and the older async resumption stomps on the newer state — placed
   *  objects get wiped, chunks render terrain only. */
  private loadMapToken: number = 0;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  isLoaded(): boolean { return this.loaded; }
  getMapId(): string { return this.mapId; }
  getMeta(): MapMeta | null { return this.meta; }
  getMapWidth(): number { return this.mapWidth; }
  getMapHeight(): number { return this.mapHeight; }

  /** Resolves once map.json is parsed AND the spawn chunk's terrain data +
   *  placed objects have finished loading. Used by the login flow's loading
   *  screen so input doesn't unlock against a half-streamed world (where you
   *  could click-walk through unloaded trees or fall through holes). Polls
   *  every 50 ms; resolves after `timeoutMs` even if some assets still
   *  haven't returned (better to unblock the player than to hang on a slow
   *  asset fetch). */
  async whenSpawnChunksReady(playerX: number, playerZ: number, timeoutMs: number = 15000): Promise<void> {
    const start = performance.now();
    // Wait for map.json + walls + asset registry — the synchronous data the
    // streamed-chunk loaders depend on.
    while (!this.loaded) {
      if (performance.now() - start > timeoutMs) return;
      await new Promise(r => setTimeout(r, 50));
    }
    // Kick chunk streaming for the spawn position.
    this.updatePlayerPosition(playerX, playerZ);
    const cx = Math.floor(playerX / CHUNK_SIZE);
    const cz = Math.floor(playerZ / CHUNK_SIZE);
    const spawnKey = `${cx},${cz}`;
    while (true) {
      if (performance.now() - start > timeoutMs) return;
      this.updatePlayerPosition(playerX, playerZ);
      const terrainReady = this.isGameChunkReady(cx, cz) && this.chunks.has(spawnKey);
      const objectsReady = this.chunkPlacedNodes.has(spawnKey) && !this.loadingObjectChunks.has(spawnKey);
      if (terrainReady && objectsReady) return;
      await new Promise(r => setTimeout(r, 50));
    }
  }

  /** Load map data from server via HTTP */
  async loadMap(mapId: string): Promise<void> {
    const myToken = ++this.loadMapToken;
    const isStale = () => this.loadMapToken !== myToken;
    this.disposeAll();
    this.loaded = false;
    this.mapId = mapId;

    // In dev mode bust the HTTP cache so editor saves show up immediately
    // (the editor preview workflow relies on a hard refresh picking up new
    // map JSON without manually clearing site data). In prod the server
    // serves these with no-cache anyway, so the bust is dead weight and
    // also defeats the AssetPreloader pre-fetch — the URL it warmed has
    // no `?t=…` suffix, so loadMap would re-hit the network. Omit it.
    const cacheBust = import.meta.env.DEV ? `?t=${Date.now()}` : '';
    const joinCb = cacheBust ? `${cacheBust}&` : '?';

    // Fetch meta
    const metaRes = await fetch(`/maps/${mapId}/meta.json${cacheBust}`);
    if (isStale()) return;
    this.meta = await metaRes.json() as MapMeta;
    if (isStale()) return;
    this.mapWidth = this.meta.width;
    this.mapHeight = this.meta.height;

    // Fetch KC map data — request chunked mode (metadata only, no tiles/heights)
    const mapRes = await fetch(`/maps/${mapId}/map.json${joinCb}chunked=1`);
    if (isStale()) return;
    const mapFile: KCMapFile = await mapRes.json();
    if (isStale()) return;
    this.mapData = mapFile.map;
    this.activeChunks = Array.isArray(this.mapData.activeChunks)
      ? new Set(this.mapData.activeChunks)
      : null;

    // Detect if server returned full tiles (backward compat) or empty (chunked mode)
    const hasFullTiles = this.mapData.tiles?.length > 0 && this.mapData.tiles[0]?.length > 0;

    const vw = this.mapWidth + 1;
    const vh = this.mapHeight + 1;

    if (hasFullTiles) {
      // Legacy path: server returned all tiles/heights inline
      this.chunkedMode = false;
      this.heights = new Float32Array(vw * vh);
      for (let z = 0; z <= this.mapHeight; z++) {
        for (let x = 0; x <= this.mapWidth; x++) {
          this.heights[z * vw + x] = this.mapData.heights[z]?.[x] ?? 0;
        }
      }
      this.tileTypes = new Uint8Array(this.mapWidth * this.mapHeight);
      for (let z = 0; z < this.mapHeight; z++) {
        for (let x = 0; x < this.mapWidth; x++) {
          if (this.activeChunks && !this.activeChunks.has(`${Math.floor(x / 64)},${Math.floor(z / 64)}`)) {
            this.tileTypes[z * this.mapWidth + x] = TileType.WALL;
            continue;
          }
          const tile = this.getTileRaw(x, z);
          if (!tile) { this.tileTypes[z * this.mapWidth + x] = TileType.GRASS; continue; }
          const corners = this.getTileCornerHeights(x, z);
          const wl = this.getChunkWaterLevel(x, z);
          this.tileTypes[z * this.mapWidth + x] = classifyTileType(tile, corners, wl);
        }
      }
    } else {
      // Chunked mode: allocate empty arrays, load per-chunk on demand
      this.chunkedMode = true;
      this.heights = new Float32Array(vw * vh); // all zeros
      this.tileTypes = new Uint8Array(this.mapWidth * this.mapHeight);
      this.tileTypes.fill(TileType.WALL); // sentinel: unloaded = impassable
      // Initialize tiles as empty 2D array
      this.mapData.tiles = [];
      this.loadedEditorChunks.clear();
      this.loadingEditorChunks.clear();
      this.pendingGameChunks.clear();
    }

    // Fetch walls data
    this.walls = new Uint8Array(this.mapWidth * this.mapHeight);
    this.wallHeights.clear();
    this.floorHeights.clear();
    this.stairData.clear();
    this.roofData.clear();
    this.holeTiles.clear();
    this.floorLayerData.clear();
    this.currentFloor = 0;
    try {
      const wallsRes = await fetch(`/maps/${mapId}/walls.json${cacheBust}`);
      if (isStale()) return;
      if (wallsRes.ok) {
        const wallsData: WallsFile = await wallsRes.json();
        if (isStale()) return;
        const parseKey = (key: string): number | null => {
          const [xStr, zStr] = key.split(',');
          const x = parseInt(xStr);
          const z = parseInt(zStr);
          if (x >= 0 && x < this.mapWidth && z >= 0 && z < this.mapHeight) return z * this.mapWidth + x;
          return null;
        };
        for (const [key, mask] of Object.entries(wallsData.walls)) {
          const idx = parseKey(key);
          if (idx !== null) this.walls[idx] = mask;
        }
        if (wallsData.wallHeights) for (const [key, h] of Object.entries(wallsData.wallHeights)) { const idx = parseKey(key); if (idx !== null) this.wallHeights.set(idx, h); }
        if (wallsData.floors) for (const [key, h] of Object.entries(wallsData.floors)) { const idx = parseKey(key); if (idx !== null) this.floorHeights.set(idx, h); }
        if (wallsData.stairs) for (const [key, data] of Object.entries(wallsData.stairs)) { const idx = parseKey(key); if (idx !== null) this.stairData.set(idx, data); }
        if (wallsData.roofs) for (const [key, data] of Object.entries(wallsData.roofs)) { const idx = parseKey(key); if (idx !== null) this.roofData.set(idx, data); }
        if (wallsData.holes) for (const key of Object.keys(wallsData.holes)) { const idx = parseKey(key); if (idx !== null) this.holeTiles.add(idx); }
        if (wallsData.floorLayers) {
          for (const [floorStr, ld] of Object.entries(wallsData.floorLayers)) {
            const floorIdx = parseInt(floorStr as string);
            const layer: FloorLayerClientData = { walls: new Map(), wallHeights: new Map(), floors: new Map(), stairs: new Map(), roofs: new Map(), tiles: new Map() };
            const ldd = ld as FloorLayerData;
            if (ldd.walls) for (const [k, v] of Object.entries(ldd.walls)) { const i = parseKey(k); if (i !== null) layer.walls.set(i, v); }
            if (ldd.wallHeights) for (const [k, v] of Object.entries(ldd.wallHeights)) { const i = parseKey(k); if (i !== null) layer.wallHeights.set(i, v); }
            if (ldd.floors) for (const [k, v] of Object.entries(ldd.floors)) { const i = parseKey(k); if (i !== null) layer.floors.set(i, v); }
            if (ldd.stairs) for (const [k, v] of Object.entries(ldd.stairs)) { const i = parseKey(k); if (i !== null) layer.stairs.set(i, v as StairData); }
            if (ldd.roofs) for (const [k, v] of Object.entries(ldd.roofs)) { const i = parseKey(k); if (i !== null) layer.roofs.set(i, v as RoofData); }
            this.floorLayerData.set(floorIdx, layer);
          }
        }
      }
    } catch { /* no walls.json */ }

    // Create shared materials
    if (!this.groundMat) {
      this.groundMat = new StandardMaterial('chunkGroundMat', this.scene);
      this.groundMat.specularColor = new Color3(0, 0, 0);
      this.groundMat.emissiveColor = new Color3(0.2, 0.2, 0.2);
    }
    if (!this.waterMat) {
      this.waterMat = new StandardMaterial('chunkWaterMat', this.scene);
      this.waterMat.specularColor = new Color3(0, 0, 0);
      this.waterMat.alpha = 0.88;
      this.waterMat.diffuseColor = new Color3(0.83, 0.91, 1.0); // 0xd4e8ff tint
      // Load water texture
      this.waterTexture = new Texture('/assets/textures/1.png', this.scene, false, true, Texture.NEAREST_LINEAR_MIPLINEAR);
      this.waterTexture.anisotropicFilteringLevel = 1;
      this.waterTexture.uScale = 1;
      this.waterTexture.vScale = 1;
      this.waterTexture.wrapU = Texture.WRAP_ADDRESSMODE;
      this.waterTexture.wrapV = Texture.WRAP_ADDRESSMODE;
      this.waterMat.diffuseTexture = this.waterTexture;
      this.waterStartTime = performance.now() / 1000;
    }
    if (!this.cliffMat) {
      this.cliffMat = new StandardMaterial('chunkCliffMat', this.scene);
      this.cliffMat.specularColor = new Color3(0, 0, 0);
      this.cliffMat.emissiveColor = new Color3(0.2, 0.2, 0.2);
      this.cliffMat.backFaceCulling = false;
    }
    if (!this.wallMat) {
      this.wallMat = new StandardMaterial('chunkWallMat', this.scene);
      this.wallMat.specularColor = new Color3(0, 0, 0);
      this.wallMat.emissiveColor = new Color3(0.2, 0.2, 0.2);
      this.wallMat.backFaceCulling = false;
    }
    if (!this.roofMat) {
      this.roofMat = new StandardMaterial('chunkRoofMat', this.scene);
      this.roofMat.specularColor = new Color3(0, 0, 0);
      this.roofMat.emissiveColor = new Color3(0.2, 0.2, 0.2);
      this.roofMat.backFaceCulling = false;
    }
    if (!this.floorMat) {
      this.floorMat = new StandardMaterial('chunkFloorMat', this.scene);
      this.floorMat.specularColor = new Color3(0, 0, 0);
      this.floorMat.emissiveColor = new Color3(0.2, 0.2, 0.2);
    }
    if (!this.stairMat) {
      this.stairMat = new StandardMaterial('chunkStairMat', this.scene);
      this.stairMat.specularColor = new Color3(0, 0, 0);
      this.stairMat.emissiveColor = new Color3(0.2, 0.2, 0.2);
    }
    if (!this.paddyWaterMat) {
      this.paddyWaterMat = new StandardMaterial('chunkPaddyWaterMat', this.scene);
      this.paddyWaterMat.specularColor = new Color3(0, 0, 0);
      this.paddyWaterMat.diffuseColor = new Color3(0.88, 0.96, 0.97);
      this.paddyWaterMat.alpha = 0.25;
      this.paddyWaterMat.backFaceCulling = false;
      this.paddyWaterMat.zOffset = -2;
      if (this.waterTexture) {
        const paddyTex = this.waterTexture.clone();
        paddyTex.wrapU = Texture.WRAP_ADDRESSMODE;
        paddyTex.wrapV = Texture.WRAP_ADDRESSMODE;
        this.paddyWaterMat.diffuseTexture = paddyTex;
      }
    }

    // Freeze shared materials — they never change after setup (big perf win)
    for (const mat of [this.groundMat, this.cliffMat, this.wallMat, this.roofMat, this.floorMat, this.stairMat]) {
      if (mat) mat.freeze();
    }

    // Load asset/texture registry before marking loaded so chunk texture overlays work immediately
    await this.loadAssetRegistry();
    if (isStale()) return;

    // Register horizontal texture planes as walkable floors (bridges, platforms)
    // Only run if we have tile data loaded (legacy mode) — in chunked mode this runs after chunks load
    if (hasFullTiles) {
      this.registerTexturePlaneFloors();
    }

    // Index placed objects by chunk (no mesh instantiation — loaded per-chunk in updatePlayerPosition)
    if (hasFullTiles) {
      this.indexPlacedObjectsByChunk(mapFile.placedObjects || []);
      this.buildShadowInfluences();
    } else {
      // Chunked mode: placed objects loaded per-chunk on demand, no pre-indexing
      this.placedObjectsByChunk.clear();
      // Pre-allocate shadow array filled with 1.0 (no shadow) — populated incrementally as objects load
      const sw = this.mapWidth + 1, sh = this.mapHeight + 1;
      this.shadowInf = new Float32Array(sw * sh);
      this.shadowInf.fill(1.0);
    }
    this.loadTexturePlanes(this.mapData!.texturePlanes || []);

    // Auto-derive upper-floor walkable tiles from elevated texture planes for
    // any floor that doesn't already have explicit tile/floor entries. Mirrors
    // server-side GameMap.registerTexturePlaneFloors so client/server agree on
    // which upper-floor tiles exist (needed for wall base heights and the
    // floor system to recognize the surfaces during visibility logic).
    const derivedFloors = deriveUpperFloorTilesFromPlanes(
      this.mapData!.texturePlanes || [],
      this.mapWidth,
      this.mapHeight,
    );
    let derivedTotal = 0;
    for (const [floorIdx, tileMap] of derivedFloors) {
      let layer = this.floorLayerData.get(floorIdx);
      if (!layer) {
        layer = { walls: new Map(), wallHeights: new Map(), floors: new Map(), stairs: new Map(), roofs: new Map(), tiles: new Map() };
        this.floorLayerData.set(floorIdx, layer);
      }
      for (const [idx, y] of tileMap) {
        if (!layer.tiles.has(idx) && !layer.floors.has(idx)) {
          layer.tiles.set(idx, y);
          derivedTotal++;
        }
      }
    }
    if (derivedTotal > 0) {
      console.log(`[ChunkManager] Derived ${derivedTotal} upper-floor walkable tiles across ${derivedFloors.size} floor(s) from texture planes`);
    }

    this.loaded = true;
    this.lastChunkX = -999;
    this.lastChunkZ = -999;
    console.log(`[ChunkManager] Loaded map '${mapId}': ${this.mapWidth}x${this.mapHeight}, tiles: ${this.mapData?.tiles?.length}, heights: ${this.mapData?.heights?.length}, waterLevel: ${this.mapData?.waterLevel}`);
  }

  // --- KC data accessors ---

  private getTileRaw(x: number, z: number): KCTile | null {
    if (!this.mapData) return null;
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return null;
    return this.mapData.tiles[z]?.[x] ?? null;
  }

  private getBaseGroundType(x: number, z: number): GroundType {
    const tile = this.getTileRaw(x, z);
    return tile?.ground ?? 'grass';
  }

  private getChunkWaterLevel(tileX: number, tileZ: number): number {
    if (!this.mapData) return -0.3;
    const chunkX = Math.floor(tileX / 64);
    const chunkZ = Math.floor(tileZ / 64);
    const key = `${chunkX},${chunkZ}`;
    return this.mapData.chunkWaterLevels[key] ?? this.mapData.waterLevel;
  }

  private shouldRenderWater(x: number, z: number): boolean {
    const tile = this.getTileRaw(x, z);
    if (!tile) return false;
    if (tile.waterPainted) return true;
    const corners = this.getTileCornerHeights(x, z);
    return shouldTileRenderWater(tile, corners, this.getChunkWaterLevel(x, z));
  }

  private getTileCornerHeights(x: number, z: number): { tl: number; tr: number; bl: number; br: number } {
    return {
      tl: this.getVertexHeight(x, z),
      tr: this.getVertexHeight(x + 1, z),
      bl: this.getVertexHeight(x, z + 1),
      br: this.getVertexHeight(x + 1, z + 1),
    };
  }

  // --- KC shading methods ---

  private getVertexSlopeShade(vx: number, vz: number): number {
    const sharingTiles: [number, number][] = [[vx - 1, vz - 1], [vx, vz - 1], [vx - 1, vz], [vx, vz]];
    let total = 0, count = 0;
    for (const [tx, tz] of sharingTiles) {
      if (!this.getTileRaw(tx, tz)) continue;
      total += getSlopeShade(this.getTileCornerHeights(tx, tz));
      count++;
    }
    return count > 0 ? total / count : 1.0;
  }

  private getVertexAO(vx: number, vz: number): number {
    return sharedGetVertexAO(vx, vz, this.mapWidth, this.mapHeight, (x, z) => this.getVertexHeight(x, z));
  }

  private getVertexWaterProximity(vx: number, vz: number): number {
    return sharedGetVertexWaterProximity(vx, vz, (tx, tz) => this.shouldRenderWater(tx, tz));
  }

  private isCliffNearby(x: number, z: number): boolean {
    const h = this.getTileCornerHeights(x, z);
    const minH = Math.min(h.tl, h.tr, h.bl, h.br);
    const maxH = Math.max(h.tl, h.tr, h.bl, h.br);
    if ((maxH - minH) > 1.1) return true;
    const centerAvg = (h.tl + h.tr + h.bl + h.br) / 4;
    for (const [nx, nz] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]] as [number, number][]) {
      if (!this.getTileRaw(nx, nz)) continue;
      const nh = this.getTileCornerHeights(nx, nz);
      const nAvg = (nh.tl + nh.tr + nh.bl + nh.br) / 4;
      if (Math.abs(centerAvg - nAvg) > 0.9) return true;
    }
    return false;
  }

  private getCornerBlendedColor(cornerX: number, cornerZ: number, shade: number): RGB {
    const sharingTiles: [number, number][] = [[cornerX - 1, cornerZ - 1], [cornerX, cornerZ - 1], [cornerX - 1, cornerZ], [cornerX, cornerZ]];
    let r = 0, g = 0, b = 0, noise = 0, totalWeight = 0;
    for (const [nx, nz] of sharingTiles) {
      if (!this.getTileRaw(nx, nz)) continue;
      const type = this.getBaseGroundType(nx, nz);
      if (type === 'road') continue;
      const c = groundColor(type, 1.0);
      r += c.r; g += c.g; b += c.b;
      noise += getNoiseExtra(type, cornerX, cornerZ);
      totalWeight += 1;
    }
    if (totalWeight === 0) return groundColor('grass', shade);
    const s = shade + noise / totalWeight;
    return { r: (r / totalWeight) * s, g: (g / totalWeight) * s, b: (b / totalWeight) * s };
  }

  // --- Chunk update ---

  updatePlayerPosition(playerX: number, playerZ: number): boolean {
    if (!this.loaded) { return false; }
    const cx = Math.floor(playerX / CHUNK_SIZE);
    const cz = Math.floor(playerZ / CHUNK_SIZE);
    if (cx === this.lastChunkX && cz === this.lastChunkZ) {
      this.buildQueuedGameChunks(cx, cz);
      return false;
    }
    this.lastChunkX = cx;
    this.lastChunkZ = cz;

    // `desired` = chunks that should be loaded (within active radius).
    // `keep`    = chunks worth keeping in memory even when the player walks
    //             out of range, so a quick step back doesn't trigger a
    //             rebuild from scratch (which causes the visible lag spikes).
    const KEEP_RADIUS = CHUNK_LOAD_RADIUS + 2;
    const desired = new Set<string>();
    const keep = new Set<string>();
    const maxCX = Math.ceil(this.mapWidth / CHUNK_SIZE);
    const maxCZ = Math.ceil(this.mapHeight / CHUNK_SIZE);
    for (let dx = -KEEP_RADIUS; dx <= KEEP_RADIUS; dx++) {
      for (let dz = -KEEP_RADIUS; dz <= KEEP_RADIUS; dz++) {
        const chunkX = cx + dx;
        const chunkZ = cz + dz;
        if (chunkX < 0 || chunkX >= maxCX || chunkZ < 0 || chunkZ >= maxCZ) continue;
        const key = `${chunkX},${chunkZ}`;
        keep.add(key);
        if (Math.abs(dx) <= CHUNK_LOAD_RADIUS && Math.abs(dz) <= CHUNK_LOAD_RADIUS) {
          desired.add(key);
        }
      }
    }
    this.desiredGameChunks = desired;
    this.keepGameChunks = keep;

    // Hide chunks that left the active radius but are still in keep-radius —
    // their meshes stay allocated for instant re-show next time the player
    // wanders back. Only fully dispose chunks beyond keep-radius.
    for (const [key, meshes] of this.chunks) {
      if (desired.has(key)) {
        meshes.ground.setEnabled(true);
        for (const overlay of meshes.overlays) overlay.setEnabled(true);
        meshes.water?.setEnabled(true);
        meshes.paddyWater?.setEnabled(true);
        meshes.cliff?.setEnabled(true);
        meshes.ceiling?.setEnabled(true);
        meshes.wall?.setEnabled(true);
        meshes.roof?.setEnabled(true);
        meshes.floor?.setEnabled(true);
        meshes.stairs?.setEnabled(true);
        for (const [, floorSet] of meshes.upperFloors) {
          floorSet.wall?.setEnabled(true);
          floorSet.roof?.setEnabled(true);
          floorSet.floor?.setEnabled(true);
          floorSet.stairs?.setEnabled(true);
        }
        this.setChunkPlacedObjectsEnabled(key, true);
      } else if (keep.has(key)) {
        // Just hide — meshes stay allocated for fast re-show.
        meshes.ground.setEnabled(false);
        for (const overlay of meshes.overlays) overlay.setEnabled(false);
        meshes.water?.setEnabled(false);
        meshes.paddyWater?.setEnabled(false);
        meshes.cliff?.setEnabled(false);
        meshes.ceiling?.setEnabled(false);
        meshes.wall?.setEnabled(false);
        meshes.roof?.setEnabled(false);
        meshes.floor?.setEnabled(false);
        meshes.stairs?.setEnabled(false);
        for (const [, floorSet] of meshes.upperFloors) {
          floorSet.wall?.setEnabled(false);
          floorSet.roof?.setEnabled(false);
          floorSet.floor?.setEnabled(false);
          floorSet.stairs?.setEnabled(false);
        }
        this.setChunkPlacedObjectsEnabled(key, false);
      } else {
        meshes.ground.dispose();
        this.disposeChunkTextureOverlays(key);
        meshes.water?.dispose();
        meshes.paddyWater?.dispose();
        meshes.cliff?.dispose();
        meshes.ceiling?.dispose();
        meshes.wall?.dispose();
        meshes.roof?.dispose();
        meshes.floor?.dispose();
        meshes.stairs?.dispose();
        for (const [, floorSet] of meshes.upperFloors) {
          floorSet.wall?.dispose();
          floorSet.roof?.dispose();
          floorSet.floor?.dispose();
          floorSet.stairs?.dispose();
        }
        this.chunks.delete(key);
      }
    }

    // Toggle texture planes by chunk — these are loaded globally so may exist
    // in chunks that don't have terrain meshes in this.chunks.
    for (const [key, planes] of this.texturePlanesByChunk) {
      const show = desired.has(key);
      for (const m of planes) m.setEnabled(show);
    }

    // In chunked mode, trigger on-demand loading of needed editor chunks
    if (this.chunkedMode) {
      const ECHUNK = 64;
      const neededEditorChunks = new Set<string>();
      for (const key of desired) {
        const [gcx, gcz] = key.split(',').map(Number);
        const sx = Math.floor((gcx * CHUNK_SIZE) / ECHUNK);
        const sz = Math.floor((gcz * CHUNK_SIZE) / ECHUNK);
        const ex = Math.floor(((gcx + 1) * CHUNK_SIZE - 1) / ECHUNK);
        const ez = Math.floor(((gcz + 1) * CHUNK_SIZE - 1) / ECHUNK);
        // Include neighbors for vertex blending at edges
        for (let ecz = sz - 1; ecz <= ez + 1; ecz++) {
          for (let ecx = sx - 1; ecx <= ex + 1; ecx++) {
            if (ecx >= 0 && ecz >= 0) {
              neededEditorChunks.add(`${ecx},${ecz}`);
            }
          }
        }
      }

      // Trigger loading of needed editor chunks (async, non-blocking)
      for (const ec of neededEditorChunks) {
        const [ecx, ecz] = ec.split(',').map(Number);
        this.loadEditorChunk(ecx, ecz);
      }
    }

    for (const key of desired) {
      if (!this.chunks.has(key)) {
        const [chunkX, chunkZ] = key.split(',').map(Number);
        // Skip if entire game chunk falls in an inactive editor chunk
        if (this.activeChunks) {
          const ecx = Math.floor((chunkX * CHUNK_SIZE) / 64);
          const ecz = Math.floor((chunkZ * CHUNK_SIZE) / 64);
          // Check all editor chunks this game chunk could overlap
          const ecx2 = Math.floor(((chunkX + 1) * CHUNK_SIZE - 1) / 64);
          const ecz2 = Math.floor(((chunkZ + 1) * CHUNK_SIZE - 1) / 64);
          let anyActive = false;
          for (let ez = ecz; ez <= ecz2; ez++) {
            for (let ex = ecx; ex <= ecx2; ex++) {
              if (this.activeChunks.has(`${ex},${ez}`)) { anyActive = true; break; }
            }
            if (anyActive) break;
          }
          if (!anyActive) continue;
        }

        if (this.isGameChunkReady(chunkX, chunkZ)) {
          this.queuedGameChunks.add(key);
        } else {
          this.pendingGameChunks.add(key);
        }
      }
    }
    // Clean up pending chunks no longer desired
    for (const key of this.pendingGameChunks) {
      if (!desired.has(key)) this.pendingGameChunks.delete(key);
    }
    for (const key of this.queuedGameChunks) {
      if (!desired.has(key)) this.queuedGameChunks.delete(key);
    }
    this.buildQueuedGameChunks(cx, cz);

    // Unload placed objects for chunks beyond the keep-radius. Chunks inside
    // keep-radius keep their objects loaded — walking back doesn't re-fetch.
    for (const key of this.chunkPlacedNodes.keys()) {
      if (!keep.has(key)) {
        this.disposeChunkPlacedObjects(key);
      }
    }
    // Load placed objects for chunks entering radius
    for (const key of desired) {
      if (!this.chunkPlacedNodes.has(key) && !this.loadingObjectChunks.has(key)) {
        this.queueChunkPlacedObjects(key);
      }
    }
    return true;
  }

  // --- On-demand editor chunk loading ---

  /** Check if all editor chunks needed by a game chunk are loaded */
  private isGameChunkReady(gcx: number, gcz: number): boolean {
    // Legacy mode: all data was loaded upfront, always ready
    if (!this.chunkedMode) return true;
    const ECHUNK = 64;
    // Check all editor chunks this game chunk overlaps (including +1 margin for vertex blending)
    const startX = gcx * CHUNK_SIZE - 1;
    const endX = (gcx + 1) * CHUNK_SIZE;
    const startZ = gcz * CHUNK_SIZE - 1;
    const endZ = (gcz + 1) * CHUNK_SIZE;
    const neededECs = new Set<string>();
    for (let x = startX; x <= endX; x++) {
      for (let z = startZ; z <= endZ; z++) {
        if (x >= 0 && z >= 0 && x < this.mapWidth && z < this.mapHeight) {
          neededECs.add(`${Math.floor(x / ECHUNK)},${Math.floor(z / ECHUNK)}`);
        }
      }
    }
    for (const ec of neededECs) {
      if (!this.loadedEditorChunks.has(ec)) return false;
    }
    return true;
  }

  /** Build any pending game chunks whose editor chunk data is now available */
  private buildPendingGameChunks(): void {
    for (const key of this.pendingGameChunks) {
      const [cx, cz] = key.split(',').map(Number);
      if (this.isGameChunkReady(cx, cz)) {
        this.pendingGameChunks.delete(key);
        if (this.desiredGameChunks.size === 0 || this.desiredGameChunks.has(key)) {
          this.queuedGameChunks.add(key);
        }
      }
    }
    this.buildQueuedGameChunks(this.lastChunkX, this.lastChunkZ);
  }

  private buildQueuedGameChunks(centerChunkX: number, centerChunkZ: number): void {
    if (this.queuedGameChunks.size === 0) return;
    let bestKey: string | null = null;
    let bestDist = Infinity;
    for (const key of this.queuedGameChunks) {
      if (this.chunks.has(key)) {
        this.queuedGameChunks.delete(key);
        continue;
      }
      if (this.desiredGameChunks.size > 0 && !this.desiredGameChunks.has(key)) continue;
      const [cx, cz] = key.split(',').map(Number);
      if (!this.isGameChunkReady(cx, cz)) {
        this.pendingGameChunks.add(key);
        this.queuedGameChunks.delete(key);
        continue;
      }
      const dist = Math.max(Math.abs(cx - centerChunkX), Math.abs(cz - centerChunkZ));
      if (dist < bestDist) {
        bestDist = dist;
        bestKey = key;
      }
    }
    if (!bestKey) return;

    this.queuedGameChunks.delete(bestKey);
    const [cx, cz] = bestKey.split(',').map(Number);
    const meshes = this.buildChunkMeshes(cx, cz);
    this.chunks.set(bestKey, meshes);
    if (!this.chunkPlacedNodes.has(bestKey) && !this.loadingObjectChunks.has(bestKey)) {
      this.queueChunkPlacedObjects(bestKey);
    }
  }

  /** Load tile/height data for a single 64x64 editor chunk from the server */
  private async loadEditorChunk(ecx: number, ecz: number): Promise<void> {
    const key = `${ecx},${ecz}`;
    if (this.loadedEditorChunks.has(key) || this.loadingEditorChunks.has(key)) return;
    this.loadingEditorChunks.add(key);

    const ECHUNK = 64;

    try {
      // Fetch tiles and heights in parallel (missing chunks return 404 — that's OK)
      const [tilesRes, heightsRes] = await Promise.all([
        fetch(`/maps/${this.mapId}/tiles/chunk_${ecx}_${ecz}.json`).catch(() => null),
        fetch(`/maps/${this.mapId}/heights/chunk_${ecx}_${ecz}.json`).catch(() => null),
      ]);
      if ((!tilesRes || !tilesRes.ok) && (!heightsRes || !heightsRes.ok)) {
        // No data for this chunk — mark as loaded (empty) and skip
        this.loadedEditorChunks.add(key);
        this.loadingEditorChunks.delete(key);
        this.buildPendingGameChunks();
        return;
      }

      const startX = ecx * ECHUNK, startZ = ecz * ECHUNK;

      // Populate heights
      if (heightsRes?.ok) {
        const hData: Record<string, number> = await heightsRes.json();
        const vw = this.mapWidth + 1;
        for (const [k, val] of Object.entries(hData)) {
          const [lz, lx] = k.split(',').map(Number);
          const gx = startX + lx, gz = startZ + lz;
          if (gx <= this.mapWidth && gz <= this.mapHeight && this.heights) {
            this.heights[gz * vw + gx] = val;
          }
        }
      }

      // Populate tiles — fill entire chunk region with defaults, then overlay sparse data
      const endX = Math.min(startX + ECHUNK, this.mapWidth);
      const endZ = Math.min(startZ + ECHUNK, this.mapHeight);
      for (let gz = startZ; gz < endZ; gz++) {
        if (!this.mapData!.tiles[gz]) this.mapData!.tiles[gz] = [];
        for (let gx = startX; gx < endX; gx++) {
          if (!this.mapData!.tiles[gz][gx]) {
            this.mapData!.tiles[gz][gx] = this.expandTile({});
          }
        }
      }
      if (tilesRes?.ok) {
        const tData: Record<string, Partial<KCTile>> = await tilesRes.json();
        for (const [k, partial] of Object.entries(tData)) {
          const [lz, lx] = k.split(',').map(Number);
          const gx = startX + lx, gz = startZ + lz;
          if (gx < this.mapWidth && gz < this.mapHeight) {
            this.mapData!.tiles[gz][gx] = this.expandTile(partial);
          }
        }
      }

      // Populate tileTypes for this region
      for (let z = startZ; z < endZ; z++) {
        for (let x = startX; x < endX; x++) {
          if (this.activeChunks && !this.activeChunks.has(`${Math.floor(x / 64)},${Math.floor(z / 64)}`)) {
            this.tileTypes![z * this.mapWidth + x] = TileType.WALL;
            continue;
          }
          const tile = this.getTileRaw(x, z);
          if (!tile) { this.tileTypes![z * this.mapWidth + x] = TileType.GRASS; continue; }
          const corners = this.getTileCornerHeights(x, z);
          const wl = this.getChunkWaterLevel(x, z);
          this.tileTypes![z * this.mapWidth + x] = classifyTileType(tile, corners, wl);
        }
      }

      this.loadedEditorChunks.add(key);

      // Re-register texture plane bridges for tiles in this chunk only
      // (chunk loading may set WATER tile types that need bridge override)
      this.registerTexturePlaneFloorsInRegion(startX, startZ, endX, endZ);
    } catch (e) {
      console.warn(`[ChunkManager] Failed to load editor chunk ${key}:`, e);
    } finally {
      this.loadingEditorChunks.delete(key);
    }

    // After loading, try to build any pending game chunks that may now be ready
    this.buildPendingGameChunks();
  }

  /** Expand a sparse/partial tile object into a full KCTile */
  private expandTile(partial: Partial<KCTile>): KCTile {
    return {
      ground: partial.ground ?? 'grass',
      groundB: partial.groundB ?? null,
      split: partial.split ?? 'forward',
      textureId: partial.textureId ?? null,
      textureRotation: partial.textureRotation ?? 0,
      textureScale: partial.textureScale ?? 1,
      textureWorldUV: partial.textureWorldUV ?? false,
      textureHalfMode: partial.textureHalfMode ?? false,
      textureIdB: partial.textureIdB ?? null,
      textureRotationB: partial.textureRotationB ?? 0,
      textureScaleB: partial.textureScaleB ?? 1,
      textureCutAngle: partial.textureCutAngle ?? legacyCutAngleFromSplit(partial.split),
      waterPainted: partial.waterPainted ?? false,
      waterSurface: partial.waterSurface ?? false,
    };
  }

  private buildChunkMeshes(chunkX: number, chunkZ: number): ChunkMeshes {
    const startX = chunkX * CHUNK_SIZE;
    const startZ = chunkZ * CHUNK_SIZE;
    const endX = Math.min(startX + CHUNK_SIZE, this.mapWidth);
    const endZ = Math.min(startZ + CHUNK_SIZE, this.mapHeight);

    const ground = this.buildGroundMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    const overlays = this.buildTextureOverlays(chunkX, chunkZ, startX, startZ, endX, endZ);
    const water = this.buildWaterMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    const paddyWater = this.buildPaddyWaterMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    const cliff = this.buildCliffMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    const ceiling = this.buildCeilingMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    // Wall meshes disabled — collision walls are invisible barriers, GLB models provide visuals
    const wall = null;
    const roof = this.buildRoofMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    const floor = this.buildFloorMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    const stairs = this.buildStairMesh(chunkX, chunkZ, startX, startZ, endX, endZ);

    const upperFloors = new Map<number, FloorMeshSet>();
    for (const [floorIdx, layerData] of this.floorLayerData) {
      const floorSet = this.buildFloorLayerMeshes(chunkX, chunkZ, startX, startZ, endX, endZ, floorIdx, layerData);
      if (floorSet) {
        upperFloors.set(floorIdx, floorSet);
        this.setFloorMeshSetVisibility(floorSet, floorIdx);
      }
    }

    // Freeze world matrices on all static chunk meshes — big perf win since these never move
    const allMeshes = [ground, water, paddyWater, cliff, ceiling, wall, roof, floor, stairs];
    for (const [, floorSet] of upperFloors) {
      allMeshes.push(floorSet.wall ?? null, floorSet.roof ?? null, floorSet.floor ?? null, floorSet.stairs ?? null);
    }
    for (const m of allMeshes) {
      if (m) {
        m.freezeWorldMatrix();
        m.doNotSyncBoundingInfo = true;
      }
    }

    return { ground, overlays, water, paddyWater, cliff, ceiling, wall, roof, floor, stairs, upperFloors };
  }

  // --- Ground mesh with KC editor shading ---

  private buildGroundMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh {
    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    let vertexIndex = 0;

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        if (this.activeChunks && !this.activeChunks.has(`${Math.floor(x / 64)},${Math.floor(z / 64)}`)) continue;
        if (this.holeTiles.has(z * this.mapWidth + x)) continue; // skip ground for terrain holes
        const tile = this.getTileRaw(x, z);
        const tileType = tile?.ground ?? 'grass';
        const h = this.getTileCornerHeights(x, z);
        const splitDir = tile?.split ?? 'forward';
        const groundBType = tile?.groundB ?? null;

        // Compute per-vertex shading
        const shadeTL = this.getVertexSlopeShade(x, z);
        const shadeTR = this.getVertexSlopeShade(x + 1, z);
        const shadeBL = this.getVertexSlopeShade(x, z + 1);
        const shadeBR = this.getVertexSlopeShade(x + 1, z + 1);
        const slopeShade = (shadeTL + shadeTR + shadeBL + shadeBR) / 4;

        let cTL: RGB, cTR: RGB, cBL: RGB, cBR: RGB;

        if (groundBType && groundBType !== tileType) {
          // Split tile: flat solid color per triangle
          const noiseA = getNoiseExtra(tileType, x + 0.25, z + 0.25);
          const noiseB = getNoiseExtra(groundBType, x + 0.75, z + 0.75);
          const cA = groundColor(tileType, Math.max(slopeShade + noiseA, 0.5));
          const cB = groundColor(groundBType, Math.max(slopeShade + noiseB, 0.5));
          const avgAO = (this.getVertexAO(x, z) + this.getVertexAO(x + 1, z) + this.getVertexAO(x, z + 1) + this.getVertexAO(x + 1, z + 1)) / 4;
          cA.r *= avgAO; cA.g *= avgAO; cA.b *= avgAO;
          cB.r *= avgAO; cB.g *= avgAO; cB.b *= avgAO;
          // Object shadows on split tiles
          if (this.shadowInf) {
            const shadowableA = tileType === 'grass' || tileType === 'dirt' || tileType === 'path';
            const shadowableB = groundBType === 'grass' || groundBType === 'dirt' || groundBType === 'path';
            const avgShadow = (this.getShadowAt(x, z) + this.getShadowAt(x + 1, z) + this.getShadowAt(x, z + 1) + this.getShadowAt(x + 1, z + 1)) / 4;
            if (shadowableA) { cA.r *= avgShadow; cA.g *= avgShadow; cA.b *= avgShadow; }
            if (shadowableB) { cB.r *= avgShadow; cB.g *= avgShadow; cB.b *= avgShadow; }
          }

          if (splitDir === 'forward') {
            // Triangle A (CCW): TL, TR, BL
            positions.push(x, h.tl, z, x + 1, h.tr, z, x, h.bl, z + 1);
            colors.push(cA.r, cA.g, cA.b, 1, cA.r, cA.g, cA.b, 1, cA.r, cA.g, cA.b, 1);
            // Triangle B (CCW): TR, BR, BL
            positions.push(x + 1, h.tr, z, x + 1, h.br, z + 1, x, h.bl, z + 1);
            colors.push(cB.r, cB.g, cB.b, 1, cB.r, cB.g, cB.b, 1, cB.r, cB.g, cB.b, 1);
          } else {
            // Triangle A (CCW): TL, TR, BR
            positions.push(x, h.tl, z, x + 1, h.tr, z, x + 1, h.br, z + 1);
            colors.push(cA.r, cA.g, cA.b, 1, cA.r, cA.g, cA.b, 1, cA.r, cA.g, cA.b, 1);
            // Triangle B (CCW): TL, BR, BL
            positions.push(x, h.tl, z, x + 1, h.br, z + 1, x, h.bl, z + 1);
            colors.push(cB.r, cB.g, cB.b, 1, cB.r, cB.g, cB.b, 1, cB.r, cB.g, cB.b, 1);
          }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex + 3, vertexIndex + 4, vertexIndex + 5);
          vertexIndex += 6;
          continue;
        }

        // Normal tile: per-vertex blended colors
        if (tileType === 'road') {
          const noise = getNoiseExtra('road', x + 0.5, z + 0.5);
          cTL = groundColor('road', Math.max(shadeTL + noise, 0.5));
          cTR = groundColor('road', Math.max(shadeTR + noise, 0.5));
          cBL = groundColor('road', Math.max(shadeBL + noise, 0.5));
          cBR = groundColor('road', Math.max(shadeBR + noise, 0.5));
        } else {
          cTL = this.getCornerBlendedColor(x, z, shadeTL);
          cTR = this.getCornerBlendedColor(x + 1, z, shadeTR);
          cBL = this.getCornerBlendedColor(x, z + 1, shadeBL);
          cBR = this.getCornerBlendedColor(x + 1, z + 1, shadeBR);
        }

        const wLevel = this.getChunkWaterLevel(x, z);

        if (tileType !== 'water') {
          // Water proximity mud tinting
          const proxTL = this.getVertexWaterProximity(x, z);
          const proxTR = this.getVertexWaterProximity(x + 1, z);
          const proxBL = this.getVertexWaterProximity(x, z + 1);
          const proxBR = this.getVertexWaterProximity(x + 1, z + 1);
          const applyMud = (c: RGB, t: number) => {
            if (t <= 0) return;
            c.r *= 1 + t * 0.18; c.g *= 1 - t * 0.22; c.b *= 1 - t * 0.28;
          };
          applyMud(cTL, proxTL); applyMud(cTR, proxTR); applyMud(cBL, proxBL); applyMud(cBR, proxBR);

          // Underwater darkening
          const applyDepth = (c: RGB, vertH: number) => {
            const depth = clamp((wLevel - vertH) / 2.5, 0, 1);
            if (depth <= 0) return;
            c.r *= 1 - depth * 0.60; c.g *= 1 - depth * 0.45; c.b *= 1 - depth * 0.20;
          };
          applyDepth(cTL, h.tl); applyDepth(cTR, h.tr); applyDepth(cBL, h.bl); applyDepth(cBR, h.br);
        }

        // Vertex AO
        if (tileType !== 'water') {
          const aoTL = this.getVertexAO(x, z);
          const aoTR = this.getVertexAO(x + 1, z);
          const aoBL = this.getVertexAO(x, z + 1);
          const aoBR = this.getVertexAO(x + 1, z + 1);
          cTL.r *= aoTL; cTL.g *= aoTL; cTL.b *= aoTL;
          cTR.r *= aoTR; cTR.g *= aoTR; cTR.b *= aoTR;
          cBL.r *= aoBL; cBL.g *= aoBL; cBL.b *= aoBL;
          cBR.r *= aoBR; cBR.g *= aoBR; cBR.b *= aoBR;
        }

        // Object shadows (grass, dirt, path only)
        if (this.shadowInf && (tileType === 'grass' || tileType === 'dirt' || tileType === 'path')) {
          const sTL = this.getShadowAt(x, z);
          const sTR = this.getShadowAt(x + 1, z);
          const sBL = this.getShadowAt(x, z + 1);
          const sBR = this.getShadowAt(x + 1, z + 1);
          cTL.r *= sTL; cTL.g *= sTL; cTL.b *= sTL;
          cTR.r *= sTR; cTR.g *= sTR; cTR.b *= sTR;
          cBL.r *= sBL; cBL.g *= sBL; cBL.b *= sBL;
          cBR.r *= sBR; cBR.g *= sBR; cBR.b *= sBR;
        }

        // Emit quad (4 vertices)
        positions.push(x, h.tl, z, x + 1, h.tr, z, x, h.bl, z + 1, x + 1, h.br, z + 1);
        colors.push(
          cTL.r, cTL.g, cTL.b, 1,
          cTR.r, cTR.g, cTR.b, 1,
          cBL.r, cBL.g, cBL.b, 1,
          cBR.r, cBR.g, cBR.b, 1,
        );

        if (splitDir === 'forward') {
          // 0=TL, 1=TR, 2=BL, 3=BR; diagonal TL-BR; CCW winding for upward normals
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex + 1, vertexIndex + 3, vertexIndex + 2);
        } else {
          // diagonal TR-BL
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 3, vertexIndex, vertexIndex + 3, vertexIndex + 2);
        }
        vertexIndex += 4;
      }
    }

    const mesh = new Mesh(`chunk_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.colors = colors;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    vertexData.normals = normals;
    vertexData.applyToMesh(mesh);
    mesh.convertToFlatShadedMesh();
    mesh.material = this.groundMat;
    mesh.hasVertexAlpha = false;
    mesh.isPickable = true;
    return mesh;
  }

  // --- Water mesh with per-chunk water levels ---

  private buildWaterMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    let vertexIndex = 0;
    let hasWater = false;

    const WATER_UV_SCALE = 5;

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        if (!this.shouldRenderWater(x, z)) continue;
        if (this.holeTiles.has(z * this.mapWidth + x)) continue; // no water in holes
        hasWater = true;

        const wY = this.getChunkWaterLevel(x, z) + 0.02;
        // CCW winding for RHS
        positions.push(x, wY, z, x + 1, wY, z, x + 1, wY, z + 1, x, wY, z + 1);
        // World-space UVs for seamless water tiling
        const u0 = x / WATER_UV_SCALE, u1 = (x + 1) / WATER_UV_SCALE;
        const v0 = z / WATER_UV_SCALE, v1 = (z + 1) / WATER_UV_SCALE;
        uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
        for (let i = 0; i < 4; i++) normals.push(0, 1, 0);
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3);
        vertexIndex += 4;
      }
    }

    if (!hasWater) return null;
    const mesh = new Mesh(`water_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.uvs = uvs;
    vertexData.applyToMesh(mesh);
    mesh.material = this.waterMat;
    mesh.isPickable = false;
    mesh.renderingGroupId = 1; // Render before texture planes (group 2) so planes appear on top
    return mesh;
  }

  // --- Paddy/surface water mesh (terrain-following shallow water) ---

  private buildPaddyWaterMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    let vertexIndex = 0;
    let hasWater = false;

    const WATER_UV_SCALE = 5;
    const LIFT = 0.05;

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tile = this.getTileRaw(x, z);
        if (!tile?.waterSurface) continue;
        hasWater = true;

        const tl = this.getVertexHeight(x, z) + LIFT;
        const tr = this.getVertexHeight(x + 1, z) + LIFT;
        const bl = this.getVertexHeight(x, z + 1) + LIFT;
        const br = this.getVertexHeight(x + 1, z + 1) + LIFT;

        positions.push(x, tl, z, x + 1, tr, z, x + 1, br, z + 1, x, bl, z + 1);
        const u0 = x / WATER_UV_SCALE, u1 = (x + 1) / WATER_UV_SCALE;
        const v0 = z / WATER_UV_SCALE, v1 = (z + 1) / WATER_UV_SCALE;
        uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
        for (let i = 0; i < 4; i++) normals.push(0, 1, 0);
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3);
        vertexIndex += 4;
      }
    }

    if (!hasWater) return null;
    const mesh = new Mesh(`paddywater_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.uvs = uvs;
    vertexData.applyToMesh(mesh);
    mesh.material = this.paddyWaterMat;
    mesh.isPickable = false;
    mesh.renderingGroupId = 1;
    return mesh;
  }

  // --- Cliff mesh (vertical faces between height differences) ---

  private buildCliffMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    let base = 0;
    let hasCliff = false;

    const cliffColor = (topY: number, bottomY: number): RGB => {
      const drop = Math.max(0, topY - bottomY);
      const shade = clamp(0.92 - drop * 0.12, 0.42, 0.92);
      return { r: 0.37 * shade, g: 0.29 * shade, b: 0.12 * shade };
    };

    const pushQuad = (a: number[], b: number[], c: number[], d: number[], color: RGB) => {
      positions.push(...a, ...b, ...c, ...d);
      for (let i = 0; i < 4; i++) colors.push(color.r, color.g, color.b, 1);
      indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
      base += 4;
    };

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const h = this.getTileCornerHeights(x, z);
        const wl = this.getChunkWaterLevel(x, z);
        const tileIdx = z * this.mapWidth + x;
        const isHole = this.holeTiles.has(tileIdx);

        // Hole-edge cliff faces: where a hole meets solid terrain, render rock walls
        if (isHole) {
          const floorH = this.floorHeights.get(tileIdx) ?? (Math.min(h.tl, h.tr, h.bl, h.br) - 2);
          const holeColor = cliffColor(Math.max(h.tl, h.tr, h.bl, h.br), floorH);
          if (x + 1 < this.mapWidth && !this.holeTiles.has(z * this.mapWidth + (x + 1))) { hasCliff = true; pushQuad([x + 1, h.tr, z], [x + 1, h.br, z + 1], [x + 1, floorH, z], [x + 1, floorH, z + 1], holeColor); }
          if (x - 1 >= 0 && !this.holeTiles.has(z * this.mapWidth + (x - 1))) { hasCliff = true; pushQuad([x, h.bl, z + 1], [x, h.tl, z], [x, floorH, z + 1], [x, floorH, z], holeColor); }
          if (z + 1 < this.mapHeight && !this.holeTiles.has((z + 1) * this.mapWidth + x)) { hasCliff = true; pushQuad([x + 1, h.br, z + 1], [x, h.bl, z + 1], [x + 1, floorH, z + 1], [x, floorH, z + 1], holeColor); }
          if (z - 1 >= 0 && !this.holeTiles.has((z - 1) * this.mapWidth + x)) { hasCliff = true; pushQuad([x, h.tl, z], [x + 1, h.tr, z], [x, floorH, z], [x + 1, floorH, z], holeColor); }
          continue; // don't render normal cliffs for hole tiles
        }

        // Check right neighbor (normal cliff logic)
        if (x + 1 < this.mapWidth && !this.holeTiles.has(z * this.mapWidth + (x + 1))) {
          const rh = this.getTileCornerHeights(x + 1, z);
          const topR = h.tr, topBR = h.br;
          const botR = rh.tl, botBR = rh.bl;
          if (Math.abs(topR - botR) > 0.01 || Math.abs(topBR - botBR) > 0.01) {
            const maxTop = Math.max(topR, botR);
            const maxBot = Math.max(topBR, botBR);
            if (maxTop > wl || maxBot > wl) {
              hasCliff = true;
              const color = cliffColor((topR + topBR) / 2, (botR + botBR) / 2);
              pushQuad(
                [x + 1, topR, z],
                [x + 1, topBR, z + 1],
                [x + 1, botR, z],
                [x + 1, botBR, z + 1],
                color,
              );
            }
          }
        }

        // Check bottom neighbor (normal cliff logic)
        if (z + 1 < this.mapHeight && !this.holeTiles.has((z + 1) * this.mapWidth + x)) {
          const bh = this.getTileCornerHeights(x, z + 1);
          const topB = h.bl, topBR = h.br;
          const botB = bh.tl, botBR = bh.tr;
          if (Math.abs(topB - botB) > 0.01 || Math.abs(topBR - botBR) > 0.01) {
            const maxTop = Math.max(topB, botB);
            const maxBot = Math.max(topBR, botBR);
            if (maxTop > wl || maxBot > wl) {
              hasCliff = true;
              const color = cliffColor((topB + topBR) / 2, (botB + botBR) / 2);
              pushQuad(
                [x, topB, z + 1],
                [x + 1, topBR, z + 1],
                [x, botB, z + 1],
                [x + 1, botBR, z + 1],
                color,
              );
            }
          }
        }
      }
    }

    if (!hasCliff) return null;
    const mesh = new Mesh(`cliff_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.colors = colors;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    vertexData.normals = normals;
    vertexData.applyToMesh(mesh);
    mesh.material = this.cliffMat;
    mesh.hasVertexAlpha = false;
    mesh.isPickable = false;
    return mesh;
  }

  /** Build ceiling mesh — cave ceiling at hole tiles, using ceilingHeights when set */
  private buildCeilingMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    let vertexIndex = 0;
    let hasCeiling = false;

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        if (!this.holeTiles.has(tileIdx)) continue;
        hasCeiling = true;

        const h = this.getTileCornerHeights(x, z);

        // Dark rock ceiling color with slight variation
        const shade = 0.25 + ((x * 7 + z * 13) % 10) * 0.01;
        const cr = 0.35 * shade, cg = 0.30 * shade, cb = 0.25 * shade;

        // Emit quad with reversed winding (normals point downward — visible from below)
        positions.push(
          x, h.tl, z,
          x + 1, h.tr, z,
          x, h.bl, z + 1,
          x + 1, h.br, z + 1,
        );
        colors.push(cr, cg, cb, 1, cr, cg, cb, 1, cr, cg, cb, 1, cr, cg, cb, 1);
        // Reversed winding: swap triangle order so face is visible from below
        indices.push(
          vertexIndex, vertexIndex + 2, vertexIndex + 1,
          vertexIndex + 1, vertexIndex + 2, vertexIndex + 3,
        );
        vertexIndex += 4;
      }
    }

    if (!hasCeiling) return null;

    const mesh = new Mesh(`ceiling_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.colors = colors;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    vertexData.normals = normals;
    vertexData.applyToMesh(mesh);
    if (!this.cliffMat) {
      this.cliffMat = new StandardMaterial('chunkCliffMat', this.scene);
      this.cliffMat.specularColor = new Color3(0, 0, 0);
      this.cliffMat.backFaceCulling = false;
    }
    mesh.material = this.cliffMat;
    mesh.hasVertexAlpha = false;
    mesh.isPickable = false;
    return mesh;
  }

  // --- Tile texture overlays (painted textures on individual tiles) ---
  // Batched: all overlays sharing the same texture within a chunk are merged into one mesh.

  private buildTextureOverlays(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh[] {
    const batches = new Map<string, { positions: number[]; uvs: number[]; indices: number[]; vertCount: number }>();
    const overlays: Mesh[] = [];

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        if (this.holeTiles.has(z * this.mapWidth + x)) continue;
        const tile = this.getTileRaw(x, z);
        if (!tile || (!tile.textureId && !tile.textureIdB)) continue;

        const h = this.getTileCornerHeights(x, z);
        const offset = 0.008;

        const appendOverlay = (textureId: string, rotation: number, scale: number, worldUV: boolean, ring: readonly UVPoint[]) => {
          if (ring.length < 3) return;
          if (!this.getOrLoadTexture(textureId)) return;

          let batch = batches.get(textureId);
          if (!batch) { batch = { positions: [], uvs: [], indices: [], vertCount: 0 }; batches.set(textureId, batch); }

          const base = batch.vertCount;
          const s = Math.max(0.1, scale);
          const r = ((rotation % 4) + 4) % 4;
          for (const p of ring) {
            const wx = x + p.u;
            const wz = z + p.v;
            const wy = bilerpCorners(h.tl, h.tr, h.bl, h.br, p.u, p.v) + offset;
            batch.positions.push(wx, wy, wz);
            if (worldUV) {
              batch.uvs.push(wx / s, wz / s);
            } else {
              const [tu, tv] = transformOverlayUV(p.u, p.v, r, s);
              batch.uvs.push(tu, tv);
            }
          }
          for (let i = 1; i < ring.length - 1; i++) {
            batch.indices.push(base, base + i, base + i + 1);
          }
          batch.vertCount += ring.length;
        };

        if (tile.textureHalfMode) {
          const { halfA, halfB } = computeCutPolygons(tile.textureCutAngle);
          if (tile.textureId) appendOverlay(tile.textureId, tile.textureRotation, tile.textureScale, tile.textureWorldUV, halfA);
          if (tile.textureIdB) appendOverlay(tile.textureIdB, tile.textureRotationB, tile.textureScaleB, false, halfB);
        } else if (tile.textureId) {
          appendOverlay(tile.textureId, tile.textureRotation, tile.textureScale, tile.textureWorldUV, fullTileRingForSplit(tile.split));
        }
      }
    }

    const chunkKey = `${chunkX},${chunkZ}`;
    for (const [textureId, batch] of batches) {
      if (batch.indices.length === 0) continue;
      const tex = this.getOrLoadTexture(textureId)!;

      const mesh = new Mesh(`texoverlay_${chunkKey}_${textureId}`, this.scene);
      const vd = new VertexData();
      vd.positions = batch.positions;
      vd.uvs = batch.uvs;
      vd.indices = batch.indices;
      const normals: number[] = [];
      VertexData.ComputeNormals(batch.positions, batch.indices, normals);
      vd.normals = normals;
      vd.applyToMesh(mesh);

      let mat = this.overlayMatCache.get(textureId);
      if (!mat) {
        mat = new StandardMaterial(`texoverlay_mat_${textureId}`, this.scene);
        mat.diffuseTexture = tex;
        mat.diffuseColor = new Color3(0.82, 0.82, 0.82);
        mat.emissiveTexture = tex;
        mat.emissiveColor = new Color3(0.45, 0.45, 0.45);
        mat.specularColor = new Color3(0, 0, 0);
        mat.useAlphaFromDiffuseTexture = true;
        mat.transparencyMode = 1;
        mat.backFaceCulling = false;
        this.overlayMatCache.set(textureId, mat);
      }
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.freezeWorldMatrix();
      mesh.doNotSyncBoundingInfo = true;
      this.texturePlaneMeshes.push(mesh);
      overlays.push(mesh);

      let oarr = this.textureOverlayMeshesByChunk.get(chunkKey);
      if (!oarr) { oarr = []; this.textureOverlayMeshesByChunk.set(chunkKey, oarr); }
      oarr.push(mesh);
    }
    return overlays;
  }

  // --- Wall, Roof, Floor, Stair mesh builders (same as before) ---

  private buildWallMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    if (!this.walls) return null;
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    let vertexIndex = 0;
    let hasWalls = false;
    const WALL_THICKNESS = 0.1;
    const cr = 0.35, cg = 0.30, cb = 0.30;

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const mask = this.getWallRaw(x, z);
        if (mask === 0) continue;
        hasWalls = true;
        const tileIdx = z * this.mapWidth + x;
        const wallH = this.wallHeights.get(tileIdx) ?? DEFAULT_WALL_HEIGHT;
        const floorH = this.floorHeights.get(tileIdx) ?? 0;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE;
        const z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;

        if (mask & WallEdge.N) {
          const yL = this.getVertexHeight(x, z) + floorH, yR = this.getVertexHeight(x + 1, z) + floorH;
          const ytL = yL + wallH, ytR = yR + wallH;
          positions.push(x0, yL, z0, x0, ytL, z0, x1, ytR, z0, x1, yR, z0);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, -1); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          const zb = z0 + WALL_THICKNESS;
          positions.push(x1, yR, zb, x1, ytR, zb, x0, ytL, zb, x0, yL, zb);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, 1); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, ytL, z0, x0, ytL, zb, x1, ytR, zb, x1, ytR, z0);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
        if (mask & WallEdge.S) {
          const yL = this.getVertexHeight(x, z + 1) + floorH, yR = this.getVertexHeight(x + 1, z + 1) + floorH;
          const ytL = yL + wallH, ytR = yR + wallH;
          const zf = z1 - WALL_THICKNESS;
          positions.push(x1, yR, z1, x1, ytR, z1, x0, ytL, z1, x0, yL, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, 1); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, yL, zf, x0, ytL, zf, x1, ytR, zf, x1, yR, zf);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, -1); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, ytL, zf, x0, ytL, z1, x1, ytR, z1, x1, ytR, zf);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
        if (mask & WallEdge.E) {
          const yT = this.getVertexHeight(x + 1, z) + floorH, yB = this.getVertexHeight(x + 1, z + 1) + floorH;
          const ytT = yT + wallH, ytB = yB + wallH;
          positions.push(x1, yT, z0, x1, ytT, z0, x1, ytB, z1, x1, yB, z1);
          for (let i = 0; i < 4; i++) { normals.push(1, 0, 0); colors.push(cr - 0.03, cg - 0.03, cb - 0.03, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          const xb = x1 - WALL_THICKNESS;
          positions.push(xb, yB, z1, xb, ytB, z1, xb, ytT, z0, xb, yT, z0);
          for (let i = 0; i < 4; i++) { normals.push(-1, 0, 0); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(xb, ytT, z0, x1, ytT, z0, x1, ytB, z1, xb, ytB, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
        if (mask & WallEdge.W) {
          const yT = this.getVertexHeight(x, z) + floorH, yB = this.getVertexHeight(x, z + 1) + floorH;
          const ytT = yT + wallH, ytB = yB + wallH;
          positions.push(x0, yB, z1, x0, ytB, z1, x0, ytT, z0, x0, yT, z0);
          for (let i = 0; i < 4; i++) { normals.push(-1, 0, 0); colors.push(cr - 0.03, cg - 0.03, cb - 0.03, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          const xb = x0 + WALL_THICKNESS;
          positions.push(xb, yT, z0, xb, ytT, z0, xb, ytB, z1, xb, yB, z1);
          for (let i = 0; i < 4; i++) { normals.push(1, 0, 0); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, ytT, z0, xb, ytT, z0, xb, ytB, z1, x0, ytB, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
      }
    }
    if (!hasWalls) return null;
    const mesh = new Mesh(`wall_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh);
    mesh.material = this.wallMat; mesh.hasVertexAlpha = false; mesh.isPickable = false;
    return mesh;
  }

  private buildRoofMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasRoof = false;
    const cr = 0.45, cg = 0.25, cb = 0.15;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const roof = this.roofData.get(tileIdx);
        if (!roof) continue;
        hasRoof = true;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const baseY = roof.height;
        if (roof.style === 'flat') {
          positions.push(x0, baseY, z0, x1, baseY, z0, x1, baseY, z1, x0, baseY, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, baseY, z1, x1, baseY, z1, x1, baseY, z0, x0, baseY, z0);
          for (let i = 0; i < 4; i++) { normals.push(0, -1, 0); colors.push(cr - 0.1, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        } else {
          const peak = baseY + (roof.peakHeight ?? 0.6);
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          if (roof.style === 'peaked_ew') {
            positions.push(x0, baseY, z0, x1, baseY, z0, x1, peak, mz, x0, peak, mz);
            for (let i = 0; i < 4; i++) { normals.push(0, 0.7, -0.7); colors.push(cr, cg, cb, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
            positions.push(x0, peak, mz, x1, peak, mz, x1, baseY, z1, x0, baseY, z1);
            for (let i = 0; i < 4; i++) { normals.push(0, 0.7, 0.7); colors.push(cr - 0.05, cg - 0.03, cb - 0.03, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          } else {
            positions.push(x0, baseY, z0, x0, baseY, z1, mx, peak, z1, mx, peak, z0);
            for (let i = 0; i < 4; i++) { normals.push(-0.7, 0.7, 0); colors.push(cr, cg, cb, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
            positions.push(mx, peak, z0, mx, peak, z1, x1, baseY, z1, x1, baseY, z0);
            for (let i = 0; i < 4; i++) { normals.push(0.7, 0.7, 0); colors.push(cr - 0.05, cg - 0.03, cb - 0.03, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          }
        }
      }
    }
    if (!hasRoof) return null;
    const mesh = new Mesh(`roof_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.roofMat; mesh.hasVertexAlpha = false; mesh.isPickable = false;
    return mesh;
  }

  private buildFloorMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasFloor = false;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const floorH = this.floorHeights.get(tileIdx);
        if (floorH === undefined) continue;
        if (this.texturePlaneFloorTiles.has(tileIdx)) continue; // texture plane IS the visual
        hasFloor = true;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const baseColor = { r: 0.45, g: 0.32, b: 0.18 }; // WOOD color
        positions.push(x0, floorH, z0, x1, floorH, z0, x1, floorH, z1, x0, floorH, z1);
        for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(baseColor.r, baseColor.g, baseColor.b, 1); }
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        positions.push(x0, floorH, z1, x1, floorH, z1, x1, floorH, z0, x0, floorH, z0);
        for (let i = 0; i < 4; i++) { normals.push(0, -1, 0); colors.push(baseColor.r - 0.1, baseColor.g - 0.1, baseColor.b - 0.1, 1); }
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        const edgeColor = { r: baseColor.r - 0.08, g: baseColor.g - 0.08, b: baseColor.b - 0.08 };
        const groundH = (this.getVertexHeight(x, z) + this.getVertexHeight(x + 1, z) + this.getVertexHeight(x, z + 1) + this.getVertexHeight(x + 1, z + 1)) / 4;
        const neighborFloor = (nx: number, nz: number) => this.floorHeights.get(nz * this.mapWidth + nx);
        if (neighborFloor(x, z - 1) !== floorH) { positions.push(x0, groundH, z0, x0, floorH, z0, x1, floorH, z0, x1, groundH, z0); for (let i = 0; i < 4; i++) { normals.push(0, 0, -1); colors.push(edgeColor.r, edgeColor.g, edgeColor.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
        if (neighborFloor(x, z + 1) !== floorH) { positions.push(x1, groundH, z1, x1, floorH, z1, x0, floorH, z1, x0, groundH, z1); for (let i = 0; i < 4; i++) { normals.push(0, 0, 1); colors.push(edgeColor.r, edgeColor.g, edgeColor.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
        if (neighborFloor(x + 1, z) !== floorH) { positions.push(x1, groundH, z0, x1, floorH, z0, x1, floorH, z1, x1, groundH, z1); for (let i = 0; i < 4; i++) { normals.push(1, 0, 0); colors.push(edgeColor.r, edgeColor.g, edgeColor.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
        if (neighborFloor(x - 1, z) !== floorH) { positions.push(x0, groundH, z1, x0, floorH, z1, x0, floorH, z0, x0, groundH, z0); for (let i = 0; i < 4; i++) { normals.push(-1, 0, 0); colors.push(edgeColor.r, edgeColor.g, edgeColor.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
      }
    }
    if (!hasFloor) return null;
    const mesh = new Mesh(`floor_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.floorMat; mesh.hasVertexAlpha = false; mesh.isPickable = true;
    return mesh;
  }

  private buildStairMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasStairs = false;
    const STEPS = 4; const cr = 0.50, cg = 0.48, cb = 0.45;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const stair = this.stairData.get(tileIdx);
        if (!stair) continue;
        hasStairs = true;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const stepH = (stair.topHeight - stair.baseHeight) / STEPS;
        for (let s = 0; s < STEPS; s++) {
          const t0 = s / STEPS, t1 = (s + 1) / STEPS;
          const y0 = stair.baseHeight + s * stepH, y1 = stair.baseHeight + (s + 1) * stepH;
          let sx0!: number, sx1!: number, sz0!: number, sz1!: number;
          let faceNormal!: [number, number, number];
          switch (stair.direction) {
            case 'N': sx0 = x0; sx1 = x1; sz0 = z1 - t1 * (z1 - z0); sz1 = z1 - t0 * (z1 - z0); faceNormal = [0, 0, 1]; break;
            case 'S': sx0 = x0; sx1 = x1; sz0 = z0 + t0 * (z1 - z0); sz1 = z0 + t1 * (z1 - z0); faceNormal = [0, 0, -1]; break;
            case 'E': sz0 = z0; sz1 = z1; sx0 = x0 + t0 * (x1 - x0); sx1 = x0 + t1 * (x1 - x0); faceNormal = [-1, 0, 0]; break;
            case 'W': sz0 = z0; sz1 = z1; sx0 = x1 - t1 * (x1 - x0); sx1 = x1 - t0 * (x1 - x0); faceNormal = [1, 0, 0]; break;
          }
          positions.push(sx0, y1, sz0, sx1, y1, sz0, sx1, y1, sz1, sx0, y1, sz1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          if (stair.direction === 'N' || stair.direction === 'S') {
            const fz = stair.direction === 'N' ? sz1 : sz0;
            positions.push(sx0, y0, fz, sx0, y1, fz, sx1, y1, fz, sx1, y0, fz);
          } else {
            const fx = stair.direction === 'W' ? sx1 : sx0;
            positions.push(fx, y0, sz0, fx, y1, sz0, fx, y1, sz1, fx, y0, sz1);
          }
          for (let i = 0; i < 4; i++) { normals.push(faceNormal[0], faceNormal[1], faceNormal[2]); colors.push(cr - 0.08, cg - 0.08, cb - 0.08, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
      }
    }
    if (!hasStairs) return null;
    const mesh = new Mesh(`stairs_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.stairMat; mesh.hasVertexAlpha = false; mesh.isPickable = true;
    return mesh;
  }

  // --- Upper floor layer mesh builders (identical logic as floor 0 but from layer data) ---

  private buildFloorLayerMeshes(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number, floorIdx: number, layer: FloorLayerClientData): FloorMeshSet | null {
    const wall = null; // collision-only, GLB models provide visuals
    const roof = this.buildRoofMeshForLayer(chunkX, chunkZ, startX, startZ, endX, endZ, floorIdx, layer);
    const floor = this.buildFloorMeshForLayer(chunkX, chunkZ, startX, startZ, endX, endZ, floorIdx, layer);
    const stairs = this.buildStairMeshForLayer(chunkX, chunkZ, startX, startZ, endX, endZ, floorIdx, layer);
    if (!wall && !roof && !floor && !stairs) return null;
    return { wall, roof, floor, stairs };
  }

  private buildWallMeshForLayer(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number, floorIdx: number, layer: FloorLayerClientData): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasWalls = false;
    const WALL_THICKNESS = 0.1; const cr = 0.35, cg = 0.30, cb = 0.30;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const mask = layer.walls.get(tileIdx) ?? 0;
        if (mask === 0) continue;
        hasWalls = true;
        const wallH = layer.wallHeights.get(tileIdx) ?? DEFAULT_WALL_HEIGHT;
        // Fall back to derived tile heights so walls on auto-derived upper
        // floors get the right base instead of defaulting to ground (y=0).
        const floorH = layer.floors.get(tileIdx) ?? layer.tiles.get(tileIdx) ?? 0;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const baseY = floorH;
        if (mask & WallEdge.N) {
          positions.push(x0, baseY, z0, x0, baseY + wallH, z0, x1, baseY + wallH, z0, x1, baseY, z0);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, -1); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          const zb = z0 + WALL_THICKNESS;
          positions.push(x1, baseY, zb, x1, baseY + wallH, zb, x0, baseY + wallH, zb, x0, baseY, zb);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, 1); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, baseY + wallH, z0, x0, baseY + wallH, zb, x1, baseY + wallH, zb, x1, baseY + wallH, z0);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
        if (mask & WallEdge.S) {
          const zf = z1 - WALL_THICKNESS;
          positions.push(x1, baseY, z1, x1, baseY + wallH, z1, x0, baseY + wallH, z1, x0, baseY, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, 1); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, baseY, zf, x0, baseY + wallH, zf, x1, baseY + wallH, zf, x1, baseY, zf);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, -1); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, baseY + wallH, zf, x0, baseY + wallH, z1, x1, baseY + wallH, z1, x1, baseY + wallH, zf);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
        if (mask & WallEdge.E) {
          positions.push(x1, baseY, z0, x1, baseY + wallH, z0, x1, baseY + wallH, z1, x1, baseY, z1);
          for (let i = 0; i < 4; i++) { normals.push(1, 0, 0); colors.push(cr - 0.03, cg - 0.03, cb - 0.03, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          const xb = x1 - WALL_THICKNESS;
          positions.push(xb, baseY, z1, xb, baseY + wallH, z1, xb, baseY + wallH, z0, xb, baseY, z0);
          for (let i = 0; i < 4; i++) { normals.push(-1, 0, 0); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(xb, baseY + wallH, z0, x1, baseY + wallH, z0, x1, baseY + wallH, z1, xb, baseY + wallH, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
        if (mask & WallEdge.W) {
          positions.push(x0, baseY, z1, x0, baseY + wallH, z1, x0, baseY + wallH, z0, x0, baseY, z0);
          for (let i = 0; i < 4; i++) { normals.push(-1, 0, 0); colors.push(cr - 0.03, cg - 0.03, cb - 0.03, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          const xb = x0 + WALL_THICKNESS;
          positions.push(xb, baseY, z0, xb, baseY + wallH, z0, xb, baseY + wallH, z1, xb, baseY, z1);
          for (let i = 0; i < 4; i++) { normals.push(1, 0, 0); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, baseY + wallH, z0, xb, baseY + wallH, z0, xb, baseY + wallH, z1, x0, baseY + wallH, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
      }
    }
    if (!hasWalls) return null;
    const mesh = new Mesh(`wall_f${floorIdx}_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.wallMat; mesh.hasVertexAlpha = false; mesh.isPickable = false;
    return mesh;
  }

  private buildFloorMeshForLayer(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number, floorIdx: number, layer: FloorLayerClientData): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasFloor = false;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const floorH = layer.floors.get(tileIdx);
        if (floorH === undefined) continue;
        hasFloor = true;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const bc = { r: 0.45, g: 0.32, b: 0.18 };
        positions.push(x0, floorH, z0, x1, floorH, z0, x1, floorH, z1, x0, floorH, z1);
        for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(bc.r, bc.g, bc.b, 1); }
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        positions.push(x0, floorH, z1, x1, floorH, z1, x1, floorH, z0, x0, floorH, z0);
        for (let i = 0; i < 4; i++) { normals.push(0, -1, 0); colors.push(bc.r - 0.1, bc.g - 0.1, bc.b - 0.1, 1); }
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        const ec = { r: bc.r - 0.08, g: bc.g - 0.08, b: bc.b - 0.08 };
        const edgeBottom = floorH - 0.5;
        const neighborFloor = (nx: number, nz: number) => layer.floors.get(nz * this.mapWidth + nx);
        if (neighborFloor(x, z - 1) !== floorH) { positions.push(x0, edgeBottom, z0, x0, floorH, z0, x1, floorH, z0, x1, edgeBottom, z0); for (let i = 0; i < 4; i++) { normals.push(0, 0, -1); colors.push(ec.r, ec.g, ec.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
        if (neighborFloor(x, z + 1) !== floorH) { positions.push(x1, edgeBottom, z1, x1, floorH, z1, x0, floorH, z1, x0, edgeBottom, z1); for (let i = 0; i < 4; i++) { normals.push(0, 0, 1); colors.push(ec.r, ec.g, ec.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
        if (neighborFloor(x + 1, z) !== floorH) { positions.push(x1, edgeBottom, z0, x1, floorH, z0, x1, floorH, z1, x1, edgeBottom, z1); for (let i = 0; i < 4; i++) { normals.push(1, 0, 0); colors.push(ec.r, ec.g, ec.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
        if (neighborFloor(x - 1, z) !== floorH) { positions.push(x0, edgeBottom, z1, x0, floorH, z1, x0, floorH, z0, x0, edgeBottom, z0); for (let i = 0; i < 4; i++) { normals.push(-1, 0, 0); colors.push(ec.r, ec.g, ec.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
      }
    }
    if (!hasFloor) return null;
    const mesh = new Mesh(`floor_f${floorIdx}_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.floorMat; mesh.hasVertexAlpha = false; mesh.isPickable = true;
    return mesh;
  }

  private buildStairMeshForLayer(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number, floorIdx: number, layer: FloorLayerClientData): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasStairs = false;
    const STEPS = 4; const cr = 0.50, cg = 0.48, cb = 0.45;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const stair = layer.stairs.get(tileIdx);
        if (!stair) continue;
        hasStairs = true;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const stepH = (stair.topHeight - stair.baseHeight) / STEPS;
        for (let s = 0; s < STEPS; s++) {
          const t0 = s / STEPS, t1 = (s + 1) / STEPS;
          const y0 = stair.baseHeight + s * stepH, y1 = stair.baseHeight + (s + 1) * stepH;
          let sx0!: number, sx1!: number, sz0!: number, sz1!: number;
          let faceNormal!: [number, number, number];
          switch (stair.direction) {
            case 'N': sx0 = x0; sx1 = x1; sz0 = z1 - t1 * (z1 - z0); sz1 = z1 - t0 * (z1 - z0); faceNormal = [0, 0, 1]; break;
            case 'S': sx0 = x0; sx1 = x1; sz0 = z0 + t0 * (z1 - z0); sz1 = z0 + t1 * (z1 - z0); faceNormal = [0, 0, -1]; break;
            case 'E': sz0 = z0; sz1 = z1; sx0 = x0 + t0 * (x1 - x0); sx1 = x0 + t1 * (x1 - x0); faceNormal = [-1, 0, 0]; break;
            case 'W': sz0 = z0; sz1 = z1; sx0 = x1 - t1 * (x1 - x0); sx1 = x1 - t0 * (x1 - x0); faceNormal = [1, 0, 0]; break;
          }
          positions.push(sx0, y1, sz0, sx1, y1, sz0, sx1, y1, sz1, sx0, y1, sz1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          if (stair.direction === 'N' || stair.direction === 'S') {
            const fz = stair.direction === 'N' ? sz1 : sz0;
            positions.push(sx0, y0, fz, sx0, y1, fz, sx1, y1, fz, sx1, y0, fz);
          } else {
            const fx = stair.direction === 'W' ? sx1 : sx0;
            positions.push(fx, y0, sz0, fx, y1, sz0, fx, y1, sz1, fx, y0, sz1);
          }
          for (let i = 0; i < 4; i++) { normals.push(faceNormal[0], faceNormal[1], faceNormal[2]); colors.push(cr - 0.08, cg - 0.08, cb - 0.08, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
      }
    }
    if (!hasStairs) return null;
    const mesh = new Mesh(`stairs_f${floorIdx}_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.stairMat; mesh.hasVertexAlpha = false; mesh.isPickable = true;
    return mesh;
  }

  private buildRoofMeshForLayer(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number, floorIdx: number, layer: FloorLayerClientData): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasRoof = false;
    const cr = 0.45, cg = 0.25, cb = 0.15;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const roof = layer.roofs.get(tileIdx);
        if (!roof) continue;
        hasRoof = true;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const baseY = roof.height;
        if (roof.style === 'flat') {
          positions.push(x0, baseY, z0, x1, baseY, z0, x1, baseY, z1, x0, baseY, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, baseY, z1, x1, baseY, z1, x1, baseY, z0, x0, baseY, z0);
          for (let i = 0; i < 4; i++) { normals.push(0, -1, 0); colors.push(cr - 0.1, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        } else {
          const peak = baseY + (roof.peakHeight ?? 0.6);
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          if (roof.style === 'peaked_ew') {
            positions.push(x0, baseY, z0, x1, baseY, z0, x1, peak, mz, x0, peak, mz);
            for (let i = 0; i < 4; i++) { normals.push(0, 0.7, -0.7); colors.push(cr, cg, cb, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
            positions.push(x0, peak, mz, x1, peak, mz, x1, baseY, z1, x0, baseY, z1);
            for (let i = 0; i < 4; i++) { normals.push(0, 0.7, 0.7); colors.push(cr - 0.05, cg - 0.03, cb - 0.03, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          } else {
            positions.push(x0, baseY, z0, x0, baseY, z1, mx, peak, z1, mx, peak, z0);
            for (let i = 0; i < 4; i++) { normals.push(-0.7, 0.7, 0); colors.push(cr, cg, cb, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
            positions.push(mx, peak, z0, mx, peak, z1, x1, baseY, z1, x1, baseY, z0);
            for (let i = 0; i < 4; i++) { normals.push(0.7, 0.7, 0); colors.push(cr - 0.05, cg - 0.03, cb - 0.03, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          }
        }
      }
    }
    if (!hasRoof) return null;
    const mesh = new Mesh(`roof_f${floorIdx}_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.roofMat; mesh.hasVertexAlpha = false; mesh.isPickable = false;
    return mesh;
  }

  private setFloorMeshSetVisibility(set: FloorMeshSet, floorIdx: number): void {
    const visible = floorIdx <= this.currentFloor;
    if (set.wall) set.wall.setEnabled(visible);
    if (set.roof) set.roof.setEnabled(floorIdx > this.currentFloor);
    if (set.floor) set.floor.setEnabled(visible);
    if (set.stairs) set.stairs.setEnabled(visible);
  }

  // --- Public query methods ---

  getVertexHeight(vx: number, vz: number): number {
    if (!this.heights) return 0;
    const vw = this.mapWidth + 1;
    if (vx < 0 || vx >= vw || vz < 0 || vz >= this.mapHeight + 1) return 0;
    return this.heights[vz * vw + vx];
  }

  getInterpolatedHeight(x: number, z: number): number {
    if (!this.heights) return 0;
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const fx = x - x0, fz = z - z0;
    const h00 = this.getVertexHeight(x0, z0);
    const h10 = this.getVertexHeight(x0 + 1, z0);
    const h01 = this.getVertexHeight(x0, z0 + 1);
    const h11 = this.getVertexHeight(x0 + 1, z0 + 1);
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  getEffectiveHeight(x: number, z: number, floor?: number, currentY?: number): number {
    const activeFloor = floor ?? this.currentFloor;
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return 0;
    const tileIdx = tz * this.mapWidth + tx;
    if (activeFloor === 0) {
      // Check placed stair ramps (proximity-based, works regardless of which tile you're on)
      for (const ramp of this.placedStairRamps) {
        // Project player position onto the ramp axis
        let along: number, across: number;
        if (ramp.direction === 'N' || ramp.direction === 'S') {
          across = Math.abs(x - ramp.cx);
          along = (ramp.direction === 'S') ? (z - ramp.cz) : (ramp.cz - z);
        } else {
          across = Math.abs(z - ramp.cz);
          along = (ramp.direction === 'W') ? (x - ramp.cx) : (ramp.cx - x);
        }
        // Check if player is within the ramp's width (±1 tile) and length
        if (across < 1.0 && along >= -ramp.halfLength && along <= ramp.halfLength) {
          const t = (along + ramp.halfLength) / (ramp.halfLength * 2); // 0 at base, 1 at top
          return ramp.baseY + t * (ramp.topY - ramp.baseY);
        }
      }

      const stair = this.stairData.get(tileIdx);
      if (stair) {
        const fx = x - tx, fz = z - tz;
        let t: number;
        switch (stair.direction) { case 'N': t = 1 - fz; break; case 'S': t = fz; break; case 'E': t = fx; break; case 'W': t = 1 - fx; break; }
        return stair.baseHeight + t * (stair.topHeight - stair.baseHeight);
      }
      const floorH = this.floorHeights.get(tileIdx);
      if (floorH !== undefined) return floorH;
      const elevH = this.elevatedFloorHeights.get(tileIdx);
      if (elevH !== undefined) {
        // Bridge tiles (over water/walls): always snap to bridge height
        if (this.bridgeFloorTiles.has(tileIdx)) return elevH;
        // Roof tiles (over walkable terrain): only snap if player is already near that height
        if (currentY !== undefined && currentY > elevH - 1.5) return elevH;
      }
      return this.getInterpolatedHeight(x, z);
    }
    const layer = this.floorLayerData.get(activeFloor);
    if (layer) {
      const stair = layer.stairs.get(tileIdx);
      if (stair) {
        const fx = x - tx, fz = z - tz;
        let t: number;
        switch (stair.direction) { case 'N': t = 1 - fz; break; case 'S': t = fz; break; case 'E': t = fx; break; case 'W': t = 1 - fx; break; }
        return stair.baseHeight + t * (stair.topHeight - stair.baseHeight);
      }
      const floorH = layer.floors.get(tileIdx) ?? layer.tiles.get(tileIdx);
      if (floorH !== undefined) return floorH;
    }
    return this.getInterpolatedHeight(x, z);
  }

  getFloorHeight(x: number, z: number): number | undefined {
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return undefined;
    return this.floorHeights.get(tz * this.mapWidth + tx);
  }

  getWalkableHeightsAt(x: number, z: number): number[] {
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return [];
    const tileIdx = tz * this.mapWidth + tx;
    const heights: number[] = [this.getInterpolatedHeight(x, z)];
    const add = (height: number | undefined | null): void => {
      if (height == null || !Number.isFinite(height)) return;
      if (!heights.some(existing => Math.abs(existing - height) < 0.1)) {
        heights.push(height);
      }
    };

    add(this.floorHeights.get(tileIdx));
    add(this.elevatedFloorHeights.get(tileIdx));
    const stair = this.stairData.get(tileIdx);
    if (stair) {
      add(stair.baseHeight);
      add(stair.topHeight);
      add(this.getEffectiveHeight(x, z, 0, Number.POSITIVE_INFINITY));
    }
    for (const [floor, layer] of this.floorLayerData) {
      add(layer.floors.get(tileIdx));
      add(layer.tiles.get(tileIdx));
      const layerStair = layer.stairs.get(tileIdx);
      if (layerStair) {
        add(layerStair.baseHeight);
        add(layerStair.topHeight);
        add(this.getEffectiveHeight(x, z, floor, Number.POSITIVE_INFINITY));
      }
    }

    return heights.sort((a, b) => a - b);
  }

  getStairAt(x: number, z: number): StairData | undefined {
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return undefined;
    return this.stairData.get(tz * this.mapWidth + tx);
  }

  private getTileTypeRaw(x: number, z: number): TileType {
    if (!this.tileTypes) return TileType.WALL;
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return TileType.WALL;
    return this.tileTypes[z * this.mapWidth + x] as TileType;
  }

  getTileType(x: number, z: number): TileType {
    return this.getTileTypeRaw(Math.floor(x), Math.floor(z));
  }

  isBlocked(x: number, z: number): boolean {
    const tx = Math.floor(x), tz = Math.floor(z);
    const idx = tz * this.mapWidth + tx;
    // Hole tiles are passable if they have a floor or stairs
    if (this.holeTiles.has(idx)) {
      return !this.floorHeights.has(idx) && !this.stairData.has(idx);
    }
    // Tiles with floors or texture plane bridges are always walkable (overrides water/wall tile type)
    if (this.floorHeights.has(idx) || this.texturePlaneFloorTiles.has(idx) || this.stairData.has(idx)) {
      return false;
    }
    if (this.decorBlockedTiles.has(idx)) return true;
    return BLOCKING_TILES.has(this.getTileType(x, z));
  }

  private getWallRaw(x: number, z: number): number {
    if (!this.walls) return 0;
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return 0;
    return this.walls[z * this.mapWidth + x];
  }

  /** Get wall bitmask at a tile (public accessor for door system) */
  getWallRawPublic(x: number, z: number): number {
    return this.getWallRaw(x, z);
  }

  /** Set wall bitmask at a tile (used by door toggle) */
  setWall(x: number, z: number, mask: number): void {
    if (!this.walls) return;
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return;
    this.walls[z * this.mapWidth + x] = mask;
  }

  /** Mark edge bits on (x,z) as open by a door — overrides wall-blocking on every floor. */
  setOpenDoorEdges(x: number, z: number, edgeMask: number, open: boolean): void {
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return;
    const idx = z * this.mapWidth + x;
    const cur = this.openDoorEdges.get(idx) ?? 0;
    const next = open ? (cur | edgeMask) : (cur & ~edgeMask);
    if (next === 0) this.openDoorEdges.delete(idx);
    else this.openDoorEdges.set(idx, next);
  }


  /** Clear neighbor wall edges pointing toward the given tile (used by door open) */
  clearNeighborWallsToward(tx: number, tz: number): void {
    if (!this.walls) return;
    // North neighbor's South edge
    if (tz > 0) this.walls[(tz - 1) * this.mapWidth + tx] &= ~WallEdge.S;
    // South neighbor's North edge
    if (tz < this.mapHeight - 1) this.walls[(tz + 1) * this.mapWidth + tx] &= ~WallEdge.N;
    // West neighbor's East edge
    if (tx > 0) this.walls[tz * this.mapWidth + (tx - 1)] &= ~WallEdge.E;
    // East neighbor's West edge
    if (tx < this.mapWidth - 1) this.walls[tz * this.mapWidth + (tx + 1)] &= ~WallEdge.W;
  }

  isBlockedOnFloor(x: number, z: number, floor: number): boolean {
    if (floor === 0) return this.isBlocked(x, z);
    const layer = this.floorLayerData.get(floor);
    if (!layer) return true;
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return true;
    const idx = tz * this.mapWidth + tx;
    return !layer.tiles.has(idx) && !layer.floors.has(idx) && !layer.stairs.has(idx);
  }

  getPlacedObjectCount(): number { return this.placedObjectNodes.length; }

  /** Check if a node is a root placed object node */
  isPlacedObjectNode(node: TransformNode): boolean {
    return this.placedObjectNodes.includes(node);
  }

  /** Check if any placed GLB object exists near a world position */
  hasPlacedObjectNear(x: number, z: number, radius: number): boolean {
    return this.findPlacedObjectNear(x, z, radius) !== null;
  }

  /** Find the nearest placed GLB object (that maps to a game object) near a world position.
   *  Uses spatial grid for O(1) lookup, checking the tile and its neighbours.
   *  If defId is provided, only matches nodes whose assetId maps to that object definition. */
  findPlacedObjectNear(x: number, z: number, radius: number, defId?: number): TransformNode | null {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    let best: TransformNode | null = null;
    let bestDist = radius;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const node = this.placedObjectGrid.get(`${tx + dx},${tz + dz}`);
        if (!node) continue;
        // Filter by defId if specified
        if (defId !== undefined) {
          const assetId = node.metadata?.assetId;
          if (!assetId || ASSET_TO_OBJECT_DEF[assetId] !== defId) continue;
        }
        const nx = node.position.x - x;
        const nz = node.position.z - z;
        const dist = Math.sqrt(nx * nx + nz * nz);
        if (dist < bestDist) {
          bestDist = dist;
          best = node;
        }
      }
    }
    return best;
  }

  isWallBlockedOnFloor(fromX: number, fromZ: number, toX: number, toZ: number, floor: number): boolean {
    if (floor === 0) return this.isWallBlocked(fromX, fromZ, toX, toZ);
    const layer = this.floorLayerData.get(floor);
    if (!layer) return false;
    const fx = Math.floor(fromX), fz = Math.floor(fromZ), tx = Math.floor(toX), tz = Math.floor(toZ);
    const dx = tx - fx, dz = tz - fz;
    const w = (x: number, z: number, edge: number) => {
      if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return false;
      const idx = z * this.mapWidth + x;
      // Open-door bypass on every floor — mirrors GameMap.wallBlocksOnFloorAt
      if (((this.openDoorEdges.get(idx) ?? 0) & edge) !== 0) return false;
      return ((layer.walls.get(idx) ?? 0) & edge) !== 0;
    };
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

  /** Check if a wall edge blocks at a given player height.
   *  Walls on floor 0 use the tile's elevation; walls on upper floor layers
   *  block regardless of player Y (editor-authored walls always count as solid). */
  private wallEdgeBlocksAtHeight(x: number, z: number, edge: number, playerY?: number): boolean {
    const idx = z * this.mapWidth + x;
    const wallH = this.wallHeights.get(idx) ?? DEFAULT_WALL_HEIGHT;
    const floorH = this.floorHeights.get(idx)
      ?? this.elevatedFloorHeights.get(idx)
      ?? this.getInterpolatedHeight(x + 0.5, z + 0.5);
    // Open-door bypass: only applies if the player is actually AT the door's
    // elevation. Without this, a basement player (Y=0) could walk through an
    // open door whose floor is at Y=2.7 and snap up onto the upper floor.
    const isOpenDoor = ((this.openDoorEdges.get(idx) ?? 0) & edge) !== 0;
    const atDoorLevel = playerY == null || (playerY >= floorH - 0.5 && playerY < floorH + wallH);
    if (isOpenDoor && atDoorLevel) return false;

    if ((this.getWallRaw(x, z) & edge) !== 0) {
      if (playerY == null) return true;
      if (playerY < floorH + wallH) return true;
    }
    for (const layer of this.floorLayerData.values()) {
      const bits = layer.walls.get(idx);
      if (bits != null && (bits & edge) !== 0) return true;
    }
    return false;
  }

  isWallBlocked(fromX: number, fromZ: number, toX: number, toZ: number, playerY?: number): boolean {
    const fx = Math.floor(fromX), fz = Math.floor(fromZ), tx = Math.floor(toX), tz = Math.floor(toZ);
    const dx = tx - fx, dz = tz - fz;
    const wb = (x: number, z: number, e: number) => this.wallEdgeBlocksAtHeight(x, z, e, playerY);
    // Cardinal: check source edge OR destination's opposite edge
    if (dx === 0 && dz === -1) return wb(fx, fz, WallEdge.N) || wb(tx, tz, WallEdge.S);
    if (dx === 1 && dz === 0) return wb(fx, fz, WallEdge.E) || wb(tx, tz, WallEdge.W);
    if (dx === 0 && dz === 1) return wb(fx, fz, WallEdge.S) || wb(tx, tz, WallEdge.N);
    if (dx === -1 && dz === 0) return wb(fx, fz, WallEdge.W) || wb(tx, tz, WallEdge.E);
    // Diagonal: check source, destination, AND both intermediate tiles
    if (dx === 1 && dz === -1) {
      if (wb(fx, fz, WallEdge.N) || wb(fx, fz, WallEdge.E)) return true;
      if (wb(tx, tz, WallEdge.S) || wb(tx, tz, WallEdge.W)) return true;
      if (wb(fx + 1, fz, WallEdge.N) || wb(fx, fz - 1, WallEdge.E)) return true;
      return false;
    }
    if (dx === -1 && dz === -1) {
      if (wb(fx, fz, WallEdge.N) || wb(fx, fz, WallEdge.W)) return true;
      if (wb(tx, tz, WallEdge.S) || wb(tx, tz, WallEdge.E)) return true;
      if (wb(fx - 1, fz, WallEdge.N) || wb(fx, fz - 1, WallEdge.W)) return true;
      return false;
    }
    if (dx === 1 && dz === 1) {
      if (wb(fx, fz, WallEdge.S) || wb(fx, fz, WallEdge.E)) return true;
      if (wb(tx, tz, WallEdge.N) || wb(tx, tz, WallEdge.W)) return true;
      if (wb(fx + 1, fz, WallEdge.S) || wb(fx, fz + 1, WallEdge.E)) return true;
      return false;
    }
    if (dx === -1 && dz === 1) {
      if (wb(fx, fz, WallEdge.S) || wb(fx, fz, WallEdge.W)) return true;
      if (wb(tx, tz, WallEdge.N) || wb(tx, tz, WallEdge.E)) return true;
      if (wb(fx - 1, fz, WallEdge.S) || wb(fx, fz + 1, WallEdge.W)) return true;
      return false;
    }
    return false;
  }

  getTilesForMinimap(centerX: number, centerZ: number, radius: number): MinimapTileSnapshot {
    const size = radius * 2;
    const startX = Math.floor(centerX) - radius;
    const startZ = Math.floor(centerZ) - radius;
    const tiles = new Uint8Array(size * size);
    const grounds = new Uint8Array(size * size);
    grounds.fill(GROUND_TYPE_NONE);
    const walls = new Uint8Array(size * size);
    const roofs = new Uint8Array(size * size);
    const textured = new Uint8Array(size * size);
    const voidTiles = new Uint8Array(size * size);
    const overrideColors = new Uint8Array(size * size * 3);
    const hasOverride = new Uint8Array(size * size);
    for (let dz = 0; dz < size; dz++) {
      for (let dx = 0; dx < size; dx++) {
        const idx = dz * size + dx;
        const tx = startX + dx;
        const tz = startZ + dz;
        if (this.activeChunks && !this.activeChunks.has(`${Math.floor(tx / 64)},${Math.floor(tz / 64)}`)) {
          voidTiles[idx] = 1;
          continue;
        }
        tiles[idx] = this.getTileTypeRaw(tx, tz);
        walls[idx] = this.getWallRaw(tx, tz);
        if (tx < 0 || tz < 0 || tx >= this.mapWidth || tz >= this.mapHeight) continue;

        const flatIdx = tz * this.mapWidth + tx;
        if (this.roofData.has(flatIdx)) roofs[idx] = 1;

        const kcTile = this.getTileRaw(tx, tz);
        if (kcTile) {
          const id = GROUND_TYPE_ID[kcTile.ground];
          if (id !== undefined) grounds[idx] = id;
        }
        // textureIdB layers over textureId on the ground mesh.
        const overlayId = kcTile?.textureIdB || kcTile?.textureId || null;
        let override: [number, number, number] | null = null;
        if (overlayId) {
          textured[idx] = 1;
          override = this.getTextureAvgColor(overlayId);
        }
        // Texture planes render above the ground mesh, so a covering flat
        // plane wins over a tile-level overlay.
        const planeEntry = this.tilePaintedEntries.get(flatIdx);
        if (planeEntry) override = planeEntry.color;

        if (override) {
          const cOff = idx * 3;
          overrideColors[cOff]     = override[0] | 0;
          overrideColors[cOff + 1] = override[1] | 0;
          overrideColors[cOff + 2] = override[2] | 0;
          hasOverride[idx] = 1;
        }
      }
    }
    return { tiles, grounds, walls, roofs, textured, voidTiles, overrideColors, hasOverride, size, startX, startZ };
  }

  isGroundMesh(meshName: string): boolean {
    return meshName.startsWith('chunk_') || meshName.startsWith('floor_') || meshName.startsWith('stairs_');
  }

  /** Check if a mesh is a walkable surface (ground chunks + bridge texture planes) */
  isWalkableMesh(meshName: string): boolean {
    return this.isGroundMesh(meshName) || meshName.startsWith('texplane_bridge_');
  }

  getGroundMeshes(): Mesh[] {
    const meshes: Mesh[] = [];
    for (const [, chunk] of this.chunks) meshes.push(chunk.ground);
    return meshes;
  }

  setCurrentFloor(floor: number): void {
    if (floor === this.currentFloor) return;
    this.currentFloor = floor;
    for (const [, chunk] of this.chunks) {
      if (chunk.roof) chunk.roof.setEnabled(floor === 0);
      for (const [floorIdx, meshSet] of chunk.upperFloors) this.setFloorMeshSetVisibility(meshSet, floorIdx);
    }
  }

  getCurrentFloor(): number { return this.currentFloor; }

  /** Call each frame to animate water texture */
  updateAnimations(): void {
    if (this.waterTexture) {
      const t = (performance.now() / 1000) - this.waterStartTime;
      this.waterTexture.uOffset = t * 0.04;
      this.waterTexture.vOffset = t * 0.02;
    }
  }

  /** Detect horizontal texture planes and register as walkable bridges/floors */
  private registerTexturePlaneFloors(): void {
    if (!this.mapData) return;
    const planes = this.mapData.texturePlanes || [];
    const derived = deriveElevatedFloorTiles(
      planes,
      this.mapWidth,
      this.mapHeight,
      (wx, wz) => this.getInterpolatedHeight(wx, wz),
      (idx) => !!(this.tileTypes && BLOCKING_TILES.has(this.tileTypes[idx] as TileType)),
    );
    let count = 0;
    for (const [idx, entry] of derived) {
      if (entry.wasBlocking && this.tileTypes) {
        this.tileTypes[idx] = TileType.STONE;
      }
      this.elevatedFloorHeights.set(idx, entry.y);
      if (entry.isBridge) this.bridgeFloorTiles.add(idx);
      this.texturePlaneFloorTiles.add(idx);
      if (!entry.allContributorsNoRoof) this.nonNoRoofElevatedTiles.add(idx);
      else this.noRoofPlaneTiles.add(idx);
      count++;
    }
    if (count > 0) {
      console.log(`[ChunkManager] Registered ${count} tiles as walkable from texture plane bridges`);
    }
  }

  /** Register texture plane bridges only for tiles within a specific region */
  private registerTexturePlaneFloorsInRegion(rx0: number, rz0: number, rx1: number, rz1: number): void {
    if (!this.mapData) return;
    const planes = this.mapData.texturePlanes || [];
    for (const plane of planes) {
      const rx = plane.rotation?.x ?? 0;
      if (Math.abs(Math.abs(rx) - Math.PI / 2) >= 0.1) continue;
      const px = plane.position?.x ?? 0;
      const py = plane.position?.y ?? 0;
      const pz = plane.position?.z ?? 0;
      const sx = plane.scale?.x ?? 1;
      const sy = plane.scale?.y ?? 1;
      const ry = plane.rotation?.y ?? 0;
      const hw = (plane.width ?? 1) * sx / 2;
      const hd = (plane.height ?? 1) * sy / 2;
      const cosR = Math.cos(ry), sinR = Math.sin(ry);
      const corners = [
        { x: px + (-hw) * cosR - (-hd) * sinR, z: pz + (-hw) * sinR + (-hd) * cosR },
        { x: px + (hw) * cosR - (-hd) * sinR, z: pz + (hw) * sinR + (-hd) * cosR },
        { x: px + (hw) * cosR - (hd) * sinR, z: pz + (hw) * sinR + (hd) * cosR },
        { x: px + (-hw) * cosR - (hd) * sinR, z: pz + (-hw) * sinR + (hd) * cosR },
      ];
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const c of corners) {
        if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
        if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z;
      }
      const tx0 = Math.max(rx0, Math.floor(minX));
      const tx1 = Math.min(rx1 - 1, Math.floor(maxX));
      const tz0 = Math.max(rz0, Math.floor(minZ));
      const tz1 = Math.min(rz1 - 1, Math.floor(maxZ));
      if (tx0 > tx1 || tz0 > tz1) continue; // plane doesn't overlap this region
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          // Require tile CENTER to be inside the rotated plane footprint —
          // matches deriveElevatedFloorTiles. Without this, a plane that
          // barely clips a tile's edge would still register it as
          // elevated/bridge and snap the player up by 2.7 units.
          const tcx = tx + 0.5, tcz = tz + 0.5;
          const lx = (tcx - px) * cosR + (tcz - pz) * sinR;
          const lz = -(tcx - px) * sinR + (tcz - pz) * cosR;
          if (Math.abs(lx) > hw || Math.abs(lz) > hd) continue;

          const idx = tz * this.mapWidth + tx;
          const wasBlocking = this.tileTypes && BLOCKING_TILES.has(this.tileTypes[idx] as TileType);
          if (wasBlocking) {
            this.tileTypes![idx] = TileType.STONE;
          }
          const terrainH = this.getInterpolatedHeight(tcx, tcz);
          if (py > terrainH) {
            const existing = this.elevatedFloorHeights.get(idx);
            if (existing === undefined || py < existing) {
              this.elevatedFloorHeights.set(idx, py);
            }
            if (wasBlocking || py < terrainH + 2.0) {
              this.bridgeFloorTiles.add(idx);
            }
            this.texturePlaneFloorTiles.add(idx);
            // noRoof flag is sticky-negative: once any non-noRoof plane
            // touches the tile it stays in nonNoRoofElevatedTiles forever.
            // Mirror set noRoofPlaneTiles is sticky-positive: a tile is in
            // it only while ALL plane contributors are noRoof. A non-noRoof
            // plane revokes membership; a later noRoof plane can't re-add.
            if (!plane.noRoof) {
              this.nonNoRoofElevatedTiles.add(idx);
              this.noRoofPlaneTiles.delete(idx);
            } else if (!this.nonNoRoofElevatedTiles.has(idx)) {
              this.noRoofPlaneTiles.add(idx);
            }
          }
        }
      }
    }
  }

  // --- Placed objects and texture planes ---

  private async loadAssetRegistry(): Promise<void> {
    try {
      const res = await fetch('/assets/assets.json');
      const data = await res.json();
      for (const asset of data.assets || []) {
        this.assetRegistry.set(asset.id, { path: asset.path });
      }
      console.log(`[ChunkManager] Loaded ${this.assetRegistry.size} asset definitions`);
    } catch (e) {
      console.warn('[ChunkManager] Failed to load asset registry:', e);
    }
    try {
      const res = await fetch('/assets/textures/textures.json');
      const data = await res.json();
      for (const tex of data) {
        this.textureRegistry.set(tex.id, { path: tex.path });
      }
      console.log(`[ChunkManager] Loaded ${this.textureRegistry.size} texture definitions`);
    } catch (e) {
      console.warn('[ChunkManager] Failed to load texture registry:', e);
    }
  }

  private async loadGLBModel(assetId: string): Promise<TransformNode | null> {
    if (this.loadedModelCache.has(assetId)) {
      return this.loadedModelCache.get(assetId)!;
    }
    const assetDef = this.assetRegistry.get(assetId);
    if (!assetDef) {
      console.warn(`[ChunkManager] Unknown asset: ${assetId}`);
      this.loadedModelCache.set(assetId, null);
      return null;
    }
    try {
      const path = assetDef.path;
      const encodedPath = path.split('/').map(s => encodeURIComponent(s)).join('/');
      const lastSlash = encodedPath.lastIndexOf('/');
      const dir = encodedPath.substring(0, lastSlash + 1);
      const file = encodedPath.substring(lastSlash + 1);
      const result = await SceneLoader.ImportMeshAsync('', dir, file, this.scene);

      // Apply nearest-neighbor filtering to all GLB textures
      for (const mesh of result.meshes) {
        const mat = mesh.material;
        if (mat && 'diffuseTexture' in mat && (mat as any).diffuseTexture) {
          (mat as any).diffuseTexture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
        }
        if (mat && 'albedoTexture' in mat && (mat as any).albedoTexture) {
          (mat as any).albedoTexture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
        }
      }

      // KC editor's buildCenteredPivotGroup: model bottom-center → origin.
      const root = result.meshes[0];
      const bb = worldAABB(result.meshes);
      const centerX = (bb.minX + bb.maxX) / 2;
      const centerZ = (bb.minZ + bb.maxZ) / 2;

      const template = new TransformNode(`template_${assetId}`, this.scene);
      root.parent = template;
      root.position.x -= centerX;
      root.position.y -= bb.minY;
      root.position.z -= centerZ;

      // Auto-scale rock models to fit within 1 tile
      if (assetDef?.path?.toLowerCase().includes('rock')) {
        const modelWidth = bb.maxX - bb.minX;
        const modelDepth = bb.maxZ - bb.minZ;
        const maxDim = Math.max(modelWidth, modelDepth);
        if (maxDim > 1.0) {
          const fit = 0.95 / maxDim; // 0.95 to keep a small margin
          template.scaling.set(fit, fit, fit);
        }
      }

      template.setEnabled(false);
      this.loadedModelCache.set(assetId, template);

      // Store animation groups from the GLB for cloning later
      if (result.animationGroups && result.animationGroups.length > 0) {
        // Stop template animations (template is disabled)
        for (const ag of result.animationGroups) ag.stop();
        this.modelAnimationGroups.set(assetId, result.animationGroups);
      }

      return template;
    } catch (e) {
      console.warn(`[ChunkManager] Failed to load model ${assetId}:`, e);
      this.loadedModelCache.set(assetId, null);
      return null;
    }
  }

  private getTemplateBaseMatrices(assetId: string, template: TransformNode): { sourceMesh: Mesh; baseMatrix: Matrix }[] {
    if (this.templateBaseMatrices.has(assetId)) return this.templateBaseMatrices.get(assetId)!;
    // Force full hierarchy recompute — disabled nodes have stale matrices
    const allNodes: TransformNode[] = [template];
    template.getChildTransformNodes(false).forEach(n => allNodes.push(n));
    for (const n of allNodes) n.computeWorldMatrix(true);

    const templateWorld = template.getWorldMatrix();
    const templateInv = new Matrix();
    templateWorld.invertToRef(templateInv);
    const entries: { sourceMesh: Mesh; baseMatrix: Matrix }[] = [];
    for (const child of template.getChildMeshes(false)) {
      if (!(child instanceof Mesh) || child.getTotalVertices() === 0) continue;
      entries.push({ sourceMesh: child, baseMatrix: child.getWorldMatrix().multiply(templateInv) });
    }
    this.templateBaseMatrices.set(assetId, entries);
    return entries;
  }

  private canThinInstance(obj: PlacedObject, groundY: number): boolean {
    if (obj.assetId in ASSET_TO_OBJECT_DEF) return false;
    if (obj.assetId in STAIR_ASSET_CONFIG) return false;
    if (this.isRoofLikeAsset(obj.assetId)) return false;
    if (this.modelAnimationGroups.has(obj.assetId)) return false;
    if (obj.position.y > groundY + 2.0) return false;
    // Doors must be unique pickable nodes — clicking one looks up its
    // metadata.objectEntityId to send PLAYER_INTERACT_OBJECT. Thin-instanced
    // source meshes share one mesh per asset across all instances, so per-
    // instance metadata can't be set and clicks fall through to ground move.
    // Names like 'castleTruedoor' / 'basicTruedoor' have animations so they
    // already opt out via modelAnimationGroups, but static doors like
    // 'stone wall door2' or 'stone_wall_door' don't — catch them by name.
    if (obj.assetId.toLowerCase().includes('door')) return false;
    return true;
  }

  /** Index placed objects by chunk key — no mesh instantiation, just data bucketing */
  private indexPlacedObjectsByChunk(objects: PlacedObject[]): void {
    this.placedObjectsByChunk.clear();
    for (const obj of objects) {
      const cx = Math.floor(obj.position.x / CHUNK_SIZE);
      const cz = Math.floor(obj.position.z / CHUNK_SIZE);
      const key = `${cx},${cz}`;
      let bucket = this.placedObjectsByChunk.get(key);
      if (!bucket) {
        bucket = [];
        this.placedObjectsByChunk.set(key, bucket);
      }
      bucket.push(obj);
    }
  }

  private queueChunkPlacedObjects(chunkKey: string): void {
    if (this.chunkPlacedNodes.has(chunkKey) || this.loadingObjectChunks.has(chunkKey) || this.queuedObjectChunks.has(chunkKey)) return;
    // Skip the network round-trip if we already know this chunk has no objects.
    if (this.chunksKnownEmpty.has(chunkKey)) {
      this.chunkPlacedNodes.set(chunkKey, []);
      return;
    }
    this.loadingObjectChunks.add(chunkKey);
    this.queuedObjectChunks.add(chunkKey);
    this.objectChunkQueue.push(chunkKey);
    this.scheduleObjectChunkQueue();
  }

  private scheduleObjectChunkQueue(): void {
    if (this.objectChunkQueueScheduled) return;
    this.objectChunkQueueScheduled = true;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16);
    schedule(() => {
      this.processObjectChunkQueue().catch(e => {
        console.warn('[ChunkManager] Failed while processing object chunk queue:', e);
      });
    });
  }

  private async processObjectChunkQueue(): Promise<void> {
    this.objectChunkQueueScheduled = false;
    const start = performance.now();

    while (this.objectChunkQueue.length > 0) {
      const chunkKey = this.objectChunkQueue.shift()!;
      this.queuedObjectChunks.delete(chunkKey);

      if (this.keepGameChunks.size > 0 && !this.keepGameChunks.has(chunkKey)) {
        this.loadingObjectChunks.delete(chunkKey);
        continue;
      }

      if (!this.chunkPlacedNodes.has(chunkKey)) {
        await this.loadChunkPlacedObjects(chunkKey);
      } else {
        this.loadingObjectChunks.delete(chunkKey);
      }

      if (performance.now() - start >= this.objectChunkFrameBudgetMs) break;
    }

    if (this.objectChunkQueue.length > 0) this.scheduleObjectChunkQueue();
  }

  /** Load and instantiate placed objects for a single chunk */
  private async loadChunkPlacedObjects(chunkKey: string): Promise<void> {
    if (this.chunkPlacedNodes.has(chunkKey)) {
      this.loadingObjectChunks.delete(chunkKey);
      return;
    }
    // Skip the network round-trip if we already know this chunk has no objects.
    if (this.chunksKnownEmpty.has(chunkKey)) {
      this.chunkPlacedNodes.set(chunkKey, []);
      this.loadingObjectChunks.delete(chunkKey);
      return;
    }
    try {
    let objects = this.placedObjectsByChunk.get(chunkKey);
    // If no pre-indexed objects, try fetching per-chunk file from server
    if (!objects || objects.length === 0) {
      try {
        const [cx, cz] = chunkKey.split(',').map(Number);
        const res = await fetch(`/maps/${this.mapId}/objects/chunk_${cx}_${cz}.json`);
        if (res.ok) {
          const fetched: PlacedObject[] = await res.json();
          if (fetched.length > 0) {
            this.placedObjectsByChunk.set(chunkKey, fetched);
            objects = fetched;
          } else {
            // Server returned an empty array — remember so we don't re-fetch.
            this.chunksKnownEmpty.add(chunkKey);
          }
        } else if (res.status === 404) {
          // No objects file exists for this chunk. Cache that fact.
          this.chunksKnownEmpty.add(chunkKey);
        }
      } catch { /* no per-chunk objects file */ }
    }
    if (!objects || objects.length === 0) {
      this.chunkPlacedNodes.set(chunkKey, []);
      this.loadingObjectChunks.delete(chunkKey);
      return;
    }

    // Stamps tile blockers for decor that stays thin-instanced (no WorldObject).
    const decorKeys: number[] = [];
    for (const obj of objects) {
      if (!BLOCKING_DECOR_ASSETS.has(obj.assetId)) continue;
      const tx = Math.floor(obj.position.x);
      const tz = Math.floor(obj.position.z);
      const key = tz * this.mapWidth + tx;
      if (this.decorBlockedTiles.has(key)) continue;
      this.decorBlockedTiles.add(key);
      decorKeys.push(key);
    }
    if (decorKeys.length > 0) this.decorBlockedTilesByChunk.set(chunkKey, decorKeys);

    // Split into thin-instanceable (static decorations) vs regular (interactable/animated/roofs/stairs).
    // Need to load templates first so canThinInstance can check for animations.
    const templatePromises = new Map<string, Promise<TransformNode | null>>();
    for (const obj of objects) {
      if (!templatePromises.has(obj.assetId)) {
        templatePromises.set(obj.assetId, this.loadGLBModel(obj.assetId));
      }
    }
    await Promise.all(templatePromises.values());

    let groundY = Infinity;
    for (const obj of objects) { if (obj.position.y < groundY) groundY = obj.position.y; }
    if (!isFinite(groundY)) groundY = 0;

    const regularObjects: PlacedObject[] = [];
    const thinGroups = new Map<string, PlacedObject[]>();
    for (const obj of objects) {
      if (!this.loadedModelCache.get(obj.assetId)) continue;
      if (this.canThinInstance(obj, groundY)) {
        let group = thinGroups.get(obj.assetId);
        if (!group) { group = []; thinGroups.set(obj.assetId, group); }
        group.push(obj);
      } else {
        regularObjects.push(obj);
      }
    }

    // --- Thin instances: one source mesh per sub-mesh per asset per chunk ---
    const thinSources: Mesh[] = [];
    const _tmpMatrix = Matrix.Identity();
    const _placementMatrix = Matrix.Identity();

    for (const [assetId, placements] of thinGroups) {
      const template = this.loadedModelCache.get(assetId)!;
      const baseEntries = this.getTemplateBaseMatrices(assetId, template);
      if (baseEntries.length === 0) continue;

      const assetDef = this.assetRegistry.get(assetId);
      const treeBoost = assetDef?.path?.toLowerCase().includes('tree') ? 1.15 : 1.0;

      for (const { sourceMesh, baseMatrix } of baseEntries) {
        const src = sourceMesh.clone(`thin_${chunkKey}_${assetId}_${sourceMesh.name}`, null)!;
        src.parent = null;
        src.position.set(0, 0, 0);
        src.rotation.set(0, 0, 0);
        src.rotationQuaternion = null;
        src.scaling.set(1, 1, 1);
        src.setEnabled(true);
        if (src instanceof Mesh) src.makeGeometryUnique();
        const mat = src.material;
        if (mat) {
          if ((mat as any).transparencyMode !== undefined) (mat as any).transparencyMode = 1;
          (mat as any).alpha = 1;
          mat.backFaceCulling = false;
          (mat as any).freeze?.();
        }
        src.isPickable = false;

        for (const obj of placements) {
          const { x: orx, y: ory, z: orz } = obj.rotation;
          const quat = Quaternion.RotationAxis(Vector3.Right(), orx)
            .multiply(Quaternion.RotationAxis(Vector3.Up(), ory))
            .multiply(Quaternion.RotationAxis(Vector3.Forward(), orz));
          const sx = obj.scale.x * treeBoost, sy = obj.scale.y * treeBoost, sz = obj.scale.z * treeBoost;
          Matrix.ComposeToRef(
            TmpVectors.Vector3[0].set(sx, sy, sz),
            quat,
            TmpVectors.Vector3[1].set(obj.position.x, obj.position.y, obj.position.z),
            _placementMatrix
          );
          baseMatrix.multiplyToRef(_placementMatrix, _tmpMatrix);
          src.thinInstanceAdd(_tmpMatrix);
        }
        // Compute AABB from instance translations + generous padding
        const pad = 5;
        let bMinX = Infinity, bMinY = Infinity, bMinZ = Infinity;
        let bMaxX = -Infinity, bMaxY = -Infinity, bMaxZ = -Infinity;
        const matBuf = (src as any)._thinInstanceDataStorage?.matrixData;
        if (matBuf) {
          for (let i = 0; i < src.thinInstanceCount; i++) {
            const tx = matBuf[i * 16 + 12], ty = matBuf[i * 16 + 13], tz = matBuf[i * 16 + 14];
            if (tx - pad < bMinX) bMinX = tx - pad;
            if (ty - pad < bMinY) bMinY = ty - pad;
            if (tz - pad < bMinZ) bMinZ = tz - pad;
            if (tx + pad > bMaxX) bMaxX = tx + pad;
            if (ty + pad > bMaxY) bMaxY = ty + pad;
            if (tz + pad > bMaxZ) bMaxZ = tz + pad;
          }
          src.setBoundingInfo(new BoundingInfo(
            new Vector3(bMinX, bMinY, bMinZ),
            new Vector3(bMaxX, bMaxY, bMaxZ)
          ));
        }
        src.doNotSyncBoundingInfo = true;
        thinSources.push(src);
      }
    }
    this.chunkThinInstSources.set(chunkKey, thinSources);

    // --- Regular instances: interactable, animated, roofs, stairs ---
    const nodes: TransformNode[] = [];
    const anims: AnimationGroup[] = [];
    let idx = 0;
    for (const obj of regularObjects) {
      const template = this.loadedModelCache.get(obj.assetId)!;

      const instance = template.instantiateHierarchy(null, undefined, (source, cloned) => {
        cloned.name = `placed_${chunkKey}_${idx}_${source.name}`;
      });
      if (!instance) continue;
      instance.setEnabled(true);
      for (const child of instance.getChildMeshes()) {
        child.setEnabled(true);
        const mat = child.material as any;
        if (mat) {
          if (mat.transparencyMode !== undefined) mat.transparencyMode = 1;
          mat.alpha = 1;
        }
      }
      const root = instance;

      const templateAnims = this.modelAnimationGroups.get(obj.assetId);
      if (templateAnims) {
        const clonedNodes = new Map<string, any>();
        instance.getChildMeshes(false).forEach(m => clonedNodes.set(m.name, m));
        instance.getChildTransformNodes(false).forEach(n => clonedNodes.set(n.name, n));
        clonedNodes.set(instance.name, instance);

        for (const srcGroup of templateAnims) {
          const clonedGroup = new AnimationGroup(`${srcGroup.name}_${chunkKey}_${idx}`, this.scene);
          for (const ta of srcGroup.targetedAnimations) {
            const srcName = ta.target?.name as string;
            const clonedTarget = srcName
              ? clonedNodes.get(`placed_${chunkKey}_${idx}_${srcName}`)
              : null;
            if (clonedTarget) {
              clonedGroup.addTargetedAnimation(ta.animation, clonedTarget);
            }
          }
          if (clonedGroup.targetedAnimations.length > 0) {
            clonedGroup.play(true);
            anims.push(clonedGroup);
            this.activeAnimationGroups.push(clonedGroup);
          } else {
            clonedGroup.dispose();
          }
        }
      }

      root.position = new Vector3(obj.position.x, obj.position.y, obj.position.z);
      const { x: orx, y: ory, z: orz } = obj.rotation;
      root.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), orx)
        .multiply(Quaternion.RotationAxis(new Vector3(0, 1, 0), ory))
        .multiply(Quaternion.RotationAxis(new Vector3(0, 0, 1), orz));
      const assetDef = this.assetRegistry.get(obj.assetId);
      const treeBoost = assetDef?.path?.toLowerCase().includes('tree') ? 1.15 : 1.0;
      root.scaling = new Vector3(obj.scale.x * treeBoost, obj.scale.y * treeBoost, obj.scale.z * treeBoost);
      root.metadata = { ...root.metadata, assetId: obj.assetId };

      const hasAnims = !!templateAnims && templateAnims.length > 0;
      const isDoorAsset = obj.assetId === 'castleTruedoor' || obj.assetId === 'basicTruedoor';
      if (!hasAnims && !isDoorAsset) {
        root.freezeWorldMatrix();
        for (const child of root.getChildMeshes()) {
          child.freezeWorldMatrix();
          child.doNotSyncBoundingInfo = true;
          if (child.material) (child.material as any).freeze?.();
        }
      }

      nodes.push(root);
      this.placedObjectNodes.push(root);

      if (obj.assetId in ASSET_TO_OBJECT_DEF) {
        const gridKey = `${Math.floor(obj.position.x)},${Math.floor(obj.position.z)}`;
        this.placedObjectGrid.set(gridKey, root);
      }

      if (this.isRoofLikeAsset(obj.assetId)) {
        // Stamp every tile whose CENTER is inside the slab's AABB. Pure
        // Math.floor(bMin)..Math.floor(bMax) over-stamps adjacent tiles
        // whenever the bbox clips into a tile by <1 unit — kcmap slabs at
        // sub-integer positions routinely bleed 0.01 unit into a neighbor
        // tile and used to fire indoor mode there via Signal B.
        // (The texture-plane stamp uses the same center-inside-footprint
        // gate below.)
        root.computeWorldMatrix(true);
        const { min: bMin, max: bMax } = root.getHierarchyBoundingVectors(true);
        const tx0 = Math.floor(bMin.x), tx1 = Math.floor(bMax.x);
        const tz0 = Math.floor(bMin.z), tz1 = Math.floor(bMax.z);
        const roofFloor = this.assignRoofFloor(obj.position.x, obj.position.z, obj.position.y);
        const stampedKeys: string[] = [];
        for (let tz = tz0; tz <= tz1; tz++) {
          for (let tx = tx0; tx <= tx1; tx++) {
            if (tx + 0.5 < bMin.x || tx + 0.5 > bMax.x) continue;
            if (tz + 0.5 < bMin.z || tz + 0.5 > bMax.z) continue;
            const rk = `${tx},${tz}`;
            let arr = this.roofObjectGrid.get(rk);
            if (!arr) { arr = []; this.roofObjectGrid.set(rk, arr); }
            arr.push({ node: root, floor: roofFloor, y: obj.position.y });
            stampedKeys.push(rk);
          }
        }
        // Cached for O(footprint) cleanup in disposeChunkPlacedObjects.
        root.metadata = { ...root.metadata, roofGridKeys: stampedKeys };
      }

      if (STAIR_ASSET_CONFIG[obj.assetId]) {
        const stairCfg = STAIR_ASSET_CONFIG[obj.assetId];
        const rotY = obj.rotation?.y ?? 0;
        const dir = rotateStairDirection(stairCfg.baseDirection, rotY);
        const totalGain = stairCfg.heightGain * Math.abs(obj.scale?.y ?? 1);
        const halfLen = stairCfg.tilesLong / 2;
        this.placedStairRamps.push({
          cx: obj.position.x, cz: obj.position.z,
          baseY: obj.position.y, topY: obj.position.y + totalGain,
          direction: dir, halfLength: halfLen,
        });
      }

      idx++;
    }

    this.chunkPlacedNodes.set(chunkKey, nodes);
    this.chunkAnimGroups.set(chunkKey, anims);

    if (objects && objects.length > 0) {
      this.addShadowsForObjects(objects);
      this.rebuildGroundChunksForObjects(objects);
    }

    this.onChunkObjectsLoaded?.(chunkKey);
    } catch (e) {
      console.warn(`[ChunkManager] Failed to instantiate objects for chunk ${chunkKey}:`, e);
      this.chunkPlacedNodes.set(chunkKey, []);
      this.chunkThinInstSources.set(chunkKey, []);
    } finally {
      this.loadingObjectChunks.delete(chunkKey);
    }
  }

  /** Dispose placed objects for a chunk leaving the player's radius */
  private disposeChunkPlacedObjects(chunkKey: string): void {
    const decorKeys = this.decorBlockedTilesByChunk.get(chunkKey);
    if (decorKeys) {
      for (const k of decorKeys) this.decorBlockedTiles.delete(k);
      this.decorBlockedTilesByChunk.delete(chunkKey);
    }

    const nodes = this.chunkPlacedNodes.get(chunkKey);
    if (nodes) {
      for (const node of nodes) {
        // Remove from spatial grid
        const assetId = node.metadata?.assetId;
        if (assetId && assetId in ASSET_TO_OBJECT_DEF) {
          const gridKey = `${Math.floor(node.position.x)},${Math.floor(node.position.z)}`;
          this.placedObjectGrid.delete(gridKey);
        }
        // Remove from roof grid using the cached footprint keys stamped at
        // add time — bbox-derived, so the cleanup mirrors the stamp exactly.
        if (assetId && this.isRoofLikeAsset(assetId)) {
          const keys: string[] | undefined = node.metadata?.roofGridKeys;
          if (keys) {
            for (const rk of keys) {
              const arr = this.roofObjectGrid.get(rk);
              if (!arr) continue;
              const ri = arr.findIndex(e => e.node === node);
              if (ri >= 0) arr.splice(ri, 1);
              if (arr.length === 0) this.roofObjectGrid.delete(rk);
            }
          }
        }
        // Remove from flat list
        const idx = this.placedObjectNodes.indexOf(node);
        if (idx >= 0) this.placedObjectNodes.splice(idx, 1);
        node.dispose();
      }
      this.chunkPlacedNodes.delete(chunkKey);
    }
    const anims = this.chunkAnimGroups.get(chunkKey);
    if (anims) {
      for (const ag of anims) {
        const aidx = this.activeAnimationGroups.indexOf(ag);
        if (aidx >= 0) this.activeAnimationGroups.splice(aidx, 1);
        ag.dispose();
      }
      this.chunkAnimGroups.delete(chunkKey);
    }
    const thinSrcs = this.chunkThinInstSources.get(chunkKey);
    if (thinSrcs) {
      for (const m of thinSrcs) m.dispose();
      this.chunkThinInstSources.delete(chunkKey);
    }
  }

  private disposeChunkTextureOverlays(chunkKey: string): void {
    const overlays = this.textureOverlayMeshesByChunk.get(chunkKey);
    if (!overlays) return;
    for (const mesh of overlays) {
      const idx = this.texturePlaneMeshes.indexOf(mesh);
      if (idx >= 0) this.texturePlaneMeshes.splice(idx, 1);
      mesh.dispose();
    }
    this.textureOverlayMeshesByChunk.delete(chunkKey);
  }

  private setChunkPlacedObjectsEnabled(chunkKey: string, enabled: boolean): void {
    const nodes = this.chunkPlacedNodes.get(chunkKey);
    if (nodes) {
      for (const node of nodes) node.setEnabled(enabled);
    }
    const thinSrcs = this.chunkThinInstSources.get(chunkKey);
    if (thinSrcs) {
      for (const m of thinSrcs) m.setEnabled(enabled);
    }
  }

  /** Determine which floor a roof/ceiling at a given Y belongs to by checking
   *  floor layer heights top-down. Returns 0 for ground floor or maps without layers. */
  private assignRoofFloor(x: number, z: number, roofY: number): number {
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return 0;
    const tileIdx = tz * this.mapWidth + tx;
    const floorIndices = Array.from(this.floorLayerData.keys()).sort((a, b) => b - a);
    for (const floorIdx of floorIndices) {
      const layer = this.floorLayerData.get(floorIdx)!;
      const floorH = layer.floors.get(tileIdx) ?? layer.tiles.get(tileIdx);
      if (floorH !== undefined && roofY > floorH + 0.5) return floorIdx;
    }
    return 0;
  }

  /** Get the Y of the lowest roof/ceiling above the player's head near a position.
   *  Searches a wide area (±8 tiles) to find intermediate ceilings from sparse
   *  texture plane grids. Height-based: works with or without floor layer data. */
  getCeilingHeight(x: number, z: number, playerY: number): number {
    const tx = Math.floor(x), tz = Math.floor(z);
    const r = 8;
    let minY = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const arr = this.roofObjectGrid.get(`${tx + dx},${tz + dz}`);
        if (!arr) continue;
        for (const entry of arr) {
          if (entry.y <= playerY + 0.5) continue;
          if (entry.y < minY) minY = entry.y;
        }
      }
    }
    return minY;
  }

  private isRoofLikeAsset(assetId: string): boolean {
    const lower = assetId.toLowerCase();
    return lower.includes('roof') || lower.includes('slab');
  }

  isUnderRoof(x: number, z: number, playerY: number, _floor: number): boolean {
    // Indoor signal A: player is literally STANDING on an elevated walkable
    // surface (a building's upper floor). The tile has an entry in
    // elevatedFloorHeights (texture-plane upper floors) AND the player's Y
    // matches that elevation — i.e. they're on it, not under it. Tiles
    // covered ONLY by noRoof-flagged planes (bridges, outdoor terraces)
    // skip this signal so standing on a bridge stays outdoor.
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx >= 0 && tx < this.mapWidth && tz >= 0 && tz < this.mapHeight) {
      const tileIdx = tz * this.mapWidth + tx;
      const elev = this.elevatedFloorHeights.get(tileIdx);
      if (elev !== undefined && Math.abs(playerY - elev) < 1.0 && this.nonNoRoofElevatedTiles.has(tileIdx)) return true;
    }

    // Indoor signal B: 1×1 roof slab cover. Player's tile has a roof entry
    // above them (single-storey building case — a roof, no upper floor).
    // Multi-layer suppression handles "under the building" (floor + roof
    // above the player ⇒ basement, not indoor).
    //
    // Veto: a flat noRoof texture plane covering this tile means the author
    // declared this column outdoor (balconies, terraces, open structures).
    // Without the veto, a roof-like placed object's bbox-stamped roofObject-
    // Grid entry over the same tile would misfire indoor mode under it.
    if (tx >= 0 && tx < this.mapWidth && tz >= 0 && tz < this.mapHeight) {
      const tileIdx = tz * this.mapWidth + tx;
      if (this.noRoofPlaneTiles.has(tileIdx)) return false;
    }
    const here = this.roofObjectGrid.get(`${tx},${tz}`);
    if (!here) return false;
    let minAbove = Infinity, maxAbove = -Infinity;
    for (const e of here) {
      if (e.y <= playerY + 0.5) continue;
      if (e.y < minAbove) minAbove = e.y;
      if (e.y > maxAbove) maxAbove = e.y;
    }
    if (minAbove === Infinity) return false;
    if (maxAbove > minAbove + 2.0) return false;
    return true;
  }


  /** Get all roof nodes near a position on the given floor or above (for hiding). */
  getRoofNodesNear(x: number, z: number, radius: number, minY: number, _floor: number): TransformNode[] {
    const result: TransformNode[] = [];
    const seen = new Set<TransformNode>();
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    const r = Math.ceil(radius);
    // Match isUnderRoof: any roof above playerY+0.5 (= minY here) counts as
    // an immediate ceiling. The floor-index heuristic is intentionally
    // ignored — see isUnderRoof for the rationale.
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const arr = this.roofObjectGrid.get(`${tx + dx},${tz + dz}`);
        if (arr) {
          for (const entry of arr) {
            if (entry.y > minY && !seen.has(entry.node)) {
              seen.add(entry.node);
              result.push(entry.node);
            }
          }
        }
      }
    }
    return result;
  }

  /** Get all placed object nodes near a position that are above a given Y height.
   *  Excludes door objects so they remain clickable when indoors.
   *  Also includes merged flat texture-plane meshes (the upper-floor surfaces)
   *  that sit above the threshold — they're not in `chunkPlacedNodes` because
   *  they're built by the merger, not the placed-object loader. */
  getNodesAboveHeight(x: number, z: number, radius: number, minY: number): TransformNode[] {
    const result: TransformNode[] = [];
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    const r = Math.ceil(radius);
    const seen = new Set<TransformNode>();
    for (const [, nodes] of this.chunkPlacedNodes) {
      for (const node of nodes) {
        if (seen.has(node)) continue;
        // Doors get reparented under a pivot in setupDoorPivot, so their
        // local `position` is relative to the pivot (≈0) — not the world Y.
        // Use absolute position so we cull doors above the player too.
        const ap = node.getAbsolutePosition();
        if (ap.y <= minY) continue;
        const dx = Math.floor(ap.x) - tx;
        const dz = Math.floor(ap.z) - tz;
        if (Math.abs(dx) <= r && Math.abs(dz) <= r) {
          seen.add(node);
          result.push(node);
        }
      }
    }
    // Also fold in flat texture-plane meshes whose lowest plane sits above
    // the threshold. We use chunk-center distance as the spatial filter
    // (each merged mesh is bound to one chunk).
    const playerChunkX = Math.floor(x / CHUNK_SIZE);
    const playerChunkZ = Math.floor(z / CHUNK_SIZE);
    const chunkRadius = Math.ceil(radius / CHUNK_SIZE) + 1;
    for (const m of this.texturePlaneMeshes) {
      const md = m.metadata as { isFlat?: boolean; isNoRoof?: boolean; minY?: number; chunkX?: number; chunkZ?: number } | undefined;
      if (!md || !md.isFlat || md.minY === undefined || md.chunkX === undefined) continue;
      if (md.isNoRoof) continue; // explicitly authored as "never hide"
      if (md.minY <= minY) continue;
      if (Math.abs(md.chunkX - playerChunkX) > chunkRadius) continue;
      if (Math.abs((md.chunkZ ?? 0) - playerChunkZ) > chunkRadius) continue;
      if (seen.has(m)) continue;
      seen.add(m);
      result.push(m);
    }
    return result;
  }

  /** Set callback for when a chunk's placed objects finish loading */
  setOnChunkObjectsLoaded(cb: (chunkKey: string) => void): void {
    this.onChunkObjectsLoaded = cb;
  }

  /** Check if a chunk's placed objects are loaded (not loading) */
  isChunkObjectsLoaded(x: number, z: number): boolean {
    const key = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
    return this.chunkPlacedNodes.has(key) && !this.loadingObjectChunks.has(key);
  }

  /** Build shadow influences from raw placed object data (no mesh required) */
  private buildShadowInfluences(): void {
    if (!this.mapWidth || !this.mapHeight) return;
    const w = this.mapWidth + 1;
    const h = this.mapHeight + 1;
    const inf = new Float32Array(w * h);
    inf.fill(1.0);

    let count = 0;
    for (const [, objects] of this.placedObjectsByChunk) {
      for (const obj of objects) {
        const cx = obj.position.x;
        const cz = obj.position.z;
        const name = obj.assetId.toLowerCase();
        const isLarge = name.includes('tree') || name.includes('modular') || name.includes('wall') || name.includes('house') || name.includes('bush');
        const isRock = name.includes('rock');
        const shadowR = isLarge ? 3.8 : isRock ? 1.8 : 2.0;
        const maxDark = isLarge ? 0.82 : isRock ? 0.5 : 0.42;

        const vx0 = Math.max(0, Math.floor(cx - shadowR));
        const vx1 = Math.min(w - 1, Math.ceil(cx + shadowR));
        const vz0 = Math.max(0, Math.floor(cz - shadowR));
        const vz1 = Math.min(h - 1, Math.ceil(cz + shadowR));

        for (let vz = vz0; vz <= vz1; vz++) {
          for (let vx = vx0; vx <= vx1; vx++) {
            const dx = vx - cx;
            const dz = vz - cz;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist >= shadowR) continue;
            const t = 1.0 - dist / shadowR;
            const factor = 1.0 - t * t * maxDark;
            const idx = vz * w + vx;
            if (factor < inf[idx]) inf[idx] = factor;
          }
        }
        count++;
      }
    }

    this.shadowInf = inf;
    console.log(`[ChunkManager] Built shadow influences for ${count} objects`);
  }

  /** Add shadow contribution from a set of placed objects (used in chunked mode) */
  private addShadowsForObjects(objects: PlacedObject[]): void {
    if (!this.shadowInf || !this.mapWidth) { console.log(`[ChunkManager] addShadowsForObjects: no shadowInf or mapWidth`); return; }
    const w = this.mapWidth + 1;
    for (const obj of objects) {
      const cx = obj.position.x;
      const cz = obj.position.z;
      const name = obj.assetId.toLowerCase();
      // Order matters — check 'bush' before 'large' so it gets its own profile.
      const isBush = name.includes('bush');
      const isLarge = !isBush && (name.includes('tree') || name.includes('modular') || name.includes('wall') || name.includes('house'));
      const isRock = name.includes('rock');
      // Rocks: sharp + dark (small radius, high contrast).
      // Bushes: wide + soft (gentle ambient occlusion under foliage).
      // Trees/structures: original strong cast.
      const shadowR = isRock ? 2.5 : isBush ? 3.5 : isLarge ? 3.8 : 2.0;
      const maxDark = isRock ? 0.85 : isBush ? 0.45 : isLarge ? 0.82 : 0.42;
      const vx0 = Math.max(0, Math.floor(cx - shadowR));
      const vx1 = Math.min(w - 1, Math.ceil(cx + shadowR));
      const vz0 = Math.max(0, Math.floor(cz - shadowR));
      const vz1 = Math.min(this.mapHeight, Math.ceil(cz + shadowR));
      for (let vz = vz0; vz <= vz1; vz++) {
        for (let vx = vx0; vx <= vx1; vx++) {
          const dx = vx - cx, dz = vz - cz;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist >= shadowR) continue;
          const t = 1.0 - dist / shadowR;
          const factor = 1.0 - t * t * maxDark;
          const idx = vz * w + vx;
          if (factor < this.shadowInf[idx]) this.shadowInf[idx] = factor;
        }
      }
    }
  }

  /** Rebuild ground meshes for chunks affected by newly loaded placed objects (for shadow updates) */
  private rebuildGroundChunksForObjects(objects: PlacedObject[]): void {
    const affectedChunks = new Set<string>();
    for (const obj of objects) {
      const name = obj.assetId.toLowerCase();
      const isShadowCaster = name.includes('tree') || name.includes('bush') || name.includes('modular') || name.includes('wall') || name.includes('house') || name.includes('rock');
      if (!isShadowCaster) continue;
      const shadowR = 3.8;
      const cx0 = Math.floor((obj.position.x - shadowR) / CHUNK_SIZE);
      const cx1 = Math.floor((obj.position.x + shadowR) / CHUNK_SIZE);
      const cz0 = Math.floor((obj.position.z - shadowR) / CHUNK_SIZE);
      const cz1 = Math.floor((obj.position.z + shadowR) / CHUNK_SIZE);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          affectedChunks.add(`${cx},${cz}`);
        }
      }
    }
    let rebuilt = 0;
    for (const key of affectedChunks) {
      const existing = this.chunks.get(key);
      if (!existing) continue;
      const [cx, cz] = key.split(',').map(Number);
      const startX = cx * CHUNK_SIZE, startZ = cz * CHUNK_SIZE;
      const endX = Math.min(startX + CHUNK_SIZE, this.mapWidth);
      const endZ = Math.min(startZ + CHUNK_SIZE, this.mapHeight);
      // Rebuild just the ground mesh with updated shadows
      existing.ground.dispose();
      existing.ground = this.buildGroundMesh(cx, cz, startX, startZ, endX, endZ);
      rebuilt++;
    }
  }

  private getShadowAt(vx: number, vz: number): number {
    if (!this.shadowInf || !this.mapWidth) return 1.0;
    if (vx < 0 || vz < 0 || vx > this.mapWidth || vz > this.mapHeight) return 1.0;
    return this.shadowInf[vz * (this.mapWidth + 1) + vx];
  }

  private getOrLoadTexture(textureId: string): Texture | null {
    if (this.textureCache.has(textureId)) {
      return this.textureCache.get(textureId)!;
    }
    const texDef = this.textureRegistry.get(textureId);
    if (!texDef) {
      console.warn(`[ChunkManager] Unknown texture: ${textureId}`);
      return null;
    }
    const tex = new Texture(texDef.path, this.scene, false, true, Texture.NEAREST_LINEAR_MIPLINEAR);
    tex.anisotropicFilteringLevel = 1;
    tex.hasAlpha = true;
    this.textureCache.set(textureId, tex);
    return tex;
  }

  setOnMinimapDataChanged(cb: (() => void) | null): void {
    this.onMinimapDataChanged = cb;
  }

  /** Schedule a minimap refresh, coalescing bursts (e.g. many texture-loads
   *  resolving in the same tick) into a single invalidation. */
  private markMinimapDirty(): void {
    if (this.minimapDirty) return;
    this.minimapDirty = true;
    queueMicrotask(() => {
      this.minimapDirty = false;
      this.onMinimapDataChanged?.();
    });
  }

  getTextureAvgColor(textureId: string): [number, number, number] | null {
    const cached = this.textureAvgColors.get(textureId);
    if (cached) return cached;
    this.computeTextureAvgColor(textureId);
    return null;
  }

  private computeTextureAvgColor(textureId: string): void {
    if (this.textureAvgColors.has(textureId)) return;
    if (this.textureAvgColorLoading.has(textureId)) return;
    const def = this.textureRegistry.get(textureId);
    if (!def) return;
    this.textureAvgColorLoading.add(textureId);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 16; canvas.height = 16;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 16, 16);
        const data = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
        if (n > 0) {
          this.textureAvgColors.set(textureId, [r / n, g / n, b / n]);
          this.refreshPaintedColorsForTexture(textureId);
          this.markMinimapDirty();
        }
      } catch (e) {
        // decode/CORS failure — leave uncached so callers fall back
      } finally {
        this.textureAvgColorLoading.delete(textureId);
      }
    };
    img.onerror = () => { this.textureAvgColorLoading.delete(textureId); };
    img.src = def.path;
  }

  private buildMinimapTexturePlaneColors(planes: TexturePlane[]): void {
    this.tilePaintedEntries.clear();
    this.flatPlanesByTexture.clear();
    for (const plane of planes) {
      if (!isFlatPlane(plane)) continue;
      let bucket = this.flatPlanesByTexture.get(plane.textureId);
      if (!bucket) { bucket = []; this.flatPlanesByTexture.set(plane.textureId, bucket); }
      bucket.push(plane);
      this.stampPlaneTilePaintedColor(plane);
    }
    this.markMinimapDirty();
  }

  private refreshPaintedColorsForTexture(textureId: string): void {
    const planes = this.flatPlanesByTexture.get(textureId);
    if (!planes) return;
    for (const plane of planes) this.stampPlaneTilePaintedColor(plane);
  }

  private stampPlaneTilePaintedColor(plane: TexturePlane): void {
    const avg = this.textureAvgColors.get(plane.textureId);
    if (!avg) {
      this.computeTextureAvgColor(plane.textureId);
      return;
    }
    const tint = plane.tintColor;
    const color: [number, number, number] = tint
      ? [avg[0] * tint.r, avg[1] * tint.g, avg[2] * tint.b]
      : [avg[0], avg[1], avg[2]];
    forEachTileInPlaneFootprint(plane, this.mapWidth, this.mapHeight, (idx, _tx, _tz, py) => {
      const existing = this.tilePaintedEntries.get(idx);
      if (existing && existing.y > py) return;
      this.tilePaintedEntries.set(idx, { color, y: py });
    });
  }

  private texPlaneMaterialCache: Map<string, StandardMaterial> = new Map();

  private getTexPlaneMaterial(plane: TexturePlane, isFlat: boolean): StandardMaterial {
    const tintKey = plane.tintColor ? `${plane.tintColor.r.toFixed(2)}_${plane.tintColor.g.toFixed(2)}_${plane.tintColor.b.toFixed(2)}` : '';
    const matKey = `${plane.textureId}_${plane.uvRepeat || 0}_${plane.texRotation || 0}_${tintKey}_${plane.doubleSided ? 1 : 0}_${isFlat ? 1 : 0}`;
    let mat = this.texPlaneMaterialCache.get(matKey);
    if (mat) return mat;

    const tex = this.getOrLoadTexture(plane.textureId);
    if (!tex) return this.texPlaneMaterialCache.values().next().value!;
    const planeTex = new Texture(tex.url, this.scene, false, true, Texture.NEAREST_LINEAR_MIPLINEAR);
    planeTex.anisotropicFilteringLevel = 1;
    planeTex.hasAlpha = true;
    const uvScale = plane.uvRepeat ? 1 / plane.uvRepeat : 1;
    planeTex.uScale = uvScale;
    planeTex.vScale = uvScale;
    planeTex.wAng = (plane.texRotation || 0) * Math.PI / 2;
    planeTex.wrapU = Texture.WRAP_ADDRESSMODE;
    planeTex.wrapV = Texture.WRAP_ADDRESSMODE;
    mat = new StandardMaterial(`texplane_mat_${matKey}`, this.scene);
    mat.diffuseTexture = planeTex;
    mat.emissiveTexture = planeTex;
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.emissiveColor = plane.tintColor
      ? new Color3(plane.tintColor.r, plane.tintColor.g, plane.tintColor.b)
      : new Color3(1, 1, 1);
    mat.specularColor = new Color3(0, 0, 0);
    mat.useAlphaFromDiffuseTexture = true;
    mat.backFaceCulling = isFlat ? false : !plane.doubleSided;
    mat.transparencyMode = isFlat ? 2 : 1;
    if (!isFlat) mat.alphaCutOff = 0.05;
    if (isFlat) mat.needDepthPrePass = true;
    if (!isFlat) mat.freeze();
    this.texPlaneMaterialCache.set(matKey, mat);
    return mat;
  }

  private buildPlaneWorldVerts(plane: TexturePlane): { positions: number[]; normals: number[]; uvs: number[]; indices: number[] } {
    const hw = plane.width / 2, hh = plane.height / 2;
    // Plane quad in local space (XY plane, facing +Z)
    const localVerts = [
      new Vector3(-hw, -hh, 0), new Vector3(hw, -hh, 0),
      new Vector3(hw, hh, 0), new Vector3(-hw, hh, 0),
    ];
    const localNormal = new Vector3(0, 0, 1);

    // Build world matrix
    const { x: rx, y: ry, z: rz } = plane.rotation;
    const quat = Quaternion.RotationAxis(new Vector3(1, 0, 0), rx)
      .multiply(Quaternion.RotationAxis(new Vector3(0, 1, 0), ry))
      .multiply(Quaternion.RotationAxis(new Vector3(0, 0, 1), rz));
    const scale = new Vector3(plane.scale.x, plane.scale.y, plane.scale.z);
    const pos = new Vector3(plane.position.x, plane.position.y, plane.position.z);
    const worldMat = Matrix.Compose(scale, quat, pos);

    const positions: number[] = [];
    const normals: number[] = [];
    for (const lv of localVerts) {
      const wv = Vector3.TransformCoordinates(lv, worldMat);
      positions.push(wv.x, wv.y, wv.z);
    }
    const wn = Vector3.TransformNormal(localNormal, worldMat).normalize();
    for (let i = 0; i < 4; i++) normals.push(wn.x, wn.y, wn.z);

    const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
    const indices = plane.doubleSided
      ? [0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]
      : [0, 1, 2, 0, 2, 3];
    return { positions, normals, uvs, indices };
  }

  private loadTexturePlanes(planes: TexturePlane[]): void {
    if (planes.length === 0) return;
    console.log(`[ChunkManager] Loading ${planes.length} texture planes...`);

    this.buildMinimapTexturePlaneColors(planes);

    // Classify each plane into a merge group
    interface MergeGroup {
      planes: TexturePlane[];
      isFlat: boolean;
      isRoof: boolean;
      roofFloor: number;
      isNoRoof: boolean;
    }
    const mergeGroups = new Map<string, MergeGroup>();

    for (const plane of planes) {
      if (!this.getOrLoadTexture(plane.textureId)) continue;
      const isFlat = isFlatPlane(plane);
      const pcx = Math.floor(plane.position.x / CHUNK_SIZE);
      const pcz = Math.floor(plane.position.z / CHUNK_SIZE);

      let isRoof = false;
      let roofFloor = 0;
      const isNoRoof = !!plane.noRoof;
      if (isFlat) {
        const terrainH = this.getEffectiveHeight(plane.position.x, plane.position.z);
        if (plane.position.y > terrainH + 1.0 && !plane.noRoof) {
          isRoof = true;
          roofFloor = this.assignRoofFloor(plane.position.x, plane.position.z, plane.position.y);
        }
      }

      const tintKey = plane.tintColor ? `${plane.tintColor.r.toFixed(2)}_${plane.tintColor.g.toFixed(2)}_${plane.tintColor.b.toFixed(2)}` : '';
      // Include noRoof in the merge key so noRoof planes don't share a
      // merged mesh with regular planes — the indoor-roof culler can then
      // skip the entire merged mesh by checking its metadata flag.
      const matKey = `${plane.textureId}_${plane.uvRepeat || 0}_${plane.texRotation || 0}_${tintKey}_${plane.doubleSided ? 1 : 0}_${isFlat ? 1 : 0}_${isNoRoof ? 1 : 0}`;
      // Y-bucket prevents different floor heights from merging into one mesh
      // when assignRoofFloor returns the same index (kcmap doesn't track per-
      // tile floor data, so every plane lands on roofFloor=0). Without this,
      // 1st-floor and 2nd-floor planes in the same chunk shared a single
      // merged mesh, and the indoor culler hiding the y=5.5 entries also
      // hid the y=2.7 planes baked into the same mesh.
      const yBucket = Math.round(plane.position.y * 10);
      const groupKey = isRoof
        ? `${matKey}_chunk${pcx}_${pcz}_roof${roofFloor}_y${yBucket}`
        : `${matKey}_chunk${pcx}_${pcz}`;

      let group = mergeGroups.get(groupKey);
      if (!group) { group = { planes: [], isFlat, isRoof, roofFloor, isNoRoof }; mergeGroups.set(groupKey, group); }
      group.planes.push(plane);
    }

    let mergedCount = 0;
    for (const [, group] of mergeGroups) {
      const allPositions: number[] = [];
      const allNormals: number[] = [];
      const allUvs: number[] = [];
      const allIndices: number[] = [];
      let vertOffset = 0;

      for (const plane of group.planes) {
        const { positions, normals, uvs, indices } = this.buildPlaneWorldVerts(plane);
        allPositions.push(...positions);
        allNormals.push(...normals);
        allUvs.push(...uvs);
        for (const idx of indices) allIndices.push(idx + vertOffset);
        vertOffset += positions.length / 3;
      }

      const refPlane = group.planes[0];
      const mesh = new Mesh(`texplane_merged_${mergedCount}`, this.scene);
      const vd = new VertexData();
      vd.positions = allPositions;
      vd.normals = allNormals;
      vd.uvs = allUvs;
      vd.indices = allIndices;
      vd.applyToMesh(mesh);

      mesh.material = this.getTexPlaneMaterial(refPlane, group.isFlat);
      mesh.renderingGroupId = 0;
      mesh.isPickable = group.isFlat;
      mesh.freezeWorldMatrix();
      mesh.doNotSyncBoundingInfo = true;

      // Compute Y range across all planes in this group so the indoor-roof
      // culler can hide upper-floor surfaces (these merged meshes aren't
      // tracked by `roofObjectGrid` — that only sees placed objects).
      let minPY = Infinity, maxPY = -Infinity;
      for (const plane of group.planes) {
        const py = plane.position.y;
        if (py < minPY) minPY = py;
        if (py > maxPY) maxPY = py;
      }
      const refChunkX = Math.floor(refPlane.position.x / CHUNK_SIZE);
      const refChunkZ = Math.floor(refPlane.position.z / CHUNK_SIZE);
      mesh.metadata = { isTexPlane: true, isFlat: group.isFlat, isNoRoof: group.isNoRoof, minY: minPY, maxY: maxPY, chunkX: refChunkX, chunkZ: refChunkZ };

      this.texturePlaneMeshes.push(mesh);

      const pcx = Math.floor(refPlane.position.x / CHUNK_SIZE);
      const pcz = Math.floor(refPlane.position.z / CHUNK_SIZE);
      const pkey = `${pcx},${pcz}`;
      let arr = this.texturePlanesByChunk.get(pkey);
      if (!arr) { arr = []; this.texturePlanesByChunk.set(pkey, arr); }
      arr.push(mesh);

      // Register roof entries for all planes in the group. Only register
      // tiles whose CENTER falls inside the plane's footprint. The previous
      // version used Math.ceil on half-width, which rounded a 1.2-tile plane
      // up to a 3-tile footprint — and an "every cell of 3×3 is covered"
      // indoor test would then fire near any wall with a slightly-oversized
      // decorative plane on it.
      if (group.isRoof) {
        for (const plane of group.planes) {
          const px = plane.position.x, pz = plane.position.z;
          const halfW = ((plane.width ?? 1) * Math.abs(plane.scale.x || 1)) / 2;
          const halfD = ((plane.height ?? 1) * Math.abs(plane.scale.z || plane.scale.y || 1)) / 2;
          const tx0 = Math.floor(px - halfW);
          const tx1 = Math.floor(px + halfW);
          const tz0 = Math.floor(pz - halfD);
          const tz1 = Math.floor(pz + halfD);
          for (let tz = tz0; tz <= tz1; tz++) {
            for (let tx = tx0; tx <= tx1; tx++) {
              if (Math.abs(tx + 0.5 - px) > halfW) continue;
              if (Math.abs(tz + 0.5 - pz) > halfD) continue;
              const rk = `${tx},${tz}`;
              let roofArr = this.roofObjectGrid.get(rk);
              if (!roofArr) { roofArr = []; this.roofObjectGrid.set(rk, roofArr); }
              roofArr.push({ node: mesh, floor: group.roofFloor, y: plane.position.y });
            }
          }
        }
      }

      mergedCount++;
    }
    console.log(`[ChunkManager] Merged ${planes.length} texture planes into ${mergedCount} batched meshes (${this.texturePlanesByChunk.size} chunks)`);
  }

  disposeAll(): void {
    // Dispose animations
    for (const ag of this.activeAnimationGroups) ag.dispose();
    this.activeAnimationGroups = [];
    for (const [, groups] of this.modelAnimationGroups) {
      for (const ag of groups) ag.dispose();
    }
    this.modelAnimationGroups.clear();
    // Dispose placed objects and texture planes
    for (const n of this.placedObjectNodes) n.dispose();
    this.placedObjectNodes = [];
    this.placedObjectGrid.clear();
    this.placedObjectsByChunk.clear();
    this.decorBlockedTiles.clear();
    this.decorBlockedTilesByChunk.clear();
    this.chunkPlacedNodes.clear();
    this.chunkAnimGroups.clear();
    for (const [, srcs] of this.chunkThinInstSources) {
      for (const m of srcs) m.dispose();
    }
    this.chunkThinInstSources.clear();
    this.objectChunkQueue = [];
    this.queuedObjectChunks.clear();
    this.objectChunkQueueScheduled = false;
    this.templateBaseMatrices.clear();
    this.loadingObjectChunks.clear();
    this.roofObjectGrid.clear();
    this.placedStairRamps = [];
    this.elevatedFloorHeights.clear();
    this.bridgeFloorTiles.clear();
    this.nonNoRoofElevatedTiles.clear();
    this.noRoofPlaneTiles.clear();
    for (const m of this.texturePlaneMeshes) m.dispose();
    this.texturePlaneMeshes = [];
    this.texturePlanesByChunk.clear();
    this.tilePaintedEntries.clear();
    this.flatPlanesByTexture.clear();
    this.textureAvgColors.clear();
    this.textureAvgColorLoading.clear();
    this.textureOverlayMeshesByChunk.clear();
    for (const [, m] of this.loadedModelCache) m?.dispose();
    this.loadedModelCache.clear();
    for (const [, t] of this.textureCache) t.dispose();
    this.textureCache.clear();
    for (const [, m] of this.overlayMatCache) m.dispose();
    this.overlayMatCache.clear();
    for (const [, m] of this.texPlaneMaterialCache) m.dispose();
    this.texPlaneMaterialCache.clear();

    for (const [, meshes] of this.chunks) {
      meshes.ground.dispose();
      meshes.water?.dispose();
      meshes.paddyWater?.dispose();
      meshes.cliff?.dispose();
      meshes.wall?.dispose();
      meshes.roof?.dispose();
      meshes.floor?.dispose();
      meshes.stairs?.dispose();
      for (const [, floorSet] of meshes.upperFloors) {
        floorSet.wall?.dispose(); floorSet.roof?.dispose(); floorSet.floor?.dispose(); floorSet.stairs?.dispose();
      }
    }
    this.chunks.clear();
    this.heights = null;
    this.tileTypes = null;
    this.mapData = null;
    this.activeChunks = null;
    this.walls = null;
    this.wallHeights.clear();
    this.floorHeights.clear();
    this.texturePlaneFloorTiles.clear();
    this.stairData.clear();
    this.roofData.clear();
    this.floorLayerData.clear();
    this.currentFloor = 0;
    this.chunkedMode = false;
    this.loadedEditorChunks.clear();
    this.loadingEditorChunks.clear();
    this.pendingGameChunks.clear();
    this.queuedGameChunks.clear();
    this.desiredGameChunks.clear();
    this.keepGameChunks.clear();
    this.loaded = false;
    this.lastChunkX = -999;
    this.lastChunkZ = -999;
  }
}
