import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { Vector3, Quaternion, Matrix, TmpVectors } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo';
import '@babylonjs/loaders/glTF';
import { worldAABB } from './MeshBounds';
import { CHUNK_SIZE, CHUNK_LOAD_RADIUS, TILE_SIZE, TileType, BLOCKING_TILES, WallEdge, DOOR_EDGE_NEIGHBOR, DEFAULT_WALL_HEIGHT, PROJECTILE_BLOCKING_WALL_HEIGHT, shouldTileRenderWater, classifyTileType } from '@projectrs/shared';
import { isGroundItemSpawnAssetId, BLOCKING_DECOR_ASSETS, objectDefIdForPlacedAsset, deriveUpperFloorTilesFromPlanes, deriveElevatedFloorTiles, isFlatPlane, isRoofCoverPlane, isWalkableElevatedPlane, forEachTileInPlaneFootprint, GROUND_TYPE_ID, GROUND_TYPE_NONE, defaultGroundForMap, hasProjectileGridLineOfSight, isShootOverProjectileFenceAssetId, createObjectShadowCaster, createWallEdgeShadowCaster, isLinearCasterCoveredByWallRuns, isLinearShadowAsset, objectShadowBounds, objectShadowFactorAt, wallShadowRunsFromEntries } from '@projectrs/shared';
import { clamp, groundColor, getNoiseExtra, getSlopeShade, getVertexAO as sharedGetVertexAO, getVertexWaterProximity as sharedGetVertexWaterProximity, computeCutPolygons, fanTriangulate, bilerpCorners, transformOverlayUV, fullTileRingForSplit, DEFAULT_CUT_ANGLE, legacyCutAngleFromSplit, normalizeWaterFlow, pushWaterFlowQuadUvs, waterFlowUvTransform, waterFlowUvFromTransform, applyWaterEdgeMudTint, applyTorchlightTint, hasTorchlightPaint, visualGroundForTorchlight, bilerpRGB, buildTorchlightInfluenceGrid, sampleTorchlightInfluenceGrid, maxTorchlightInfluenceForTile, TORCHLIGHT_GLOW_RADIUS_TILES, TORCHLIGHT_GLOW_SUBDIVISIONS, WATER_TEXTURE_ALPHA, SURFACE_WATER_ALPHA, WATER_TEXTURE_TINT, SURFACE_WATER_TEXTURE_TINT, WATER_UV_SCALE } from '@projectrs/shared';
import type { UVPoint } from '@projectrs/shared';
import type { RGB, TorchlightInfluenceGrid, TorchlightPaintTile } from '@projectrs/shared';
import type { MapMeta, WallsFile, StairData, RoofData, FloorLayerData, KCMapFile, KCMapData, KCTile, GroundType, PlacedObject, PlacedObjectInteraction, TexturePlane, WaterFlow, WaterFlowUvTransform, WallShadowRun, MinimapMarker } from '@projectrs/shared';
import { SAME_PLANE_PICK_Y_TOLERANCE } from './pickingConstants';

const EDITOR_CHUNK_SIZE = 64;
const CHUNK_RENDER_PADDING_TILES = 8;
const CHUNK_RESIDENT_RADIUS = CHUNK_LOAD_RADIUS;
const CHUNK_CACHE_RADIUS = CHUNK_LOAD_RADIUS + 4;
const CHUNK_MESH_CACHE_MAX_CHUNKS = 96;
const VISIBLE_CHUNK_BUILD_INTERVAL_MS = 12;
const HIDDEN_CHUNK_BUILD_INTERVAL_MS = 180;
const OBJECT_RENDER_PADDING_TILES = 0;
const OBJECT_PREFETCH_PADDING_TILES = 8;
const OBJECT_CHUNK_CACHE_RADIUS = CHUNK_LOAD_RADIUS + 4;
const OBJECT_CHUNK_CACHE_MAX_CHUNKS = 96;
const OBJECT_RENDER_HYSTERESIS_TILES = 8;
const OBJECT_VISIBILITY_BUCKET_TILES = 4;
const FLAT_TEXTURE_PICK_CELL_SIZE = 8;
const FLAT_TEXTURE_PICK_Y_BUCKET_SIZE = SAME_PLANE_PICK_Y_TOLERANCE;
const HIDDEN_OBJECT_CHUNK_LOAD_INTERVAL_MS = 220;
const CHUNK_MIN_RENDER_DISTANCE_TILES = CHUNK_SIZE * 1.25;
const CHUNK_RENDER_DISTANCE_BUCKET_TILES = 8;
const ROOF_REVEAL_CONNECTED_TILE_LIMIT = 2048;
const ROOF_REVEAL_LAYER_HEIGHT_TOLERANCE = 1.25;
const ROOF_REVEAL_NEARBY_TILE_PADDING = 2;
const ROOF_REVEAL_OBJECT_LAYER_BELOW_TOLERANCE = 0.75;
const ROOF_REVEAL_TEXTURE_PLANE_BBOX_PADDING = 10;

export function isRoofLikePlacedAsset(assetId: string): boolean {
  const lower = assetId.toLowerCase().trim();
  return lower.includes('roof') || lower.includes('spire');
}

export function isInteractiveDoorPlacedAsset(assetId: string): boolean {
  const lower = assetId.toLowerCase().trim();
  return lower === 'castletruedoor' || lower === 'basictruedoor';
}

function isRevealStructuralPlacedAsset(assetId: string): boolean {
  const lower = assetId.toLowerCase().trim();
  if (lower.includes('torch')) return false;
  return lower.includes('wall')
    || lower.includes('window')
    || lower.includes('door')
    || lower.includes('doorframe')
    || lower.includes('arrowslit')
    || lower.includes('slab')
    || lower.includes('pillar')
    || lower.includes('stair')
    || lower === 'stone 30';
}

function shouldSmoothPlacedObjectTextures(assetId: string, path: string): boolean {
  const lowerId = assetId.toLowerCase().trim();
  const lowerPath = path.toLowerCase();
  return lowerPath.includes('/modular-assets/byzantine-modular/')
    || lowerPath.includes('/modular-assets/theodosian-limewall-modular/')
    || lowerId.startsWith('byzantine ')
    || lowerId.startsWith('theodosian limewall ');
}

export function placedObjectThinGroupKey(assetId: string, visibility: 'ground' | 'elevated' | 'roof', originY: number): string {
  const yBucket = visibility === 'elevated' ? Math.floor(originY * 2) / 2 : 0;
  return `${assetId}\u0000${visibility}\u0000${yBucket}`;
}

function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('evilquest_token') || '';
  if (!token) return fetch(input, init);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers, credentials: 'same-origin' });
}

interface MapResourceFetchError extends Error {
  mapResourceStatus: number;
}

function mapResourceFetchError(resource: string, status: number): MapResourceFetchError {
  const message = status === 0
    ? `Network error while loading ${resource}`
    : `HTTP ${status} while loading ${resource}`;
  const error = new Error(message) as MapResourceFetchError;
  error.mapResourceStatus = status;
  return error;
}

function isMapResourceFetchError(error: unknown): error is MapResourceFetchError {
  return !!error
    && typeof error === 'object'
    && 'mapResourceStatus' in error
    && typeof (error as { mapResourceStatus?: unknown }).mapResourceStatus === 'number';
}

export function assertOptionalMapResourceResponse(res: Response, resource: string): void {
  if (res.ok || res.status === 404) return;
  throw mapResourceFetchError(resource, res.status);
}

async function fetchOptionalMapResource(input: RequestInfo | URL, resource: string): Promise<Response> {
  try {
    const res = await authFetch(input);
    assertOptionalMapResourceResponse(res, resource);
    return res;
  } catch (e) {
    if (isMapResourceFetchError(e)) throw e;
    throw mapResourceFetchError(resource, 0);
  }
}

function rgbToColor3(c: RGB): Color3 {
  return new Color3(c.r, c.g, c.b);
}

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

interface ChunkBuildResult {
  built: boolean;
  visible: boolean;
}

interface ElevatedThinInstanceSource {
  mesh: Mesh;
  minX: number;
  maxX: number;
  maxOriginY: number;
  minZ: number;
  maxZ: number;
  tileKeys?: Set<string>;
}

interface FlatTexturePickPlane {
  invWorld: Matrix;
  halfWidth: number;
  halfHeight: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

interface TexturePlaneRevealEntry {
  mesh: Mesh;
  minY: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
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

interface PlacedObjectNodeMetadata {
  assetId?: string;
  chunkKey?: string;
  placedX?: number;
  placedY?: number;
  placedZ?: number;
  placedName?: string;
  interactionActions?: string[];
  interactions?: PlacedObjectInteraction[];
  isNoRoof?: boolean;
  roofGridKeys?: string[];
}

type RoofObjectGridEntry = { node?: TransformNode; chunkKey?: string; floor: number; y: number };

type RoofBuildTile = { x: number; z: number; roof: RoofData };

type RoofRevealSeed = { x: number; z: number; floor: number; y: number };

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
  private defaultGround: GroundType = 'grass';
  private torchlightPaintTiles: Set<number> = new Set();
  private chunkCols: number = 0;
  private chunkRows: number = 0;
  private defaultWaterLevel: number = -0.3;
  private chunkWaterLevelCache: Float32Array | null = null;

  // Cached flat arrays for fast access
  private heights: Float32Array | null = null;
  private tileTypes: Uint8Array | null = null;

  // Building data
  private walls: Uint8Array | null = null;
  private wallHeights: Map<number, number> = new Map();
  private shootOverProjectileWallEdges: Uint8Array | null = null;
  private floorHeights: Map<number, number> = new Map();
  private stairData: Map<number, StairData> = new Map();
  private roofData: Map<number, RoofData> = new Map();
  private holeTiles: Set<number> = new Set();
  private texturePlaneFloorTiles: Set<number> = new Set(); // floors from texture planes (don't render floor mesh)
  /** Edge bits currently suppressed by open doors (`floor:tileIdx` → edge bitmask).
   *  Scoping by floor keeps stacked doors from leaking pathing state across
   *  each other. */
  private openDoorEdges: Map<string, number> = new Map();

  // Multi-floor layer data (floor 1+)
  private floorLayerData: Map<number, FloorLayerClientData> = new Map();
  private currentFloor: number = 0;

  // Active chunk meshes
  private chunks: Map<string, ChunkMeshes> = new Map();
  private lastChunkX: number = -999;
  private lastChunkZ: number = -999;
  private lastRenderDistanceBucket: number = -999;
  private lastObjectBucketX: number = -999;
  private lastObjectBucketZ: number = -999;
  private lastObjectDistanceBucket: number = -999;

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
  private residentGameChunks: Set<string> = new Set();
  private desiredObjectChunks: Set<string> = new Set();
  private objectLoadChunks: Set<string> = new Set();
  private chunkCacheTick: number = 0;
  private chunkLastUsed: Map<string, number> = new Map();
  private chunkMeshesEnabled: Map<string, boolean> = new Map();
  private objectChunkLastUsed: Map<string, number> = new Map();
  private lastHiddenGameChunkBuildAt: number = 0;
  private lastUpdateTerrainChanged: boolean = false;
  private lastUpdateObjectsChanged: boolean = false;

  // Water texture + animation
  private waterTexture: Texture | null = null;
  private waterStartTime: number = 0;

  // Object shadow influences (vertex grid, 1.0 = full brightness, 0.0 = full shadow)
  private shadowInf: Float32Array | null = null;
  private rootWallShadowRunsCache: WallShadowRun[] | null = null;

  // Placed objects and texture planes from KC editor
  private placedObjectNodes: TransformNode[] = [];
  private placedObjectNodeSet: Set<TransformNode> = new Set();
  /** Spatial index: "tileX,tileZ" → placed object node (only interactable objects) */
  private placedObjectGrid: Map<string, TransformNode[]> = new Map();
  /** Raw placed object data indexed by chunk key "cx,cz" */
  private placedObjectsByChunk: Map<string, PlacedObject[]> = new Map();
  /** Tile-index blockers for thin-instanced decor (bushes); mirrored server-side. */
  private decorBlockedTiles: Set<number> = new Set();
  private decorBlockedTilesByChunk: Map<string, number[]> = new Map();
  /** Object chunk keys known to exist from the server manifest. Null means the
   *  map/server did not provide a manifest, so fall back to probing chunks. */
  private objectChunkManifest: Set<string> | null = null;
  /** Instantiated placed object nodes per chunk */
  private chunkPlacedNodes: Map<string, TransformNode[]> = new Map();
  /** Animation groups per chunk */
  private chunkAnimGroups: Map<string, AnimationGroup[]> = new Map();
  /** Last applied enabled state for cached placed-object chunks. */
  private chunkPlacedEnabled: Map<string, boolean> = new Map();
  /** Chunks currently loading placed objects (prevents double-load) */
  private loadingObjectChunks: Set<string> = new Set();
  /** FIFO of object chunks waiting for instantiation. Keeps many chunks from
   *  resuming into mesh creation in the same frame after their assets load. */
  private objectChunkQueue: string[] = [];
  private queuedObjectChunks: Set<string> = new Set();
  private objectChunkQueueScheduled: boolean = false;
  private objectChunkQueueProcessing: boolean = false;
  private objectLoadGeneration: number = 0;
  private lastHiddenObjectChunkLoadAt: number = 0;
  private readonly objectChunkFrameBudgetMs: number = 3;
  private pendingShadowGroundRebuildChunks: Set<string> = new Set();
  private shadowGroundRebuildScheduled: boolean = false;
  private readonly shadowGroundRebuildFrameBudgetMs: number = 2;
  /** Chunks the server has confirmed have no placed objects (404 from per-chunk
   *  fetch). Persists across chunk eviction so we never re-fetch a known-empty
   *  chunk in the same session. */
  private chunksKnownEmpty: Set<string> = new Set();
  private editorChunkApplyTail: Promise<void> = Promise.resolve();
  private lastVisibleGameChunkBuildAt: number = 0;
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
  /** Spatial index of roof objects: "tileX,tileZ" → roof entries with floor tag + Y height */
  private roofObjectGrid: Map<string, RoofObjectGridEntry[]> = new Map();
  /** Roof-grid tile keys stamped by each streamed placed-object chunk. */
  private roofObjectGridKeysByChunk: Map<string, Set<string>> = new Map();
  /** Callback fired when a chunk's placed objects finish loading */
  private onChunkObjectsLoaded: ((chunkKey: string) => void) | null = null;
  private texturePlaneMeshes: Mesh[] = [];
  private flatTexturePickPlanes: FlatTexturePickPlane[] = [];
  private flatTexturePickPlanesByYBucket: Map<number, FlatTexturePickPlane[]> = new Map();
  private flatTexturePickPlanesByCell: Map<string, FlatTexturePickPlane[]> = new Map();
  private texturePlanesByChunk: Map<string, Mesh[]> = new Map();
  private texturePlaneRevealEntriesByChunk: Map<string, TexturePlaneRevealEntry[]> = new Map();
  private texturePlaneChunksEnabled: Map<string, boolean> = new Map();
  private textureOverlayMeshesByChunk: Map<string, Mesh[]> = new Map();
  private assetRegistry: Map<string, { path: string }> = new Map();
  private loadedModelCache: Map<string, TransformNode | null> = new Map();
  private loadingModelPromises: Map<string, Promise<TransformNode | null>> = new Map();
  private modelAnimationGroups: Map<string, AnimationGroup[]> = new Map();
  private placedObjectAnimationGroups: WeakMap<TransformNode, AnimationGroup[]> = new WeakMap();
  private oneShotPlacedAnimationGroups: WeakSet<AnimationGroup> = new WeakSet();
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
  private chunkRoofThinInstSources: Map<string, Mesh[]> = new Map();
  private chunkElevatedThinInstSources: Map<string, ElevatedThinInstanceSource[]> = new Map();
  private chunkStructuralThinInstSources: Map<string, ElevatedThinInstanceSource[]> = new Map();

  private doorEdgeKey(floor: number, tileIdx: number): string {
    return `${Math.floor(floor)}:${tileIdx}`;
  }

  private isOneShotPlacedAnimationAsset(assetId: string): boolean {
    return assetId.toLowerCase().replace(/\s+/g, '') === 'spinningwheel';
  }

  private ensureFloorLayer(floor: number): FloorLayerClientData {
    const floorIdx = Math.floor(floor);
    if (floorIdx === 0) throw new Error('ensureFloorLayer() is only valid for non-zero floors');
    let layer = this.floorLayerData.get(floorIdx);
    if (!layer) {
      layer = { walls: new Map(), wallHeights: new Map(), floors: new Map(), stairs: new Map(), roofs: new Map(), tiles: new Map() };
      this.floorLayerData.set(floorIdx, layer);
    }
    return layer;
  }

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

  private scheduleNextFrame(callback: FrameRequestCallback): void {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(callback);
      return;
    }
    window.setTimeout(() => callback(performance.now()), 16);
  }

  private waitForNextFrame(): Promise<void> {
    return new Promise(resolve => this.scheduleNextFrame(() => resolve()));
  }

  private async yieldIfFrameBudgetSpent(slice: { start: number }, budgetMs: number = this.objectChunkFrameBudgetMs): Promise<void> {
    if (performance.now() - slice.start < budgetMs) return;
    await this.waitForNextFrame();
    slice.start = performance.now();
  }

  private enqueueEditorChunkApply(work: () => Promise<void>): Promise<void> {
    const run = this.editorChunkApplyTail.then(async () => {
      await this.waitForNextFrame();
      await work();
    });
    this.editorChunkApplyTail = run.catch(() => {});
    return run;
  }

  private getVisibilityDistanceTiles(paddingTiles: number): number {
    const metaFogEnd = this.meta?.fogEnd ?? (CHUNK_LOAD_RADIUS + 1) * CHUNK_SIZE;
    const sceneFogEnd = Number.isFinite(this.scene.fogEnd) && this.scene.fogEnd > 0
      ? this.scene.fogEnd
      : metaFogEnd;
    const cameraMaxZ = this.scene.activeCamera?.maxZ ?? Number.POSITIVE_INFINITY;
    const limitingDistance = Math.min(sceneFogEnd, cameraMaxZ);
    const baseDistance = Number.isFinite(limitingDistance) ? limitingDistance : sceneFogEnd;
    return Math.max(CHUNK_MIN_RENDER_DISTANCE_TILES, baseDistance + paddingTiles);
  }

  private getRenderDistanceTiles(): number {
    return this.getVisibilityDistanceTiles(CHUNK_RENDER_PADDING_TILES);
  }

  private getObjectRenderDistanceTiles(): number {
    return this.getVisibilityDistanceTiles(OBJECT_RENDER_PADDING_TILES);
  }

  private getRenderDistanceBucket(renderDistance: number): number {
    return Math.floor(renderDistance / CHUNK_RENDER_DISTANCE_BUCKET_TILES);
  }

  private getObjectVisibilityDistanceBucket(renderDistance: number): number {
    return Math.floor(renderDistance / OBJECT_VISIBILITY_BUCKET_TILES);
  }

  private isChunkWithinRenderDistance(
    chunkX: number,
    chunkZ: number,
    playerX: number,
    playerZ: number,
    renderDistance: number,
  ): boolean {
    const minX = chunkX * CHUNK_SIZE;
    const maxX = Math.min(minX + CHUNK_SIZE, this.mapWidth);
    const minZ = chunkZ * CHUNK_SIZE;
    const maxZ = Math.min(minZ + CHUNK_SIZE, this.mapHeight);
    const dx = playerX < minX ? minX - playerX : (playerX > maxX ? playerX - maxX : 0);
    const dz = playerZ < minZ ? minZ - playerZ : (playerZ > maxZ ? playerZ - maxZ : 0);
    return dx * dx + dz * dz <= renderDistance * renderDistance;
  }

  private chunkDistanceFromCenter(key: string, centerChunkX: number, centerChunkZ: number): number {
    const comma = key.indexOf(',');
    const chunkX = Number(key.slice(0, comma));
    const chunkZ = Number(key.slice(comma + 1));
    return Math.max(Math.abs(chunkX - centerChunkX), Math.abs(chunkZ - centerChunkZ));
  }

  private touchTerrainChunk(key: string): void {
    this.chunkLastUsed.set(key, this.chunkCacheTick);
  }

  private touchObjectChunk(key: string): void {
    this.objectChunkLastUsed.set(key, this.chunkCacheTick);
  }

  private isHeavyObjectChunk(key: string): boolean {
    const nodes = this.chunkPlacedNodes.get(key);
    const thinSources = this.chunkThinInstSources.get(key);
    const anims = this.chunkAnimGroups.get(key);
    return (nodes?.length ?? 0) > 0
      || (thinSources?.length ?? 0) > 0
      || (anims?.length ?? 0) > 0;
  }

  private setRenderTreeEnabled(node: TransformNode | null | undefined, enabled: boolean): void {
    if (!node) return;
    const seen = new Set<TransformNode>();
    const apply = (target: TransformNode): void => {
      if (seen.has(target)) return;
      seen.add(target);
      target.setEnabled(enabled);
    };
    apply(node);
    for (const child of node.getChildTransformNodes(false)) apply(child);
    for (const child of node.getChildMeshes(false)) apply(child as unknown as TransformNode);
  }

  private setChunkMeshesEnabled(chunkKey: string, meshes: ChunkMeshes, enabled: boolean): boolean {
    if (this.chunkMeshesEnabled.get(chunkKey) === enabled) return false;
    this.chunkMeshesEnabled.set(chunkKey, enabled);
    meshes.ground.setEnabled(enabled);
    for (const overlay of meshes.overlays) overlay.setEnabled(enabled);
    meshes.water?.setEnabled(enabled);
    meshes.paddyWater?.setEnabled(enabled);
    meshes.cliff?.setEnabled(enabled);
    meshes.ceiling?.setEnabled(enabled);
    meshes.wall?.setEnabled(enabled);
    this.setRenderTreeEnabled(meshes.roof, enabled && this.currentFloor === 0);
    meshes.floor?.setEnabled(enabled);
    meshes.stairs?.setEnabled(enabled);
    for (const [floorIdx, floorSet] of meshes.upperFloors) {
      if (enabled) this.setFloorMeshSetVisibility(floorSet, floorIdx);
      else {
        floorSet.wall?.setEnabled(false);
        this.setRenderTreeEnabled(floorSet.roof, false);
        floorSet.floor?.setEnabled(false);
        floorSet.stairs?.setEnabled(false);
      }
    }
    return true;
  }

  private setTexturePlaneChunkEnabled(chunkKey: string, planes: Mesh[], enabled: boolean): boolean {
    if (this.texturePlaneChunksEnabled.get(chunkKey) === enabled) return false;
    this.texturePlaneChunksEnabled.set(chunkKey, enabled);
    for (const m of planes) m.setEnabled(enabled);
    return planes.length > 0;
  }

  private disposeChunkMeshes(key: string, meshes: ChunkMeshes): void {
    this.clearRoofObjectGridForChunk(this.terrainRoofChunkKey(key));
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
    this.chunkLastUsed.delete(key);
    this.chunkMeshesEnabled.delete(key);
    this.pendingShadowGroundRebuildChunks.delete(key);
    this.disposeChunkPlacedObjects(key);
  }

  /** Resolves once map.json is parsed and the spawn chunk's terrain is built.
   *  Placed objects get a short grace period, but they must not be able to
   *  pin the login overlay forever if a model import stalls. */
  async whenSpawnChunksReady(playerX: number, playerZ: number, timeoutMs: number = 15000): Promise<void> {
    const start = performance.now();
    const objectGraceMs = Math.min(2500, timeoutMs);
    let terrainReadyAt = 0;
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
      const terrainDataReady = this.isGameChunkReady(cx, cz);
      if (terrainDataReady && !this.chunks.has(spawnKey)) {
        this.pendingGameChunks.delete(spawnKey);
        this.queuedGameChunks.add(spawnKey);
        this.residentGameChunks.add(spawnKey);
        this.desiredGameChunks.add(spawnKey);
        this.touchTerrainChunk(spawnKey);
        this.buildQueuedGameChunks(cx, cz);
      }
      const terrainReady = terrainDataReady && this.chunks.has(spawnKey);
      const objectsReady = this.chunkPlacedNodes.has(spawnKey) && !this.loadingObjectChunks.has(spawnKey);
      if (terrainReady && objectsReady) return;
      if (terrainReady) {
        if (terrainReadyAt === 0) terrainReadyAt = performance.now();
        if (performance.now() - terrainReadyAt > objectGraceMs) return;
      }
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
    const metaRes = await authFetch(`/maps/${mapId}/meta.json${cacheBust}`);
    if (isStale()) return;
    this.meta = await metaRes.json() as MapMeta;
    if (isStale()) return;
    this.mapWidth = this.meta.width;
    this.mapHeight = this.meta.height;

    // Fetch KC map data — request chunked mode (metadata only, no tiles/heights)
    const mapRes = await authFetch(`/maps/${mapId}/map.json${joinCb}chunked=1`);
    if (isStale()) return;
    const mapFile: KCMapFile = await mapRes.json();
    if (isStale()) return;
    this.mapData = mapFile.map;
    if (this.mapData.mapType && !this.meta.mapType) {
      this.meta.mapType = this.mapData.mapType;
    }
    this.defaultGround = defaultGroundForMap(this.mapData);
    this.activeChunks = Array.isArray(this.mapData.activeChunks)
      ? new Set(this.mapData.activeChunks)
      : null;
    this.buildChunkWaterLevelCache();

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
          if (this.activeChunks && !this.activeChunks.has(`${Math.floor(x / EDITOR_CHUNK_SIZE)},${Math.floor(z / EDITOR_CHUNK_SIZE)}`)) {
            this.tileTypes[z * this.mapWidth + x] = TileType.WALL;
            continue;
          }
          const tile = this.getTileRaw(x, z);
          if (!tile) { this.tileTypes[z * this.mapWidth + x] = this.defaultGround === 'void' ? TileType.WALL : TileType.GRASS; continue; }
          const corners = this.getTileCornerHeights(x, z);
          const wl = this.getChunkWaterLevel(x, z);
          this.tileTypes[z * this.mapWidth + x] = classifyTileType(tile, corners, wl);
        }
      }
      this.rebuildTorchlightPaintIndex();
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
    this.rootWallShadowRunsCache = null;
    this.shootOverProjectileWallEdges = new Uint8Array(this.mapWidth * this.mapHeight);
    this.wallHeights.clear();
    this.floorHeights.clear();
    this.stairData.clear();
    this.roofData.clear();
    this.holeTiles.clear();
    this.floorLayerData.clear();
    this.currentFloor = 0;
    try {
      const wallsRes = await fetchOptionalMapResource(`/maps/${mapId}/walls.json${cacheBust}`, `${mapId}/walls.json`);
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
        const loadNumberMap = (record: Record<string, unknown> | undefined, target: Map<number, number>): void => {
          if (!record) return;
          for (const [key, value] of Object.entries(record)) {
            const idx = parseKey(key);
            const n = Number(value);
            if (idx !== null && Number.isFinite(n)) target.set(idx, n);
          }
        };
        const loadValueMap = <T>(record: Record<string, T> | undefined, target: Map<number, T>): void => {
          if (!record) return;
          for (const [key, value] of Object.entries(record)) {
            const idx = parseKey(key);
            if (idx !== null) target.set(idx, value as T);
          }
        };
        for (const [key, mask] of Object.entries(wallsData.walls ?? {})) {
          const idx = parseKey(key);
          if (idx !== null) this.walls[idx] = mask;
        }
        loadNumberMap(wallsData.wallHeights, this.wallHeights);
        loadNumberMap(wallsData.floors, this.floorHeights);
        loadValueMap(wallsData.roofs, this.roofData);
        if (wallsData.holes) for (const key of Object.keys(wallsData.holes)) { const idx = parseKey(key); if (idx !== null) this.holeTiles.add(idx); }
        if (wallsData.floorLayers) {
          for (const [floorStr, ld] of Object.entries(wallsData.floorLayers)) {
            const floorIdx = parseInt(floorStr as string);
            const layer: FloorLayerClientData = { walls: new Map(), wallHeights: new Map(), floors: new Map(), stairs: new Map(), roofs: new Map(), tiles: new Map() };
            const ldd = ld as FloorLayerData;
            loadNumberMap(ldd.tiles, layer.tiles);
            loadNumberMap(ldd.walls, layer.walls);
            loadNumberMap(ldd.wallHeights, layer.wallHeights);
            loadNumberMap(ldd.floors, layer.floors);
            loadValueMap(ldd.roofs, layer.roofs);
            this.floorLayerData.set(floorIdx, layer);
          }
        }
      }
    } catch (e) {
      if (isMapResourceFetchError(e)) throw e;
      // Missing or malformed walls.json is legacy-compatible; protected-resource
      // failures are rethrown above so they can't masquerade as an empty map.
    }

    // Create shared materials
    if (!this.groundMat) {
      this.groundMat = new StandardMaterial('chunkGroundMat', this.scene);
      this.groundMat.specularColor = new Color3(0, 0, 0);
      this.groundMat.emissiveColor = new Color3(0.2, 0.2, 0.2);
    }
    if (!this.waterMat) {
      this.waterMat = new StandardMaterial('chunkWaterMat', this.scene);
      this.waterMat.specularColor = new Color3(0, 0, 0);
      this.waterMat.alpha = WATER_TEXTURE_ALPHA;
      this.waterMat.transparencyMode = Material.MATERIAL_ALPHABLEND;
      this.waterMat.backFaceCulling = false;
      this.waterMat.diffuseColor = rgbToColor3(WATER_TEXTURE_TINT);
      // Load water texture
      this.waterTexture = new Texture('/assets/textures/1.png', this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
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
      this.paddyWaterMat.diffuseColor = rgbToColor3(SURFACE_WATER_TEXTURE_TINT);
      this.paddyWaterMat.alpha = SURFACE_WATER_ALPHA;
      this.paddyWaterMat.transparencyMode = Material.MATERIAL_ALPHABLEND;
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
    if (!hasFullTiles) {
      await this.loadObjectChunkManifest(mapId, cacheBust);
      if (isStale()) return;
    }

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
      this.applyCollisionWallShadows(this.shadowInf, sw, sw - 1, sh - 1);
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
    if (import.meta.env.DEV && derivedTotal > 0) {
      console.log(`[ChunkManager] Derived ${derivedTotal} upper-floor walkable tiles across ${derivedFloors.size} floor(s) from texture planes`);
    }

    this.loaded = true;
    this.lastChunkX = -999;
    this.lastChunkZ = -999;
    this.lastRenderDistanceBucket = -999;
    if (import.meta.env.DEV) console.log(`[ChunkManager] Loaded map '${mapId}': ${this.mapWidth}x${this.mapHeight}, tiles: ${this.mapData?.tiles?.length}, heights: ${this.mapData?.heights?.length}, waterLevel: ${this.mapData?.waterLevel}`);
  }

  // --- KC data accessors ---

  private getTileRaw(x: number, z: number): KCTile | null {
    if (!this.mapData) return null;
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return null;
    return this.mapData.tiles[z]?.[x] ?? null;
  }

  private getBaseGroundType(x: number, z: number): GroundType {
    const tile = this.getTileRaw(x, z);
    return tile?.ground ?? this.defaultGround;
  }

  private tileHasTorchlightPaint(x: number, z: number): boolean {
    if (x < 0 || z < 0 || x >= this.mapWidth || z >= this.mapHeight) return false;
    return this.torchlightPaintTiles.has(z * this.mapWidth + x);
  }

  private noteTorchlightPaintTile(x: number, z: number, tile: KCTile | null | undefined): void {
    if (x < 0 || z < 0 || x >= this.mapWidth || z >= this.mapHeight) return;
    const idx = z * this.mapWidth + x;
    if (hasTorchlightPaint(tile?.ground, tile?.groundB)) {
      this.torchlightPaintTiles.add(idx);
    } else {
      this.torchlightPaintTiles.delete(idx);
    }
  }

  private rebuildTorchlightPaintIndex(): void {
    this.torchlightPaintTiles.clear();
    for (let z = 0; z < this.mapHeight; z++) {
      for (let x = 0; x < this.mapWidth; x++) {
        this.noteTorchlightPaintTile(x, z, this.getTileRaw(x, z));
      }
    }
  }

  private getVisualBaseGroundType(x: number, z: number): GroundType {
    const tile = this.getTileRaw(x, z);
    return visualGroundForTorchlight(tile?.ground ?? this.defaultGround, tile?.groundB ?? null);
  }

  private collectTorchlightPaintTilesForRegion(startX: number, startZ: number, endX: number, endZ: number): TorchlightPaintTile[] {
    if (this.torchlightPaintTiles.size === 0) return [];
    const pad = Math.ceil(TORCHLIGHT_GLOW_RADIUS_TILES);
    const minX = Math.max(0, startX - pad);
    const maxX = Math.min(this.mapWidth - 1, endX + pad - 1);
    const minZ = Math.max(0, startZ - pad);
    const maxZ = Math.min(this.mapHeight - 1, endZ + pad - 1);
    const out: TorchlightPaintTile[] = [];

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (!this.tileHasTorchlightPaint(x, z)) continue;
        out.push({ x, z });
      }
    }

    return out;
  }

  private buildTorchlightGridForRegion(startX: number, startZ: number, endX: number, endZ: number): TorchlightInfluenceGrid | null {
    return buildTorchlightInfluenceGrid(
      startX,
      startZ,
      endX,
      endZ,
      this.collectTorchlightPaintTilesForRegion(startX, startZ, endX, endZ),
    );
  }

  private getChunkWaterLevel(tileX: number, tileZ: number): number {
    const levels = this.chunkWaterLevelCache;
    if (!levels || tileX < 0 || tileZ < 0) return this.defaultWaterLevel;
    const chunkX = Math.floor(tileX / EDITOR_CHUNK_SIZE);
    const chunkZ = Math.floor(tileZ / EDITOR_CHUNK_SIZE);
    if (chunkX >= this.chunkCols || chunkZ >= this.chunkRows) return this.defaultWaterLevel;
    return levels[chunkZ * this.chunkCols + chunkX];
  }

  private getChunkWaterFlow(tileX: number, tileZ: number): WaterFlow {
    if (!this.mapData || tileX < 0 || tileZ < 0) return normalizeWaterFlow(null);
    const chunkX = Math.floor(tileX / EDITOR_CHUNK_SIZE);
    const chunkZ = Math.floor(tileZ / EDITOR_CHUNK_SIZE);
    return normalizeWaterFlow(this.mapData.chunkWaterFlows?.[`${chunkX},${chunkZ}`]);
  }

  private getWaterFlowTransform(tileX: number, tileZ: number, scale: number, cache: Map<string, WaterFlowUvTransform>): WaterFlowUvTransform {
    const chunkX = Math.floor(tileX / EDITOR_CHUNK_SIZE);
    const chunkZ = Math.floor(tileZ / EDITOR_CHUNK_SIZE);
    const key = `${chunkX},${chunkZ}`;
    let transform = cache.get(key);
    if (!transform) {
      transform = waterFlowUvTransform(this.getChunkWaterFlow(tileX, tileZ), scale);
      cache.set(key, transform);
    }
    return transform;
  }

  private buildChunkWaterLevelCache(): void {
    if (!this.mapData) {
      this.defaultWaterLevel = -0.3;
      this.chunkCols = 0;
      this.chunkRows = 0;
      this.chunkWaterLevelCache = null;
      return;
    }

    this.defaultWaterLevel = this.mapData.waterLevel ?? -0.3;
    this.chunkCols = Math.ceil(this.mapWidth / EDITOR_CHUNK_SIZE);
    this.chunkRows = Math.ceil(this.mapHeight / EDITOR_CHUNK_SIZE);
    const levels = new Float32Array(this.chunkCols * this.chunkRows);
    levels.fill(this.defaultWaterLevel);

    for (const [key, level] of Object.entries(this.mapData.chunkWaterLevels ?? {})) {
      const comma = key.indexOf(',');
      if (comma < 1) continue;
      const chunkX = Number(key.slice(0, comma));
      const chunkZ = Number(key.slice(comma + 1));
      if (!Number.isInteger(chunkX) || !Number.isInteger(chunkZ)) continue;
      if (chunkX < 0 || chunkZ < 0 || chunkX >= this.chunkCols || chunkZ >= this.chunkRows) continue;
      levels[chunkZ * this.chunkCols + chunkX] = level;
    }

    this.chunkWaterLevelCache = levels;
  }

  private shouldRenderWater(x: number, z: number): boolean {
    const tile = this.getTileRaw(x, z);
    if (!tile) return false;
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

  private getCornerBlendedColor(cornerX: number, cornerZ: number, shade: number): RGB {
    const sharingTiles: [number, number][] = [[cornerX - 1, cornerZ - 1], [cornerX, cornerZ - 1], [cornerX - 1, cornerZ], [cornerX, cornerZ]];
    let r = 0, g = 0, b = 0, noise = 0, totalWeight = 0;
    for (const [nx, nz] of sharingTiles) {
      if (!this.getTileRaw(nx, nz)) continue;
      const type = this.getVisualBaseGroundType(nx, nz);
      if (type === 'void') continue;
      if (type === 'road') continue;
      const c = groundColor(type, 1.0);
      r += c.r; g += c.g; b += c.b;
      noise += getNoiseExtra(type, cornerX, cornerZ);
      totalWeight += 1;
    }
    if (totalWeight === 0) return groundColor(this.defaultGround, shade);
    const s = shade + noise / totalWeight;
    return { r: (r / totalWeight) * s, g: (g / totalWeight) * s, b: (b / totalWeight) * s };
  }

  // --- Chunk update ---

  private updateObjectChunkVisibility(
    playerX: number,
    playerZ: number,
    centerChunkX: number,
    centerChunkZ: number,
    force: boolean = false,
  ): boolean {
    const objectRenderDistance = this.getObjectRenderDistanceTiles();
    const bucketX = Math.floor(playerX / OBJECT_VISIBILITY_BUCKET_TILES);
    const bucketZ = Math.floor(playerZ / OBJECT_VISIBILITY_BUCKET_TILES);
    const distanceBucket = this.getObjectVisibilityDistanceBucket(objectRenderDistance);
    if (
      !force &&
      bucketX === this.lastObjectBucketX &&
      bucketZ === this.lastObjectBucketZ &&
      distanceBucket === this.lastObjectDistanceBucket
    ) {
      return false;
    }

    this.lastObjectBucketX = bucketX;
    this.lastObjectBucketZ = bucketZ;
    this.lastObjectDistanceBucket = distanceBucket;

    const objectDesired = new Set<string>();
    const objectLoad = new Set<string>();
    const maxCX = Math.ceil(this.mapWidth / CHUNK_SIZE);
    const maxCZ = Math.ceil(this.mapHeight / CHUNK_SIZE);
    for (let dx = -CHUNK_LOAD_RADIUS; dx <= CHUNK_LOAD_RADIUS; dx++) {
      for (let dz = -CHUNK_LOAD_RADIUS; dz <= CHUNK_LOAD_RADIUS; dz++) {
        const chunkX = centerChunkX + dx;
        const chunkZ = centerChunkZ + dz;
        if (chunkX < 0 || chunkX >= maxCX || chunkZ < 0 || chunkZ >= maxCZ) continue;
        const key = `${chunkX},${chunkZ}`;

        const visibleDistance = objectRenderDistance + (this.chunkPlacedEnabled.get(key) === true ? OBJECT_RENDER_HYSTERESIS_TILES : 0);
        if (this.isChunkWithinRenderDistance(chunkX, chunkZ, playerX, playerZ, visibleDistance)) {
          objectDesired.add(key);
        }

        const loadDistance = objectRenderDistance + OBJECT_PREFETCH_PADDING_TILES;
        if (this.isChunkWithinRenderDistance(chunkX, chunkZ, playerX, playerZ, loadDistance)) {
          objectLoad.add(key);
        }
      }
    }

    const centerKey = `${centerChunkX},${centerChunkZ}`;
    objectDesired.add(centerKey);
    objectLoad.add(centerKey);
    this.desiredObjectChunks = objectDesired;
    this.objectLoadChunks = objectLoad;

    let changed = false;
    // Visibility is independent from terrain mesh visibility so fog-padding
    // terrain does not force expensive placed objects on. Chunks outside the
    // active object window stay cached until the object LRU evicts them.
    for (const key of this.chunkPlacedNodes.keys()) {
      if (objectLoad.has(key) || objectDesired.has(key)) this.touchObjectChunk(key);
      changed = this.setChunkPlacedObjectsEnabled(key, objectDesired.has(key)) || changed;
    }

    // Hidden prefetch warms nearby object chunks once their terrain exists.
    // This shifts one-time GLB instantiation away from the exact visibility
    // edge and prevents walking back over that edge from reloading anything.
    for (const key of objectLoad) {
      if (this.chunks.has(key) && !this.chunkPlacedNodes.has(key) && !this.loadingObjectChunks.has(key)) {
        this.touchObjectChunk(key);
        this.queueChunkPlacedObjects(key);
      }
    }

    changed = this.evictObjectChunkCache(centerChunkX, centerChunkZ, objectLoad) || changed;

    return changed;
  }

  updatePlayerPosition(playerX: number, playerZ: number): boolean {
    this.lastUpdateTerrainChanged = false;
    this.lastUpdateObjectsChanged = false;
    if (!this.loaded) { return false; }
    this.chunkCacheTick++;
    const cx = Math.floor(playerX / CHUNK_SIZE);
    const cz = Math.floor(playerZ / CHUNK_SIZE);
    const renderDistance = this.getRenderDistanceTiles();
    const renderDistanceBucket = this.getRenderDistanceBucket(renderDistance);
    if (
      cx === this.lastChunkX &&
      cz === this.lastChunkZ &&
      renderDistanceBucket === this.lastRenderDistanceBucket
    ) {
      const objectChanged = this.updateObjectChunkVisibility(playerX, playerZ, cx, cz);
      const buildResult = this.buildQueuedGameChunks(cx, cz);
      const evictedObjects = buildResult.built ? this.evictTerrainChunkCache(cx, cz, this.residentGameChunks) : false;
      this.lastUpdateTerrainChanged = buildResult.visible;
      this.lastUpdateObjectsChanged = objectChanged || evictedObjects;
      return this.lastUpdateTerrainChanged || this.lastUpdateObjectsChanged;
    }
    this.lastChunkX = cx;
    this.lastChunkZ = cz;
    this.lastRenderDistanceBucket = renderDistanceBucket;

    // `resident` = stable local scene window whose tile/height data and meshes
    //              should exist, even if some meshes stay hidden by fog range.
    // `desired` = chunks whose meshes should be visible now. This is clipped
    //             by fog/camera distance so fully fog-hidden scenery doesn't
    //             spend active-mesh, draw-call, or instantiation budget.
    const resident = new Set<string>();
    const desired = new Set<string>();
    const maxCX = Math.ceil(this.mapWidth / CHUNK_SIZE);
    const maxCZ = Math.ceil(this.mapHeight / CHUNK_SIZE);
    for (let dx = -CHUNK_RESIDENT_RADIUS; dx <= CHUNK_RESIDENT_RADIUS; dx++) {
      for (let dz = -CHUNK_RESIDENT_RADIUS; dz <= CHUNK_RESIDENT_RADIUS; dz++) {
        const chunkX = cx + dx;
        const chunkZ = cz + dz;
        if (chunkX < 0 || chunkX >= maxCX || chunkZ < 0 || chunkZ >= maxCZ) continue;
        const key = `${chunkX},${chunkZ}`;
        resident.add(key);
        if (this.isChunkWithinRenderDistance(chunkX, chunkZ, playerX, playerZ, renderDistance)) {
          desired.add(key);
        }
      }
    }
    const centerKey = `${cx},${cz}`;
    if (resident.has(centerKey)) desired.add(centerKey);
    this.desiredGameChunks = desired;
    this.residentGameChunks = resident;
    for (const key of resident) this.touchTerrainChunk(key);

    let terrainChanged = false;

    // Keep cached chunk meshes allocated. Visibility changes are cheap; actual
    // disposal is handled by evictTerrainChunkCache below.
    for (const [key, meshes] of this.chunks) {
      if (desired.has(key)) {
        terrainChanged = this.setChunkMeshesEnabled(key, meshes, true) || terrainChanged;
        this.touchTerrainChunk(key);
      } else {
        terrainChanged = this.setChunkMeshesEnabled(key, meshes, false) || terrainChanged;
      }
    }

    // Toggle texture planes by chunk — these are loaded globally so may exist
    // in chunks that don't have terrain meshes in this.chunks.
    for (const [key, planes] of this.texturePlanesByChunk) {
      terrainChanged = this.setTexturePlaneChunkEnabled(key, planes, desired.has(key)) || terrainChanged;
    }

    // In chunked mode, trigger on-demand loading of needed editor chunks
    if (this.chunkedMode) {
      const ECHUNK = EDITOR_CHUNK_SIZE;
      const neededEditorChunks = new Set<string>();
      for (const key of resident) {
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

    for (const key of resident) {
      if (!this.chunks.has(key)) {
        const [chunkX, chunkZ] = key.split(',').map(Number);
        // Skip if entire game chunk falls in an inactive editor chunk
        if (this.activeChunks) {
          const ecx = Math.floor((chunkX * CHUNK_SIZE) / EDITOR_CHUNK_SIZE);
          const ecz = Math.floor((chunkZ * CHUNK_SIZE) / EDITOR_CHUNK_SIZE);
          // Check all editor chunks this game chunk could overlap
          const ecx2 = Math.floor(((chunkX + 1) * CHUNK_SIZE - 1) / EDITOR_CHUNK_SIZE);
          const ecz2 = Math.floor(((chunkZ + 1) * CHUNK_SIZE - 1) / EDITOR_CHUNK_SIZE);
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
    // Clean up pending chunks outside the stable resident window.
    for (const key of this.pendingGameChunks) {
      if (!resident.has(key)) this.pendingGameChunks.delete(key);
    }
    for (const key of this.queuedGameChunks) {
      if (!resident.has(key)) this.queuedGameChunks.delete(key);
    }
    const objectChanged = this.updateObjectChunkVisibility(playerX, playerZ, cx, cz, true);
    const buildResult = this.buildQueuedGameChunks(cx, cz);
    const evictedObjects = this.evictTerrainChunkCache(cx, cz, resident);
    this.lastUpdateTerrainChanged = terrainChanged || buildResult.visible;
    this.lastUpdateObjectsChanged = objectChanged || evictedObjects;
    return this.lastUpdateTerrainChanged || this.lastUpdateObjectsChanged;
  }

  forceRefreshPlayerPosition(playerX: number, playerZ: number): boolean {
    this.lastChunkX = -999;
    this.lastChunkZ = -999;
    this.lastObjectBucketX = -999;
    this.lastObjectBucketZ = -999;
    this.lastObjectDistanceBucket = -999;
    return this.updatePlayerPosition(playerX, playerZ);
  }

  didLastUpdateChangeTerrain(): boolean {
    return this.lastUpdateTerrainChanged;
  }

  didLastUpdateChangeObjects(): boolean {
    return this.lastUpdateObjectsChanged;
  }

  // --- On-demand editor chunk loading ---

  /** Check if all editor chunks needed by a game chunk are loaded */
  private isGameChunkReady(gcx: number, gcz: number): boolean {
    // Legacy mode: all data was loaded upfront, always ready
    if (!this.chunkedMode) return true;
    const ECHUNK = EDITOR_CHUNK_SIZE;
    // Check the small editor-chunk range this game chunk overlaps, including
    // the +1 vertex-blending margin. Avoid scanning every tile in the game
    // chunk; this runs from the streaming queue hot path.
    const startX = Math.max(0, gcx * CHUNK_SIZE - 1);
    const endX = Math.min(this.mapWidth - 1, (gcx + 1) * CHUNK_SIZE);
    const startZ = Math.max(0, gcz * CHUNK_SIZE - 1);
    const endZ = Math.min(this.mapHeight - 1, (gcz + 1) * CHUNK_SIZE);
    const minECX = Math.floor(startX / ECHUNK);
    const maxECX = Math.floor(endX / ECHUNK);
    const minECZ = Math.floor(startZ / ECHUNK);
    const maxECZ = Math.floor(endZ / ECHUNK);
    for (let ecz = minECZ; ecz <= maxECZ; ecz++) {
      for (let ecx = minECX; ecx <= maxECX; ecx++) {
        if (!this.loadedEditorChunks.has(`${ecx},${ecz}`)) return false;
      }
    }
    return true;
  }

  /** Build any pending game chunks whose editor chunk data is now available */
  private buildPendingGameChunks(): void {
    for (const key of this.pendingGameChunks) {
      const [cx, cz] = key.split(',').map(Number);
      if (this.isGameChunkReady(cx, cz)) {
        this.pendingGameChunks.delete(key);
        if (this.residentGameChunks.size === 0 || this.residentGameChunks.has(key)) {
          this.queuedGameChunks.add(key);
        }
      }
    }
  }

  private buildQueuedGameChunks(centerChunkX: number, centerChunkZ: number): ChunkBuildResult {
    if (this.queuedGameChunks.size === 0) return { built: false, visible: false };
    let bestVisibleKey: string | null = null;
    let bestVisibleDist = Infinity;
    let bestHiddenKey: string | null = null;
    let bestHiddenDist = Infinity;
    for (const key of this.queuedGameChunks) {
      if (this.chunks.has(key)) {
        this.queuedGameChunks.delete(key);
        continue;
      }
      if (this.residentGameChunks.size > 0 && !this.residentGameChunks.has(key)) {
        this.queuedGameChunks.delete(key);
        continue;
      }
      const [cx, cz] = key.split(',').map(Number);
      if (!this.isGameChunkReady(cx, cz)) {
        this.pendingGameChunks.add(key);
        this.queuedGameChunks.delete(key);
        continue;
      }
      const dist = Math.max(Math.abs(cx - centerChunkX), Math.abs(cz - centerChunkZ));
      const visible = this.desiredGameChunks.size === 0 || this.desiredGameChunks.has(key);
      if (visible) {
        if (dist < bestVisibleDist) {
          bestVisibleDist = dist;
          bestVisibleKey = key;
        }
      } else if (dist < bestHiddenDist) {
        bestHiddenDist = dist;
        bestHiddenKey = key;
      }
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let bestKey = bestVisibleKey;
    if (bestKey) {
      const centerKey = `${centerChunkX},${centerChunkZ}`;
      if (bestKey !== centerKey && now - this.lastVisibleGameChunkBuildAt < VISIBLE_CHUNK_BUILD_INTERVAL_MS) {
        return { built: false, visible: false };
      }
      this.lastVisibleGameChunkBuildAt = now;
    }
    if (!bestKey && bestHiddenKey) {
      if (now - this.lastHiddenGameChunkBuildAt < HIDDEN_CHUNK_BUILD_INTERVAL_MS) return { built: false, visible: false };
      this.lastHiddenGameChunkBuildAt = now;
      bestKey = bestHiddenKey;
    }
    if (!bestKey) return { built: false, visible: false };

    this.queuedGameChunks.delete(bestKey);
    const [cx, cz] = bestKey.split(',').map(Number);
    const meshes = this.buildChunkMeshes(cx, cz);
    this.chunks.set(bestKey, meshes);
    this.touchTerrainChunk(bestKey);
    const visible = this.desiredGameChunks.size === 0 || this.desiredGameChunks.has(bestKey);
    this.setChunkMeshesEnabled(bestKey, meshes, visible);
    if (this.objectLoadChunks.has(bestKey) && !this.chunkPlacedNodes.has(bestKey) && !this.loadingObjectChunks.has(bestKey)) {
      this.touchObjectChunk(bestKey);
      this.queueChunkPlacedObjects(bestKey);
    }
    return { built: true, visible };
  }

  private evictTerrainChunkCache(centerChunkX: number, centerChunkZ: number, resident: Set<string>): boolean {
    let evictedObjectContent = false;
    const evictKeys: string[] = [];
    for (const key of this.chunks.keys()) {
      if (resident.has(key)) continue;
      if (this.chunkDistanceFromCenter(key, centerChunkX, centerChunkZ) > CHUNK_CACHE_RADIUS) {
        evictKeys.push(key);
      }
    }

    for (const key of evictKeys) {
      const meshes = this.chunks.get(key);
      if (meshes) {
        evictedObjectContent = this.isHeavyObjectChunk(key) || evictedObjectContent;
        this.disposeChunkMeshes(key, meshes);
      }
    }

    if (this.chunks.size <= CHUNK_MESH_CACHE_MAX_CHUNKS) return evictedObjectContent;
    const candidates = [...this.chunks.keys()]
      .filter(key => !resident.has(key))
      .sort((a, b) => {
        const lastA = this.chunkLastUsed.get(a) ?? 0;
        const lastB = this.chunkLastUsed.get(b) ?? 0;
        if (lastA !== lastB) return lastA - lastB;
        return this.chunkDistanceFromCenter(b, centerChunkX, centerChunkZ) - this.chunkDistanceFromCenter(a, centerChunkX, centerChunkZ);
      });

    for (const key of candidates) {
      if (this.chunks.size <= CHUNK_MESH_CACHE_MAX_CHUNKS) break;
      const meshes = this.chunks.get(key);
      if (meshes) {
        evictedObjectContent = this.isHeavyObjectChunk(key) || evictedObjectContent;
        this.disposeChunkMeshes(key, meshes);
      }
    }

    return evictedObjectContent;
  }

  private evictObjectChunkCache(centerChunkX: number, centerChunkZ: number, protectedChunks: Set<string>): boolean {
    let evicted = false;
    const evictKeys: string[] = [];
    for (const key of this.chunkPlacedNodes.keys()) {
      if (protectedChunks.has(key) || this.loadingObjectChunks.has(key) || this.queuedObjectChunks.has(key)) continue;
      if (this.chunkDistanceFromCenter(key, centerChunkX, centerChunkZ) > OBJECT_CHUNK_CACHE_RADIUS) {
        evictKeys.push(key);
      }
    }

    for (const key of evictKeys) {
      evicted = true;
      this.disposeChunkPlacedObjects(key);
    }

    let heavyCount = 0;
    for (const key of this.chunkPlacedNodes.keys()) {
      if (this.isHeavyObjectChunk(key)) heavyCount++;
    }
    if (heavyCount <= OBJECT_CHUNK_CACHE_MAX_CHUNKS) return evicted;

    const candidates = [...this.chunkPlacedNodes.keys()]
      .filter(key => !protectedChunks.has(key) && !this.loadingObjectChunks.has(key) && !this.queuedObjectChunks.has(key) && this.isHeavyObjectChunk(key))
      .sort((a, b) => {
        const lastA = this.objectChunkLastUsed.get(a) ?? 0;
        const lastB = this.objectChunkLastUsed.get(b) ?? 0;
        if (lastA !== lastB) return lastA - lastB;
        return this.chunkDistanceFromCenter(b, centerChunkX, centerChunkZ) - this.chunkDistanceFromCenter(a, centerChunkX, centerChunkZ);
      });

    for (const key of candidates) {
      if (heavyCount <= OBJECT_CHUNK_CACHE_MAX_CHUNKS) break;
      if (this.isHeavyObjectChunk(key)) heavyCount--;
      evicted = true;
      this.disposeChunkPlacedObjects(key);
    }

    return evicted;
  }

  /** Load tile/height data for a single 64x64 editor chunk from the server */
  private async loadEditorChunk(ecx: number, ecz: number): Promise<void> {
    const key = `${ecx},${ecz}`;
    if (this.loadedEditorChunks.has(key) || this.loadingEditorChunks.has(key)) return;
    if (this.activeChunks && !this.activeChunks.has(key)) {
      this.loadedEditorChunks.add(key);
      this.buildPendingGameChunks();
      return;
    }
    this.loadingEditorChunks.add(key);

    const ECHUNK = EDITOR_CHUNK_SIZE;
    const mapId = this.mapId;
    const generation = this.loadMapToken;

    try {
      // Fetch tiles and heights in parallel (missing chunks return 404 — that's OK)
      const [tilesRes, heightsRes] = await Promise.all([
        fetchOptionalMapResource(`/maps/${mapId}/tiles/chunk_${ecx}_${ecz}.json`, `${mapId}/tiles/chunk_${ecx}_${ecz}.json`),
        fetchOptionalMapResource(`/maps/${mapId}/heights/chunk_${ecx}_${ecz}.json`, `${mapId}/heights/chunk_${ecx}_${ecz}.json`),
      ]);
      const startX = ecx * ECHUNK, startZ = ecz * ECHUNK;
      const endX = Math.min(startX + ECHUNK, this.mapWidth);
      const endZ = Math.min(startZ + ECHUNK, this.mapHeight);

      await this.enqueueEditorChunkApply(async () => {
        if (generation !== this.loadMapToken || mapId !== this.mapId) return;
        if (!this.mapData || !this.tileTypes) return;

        // Populate heights
        if (heightsRes?.ok) {
          const hData: Record<string, number> = await heightsRes.json();
          if (generation !== this.loadMapToken || mapId !== this.mapId) return;
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
        for (let gz = startZ; gz < endZ; gz++) {
          if (!this.mapData.tiles[gz]) this.mapData.tiles[gz] = [];
          for (let gx = startX; gx < endX; gx++) {
            if (!this.mapData.tiles[gz][gx]) {
              this.mapData.tiles[gz][gx] = this.expandTile({});
            }
          }
        }
        if (tilesRes?.ok) {
          const tData: Record<string, Partial<KCTile>> = await tilesRes.json();
          if (generation !== this.loadMapToken || mapId !== this.mapId) return;
          for (const [k, partial] of Object.entries(tData)) {
            const [lz, lx] = k.split(',').map(Number);
            const gx = startX + lx, gz = startZ + lz;
            if (gx < this.mapWidth && gz < this.mapHeight) {
              const expanded = this.expandTile(partial);
              this.mapData.tiles[gz][gx] = expanded;
              this.noteTorchlightPaintTile(gx, gz, expanded);
            }
          }
        }

        // Populate tileTypes for this region
        for (let z = startZ; z < endZ; z++) {
          for (let x = startX; x < endX; x++) {
            if (this.activeChunks && !this.activeChunks.has(`${Math.floor(x / EDITOR_CHUNK_SIZE)},${Math.floor(z / EDITOR_CHUNK_SIZE)}`)) {
              this.tileTypes[z * this.mapWidth + x] = TileType.WALL;
              continue;
            }
            const tile = this.getTileRaw(x, z);
            if (!tile) { this.tileTypes[z * this.mapWidth + x] = this.defaultGround === 'void' ? TileType.WALL : TileType.GRASS; continue; }
            const corners = this.getTileCornerHeights(x, z);
            const wl = this.getChunkWaterLevel(x, z);
            this.tileTypes[z * this.mapWidth + x] = classifyTileType(tile, corners, wl);
          }
        }

        this.loadedEditorChunks.add(key);

        // Re-register texture plane bridges for tiles in this chunk only
        // (chunk loading may set WATER tile types that need bridge override)
        this.registerTexturePlaneFloorsInRegion(startX, startZ, endX, endZ);

        // Mark dependent game chunks as buildable; actual mesh creation is
        // left to the render-loop queue so fetch completions cannot stack
        // multiple terrain builds into one frame.
        this.buildPendingGameChunks();
      });
    } catch (e) {
      console.warn(`[ChunkManager] Failed to load editor chunk ${key}:`, e);
    } finally {
      this.loadingEditorChunks.delete(key);
    }
  }

  /** Expand a sparse/partial tile object into a full KCTile */
  private expandTile(partial: Partial<KCTile>): KCTile {
    return {
      ground: partial.ground ?? this.defaultGround,
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
      textureCutOffset: partial.textureCutOffset ?? 0,
      waterPainted: partial.waterPainted ?? false,
      waterSurface: partial.waterSurface ?? false,
      waterSurfaceB: partial.waterSurfaceB ?? partial.waterSurface ?? false,
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

  private pushTorchlightSubdividedTile(
    positions: number[],
    colors: number[],
    indices: number[],
    grid: TorchlightInfluenceGrid | null,
    base: number,
    h: { tl: number; tr: number; bl: number; br: number },
    x: number,
    z: number,
    cTL: RGB,
    cTR: RGB,
    cBL: RGB,
    cBR: RGB,
  ): number {
    const steps = TORCHLIGHT_GLOW_SUBDIVISIONS;
    const row = steps + 1;

    for (let vz = 0; vz <= steps; vz++) {
      const v = vz / steps;
      for (let ux = 0; ux <= steps; ux++) {
        const u = ux / steps;
        const color = bilerpRGB(cTL, cTR, cBL, cBR, u, v);
        applyTorchlightTint(color, sampleTorchlightInfluenceGrid(grid, x + u, z + v));
        positions.push(x + u, bilerpCorners(h.tl, h.tr, h.bl, h.br, u, v), z + v);
        colors.push(color.r, color.g, color.b, 1);
      }
    }

    for (let vz = 0; vz < steps; vz++) {
      for (let ux = 0; ux < steps; ux++) {
        const tl = base + vz * row + ux;
        const tr = tl + 1;
        const bl = base + (vz + 1) * row + ux;
        const br = bl + 1;
        indices.push(tl, tr, bl, tr, br, bl);
      }
    }

    return row * row;
  }

  private buildGroundMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh {
    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    const torchlightGrid = this.buildTorchlightGridForRegion(startX, startZ, endX, endZ);
    let vertexIndex = 0;

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        if (this.activeChunks && !this.activeChunks.has(`${Math.floor(x / EDITOR_CHUNK_SIZE)},${Math.floor(z / EDITOR_CHUNK_SIZE)}`)) continue;
        if (this.holeTiles.has(z * this.mapWidth + x)) continue; // skip ground for terrain holes
        const tile = this.getTileRaw(x, z);
        const tileType = tile?.ground ?? this.defaultGround;
        if (tileType === 'void') continue;
        const h = this.getTileCornerHeights(x, z);
        const splitDir = tile?.split ?? 'forward';
        const rawGroundBType = tile?.groundB ?? null;
        const isTorchlightPaint = hasTorchlightPaint(tileType, rawGroundBType);
        const renderTileType = visualGroundForTorchlight(tileType, rawGroundBType);
        const groundBType = rawGroundBType && !isTorchlightPaint ? rawGroundBType : null;

        // Compute per-vertex shading
        const shadeTL = this.getVertexSlopeShade(x, z);
        const shadeTR = this.getVertexSlopeShade(x + 1, z);
        const shadeBL = this.getVertexSlopeShade(x, z + 1);
        const shadeBR = this.getVertexSlopeShade(x + 1, z + 1);
        const slopeShade = (shadeTL + shadeTR + shadeBL + shadeBR) / 4;

        let cTL: RGB, cTR: RGB, cBL: RGB, cBR: RGB;

        if (groundBType && groundBType !== renderTileType) {
          // Split tile: flat solid color per triangle
          const noiseA = getNoiseExtra(renderTileType, x + 0.25, z + 0.25);
          const noiseB = getNoiseExtra(groundBType, x + 0.75, z + 0.75);
          const cA = groundColor(renderTileType, Math.max(slopeShade + noiseA, 0.5));
          const cB = groundColor(groundBType, Math.max(slopeShade + noiseB, 0.5));
          const avgAO = (this.getVertexAO(x, z) + this.getVertexAO(x + 1, z) + this.getVertexAO(x, z + 1) + this.getVertexAO(x + 1, z + 1)) / 4;
          cA.r *= avgAO; cA.g *= avgAO; cA.b *= avgAO;
          cB.r *= avgAO; cB.g *= avgAO; cB.b *= avgAO;
          // Object shadows on split tiles
          if (this.shadowInf) {
            const shadowableA = renderTileType === 'grass' || renderTileType === 'dirt' || renderTileType === 'path';
            const shadowableB = groundBType === 'grass' || groundBType === 'dirt' || groundBType === 'path';
            const avgShadow = (this.getShadowAt(x, z) + this.getShadowAt(x + 1, z) + this.getShadowAt(x, z + 1) + this.getShadowAt(x + 1, z + 1)) / 4;
            if (shadowableA) { cA.r *= avgShadow; cA.g *= avgShadow; cA.b *= avgShadow; }
            if (shadowableB) { cB.r *= avgShadow; cB.g *= avgShadow; cB.b *= avgShadow; }
          }
          const splitGlow = sampleTorchlightInfluenceGrid(torchlightGrid, x + 0.5, z + 0.5);
          applyTorchlightTint(cA, splitGlow);
          applyTorchlightTint(cB, splitGlow);

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
        if (renderTileType === 'road') {
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

        if (renderTileType !== 'water') {
          // Water proximity mud tinting
          const proxTL = this.getVertexWaterProximity(x, z);
          const proxTR = this.getVertexWaterProximity(x + 1, z);
          const proxBL = this.getVertexWaterProximity(x, z + 1);
          const proxBR = this.getVertexWaterProximity(x + 1, z + 1);
          applyWaterEdgeMudTint(cTL, proxTL);
          applyWaterEdgeMudTint(cTR, proxTR);
          applyWaterEdgeMudTint(cBL, proxBL);
          applyWaterEdgeMudTint(cBR, proxBR);

          // Underwater darkening
          const applyDepth = (c: RGB, vertH: number) => {
            const depth = clamp((wLevel - vertH) / 2.5, 0, 1);
            if (depth <= 0) return;
            c.r *= 1 - depth * 0.60; c.g *= 1 - depth * 0.45; c.b *= 1 - depth * 0.20;
          };
          applyDepth(cTL, h.tl); applyDepth(cTR, h.tr); applyDepth(cBL, h.bl); applyDepth(cBR, h.br);
        }

        // Vertex AO
        if (renderTileType !== 'water') {
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
        if (this.shadowInf && (renderTileType === 'grass' || renderTileType === 'dirt' || renderTileType === 'path')) {
          const sTL = this.getShadowAt(x, z);
          const sTR = this.getShadowAt(x + 1, z);
          const sBL = this.getShadowAt(x, z + 1);
          const sBR = this.getShadowAt(x + 1, z + 1);
          cTL.r *= sTL; cTL.g *= sTL; cTL.b *= sTL;
          cTR.r *= sTR; cTR.g *= sTR; cTR.b *= sTR;
          cBL.r *= sBL; cBL.g *= sBL; cBL.b *= sBL;
          cBR.r *= sBR; cBR.g *= sBR; cBR.b *= sBR;
        }

        const torchMax = maxTorchlightInfluenceForTile(torchlightGrid, x, z);
        if (renderTileType !== 'water' && torchMax > 0.001) {
          vertexIndex += this.pushTorchlightSubdividedTile(
            positions,
            colors,
            indices,
            torchlightGrid,
            vertexIndex,
            h,
            x,
            z,
            cTL,
            cTR,
            cBL,
            cBR,
          );
          continue;
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
    if (positions.length === 0 || indices.length === 0) {
      mesh.material = this.groundMat;
      mesh.hasVertexAlpha = false;
      mesh.isPickable = false;
      return mesh;
    }
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.colors = colors;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    vertexData.normals = normals;
    vertexData.applyToMesh(mesh);
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

    const waterFlowTransformCache = new Map<string, WaterFlowUvTransform>();

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        if (this.getBaseGroundType(x, z) === 'void') continue;
        if (!this.shouldRenderWater(x, z)) continue;
        if (this.holeTiles.has(z * this.mapWidth + x)) continue; // no water in holes
        hasWater = true;

        const wY = this.getChunkWaterLevel(x, z) + 0.02;
        // CCW winding for RHS
        positions.push(x, wY, z, x + 1, wY, z, x + 1, wY, z + 1, x, wY, z + 1);
        pushWaterFlowQuadUvs(uvs, x, z, this.getWaterFlowTransform(x, z, WATER_UV_SCALE, waterFlowTransformCache), 'tl-tr-br-bl');
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

    const LIFT = 0.05;
    const waterFlowTransformCache = new Map<string, WaterFlowUvTransform>();

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tile = this.getTileRaw(x, z);
        if (tile?.ground === 'void') continue;
        const waterA = !!tile?.waterSurface;
        const waterB = typeof tile?.waterSurfaceB === 'boolean' ? tile.waterSurfaceB : waterA;
        if (!waterA && !waterB) continue;
        hasWater = true;

        const h = this.getTileCornerHeights(x, z);
        const transform = this.getWaterFlowTransform(x, z, WATER_UV_SCALE, waterFlowTransformCache);
        const appendRing = (ring: readonly UVPoint[]) => {
          if (ring.length < 3) return;
          const base = vertexIndex;
          for (const p of ring) {
            const wx = x + p.u;
            const wz = z + p.v;
            const wy = bilerpCorners(h.tl, h.tr, h.bl, h.br, p.u, p.v) + LIFT;
            const [u, v] = waterFlowUvFromTransform(wx, wz, transform);
            positions.push(wx, wy, wz);
            uvs.push(u, v);
            normals.push(0, 1, 0);
          }
          for (const i of fanTriangulate(ring.length)) indices.push(base + i);
          vertexIndex += ring.length;
        };

        if (waterA && waterB) {
          appendRing(fullTileRingForSplit(tile?.split));
        } else {
          const { halfA, halfB } = computeCutPolygons(tile?.textureCutAngle ?? DEFAULT_CUT_ANGLE, tile?.textureCutOffset ?? 0);
          if (waterA) appendRing(halfA);
          if (waterB) appendRing(halfB);
        }
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
        if (tile?.ground === 'void') continue;
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
          const { halfA, halfB } = computeCutPolygons(tile.textureCutAngle, tile.textureCutOffset ?? 0);
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

  private appendRoofTileGeometry(
    roof: RoofData,
    x: number,
    z: number,
    positions: number[],
    indices: number[],
    normals: number[],
    colors: number[],
    vertexIndex: number,
  ): number {
    const cr = 0.45, cg = 0.25, cb = 0.15;
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
    return vertexIndex;
  }

  private collectConnectedRoofBuildTileGroups(
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
    roofAt: (tileIdx: number) => RoofData | undefined,
  ): RoofBuildTile[][] {
    const roofTiles = new Map<string, RoofBuildTile>();
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const roof = roofAt(z * this.mapWidth + x);
        if (roof) roofTiles.set(`${x},${z}`, { x, z, roof });
      }
    }
    if (roofTiles.size === 0) return [];

    const groups: RoofBuildTile[][] = [];
    const visited = new Set<string>();
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    for (const [seedKey, seedTile] of roofTiles) {
      if (visited.has(seedKey)) continue;
      const group: RoofBuildTile[] = [];
      const queue: RoofBuildTile[] = [seedTile];
      visited.add(seedKey);
      for (let qi = 0; qi < queue.length; qi++) {
        const tile = queue[qi];
        group.push(tile);
        for (const [dx, dz] of dirs) {
          const nk = `${tile.x + dx},${tile.z + dz}`;
          if (visited.has(nk)) continue;
          const next = roofTiles.get(nk);
          if (!next) continue;
          visited.add(nk);
          queue.push(next);
        }
      }
      groups.push(group);
    }
    return groups;
  }

  private createRoofComponentMesh(
    name: string,
    chunkKey: string,
    roofGridChunkKey: string,
    floor: number,
    roofTiles: RoofBuildTile[],
  ): Mesh {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0;
    for (const tile of roofTiles) {
      vertexIndex = this.appendRoofTileGeometry(tile.roof, tile.x, tile.z, positions, indices, normals, colors, vertexIndex);
    }

    const mesh = new Mesh(name, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.roofMat; mesh.hasVertexAlpha = false; mesh.isPickable = false;
    mesh.metadata = { ...(mesh.metadata ?? {}), kind: 'terrainRoof', chunkKey, floor };
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    this.stampTerrainRoofMeshTiles(
      roofGridChunkKey,
      mesh,
      roofTiles.map(tile => ({ x: tile.x, z: tile.z, y: tile.roof.height })),
      floor,
    );
    return mesh;
  }

  private createRoofChunkMesh(
    baseName: string,
    chunkKey: string,
    roofGridChunkKey: string,
    floor: number,
    groups: RoofBuildTile[][],
  ): Mesh | null {
    if (groups.length === 0) return null;
    const components = groups.map((group, idx) => this.createRoofComponentMesh(
      groups.length === 1 ? baseName : `${baseName}_${idx}`,
      chunkKey,
      roofGridChunkKey,
      floor,
      group,
    ));
    if (components.length === 1) return components[0];

    const parent = new Mesh(`${baseName}_root`, this.scene);
    parent.isPickable = false;
    parent.metadata = { ...(parent.metadata ?? {}), kind: 'terrainRoofGroup', chunkKey, floor };
    for (const component of components) component.parent = parent;
    return parent;
  }

  private buildRoofMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const chunkKey = `${chunkX},${chunkZ}`;
    const groups = this.collectConnectedRoofBuildTileGroups(startX, startZ, endX, endZ, tileIdx => this.roofData.get(tileIdx));
    return this.createRoofChunkMesh(`roof_${chunkX}_${chunkZ}`, chunkKey, this.terrainRoofChunkKey(chunkKey), 0, groups);
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
    const chunkKey = `${chunkX},${chunkZ}`;
    const groups = this.collectConnectedRoofBuildTileGroups(startX, startZ, endX, endZ, tileIdx => layer.roofs.get(tileIdx));
    return this.createRoofChunkMesh(`roof_f${floorIdx}_${chunkX}_${chunkZ}`, chunkKey, this.terrainRoofChunkKey(chunkKey), floorIdx, groups);
  }

  private setFloorMeshSetVisibility(set: FloorMeshSet, floorIdx: number): void {
    const visible = floorIdx <= this.currentFloor;
    if (set.wall) set.wall.setEnabled(visible);
    this.setRenderTreeEnabled(set.roof, floorIdx > this.currentFloor);
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
    this.rootWallShadowRunsCache = null;
  }

  getWallOnFloorPublic(x: number, z: number, floor: number): number {
    if (floor === 0) return this.getWallRawPublic(x, z);
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return 0;
    const layer = this.floorLayerData.get(floor);
    if (!layer) return 0;
    return layer.walls.get(z * this.mapWidth + x) ?? 0;
  }

  /** Set wall bitmask at a tile on the authoritative interaction floor. */
  setWallOnFloor(x: number, z: number, floor: number, mask: number): void {
    if (floor === 0) {
      this.setWall(x, z, mask);
      return;
    }
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return;
    const idx = z * this.mapWidth + x;
    const layer = this.ensureFloorLayer(floor);
    if (mask === 0) layer.walls.delete(idx);
    else layer.walls.set(idx, mask);
  }

  /** Mark edge bits on (x,z) as open by a door on the same floor. */
  setOpenDoorEdges(x: number, z: number, edgeMask: number, open: boolean, floor: number = 0): void {
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return;
    const idx = z * this.mapWidth + x;
    const key = this.doorEdgeKey(floor, idx);
    const cur = this.openDoorEdges.get(key) ?? 0;
    const next = open ? (cur | edgeMask) : (cur & ~edgeMask);
    if (next === 0) this.openDoorEdges.delete(key);
    else this.openDoorEdges.set(key, next);
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
    this.rootWallShadowRunsCache = null;
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
    return this.placedObjectNodeSet.has(node);
  }

  /** Check if any placed GLB object exists near a world position */
  hasPlacedObjectNear(x: number, z: number, radius: number): boolean {
    return this.findPlacedObjectNear(x, z, radius) !== null;
  }

  private placedObjectAuthoredPosition(node: TransformNode): { x: number; y: number; z: number } {
    const meta = node.metadata as PlacedObjectNodeMetadata | null;
    const x = meta?.placedX;
    const y = meta?.placedY;
    const z = meta?.placedZ;
    if (
      typeof x === 'number' && Number.isFinite(x) &&
      typeof y === 'number' && Number.isFinite(y) &&
      typeof z === 'number' && Number.isFinite(z)
    ) {
      return { x, y, z };
    }
    const pos = node.getAbsolutePosition();
    return { x: pos.x, y: pos.y, z: pos.z };
  }

  getPlacedObjectAuthoredPosition(node: TransformNode): { x: number; y: number; z: number } {
    return this.placedObjectAuthoredPosition(node);
  }

  /** Find the nearest placed GLB object (that maps to a game object) near a world position.
   *  Uses spatial grid for O(1) lookup, checking the tile and its neighbours.
   *  If defId is provided, only matches nodes whose assetId maps to that object definition. */
  findPlacedObjectNear(
    x: number,
    z: number,
    radius: number,
    defId?: number,
    y?: number,
    acceptNode?: (node: TransformNode) => boolean,
  ): TransformNode | null {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    let best: TransformNode | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nodes = this.placedObjectGrid.get(`${tx + dx},${tz + dz}`);
        if (!nodes) continue;
        for (const node of nodes) {
          if (node.isDisposed()) continue;
          if (!node.isEnabled()) continue;
          if (acceptNode && !acceptNode(node)) continue;
          // Filter by defId if specified
          if (defId !== undefined) {
            const assetId = (node.metadata as PlacedObjectNodeMetadata | null)?.assetId;
            if (!assetId || objectDefIdForPlacedAsset(assetId) !== defId) continue;
          }
          const placed = this.placedObjectAuthoredPosition(node);
          const nx = placed.x - x;
          const nz = placed.z - z;
          const dist = Math.sqrt(nx * nx + nz * nz);
          if (dist >= radius) continue;
          const yPenalty = Number.isFinite(y) ? Math.abs(placed.y - (y as number)) : 0;
          if (yPenalty > 1.25) continue;
          const score = dist + yPenalty;
          if (score < bestScore) {
            bestScore = score;
            best = node;
          }
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
      if (((this.openDoorEdges.get(this.doorEdgeKey(floor, idx)) ?? 0) & edge) !== 0) return false;
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

  /** Mirrors GameMap.wallBlocksAtHeight — see that doc comment for semantics. */
  private wallEdgeBlocksAtHeight(x: number, z: number, edge: number, playerY?: number): boolean {
    const idx = z * this.mapWidth + x;
    const wallH = this.wallHeights.get(idx) ?? DEFAULT_WALL_HEIGHT;
    // Open-door bypass: the door is on a wall whose base is either floor 0
    // (terrain) or an upper floor (elev). The player must be at one of those
    // levels — covers both a ground-floor door entered from outside AND an
    // upper-floor door used from the elevated walkway. Using one base height
    // with the elev fallback (as an older version did) made ground-floor
    // doors fail when the tile ALSO had an upper-floor plane, because the
    // bypass then demanded upper-floor Y.
    const isOpenDoor = ((this.openDoorEdges.get(this.doorEdgeKey(0, idx)) ?? 0) & edge) !== 0;
    const groundBaseH = this.floorHeights.get(idx) ?? this.getInterpolatedHeight(x + 0.5, z + 0.5);
    const upperBaseH = this.elevatedFloorHeights.get(idx);
    const atGroundDoor = playerY == null || (playerY >= groundBaseH - 0.5 && playerY < groundBaseH + wallH);
    const atUpperDoor = playerY == null || (upperBaseH !== undefined && playerY >= upperBaseH - 0.5 && playerY < upperBaseH + wallH);
    if (isOpenDoor && (atGroundDoor || atUpperDoor)) return false;

    if ((this.getWallRaw(x, z) & edge) !== 0) {
      if (playerY == null) return true;
      // Raw walls are floor-0 walls — their base is terrain (or a bridge-
      // upgraded floor 0), NOT the upper-floor texture plane. Using floorH
      // here would lift the wall up to `elev + wallH` on tiles that also
      // carry an upper floor, blocking upper-floor players from crossing a
      // wall that actually ends below their feet.
      const wallBaseH = this.floorHeights.get(idx) ?? this.getInterpolatedHeight(x + 0.5, z + 0.5);
      if (playerY < wallBaseH + wallH) return true;
    }
    if (this.floorLayerData.size === 0 || playerY == null) return false;
    // Boundary walls are commonly authored on the tile that sits OUTSIDE the
    // upper-floor footprint, so the layer's floor/tile elevation lives on
    // the neighbour rather than this tile.
    const nb = DOOR_EDGE_NEIGHBOR[edge];
    const nIdx = (z + nb.dz) * this.mapWidth + (x + nb.dx);
    for (const layer of this.floorLayerData.values()) {
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

  private static projectileWallBlocksAtCallback(
    chunkManager: ChunkManager,
    x: number,
    z: number,
    edge: number,
    floor: number,
    projectileY: number,
  ): boolean {
    return chunkManager.projectileWallBlocksAt(x, z, edge, floor, projectileY);
  }

  private projectileWallBlocksAt(
    x: number,
    z: number,
    edge: number,
    floor: number,
    projectileY: number,
  ): boolean {
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return false;
    const floorIdx = Math.floor(floor);
    const idx = z * this.mapWidth + x;
    if (((this.openDoorEdges.get(this.doorEdgeKey(floorIdx, idx)) ?? 0) & edge) !== 0) return false;

    if (floorIdx === 0) {
      if (!this.walls || (this.walls[idx] & edge) === 0) return false;
      const explicitWallH = this.wallHeights.get(idx);
      if (explicitWallH === undefined && ((this.shootOverProjectileWallEdges?.[idx] ?? 0) & edge) !== 0) return false;
      const wallH = explicitWallH ?? DEFAULT_WALL_HEIGHT;
      if (wallH < PROJECTILE_BLOCKING_WALL_HEIGHT) return false;
      const wallBaseH = this.floorHeights.get(idx) ?? this.getInterpolatedHeight(x + 0.5, z + 0.5);
      return projectileY < wallBaseH + wallH;
    }

    const layer = this.floorLayerData.get(floorIdx);
    if (!layer || ((layer.walls.get(idx) ?? 0) & edge) === 0) return false;
    const wallH = layer.wallHeights.get(idx) ?? DEFAULT_WALL_HEIGHT;
    if (wallH < PROJECTILE_BLOCKING_WALL_HEIGHT) return false;
    const nb = DOOR_EDGE_NEIGHBOR[edge];
    const nIdx = (z + nb.dz) * this.mapWidth + (x + nb.dx);
    const wallBaseH = layer.floors.get(idx)
      ?? layer.tiles.get(idx)
      ?? layer.floors.get(nIdx)
      ?? layer.tiles.get(nIdx)
      ?? this.elevatedFloorHeights.get(idx)
      ?? this.elevatedFloorHeights.get(nIdx)
      ?? this.getInterpolatedHeight(x + 0.5, z + 0.5);
    return projectileY < wallBaseH + wallH;
  }

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
      ChunkManager.projectileWallBlocksAtCallback,
    );
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
        if (this.activeChunks && !this.activeChunks.has(`${Math.floor(tx / EDITOR_CHUNK_SIZE)},${Math.floor(tz / EDITOR_CHUNK_SIZE)}`)) {
          voidTiles[idx] = 1;
          continue;
        }
        tiles[idx] = this.getTileTypeRaw(tx, tz);
        walls[idx] = this.getWallRaw(tx, tz);
        if (tx < 0 || tz < 0 || tx >= this.mapWidth || tz >= this.mapHeight) continue;

        const flatIdx = tz * this.mapWidth + tx;
        const kcTile = this.getTileRaw(tx, tz);
        const hasSurfaceOverride = this.floorHeights.has(flatIdx)
          || this.texturePlaneFloorTiles.has(flatIdx)
          || this.stairData.has(flatIdx)
          || this.roofData.has(flatIdx);
        if ((kcTile?.ground ?? this.defaultGround) === 'void' && !hasSurfaceOverride) {
          voidTiles[idx] = 1;
          continue;
        }
        if (this.roofData.has(flatIdx)) roofs[idx] = 1;

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

  private flatTexturePickCellKey(yBucket: number, cellX: number, cellZ: number): string {
    return `${yBucket}:${cellX},${cellZ}`;
  }

  private flatTexturePickYBucket(y: number): number {
    return Math.floor(y / FLAT_TEXTURE_PICK_Y_BUCKET_SIZE);
  }

  private flatTexturePickCellCoord(v: number): number {
    return Math.floor(v / FLAT_TEXTURE_PICK_CELL_SIZE);
  }

  private collectFlatTexturePickCandidates(
    rayOrigin: Vector3,
    rayDirection: Vector3,
    playerY: number,
  ): { primary: FlatTexturePickPlane[]; fallback: FlatTexturePickPlane[] } {
    const yBucket = this.flatTexturePickYBucket(playerY);
    const fallback = this.flatTexturePickPlanesByYBucket.get(yBucket) ?? [];
    if (fallback.length === 0 || Math.abs(rayDirection.y) < 1e-6) {
      return { primary: fallback, fallback };
    }

    const yMin = playerY - SAME_PLANE_PICK_Y_TOLERANCE;
    const yMax = playerY + SAME_PLANE_PICK_Y_TOLERANCE;
    const t0 = (yMin - rayOrigin.y) / rayDirection.y;
    const t1 = (yMax - rayOrigin.y) / rayDirection.y;
    const minT = Math.max(0, Math.min(t0, t1));
    const maxT = Math.max(t0, t1);
    if (maxT <= 0) return { primary: fallback, fallback };

    const x0 = rayOrigin.x + rayDirection.x * minT;
    const z0 = rayOrigin.z + rayDirection.z * minT;
    const x1 = rayOrigin.x + rayDirection.x * maxT;
    const z1 = rayOrigin.z + rayDirection.z * maxT;
    const minCellX = this.flatTexturePickCellCoord(Math.min(x0, x1)) - 1;
    const maxCellX = this.flatTexturePickCellCoord(Math.max(x0, x1)) + 1;
    const minCellZ = this.flatTexturePickCellCoord(Math.min(z0, z1)) - 1;
    const maxCellZ = this.flatTexturePickCellCoord(Math.max(z0, z1)) + 1;

    const primary: FlatTexturePickPlane[] = [];
    const seen = new Set<FlatTexturePickPlane>();
    for (let cz = minCellZ; cz <= maxCellZ; cz++) {
      for (let cx = minCellX; cx <= maxCellX; cx++) {
        const planes = this.flatTexturePickPlanesByCell.get(this.flatTexturePickCellKey(yBucket, cx, cz));
        if (!planes) continue;
        for (const plane of planes) {
          if (seen.has(plane)) continue;
          seen.add(plane);
          primary.push(plane);
        }
      }
    }

    return { primary: primary.length > 0 ? primary : fallback, fallback };
  }

  private pickBestAuthoredFlatTexturePlane(
    candidates: FlatTexturePickPlane[],
    rayOrigin: Vector3,
    rayDirection: Vector3,
    playerY: number,
  ): { x: number; z: number; y: number; distance: number } | null {
    let best: { x: number; z: number; y: number; distance: number } | null = null;

    for (const plane of candidates) {
      if (
        playerY < plane.minY - SAME_PLANE_PICK_Y_TOLERANCE ||
        playerY > plane.maxY + SAME_PLANE_PICK_Y_TOLERANCE
      ) continue;

      const localOrigin = Vector3.TransformCoordinates(rayOrigin, plane.invWorld);
      const localDir = Vector3.TransformNormal(rayDirection, plane.invWorld);
      if (Math.abs(localDir.z) < 1e-6) continue;

      const t = -localOrigin.z / localDir.z;
      if (t <= 0) continue;

      const lx = localOrigin.x + localDir.x * t;
      const ly = localOrigin.y + localDir.y * t;
      if (Math.abs(lx) > plane.halfWidth || Math.abs(ly) > plane.halfHeight) continue;

      const wx = rayOrigin.x + rayDirection.x * t;
      const wy = rayOrigin.y + rayDirection.y * t;
      const wz = rayOrigin.z + rayDirection.z * t;
      const walkableHeights = this.getWalkableHeightsAt(wx, wz);
      const matchesWalkableHeight = walkableHeights.some(height => Math.abs(wy - height) <= 0.4);
      if (!matchesWalkableHeight) continue;
      if (Math.abs(wy - playerY) > SAME_PLANE_PICK_Y_TOLERANCE) continue;

      const distance = Math.hypot(wx - rayOrigin.x, wy - rayOrigin.y, wz - rayOrigin.z);
      if (!best || distance < best.distance) {
        best = { x: wx, z: wz, y: wy, distance };
      }
    }

    return best;
  }

  pickAuthoredFlatTexturePlane(
    rayOrigin: Vector3,
    rayDirection: Vector3,
    playerY: number,
  ): { x: number; z: number; y: number; distance: number } | null {
    const { primary, fallback } = this.collectFlatTexturePickCandidates(rayOrigin, rayDirection, playerY);
    const best = this.pickBestAuthoredFlatTexturePlane(primary, rayOrigin, rayDirection, playerY);
    if (best || primary === fallback) return best;
    return this.pickBestAuthoredFlatTexturePlane(fallback, rayOrigin, rayDirection, playerY);
  }

  setCurrentFloor(floor: number): void {
    if (floor === this.currentFloor) return;
    this.currentFloor = floor;
    for (const [key, chunk] of this.chunks) {
      if (this.desiredGameChunks.size > 0 && !this.desiredGameChunks.has(key)) {
        this.setChunkMeshesEnabled(key, chunk, false);
        continue;
      }
      this.setRenderTreeEnabled(chunk.roof, floor === 0);
      for (const [floorIdx, meshSet] of chunk.upperFloors) this.setFloorMeshSetVisibility(meshSet, floorIdx);
    }
  }

  getCurrentFloor(): number { return this.currentFloor; }

  roofNodeDefaultEnabled(node: TransformNode): boolean | null {
    const md = node.metadata as { kind?: string; assetId?: string; chunkKey?: string; floor?: number; isTexPlane?: boolean; chunkX?: number; chunkZ?: number } | null;
    if (!md) return null;

    if (md.kind === 'terrainRoof' && typeof md.chunkKey === 'string' && typeof md.floor === 'number') {
      if (this.chunkMeshesEnabled.get(md.chunkKey) !== true) return false;
      return md.floor === 0 ? this.currentFloor === 0 : md.floor > this.currentFloor;
    }

    if (md.isTexPlane === true && typeof md.chunkX === 'number' && typeof md.chunkZ === 'number') {
      return this.texturePlaneChunksEnabled.get(`${md.chunkX},${md.chunkZ}`) !== false;
    }

    if (typeof md.assetId === 'string' && typeof md.chunkKey === 'string') {
      const enabled = this.chunkPlacedEnabled.get(md.chunkKey);
      return enabled === undefined ? null : enabled;
    }

    return null;
  }

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
    if (import.meta.env.DEV && count > 0) {
      console.log(`[ChunkManager] Registered ${count} tiles as walkable from texture plane bridges`);
    }
  }

  /** Register texture plane bridges only for tiles within a specific region */
  private registerTexturePlaneFloorsInRegion(rx0: number, rz0: number, rx1: number, rz1: number): void {
    if (!this.mapData) return;
    const planes = this.mapData.texturePlanes || [];
    for (const plane of planes) {
      if (!isWalkableElevatedPlane(plane)) continue;
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
            // Bridge threshold mirrors deriveElevatedFloorTiles — must stay
            // below typical building-floor elevation (~2 units) or every
            // building's ground-floor plane auto-bridges and walking under
            // the overhang teleports the player to the upper floor.
            if (plane.bridge || wasBlocking || py < terrainH + 1.0) {
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
      const res = await authFetch('/assets/assets.json');
      const data = await res.json();
      for (const asset of data.assets || []) {
        if (!asset?.id || !asset?.path) continue;
        if (this.assetRegistry.has(asset.id)) {
          if (import.meta.env.DEV) console.warn(`[ChunkManager] Duplicate asset id '${asset.id}' ignored: ${asset.path}`);
          continue;
        }
        this.assetRegistry.set(asset.id, { path: asset.path });
      }
      if (import.meta.env.DEV) console.log(`[ChunkManager] Loaded ${this.assetRegistry.size} asset definitions`);
    } catch (e) {
      console.warn('[ChunkManager] Failed to load asset registry:', e);
    }
    try {
      const res = await authFetch('/assets/textures/textures.json');
      const data = await res.json();
      for (const tex of data) {
        this.textureRegistry.set(tex.id, { path: tex.path });
      }
      if (import.meta.env.DEV) console.log(`[ChunkManager] Loaded ${this.textureRegistry.size} texture definitions`);
    } catch (e) {
      console.warn('[ChunkManager] Failed to load texture registry:', e);
    }
  }

  private async loadObjectChunkManifest(mapId: string, cacheBust: string): Promise<void> {
    this.objectChunkManifest = null;
    try {
      const res = await fetchOptionalMapResource(`/maps/${mapId}/objects/manifest.json${cacheBust}`, `${mapId}/objects/manifest.json`);
      if (!res.ok) return;
      const data = await res.json() as { chunks?: Record<string, unknown> };
      if (!data || !data.chunks || typeof data.chunks !== 'object') return;
      const manifest = new Set<string>();
      for (const [chunkKey, rawAssetIds] of Object.entries(data.chunks)) {
        if (!Array.isArray(rawAssetIds)) continue;
        manifest.add(chunkKey);
      }
      this.objectChunkManifest = manifest;
      if (import.meta.env.DEV) console.log(`[ChunkManager] Loaded object manifest for ${manifest.size} chunks`);
    } catch (e) {
      if (isMapResourceFetchError(e)) throw e;
      this.objectChunkManifest = null;
    }
  }

  private isObjectLoadStale(generation: number): boolean {
    return generation !== this.objectLoadGeneration || this.scene.isDisposed;
  }

  private shouldLoadObjectChunkNow(chunkKey: string): boolean {
    return this.objectLoadChunks.size === 0 || this.objectLoadChunks.has(chunkKey);
  }

  private isObjectChunkVisibleNow(chunkKey: string): boolean {
    return this.desiredObjectChunks.size === 0 || this.desiredObjectChunks.has(chunkKey);
  }

  private async loadGLBModel(assetId: string, generation: number = this.objectLoadGeneration): Promise<TransformNode | null> {
    if (this.isObjectLoadStale(generation)) return null;
    if (this.loadedModelCache.has(assetId)) {
      return this.loadedModelCache.get(assetId)!;
    }
    const loading = this.loadingModelPromises.get(assetId);
    if (loading) return loading;
    const promise = this.loadGLBModelUncached(assetId, generation).finally(() => {
      if (this.loadingModelPromises.get(assetId) === promise) {
        this.loadingModelPromises.delete(assetId);
      }
    });
    this.loadingModelPromises.set(assetId, promise);
    return promise;
  }

  private async loadGLBModelUncached(assetId: string, generation: number): Promise<TransformNode | null> {
    if (this.isObjectLoadStale(generation)) return null;
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
      const result = await this.importMeshWithSlowWarning(dir, file);
      if (this.isObjectLoadStale(generation)) {
        this.disposeImportedMeshResult(result);
        return null;
      }

      const samplingMode = shouldSmoothPlacedObjectTextures(assetId, path)
        ? Texture.TRILINEAR_SAMPLINGMODE
        : Texture.NEAREST_SAMPLINGMODE;
      for (const mesh of result.meshes) {
        const mat = mesh.material;
        if (mat && 'diffuseTexture' in mat && (mat as any).diffuseTexture) {
          (mat as any).diffuseTexture.updateSamplingMode(samplingMode);
          if (samplingMode === Texture.TRILINEAR_SAMPLINGMODE) {
            (mat as any).diffuseTexture.anisotropicFilteringLevel = 4;
          }
        }
        if (mat && 'albedoTexture' in mat && (mat as any).albedoTexture) {
          (mat as any).albedoTexture.updateSamplingMode(samplingMode);
          if (samplingMode === Texture.TRILINEAR_SAMPLINGMODE) {
            (mat as any).albedoTexture.anisotropicFilteringLevel = 4;
          }
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
      if (!this.isObjectLoadStale(generation)) {
        console.warn(`[ChunkManager] Failed to load model ${assetId}:`, e);
        this.loadedModelCache.set(assetId, null);
      }
      return null;
    }
  }

  private async importMeshWithSlowWarning(dir: string, file: string, slowWarnMs: number = 20_000): Promise<Awaited<ReturnType<typeof SceneLoader.ImportMeshAsync>>> {
    let timer: number | null = null;
    try {
      const url = `${dir}${file}`;
      timer = window.setTimeout(() => {
        console.warn(`[loading] GLB import still running after ${slowWarnMs}ms: ${url}`);
      }, slowWarnMs);
      return await SceneLoader.ImportMeshAsync('', dir, file, this.scene);
    } finally {
      if (timer !== null) window.clearTimeout(timer);
    }
  }

  private disposeImportedMeshResult(result: Awaited<ReturnType<typeof SceneLoader.ImportMeshAsync>>): void {
    for (const group of result.animationGroups) group.dispose();
    for (const skeleton of result.skeletons) skeleton.dispose();
    for (const mesh of result.meshes) mesh.dispose();
    for (const node of result.transformNodes) {
      if (!node.isDisposed()) node.dispose();
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

  private canThinInstance(obj: PlacedObject): boolean {
    if (objectDefIdForPlacedAsset(obj.assetId) != null) return false;
    if (this.modelAnimationGroups.has(obj.assetId)) return false;
    if (this.isRoofLikeAsset(obj.assetId)) return false;
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

  private placedObjectInteractionActions(obj: PlacedObject): string[] | undefined {
    if (!Array.isArray(obj.interactions) || obj.interactions.length === 0) return undefined;
    const actions: string[] = [];
    for (const interaction of obj.interactions) {
      const action = interaction.action?.trim();
      if (!action || actions.includes(action)) continue;
      actions.push(action);
    }
    return actions.length > 0 ? actions : undefined;
  }

  private getPlacedObjectScaleBoost(assetId: string): number {
    const assetDef = this.assetRegistry.get(assetId);
    return assetDef?.path?.toLowerCase().includes('tree') ? 1.15 : 1.0;
  }

  private getThinVisibilityClass(obj: PlacedObject): 'ground' | 'elevated' | 'roof' {
    if (this.isRoofLikeAsset(obj.assetId)) return obj.noRoof ? 'ground' : 'roof';
    const terrainY = this.getInterpolatedHeight(obj.position.x, obj.position.z);
    return obj.position.y > terrainY + 1.5 ? 'elevated' : 'ground';
  }

  private composePlacedObjectMatrix(obj: PlacedObject, scaleBoost: number, out: Matrix): void {
    const { x: orx, y: ory, z: orz } = obj.rotation;
    const quat = Quaternion.FromEulerAngles(orx, ory, orz);
    Matrix.ComposeToRef(
      TmpVectors.Vector3[0].set(obj.scale.x * scaleBoost, obj.scale.y * scaleBoost, obj.scale.z * scaleBoost),
      quat,
      TmpVectors.Vector3[1].set(obj.position.x, obj.position.y, obj.position.z),
      out,
    );
  }

  private getPlacedObjectTemplateBounds(assetId: string, obj: PlacedObject): { min: Vector3; max: Vector3 } | null {
    const template = this.loadedModelCache.get(assetId);
    if (!template) return null;
    const baseEntries = this.getTemplateBaseMatrices(assetId, template);
    if (baseEntries.length === 0) return null;

    const placement = Matrix.Identity();
    const world = Matrix.Identity();
    this.composePlacedObjectMatrix(obj, this.getPlacedObjectScaleBoost(assetId), placement);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const local = TmpVectors.Vector3[2];
    const transformed = TmpVectors.Vector3[3];
    for (const { sourceMesh, baseMatrix } of baseEntries) {
      const box = sourceMesh.getBoundingInfo().boundingBox;
      const bMin = box.minimum;
      const bMax = box.maximum;
      baseMatrix.multiplyToRef(placement, world);
      for (let corner = 0; corner < 8; corner++) {
        local.set(
          (corner & 1) ? bMax.x : bMin.x,
          (corner & 2) ? bMax.y : bMin.y,
          (corner & 4) ? bMax.z : bMin.z,
        );
        Vector3.TransformCoordinatesToRef(local, world, transformed);
        if (transformed.x < minX) minX = transformed.x;
        if (transformed.y < minY) minY = transformed.y;
        if (transformed.z < minZ) minZ = transformed.z;
        if (transformed.x > maxX) maxX = transformed.x;
        if (transformed.y > maxY) maxY = transformed.y;
        if (transformed.z > maxZ) maxZ = transformed.z;
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
    return {
      min: new Vector3(minX, minY, minZ),
      max: new Vector3(maxX, maxY, maxZ),
    };
  }

  private terrainRoofChunkKey(chunkKey: string): string {
    return `terrain:${chunkKey}`;
  }

  private addRoofGridEntry(gridKey: string, entry: RoofObjectGridEntry): void {
    let arr = this.roofObjectGrid.get(gridKey);
    if (!arr) {
      arr = [];
      this.roofObjectGrid.set(gridKey, arr);
    }
    arr.push(entry);
  }

  private registerChunkRoofGridTile(chunkKeys: Set<string>, tx: number, tz: number, entry: RoofObjectGridEntry): void {
    const rk = `${tx},${tz}`;
    this.addRoofGridEntry(rk, entry);
    chunkKeys.add(rk);
  }

  private stampTerrainRoofMeshTiles(
    chunkKey: string,
    node: TransformNode,
    roofTiles: ReadonlyArray<{ x: number; z: number; y: number }>,
    floor: number,
  ): void {
    if (roofTiles.length === 0) return;
    let chunkKeys = this.roofObjectGridKeysByChunk.get(chunkKey);
    if (!chunkKeys) {
      chunkKeys = new Set();
      this.roofObjectGridKeysByChunk.set(chunkKey, chunkKeys);
    }

    for (const tile of roofTiles) {
      const rk = `${tile.x},${tile.z}`;
      this.addRoofGridEntry(rk, { node, chunkKey, floor, y: tile.y });
      chunkKeys.add(rk);
    }
  }

  private stampRoofObjectFootprint(chunkKey: string, obj: PlacedObject, bMin: Vector3, bMax: Vector3, node?: TransformNode): void {
    const tx0 = Math.max(0, Math.floor(bMin.x));
    const tx1 = Math.min(this.mapWidth - 1, Math.floor(bMax.x));
    const tz0 = Math.max(0, Math.floor(bMin.z));
    const tz1 = Math.min(this.mapHeight - 1, Math.floor(bMax.z));

    const roofFloor = this.assignRoofFloor(obj.position.x, obj.position.z, obj.position.y);
    let chunkKeys = this.roofObjectGridKeysByChunk.get(chunkKey);
    if (!chunkKeys) {
      chunkKeys = new Set();
      this.roofObjectGridKeysByChunk.set(chunkKey, chunkKeys);
    }

    const stampedKeys = new Set<string>();
    if (tx0 <= tx1 && tz0 <= tz1) {
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (tx + 0.5 < bMin.x || tx + 0.5 > bMax.x) continue;
          if (tz + 0.5 < bMin.z || tz + 0.5 > bMax.z) continue;
          this.registerChunkRoofGridTile(chunkKeys, tx, tz, { node, chunkKey, floor: roofFloor, y: obj.position.y });
          stampedKeys.add(`${tx},${tz}`);
        }
      }
    }

    const authoredTx = Math.floor(obj.position.x);
    const authoredTz = Math.floor(obj.position.z);
    if (authoredTx < 0 || authoredTx >= this.mapWidth || authoredTz < 0 || authoredTz >= this.mapHeight) return;
    if (stampedKeys.has(`${authoredTx},${authoredTz}`)) return;
    this.registerChunkRoofGridTile(chunkKeys, authoredTx, authoredTz, { node, chunkKey, floor: roofFloor, y: obj.position.y });
  }

  private clearRoofObjectGridForChunk(chunkKey: string): void {
    const roofKeys = this.roofObjectGridKeysByChunk.get(chunkKey);
    if (!roofKeys) return;
    for (const rk of roofKeys) {
      const arr = this.roofObjectGrid.get(rk);
      if (!arr) continue;
      const next = arr.filter(entry => entry.chunkKey !== chunkKey);
      if (next.length > 0) this.roofObjectGrid.set(rk, next);
      else this.roofObjectGrid.delete(rk);
    }
    this.roofObjectGridKeysByChunk.delete(chunkKey);
  }

  /** Index placed objects by chunk key — no mesh instantiation, just data bucketing */
  private indexPlacedObjectsByChunk(objects: PlacedObject[]): void {
    this.placedObjectsByChunk.clear();
    this.registerShootOverFenceWalls(objects);
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

  private markShootOverProjectileWallTile(x: number, z: number): void {
    if (!this.walls || !this.shootOverProjectileWallEdges) return;
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return;
    const idx = z * this.mapWidth + x;
    const mask = this.walls[idx];
    if (mask === 0 || this.wallHeights.has(idx)) return;
    this.shootOverProjectileWallEdges[idx] |= mask;
  }

  private registerShootOverFenceWalls(objects: readonly PlacedObject[]): void {
    if (!this.walls || !this.shootOverProjectileWallEdges) return;
    for (const placed of objects) {
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

  private queueChunkPlacedObjects(chunkKey: string): void {
    if (this.chunkPlacedNodes.has(chunkKey) || this.loadingObjectChunks.has(chunkKey) || this.queuedObjectChunks.has(chunkKey)) return;
    this.touchObjectChunk(chunkKey);
    if (this.objectChunkManifest && !this.objectChunkManifest.has(chunkKey)) {
      this.chunksKnownEmpty.add(chunkKey);
      this.chunkPlacedNodes.set(chunkKey, []);
      return;
    }
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
    if (this.objectChunkQueueScheduled || this.objectChunkQueueProcessing) return;
    this.objectChunkQueueScheduled = true;
    this.scheduleNextFrame(() => {
      this.processObjectChunkQueue().catch(e => {
        console.warn('[ChunkManager] Failed while processing object chunk queue:', e);
      });
    });
  }

  private async processObjectChunkQueue(): Promise<void> {
    this.objectChunkQueueScheduled = false;
    if (this.objectChunkQueueProcessing) return;
    this.objectChunkQueueProcessing = true;
    try {
      const start = performance.now();
      const generation = this.objectLoadGeneration;
      if (this.objectChunkQueue.length > 1) {
        this.objectChunkQueue.sort((a, b) => {
          const visibleA = this.isObjectChunkVisibleNow(a);
          const visibleB = this.isObjectChunkVisibleNow(b);
          if (visibleA !== visibleB) return visibleA ? -1 : 1;
          const [ax, az] = a.split(',').map(Number);
          const [bx, bz] = b.split(',').map(Number);
          const da = Math.max(Math.abs(ax - this.lastChunkX), Math.abs(az - this.lastChunkZ));
          const db = Math.max(Math.abs(bx - this.lastChunkX), Math.abs(bz - this.lastChunkZ));
          return da - db;
        });
      }

      while (this.objectChunkQueue.length > 0) {
        if (this.isObjectLoadStale(generation)) return;
        const chunkKey = this.objectChunkQueue.shift()!;
        if (!this.shouldLoadObjectChunkNow(chunkKey)) {
          this.queuedObjectChunks.delete(chunkKey);
          this.loadingObjectChunks.delete(chunkKey);
          continue;
        }
        const visible = this.isObjectChunkVisibleNow(chunkKey);
        if (!visible) {
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          if (now - this.lastHiddenObjectChunkLoadAt < HIDDEN_OBJECT_CHUNK_LOAD_INTERVAL_MS) {
            this.objectChunkQueue.unshift(chunkKey);
            return;
          }
          this.lastHiddenObjectChunkLoadAt = now;
        }
        this.queuedObjectChunks.delete(chunkKey);

        if (!this.chunkPlacedNodes.has(chunkKey)) {
          await this.loadChunkPlacedObjects(chunkKey, generation);
        } else {
          this.loadingObjectChunks.delete(chunkKey);
        }

        if (this.isObjectLoadStale(generation)) return;
        if (performance.now() - start >= this.objectChunkFrameBudgetMs) break;
      }
    } finally {
      this.objectChunkQueueProcessing = false;
      if (this.objectChunkQueue.length > 0) this.scheduleObjectChunkQueue();
    }
  }

  /** Load and instantiate placed objects for a single chunk */
  private async loadChunkPlacedObjects(chunkKey: string, generation: number = this.objectLoadGeneration): Promise<void> {
    if (this.isObjectLoadStale(generation)) return;
    if (this.chunkPlacedNodes.has(chunkKey)) {
      this.loadingObjectChunks.delete(chunkKey);
      return;
    }
    // Skip the network round-trip if we already know this chunk has no objects.
    if (this.chunksKnownEmpty.has(chunkKey)) {
      this.chunkPlacedNodes.set(chunkKey, []);
      this.loadingObjectChunks.delete(chunkKey);
      this.touchObjectChunk(chunkKey);
      return;
    }
    try {
      if (!this.shouldLoadObjectChunkNow(chunkKey)) {
        this.loadingObjectChunks.delete(chunkKey);
        return;
      }
      let objects = this.placedObjectsByChunk.get(chunkKey);
    // If no pre-indexed objects, try fetching per-chunk file from server
    if (!objects || objects.length === 0) {
      try {
        const [cx, cz] = chunkKey.split(',').map(Number);
        const resource = `${this.mapId}/objects/chunk_${cx}_${cz}.json`;
        const res = await fetchOptionalMapResource(`/maps/${resource}`, resource);
        if (this.isObjectLoadStale(generation)) return;
        if (res.ok) {
          const fetched: PlacedObject[] = await res.json();
          if (this.isObjectLoadStale(generation)) return;
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
      } catch (e) {
        if (isMapResourceFetchError(e)) throw e;
        throw mapResourceFetchError(`${this.mapId}/objects/chunk_${chunkKey.replace(',', '_')}.json`, 0);
      }
    }
    if (!objects || objects.length === 0) {
      this.chunkPlacedNodes.set(chunkKey, []);
      this.loadingObjectChunks.delete(chunkKey);
      this.touchObjectChunk(chunkKey);
      return;
    }
    this.registerShootOverFenceWalls(objects);
    if (this.isObjectLoadStale(generation)) return;
    if (!this.shouldLoadObjectChunkNow(chunkKey)) {
      this.disposeChunkPlacedObjects(chunkKey);
      this.loadingObjectChunks.delete(chunkKey);
      return;
    }

    let renderableObjects = objects;
    if (objects.some(obj => isGroundItemSpawnAssetId(obj.assetId))) {
      renderableObjects = objects.filter(obj => !isGroundItemSpawnAssetId(obj.assetId));
    }
    if (renderableObjects.length === 0) {
      this.chunkPlacedNodes.set(chunkKey, []);
      this.loadingObjectChunks.delete(chunkKey);
      this.touchObjectChunk(chunkKey);
      return;
    }
    const workSlice = { start: performance.now() };

    // Stamps tile blockers for decor that stays thin-instanced (no WorldObject).
    const decorKeys: number[] = [];
    for (const obj of renderableObjects) {
      if (!BLOCKING_DECOR_ASSETS.has(obj.assetId)) continue;
      const tx = Math.floor(obj.position.x);
      const tz = Math.floor(obj.position.z);
      const key = tz * this.mapWidth + tx;
      if (this.decorBlockedTiles.has(key)) continue;
      this.decorBlockedTiles.add(key);
      decorKeys.push(key);
    }
    if (decorKeys.length > 0) this.decorBlockedTilesByChunk.set(chunkKey, decorKeys);
    const cleanupDecorAndRoofStamps = () => {
      this.clearRoofObjectGridForChunk(chunkKey);
      const stampedDecor = this.decorBlockedTilesByChunk.get(chunkKey) ?? decorKeys;
      for (const k of stampedDecor) this.decorBlockedTiles.delete(k);
      this.decorBlockedTilesByChunk.delete(chunkKey);
    };
    const abortEarlyObjectLoadIfStopped = (): boolean => {
      if (!this.isObjectLoadStale(generation) && this.shouldLoadObjectChunkNow(chunkKey)) return false;
      cleanupDecorAndRoofStamps();
      return true;
    };

    // Split into thin-instanceable static scenery vs regular interactable,
    // animated, door, and stair hierarchies.
    // Need to load templates first so canThinInstance can check for animations.
    const templateAssetIds = new Set<string>();
    for (const obj of renderableObjects) {
      templateAssetIds.add(obj.assetId);
    }
    for (const assetId of templateAssetIds) {
      await this.loadGLBModel(assetId, generation);
      await this.yieldIfFrameBudgetSpent(workSlice);
      if (abortEarlyObjectLoadIfStopped()) return;
    }
    if (abortEarlyObjectLoadIfStopped()) return;
    if (!this.shouldLoadObjectChunkNow(chunkKey)) {
      this.disposeChunkPlacedObjects(chunkKey);
      this.loadingObjectChunks.delete(chunkKey);
      return;
    }

    for (const obj of renderableObjects) {
      if (obj.noRoof || !this.isRoofLikeAsset(obj.assetId)) continue;
      const bounds = this.getPlacedObjectTemplateBounds(obj.assetId, obj);
      if (bounds) this.stampRoofObjectFootprint(chunkKey, obj, bounds.min, bounds.max);
      await this.yieldIfFrameBudgetSpent(workSlice);
      if (abortEarlyObjectLoadIfStopped()) return;
    }

    type ThinGroup = { assetId: string; visibility: 'ground' | 'elevated' | 'roof'; placements: PlacedObject[] };
    const regularObjects: PlacedObject[] = [];
    const thinGroups = new Map<string, ThinGroup>();
    for (const obj of renderableObjects) {
      if (!this.loadedModelCache.get(obj.assetId)) continue;
      if (this.canThinInstance(obj)) {
        const visibility = this.getThinVisibilityClass(obj);
        const groupKey = placedObjectThinGroupKey(obj.assetId, visibility, obj.position.y);
        let group = thinGroups.get(groupKey);
        if (!group) {
          group = { assetId: obj.assetId, visibility, placements: [] };
          thinGroups.set(groupKey, group);
        }
        group.placements.push(obj);
      } else {
        regularObjects.push(obj);
      }
      await this.yieldIfFrameBudgetSpent(workSlice);
      if (abortEarlyObjectLoadIfStopped()) return;
    }

    // --- Thin instances: one source mesh per sub-mesh per asset per chunk ---
    const thinSources: Mesh[] = [];
    const roofThinSources: Mesh[] = [];
    const elevatedThinSources: ElevatedThinInstanceSource[] = [];
    const structuralThinSources: ElevatedThinInstanceSource[] = [];
    const nodes: TransformNode[] = [];
    const anims: AnimationGroup[] = [];
    const cleanupPartialChunkLoad = () => {
      cleanupDecorAndRoofStamps();
      for (const m of thinSources) {
        if (!m.isDisposed()) m.dispose();
      }
      thinSources.length = 0;
      roofThinSources.length = 0;
      elevatedThinSources.length = 0;
      structuralThinSources.length = 0;
      for (const ag of anims) {
        const aidx = this.activeAnimationGroups.indexOf(ag);
        if (aidx >= 0) this.activeAnimationGroups.splice(aidx, 1);
        ag.dispose();
      }
      anims.length = 0;
      for (const node of nodes) {
        const idx = this.placedObjectNodes.indexOf(node);
        if (idx >= 0) this.placedObjectNodes.splice(idx, 1);
        this.placedObjectNodeSet.delete(node);
        const assetId = (node.metadata as PlacedObjectNodeMetadata | null)?.assetId;
        if (assetId && objectDefIdForPlacedAsset(assetId) != null) {
          const placed = this.placedObjectAuthoredPosition(node);
          const gridKey = `${Math.floor(placed.x)},${Math.floor(placed.z)}`;
          const nodesAtTile = this.placedObjectGrid.get(gridKey);
          if (nodesAtTile) {
            const nidx = nodesAtTile.indexOf(node);
            if (nidx >= 0) nodesAtTile.splice(nidx, 1);
            if (nodesAtTile.length === 0) this.placedObjectGrid.delete(gridKey);
          }
        }
        if (!node.isDisposed()) node.dispose();
      }
      nodes.length = 0;
      this.chunkThinInstSources.delete(chunkKey);
      this.chunkRoofThinInstSources.delete(chunkKey);
      this.chunkElevatedThinInstSources.delete(chunkKey);
      this.chunkStructuralThinInstSources.delete(chunkKey);
    };
    const abortPartialLoadIfStopped = (): boolean => {
      if (!this.isObjectLoadStale(generation) && this.shouldLoadObjectChunkNow(chunkKey)) return false;
      cleanupPartialChunkLoad();
      return true;
    };
    const _tmpMatrix = Matrix.Identity();
    const _placementMatrix = Matrix.Identity();

    for (const { assetId, visibility, placements } of thinGroups.values()) {
      const template = this.loadedModelCache.get(assetId)!;
      const baseEntries = this.getTemplateBaseMatrices(assetId, template);
      if (baseEntries.length === 0) continue;

      const scaleBoost = this.getPlacedObjectScaleBoost(assetId);
      const elevatedTileKeys = visibility === 'elevated'
        ? new Set(placements.map(obj => `${Math.floor(obj.position.x)},${Math.floor(obj.position.z)}`))
        : null;
      const structuralTileKeys = visibility !== 'roof' && isRevealStructuralPlacedAsset(assetId)
        ? elevatedTileKeys ?? new Set(placements.map(obj => `${Math.floor(obj.position.x)},${Math.floor(obj.position.z)}`))
        : null;

      for (const { sourceMesh, baseMatrix } of baseEntries) {
        const src = sourceMesh.clone(`thin_${chunkKey}_${assetId}_${sourceMesh.name}`, null)!;
        src.parent = null;
        src.position.set(0, 0, 0);
        src.rotation.set(0, 0, 0);
        src.rotationQuaternion = null;
        src.scaling.set(1, 1, 1);
        src.setEnabled(false);
        if (src instanceof Mesh) src.makeGeometryUnique();
        const mat = src.material;
        if (mat) {
          if ((mat as any).transparencyMode !== undefined) (mat as any).transparencyMode = 1;
          (mat as any).alpha = 1;
          mat.backFaceCulling = false;
          (mat as any).freeze?.();
        }
        src.isPickable = false;

        let maxOriginY = -Infinity;
        for (const obj of placements) {
          this.composePlacedObjectMatrix(obj, scaleBoost, _placementMatrix);
          baseMatrix.multiplyToRef(_placementMatrix, _tmpMatrix);
          src.thinInstanceAdd(_tmpMatrix);
          if (obj.position.y > maxOriginY) maxOriginY = obj.position.y;
          await this.yieldIfFrameBudgetSpent(workSlice);
          if (abortPartialLoadIfStopped()) return;
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
        src.metadata = { ...(src.metadata ?? {}), assetId, chunkKey };
        thinSources.push(src);
        if (visibility === 'roof') roofThinSources.push(src);
        else if (visibility === 'elevated' && Number.isFinite(bMinX) && Number.isFinite(bMaxX) && Number.isFinite(maxOriginY)) {
          elevatedThinSources.push({ mesh: src, minX: bMinX, maxX: bMaxX, maxOriginY, minZ: bMinZ, maxZ: bMaxZ, tileKeys: elevatedTileKeys ?? undefined });
        }
        if (structuralTileKeys && Number.isFinite(bMinX) && Number.isFinite(bMaxX) && Number.isFinite(maxOriginY)) {
          structuralThinSources.push({ mesh: src, minX: bMinX, maxX: bMaxX, maxOriginY, minZ: bMinZ, maxZ: bMaxZ, tileKeys: structuralTileKeys });
        }
        await this.yieldIfFrameBudgetSpent(workSlice);
        if (abortPartialLoadIfStopped()) return;
      }
    }
    this.chunkThinInstSources.set(chunkKey, thinSources);
    if (roofThinSources.length > 0) this.chunkRoofThinInstSources.set(chunkKey, roofThinSources);
    if (elevatedThinSources.length > 0) this.chunkElevatedThinInstSources.set(chunkKey, elevatedThinSources);
    if (structuralThinSources.length > 0) this.chunkStructuralThinInstSources.set(chunkKey, structuralThinSources);

    // --- Regular instances: interactable, animated, doors, stairs ---
    let idx = 0;
    for (const obj of regularObjects) {
      const template = this.loadedModelCache.get(obj.assetId)!;

      const instance = template.instantiateHierarchy(null, undefined, (source, cloned) => {
        cloned.name = `placed_${chunkKey}_${idx}_${source.name}`;
      });
      if (!instance) continue;
      instance.setEnabled(false);
      for (const child of instance.getChildMeshes()) {
        child.setEnabled(true);
        child.isPickable = false;
        const mat = child.material as any;
        if (mat) {
          if (mat.transparencyMode !== undefined) mat.transparencyMode = 1;
          mat.alpha = 1;
        }
      }
      const root = instance;

      const templateAnims = this.modelAnimationGroups.get(obj.assetId);
      const instanceAnims: AnimationGroup[] = [];
      if (templateAnims) {
        const oneShotAnimation = this.isOneShotPlacedAnimationAsset(obj.assetId);
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
            if (oneShotAnimation) {
              clonedGroup.stop();
              this.oneShotPlacedAnimationGroups.add(clonedGroup);
            } else {
              clonedGroup.stop();
            }
            anims.push(clonedGroup);
            instanceAnims.push(clonedGroup);
            this.activeAnimationGroups.push(clonedGroup);
          } else {
            clonedGroup.dispose();
          }
        }
      }

      root.position = new Vector3(obj.position.x, obj.position.y, obj.position.z);
      const { x: orx, y: ory, z: orz } = obj.rotation;
      root.rotationQuaternion = Quaternion.FromEulerAngles(orx, ory, orz);
      const scaleBoost = this.getPlacedObjectScaleBoost(obj.assetId);
      root.scaling = new Vector3(obj.scale.x * scaleBoost, obj.scale.y * scaleBoost, obj.scale.z * scaleBoost);
      root.metadata = {
        ...root.metadata,
        assetId: obj.assetId,
        chunkKey,
        placedX: obj.position.x,
        placedY: obj.position.y,
        placedZ: obj.position.z,
        interactionActions: this.placedObjectInteractionActions(obj),
        interactions: Array.isArray(obj.interactions) && obj.interactions.length > 0 ? obj.interactions : undefined,
        placedName: obj.name,
        isNoRoof: obj.noRoof === true,
      } satisfies PlacedObjectNodeMetadata;

      if (!obj.noRoof && this.isRoofLikeAsset(obj.assetId)) {
        const bounds = this.getPlacedObjectTemplateBounds(obj.assetId, obj);
        if (bounds) this.stampRoofObjectFootprint(chunkKey, obj, bounds.min, bounds.max, root);
      }

      const hasAnims = !!templateAnims && templateAnims.length > 0;
      if (!hasAnims && !isInteractiveDoorPlacedAsset(obj.assetId)) {
        root.freezeWorldMatrix();
        for (const child of root.getChildMeshes()) {
          child.freezeWorldMatrix();
          child.doNotSyncBoundingInfo = true;
          if (child.material) (child.material as any).freeze?.();
        }
      }

      nodes.push(root);
      if (instanceAnims.length > 0) this.placedObjectAnimationGroups.set(root, instanceAnims);
      this.placedObjectNodes.push(root);
      this.placedObjectNodeSet.add(root);

      if (objectDefIdForPlacedAsset(obj.assetId) != null) {
        const gridKey = `${Math.floor(obj.position.x)},${Math.floor(obj.position.z)}`;
        let nodesAtTile = this.placedObjectGrid.get(gridKey);
        if (!nodesAtTile) {
          nodesAtTile = [];
          this.placedObjectGrid.set(gridKey, nodesAtTile);
        }
        nodesAtTile.push(root);
      }

      idx++;
      await this.yieldIfFrameBudgetSpent(workSlice);
      if (abortPartialLoadIfStopped()) return;
    }

    if (renderableObjects.length > 0) {
      await this.addShadowsForObjects(renderableObjects, workSlice);
      if (abortPartialLoadIfStopped()) return;
      this.queueGroundShadowRebuildsForObjects(renderableObjects);
    }

    this.chunkPlacedNodes.set(chunkKey, nodes);
    this.touchObjectChunk(chunkKey);
    this.chunkAnimGroups.set(chunkKey, anims);
    const visible = this.isObjectChunkVisibleNow(chunkKey);
    this.setChunkPlacedObjectsEnabled(chunkKey, visible);

    if (visible) this.onChunkObjectsLoaded?.(chunkKey);
    } catch (e) {
      if (!this.isObjectLoadStale(generation)) {
        if (isMapResourceFetchError(e)) {
          console.warn(`[ChunkManager] Failed to load object chunk ${chunkKey}:`, e);
          return;
        }
        console.warn(`[ChunkManager] Failed to instantiate objects for chunk ${chunkKey}:`, e);
        this.clearRoofObjectGridForChunk(chunkKey);
        this.chunkPlacedNodes.set(chunkKey, []);
        this.touchObjectChunk(chunkKey);
        this.chunkThinInstSources.set(chunkKey, []);
        this.chunkStructuralThinInstSources.delete(chunkKey);
      }
    } finally {
      if (!this.isObjectLoadStale(generation)) this.loadingObjectChunks.delete(chunkKey);
    }
  }

  /** Dispose placed objects for a chunk leaving the player's radius */
  private disposeChunkPlacedObjects(chunkKey: string): void {
    this.clearRoofObjectGridForChunk(chunkKey);

    const decorKeys = this.decorBlockedTilesByChunk.get(chunkKey);
    if (decorKeys) {
      for (const k of decorKeys) this.decorBlockedTiles.delete(k);
      this.decorBlockedTilesByChunk.delete(chunkKey);
    }

    const nodes = this.chunkPlacedNodes.get(chunkKey);
    if (nodes) {
      for (const node of nodes) {
        // Remove from spatial grid
        const assetId = (node.metadata as PlacedObjectNodeMetadata | null)?.assetId;
        if (assetId && objectDefIdForPlacedAsset(assetId) != null) {
          const placed = this.placedObjectAuthoredPosition(node);
          const gridKey = `${Math.floor(placed.x)},${Math.floor(placed.z)}`;
          const nodesAtTile = this.placedObjectGrid.get(gridKey);
          if (nodesAtTile) {
            const idx = nodesAtTile.indexOf(node);
            if (idx >= 0) nodesAtTile.splice(idx, 1);
            if (nodesAtTile.length === 0) this.placedObjectGrid.delete(gridKey);
          }
        }
        // Remove from flat list
        const idx = this.placedObjectNodes.indexOf(node);
        if (idx >= 0) this.placedObjectNodes.splice(idx, 1);
        this.placedObjectNodeSet.delete(node);
        node.dispose();
      }
      this.chunkPlacedNodes.delete(chunkKey);
    }
    this.chunkPlacedEnabled.delete(chunkKey);
    this.objectChunkLastUsed.delete(chunkKey);
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
    this.chunkRoofThinInstSources.delete(chunkKey);
    this.chunkElevatedThinInstSources.delete(chunkKey);
    this.chunkStructuralThinInstSources.delete(chunkKey);
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
    this.texturePlaneChunksEnabled.delete(chunkKey);
  }

  private setChunkPlacedObjectsEnabled(chunkKey: string, enabled: boolean): boolean {
    if (this.chunkPlacedEnabled.get(chunkKey) === enabled) return false;

    const nodes = this.chunkPlacedNodes.get(chunkKey);
    const thinSrcs = this.chunkThinInstSources.get(chunkKey);
    const anims = this.chunkAnimGroups.get(chunkKey);
    const hasRenderableContent = (nodes?.length ?? 0) > 0 || (thinSrcs?.length ?? 0) > 0 || (anims?.length ?? 0) > 0;

    this.chunkPlacedEnabled.set(chunkKey, enabled);
    if (nodes) {
      for (const node of nodes) node.setEnabled(enabled);
    }
    if (thinSrcs) {
      for (const m of thinSrcs) m.setEnabled(enabled);
    }
    if (anims) {
      for (const ag of anims) {
        if (enabled && !this.oneShotPlacedAnimationGroups.has(ag)) ag.play(true);
        else ag.stop();
      }
    }

    return hasRenderableContent;
  }

  playPlacedObjectAnimation(node: TransformNode): boolean {
    let root: TransformNode | null = node;
    while (root && !this.placedObjectNodeSet.has(root)) root = root.parent as TransformNode | null;
    if (!root) return false;

    const groups = this.placedObjectAnimationGroups.get(root);
    if (!groups || groups.length === 0) return false;

    for (const group of groups) {
      group.stop();
      group.reset();
      group.play(false);
    }
    return true;
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
    return isRoofLikePlacedAsset(assetId);
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

    // Indoor signal B: roof/upper-floor cover. Player's tile has any roof
    // entry above their head. Stamps are tight (center-inside-AABB gate at
    // the placed-object and texture-plane stamp sites), so an entry here
    // really means the player is under it — multiple layers (e.g. upper
    // floor + building roof on the ground floor of a 2-storey building)
    // all count as indoor.
    //
    // Veto: a flat noRoof texture plane covering this tile means the author
    // declared this column outdoor (balconies, terraces, open structures).
    if (tx >= 0 && tx < this.mapWidth && tz >= 0 && tz < this.mapHeight) {
      const tileIdx = tz * this.mapWidth + tx;
      if (this.noRoofPlaneTiles.has(tileIdx)) return false;
    }
    const here = this.roofObjectGrid.get(`${tx},${tz}`);
    if (!here) return false;
    for (const e of here) {
      if (e.y > playerY + 0.5) return true;
    }
    return false;
  }


  private appendRoofEntryNodes(
    entry: RoofObjectGridEntry,
    minY: number,
    result: TransformNode[],
    seen: Set<TransformNode>,
    seenRoofChunkKeys: Set<string>,
  ): void {
    if (entry.y <= minY) return;
    if (entry.node) {
      if (seen.has(entry.node)) return;
      seen.add(entry.node);
      result.push(entry.node);
      return;
    }
    if (!entry.chunkKey || seenRoofChunkKeys.has(entry.chunkKey)) return;
    seenRoofChunkKeys.add(entry.chunkKey);
    const roofSources = this.chunkRoofThinInstSources.get(entry.chunkKey);
    if (!roofSources) return;
    for (const node of roofSources) {
      if (seen.has(node)) continue;
      seen.add(node);
      result.push(node);
    }
  }

  private roofEntryMatchesRevealSeed(entry: RoofObjectGridEntry, minY: number, seed: RoofRevealSeed): boolean {
    return entry.y > minY
      && entry.floor === seed.floor
      && Math.abs(entry.y - seed.y) <= ROOF_REVEAL_LAYER_HEIGHT_TOLERANCE;
  }

  private roofSeedAtTile(tx: number, tz: number, minY: number): RoofRevealSeed | null {
    const arr = this.roofObjectGrid.get(`${tx},${tz}`);
    if (!arr) return null;
    let best: RoofObjectGridEntry | null = null;
    for (const entry of arr) {
      if (entry.y <= minY) continue;
      if (!best || entry.y < best.y) best = entry;
    }
    return best ? { x: tx, z: tz, floor: best.floor, y: best.y } : null;
  }

  findRoofHoverPointFromRay(
    rayOrigin: Vector3,
    rayDirection: Vector3,
    minY: number,
    searchX: number,
    searchZ: number,
    radius: number,
  ): { x: number; z: number; y: number } | null {
    if (Math.abs(rayDirection.y) < 0.0001) return null;
    const tx = Math.floor(searchX);
    const tz = Math.floor(searchZ);
    const r = Math.max(0, Math.ceil(radius));
    let best: { x: number; z: number; y: number; t: number } | null = null;

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const tileX = tx + dx;
        const tileZ = tz + dz;
        const arr = this.roofObjectGrid.get(`${tileX},${tileZ}`);
        if (!arr) continue;
        for (const entry of arr) {
          if (entry.y <= minY) continue;
          if (entry.node?.isDisposed()) continue;
          const t = (entry.y - rayOrigin.y) / rayDirection.y;
          if (t <= 0 || !Number.isFinite(t)) continue;
          if (best && t >= best.t) continue;

          const x = rayOrigin.x + rayDirection.x * t;
          const z = rayOrigin.z + rayDirection.z * t;
          if (Math.floor(x) !== tileX || Math.floor(z) !== tileZ) continue;
          best = { x, z, y: entry.y, t };
        }
      }
    }

    return best ? { x: best.x, z: best.z, y: best.y } : null;
  }

  findRoofRevealPointFromRay(
    rayOrigin: Vector3,
    rayDirection: Vector3,
    minY: number,
    searchX: number,
    searchZ: number,
    roofRayRadius: number,
    structuralTriggerRadius: number,
    structuralSampleYs: readonly number[],
  ): { x: number; z: number; y: number } | null {
    const roofHit = this.findRoofHoverPointFromRay(rayOrigin, rayDirection, minY, searchX, searchZ, roofRayRadius);
    if (roofHit) return roofHit;
    if (Math.abs(rayDirection.y) < 0.0001) return null;

    const seenTiles = new Set<string>();
    for (const sampleY of structuralSampleYs) {
      const t = (sampleY - rayOrigin.y) / rayDirection.y;
      if (t <= 0 || !Number.isFinite(t)) continue;
      const x = rayOrigin.x + rayDirection.x * t;
      const z = rayOrigin.z + rayDirection.z * t;
      const tx = Math.floor(x);
      const tz = Math.floor(z);
      const key = `${tx},${tz}`;
      if (seenTiles.has(key)) continue;
      seenTiles.add(key);
      const seed = this.roofSeedAtTile(tx, tz, minY)
        ?? this.findRevealStructuralRoofSeedNear(x, z, minY, structuralTriggerRadius);
      if (seed) return { x, z, y: sampleY };
    }

    return null;
  }

  private roofHasRevealSeedAtTile(tx: number, tz: number, minY: number, seed: RoofRevealSeed): boolean {
    const arr = this.roofObjectGrid.get(`${tx},${tz}`);
    if (!arr) return false;
    for (const entry of arr) {
      if (this.roofEntryMatchesRevealSeed(entry, minY, seed)) return true;
    }
    return false;
  }

  private findRoofSeedTile(tx: number, tz: number, minY: number, radius: number): RoofRevealSeed | null {
    const r = Math.max(0, Math.ceil(radius));
    let best: { seed: RoofRevealSeed; distSq: number } | null = null;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = tx + dx;
        const z = tz + dz;
        const seed = this.roofSeedAtTile(x, z, minY);
        if (!seed) continue;
        const distSq = dx * dx + dz * dz;
        if (!best || distSq < best.distSq || (distSq === best.distSq && seed.y < best.seed.y)) best = { seed, distSq };
      }
    }
    return best?.seed ?? null;
  }

  private findRevealStructuralRoofSeedNear(x: number, z: number, minY: number, radius: number): RoofRevealSeed | null {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    const r = Math.ceil(radius);
    const radiusSq = Math.max(0, radius) * Math.max(0, radius);
    const minChunkX = Math.floor((tx - r) / CHUNK_SIZE);
    const maxChunkX = Math.floor((tx + r) / CHUNK_SIZE);
    const minChunkZ = Math.floor((tz - r) / CHUNK_SIZE);
    const maxChunkZ = Math.floor((tz + r) / CHUNK_SIZE);
    let best: { seed: RoofRevealSeed; objectDistSq: number; roofDistSq: number } | null = null;

    for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
      for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
        const objects = this.placedObjectsByChunk.get(`${chunkX},${chunkZ}`);
        if (!objects) continue;
        for (const obj of objects) {
          if (obj.noRoof || !isRevealStructuralPlacedAsset(obj.assetId)) continue;
          const ox = Math.floor(obj.position.x);
          const oz = Math.floor(obj.position.z);
          const dx = ox - tx;
          const dz = oz - tz;
          if (Math.abs(dx) > r || Math.abs(dz) > r) continue;
          const objectDx = (ox + 0.5) - x;
          const objectDz = (oz + 0.5) - z;
          const objectDistSq = objectDx * objectDx + objectDz * objectDz;
          if (objectDistSq > radiusSq) continue;
          const seed = this.findRoofSeedTile(ox, oz, minY, radius);
          if (!seed) continue;

          const roofDx = seed.x - ox;
          const roofDz = seed.z - oz;
          const roofDistSq = roofDx * roofDx + roofDz * roofDz;
          if (!best
            || objectDistSq < best.objectDistSq
            || (objectDistSq === best.objectDistSq && roofDistSq < best.roofDistSq)
            || (objectDistSq === best.objectDistSq && roofDistSq === best.roofDistSq && seed.y < best.seed.y)) {
            best = { seed, objectDistSq, roofDistSq };
          }
        }
      }
    }

    return best?.seed ?? null;
  }

  private collectConnectedRoofTileKeys(seed: RoofRevealSeed, minY: number): Set<string> {
    const result = new Set<string>();
    const queue: { x: number; z: number }[] = [{ x: seed.x, z: seed.z }];
    const seedKey = `${seed.x},${seed.z}`;
    result.add(seedKey);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    for (let qi = 0; qi < queue.length && result.size < ROOF_REVEAL_CONNECTED_TILE_LIMIT; qi++) {
      const tile = queue[qi];
      for (const [dx, dz] of dirs) {
        const nx = tile.x + dx;
        const nz = tile.z + dz;
        const nk = `${nx},${nz}`;
        if (result.has(nk)) continue;
        if (!this.roofHasRevealSeedAtTile(nx, nz, minY, seed)) continue;
        result.add(nk);
        queue.push({ x: nx, z: nz });
        if (result.size >= ROOF_REVEAL_CONNECTED_TILE_LIMIT) break;
      }
    }
    return result;
  }

  private appendRoofEntriesForTileKeys(
    tileKeys: Set<string>,
    minY: number,
    result: TransformNode[],
    seen: Set<TransformNode>,
    seenRoofChunkKeys: Set<string>,
  ): void {
    for (const key of tileKeys) {
      const arr = this.roofObjectGrid.get(key);
      if (!arr) continue;
      for (const entry of arr) {
        if (entry.y <= minY) continue;
        this.appendRoofEntryNodes(entry, minY, result, seen, seenRoofChunkKeys);
      }
    }
  }

  private firstRoofRevealLayerY(tileKeys: Set<string>, minY: number): number | null {
    let result = Infinity;
    for (const key of tileKeys) {
      const arr = this.roofObjectGrid.get(key);
      if (!arr) continue;
      for (const entry of arr) {
        if (entry.y > minY && entry.y < result) result = entry.y;
      }
    }
    return Number.isFinite(result) ? result : null;
  }

  private expandedTileKeys(tileKeys: Set<string>, radius: number): Set<string> {
    if (radius <= 0) return tileKeys;
    const expanded = new Set<string>(tileKeys);
    const r = Math.ceil(radius);
    for (const key of tileKeys) {
      const [sx, sz] = key.split(',');
      const tx = Number(sx);
      const tz = Number(sz);
      if (!Number.isFinite(tx) || !Number.isFinite(tz)) continue;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          expanded.add(`${tx + dx},${tz + dz}`);
        }
      }
    }
    return expanded;
  }

  private appendPlacedRevealNodesForTileKeys(
    tileKeys: Set<string>,
    minRevealY: number,
    hiddenObjectMinY: number,
    texturePlaneMinY: number,
    result: TransformNode[],
    seen: Set<TransformNode>,
  ): void {
    if (tileKeys.size === 0) return;
    let minTileX = Infinity, maxTileX = -Infinity, minTileZ = Infinity, maxTileZ = -Infinity;
    for (const key of tileKeys) {
      const [sx, sz] = key.split(',');
      const tx = Number(sx);
      const tz = Number(sz);
      if (!Number.isFinite(tx) || !Number.isFinite(tz)) continue;
      if (tx < minTileX) minTileX = tx;
      if (tx > maxTileX) maxTileX = tx;
      if (tz < minTileZ) minTileZ = tz;
      if (tz > maxTileZ) maxTileZ = tz;
    }
    if (!Number.isFinite(minTileX) || !Number.isFinite(minTileZ)) return;

    const minChunkX = Math.floor(minTileX / CHUNK_SIZE);
    const maxChunkX = Math.floor(maxTileX / CHUNK_SIZE);
    const minChunkZ = Math.floor(minTileZ / CHUNK_SIZE);
    const maxChunkZ = Math.floor(maxTileZ / CHUNK_SIZE);
    const footprintMinX = minTileX;
    const footprintMaxX = maxTileX + 1;
    const footprintMinZ = minTileZ;
    const footprintMaxZ = maxTileZ + 1;
    const textureFootprintMinX = footprintMinX - ROOF_REVEAL_TEXTURE_PLANE_BBOX_PADDING;
    const textureFootprintMaxX = footprintMaxX + ROOF_REVEAL_TEXTURE_PLANE_BBOX_PADDING;
    const textureFootprintMinZ = footprintMinZ - ROOF_REVEAL_TEXTURE_PLANE_BBOX_PADDING;
    const textureFootprintMaxZ = footprintMaxZ + ROOF_REVEAL_TEXTURE_PLANE_BBOX_PADDING;
    const textureMinChunkX = Math.floor(textureFootprintMinX / CHUNK_SIZE);
    const textureMaxChunkX = Math.floor(textureFootprintMaxX / CHUNK_SIZE);
    const textureMinChunkZ = Math.floor(textureFootprintMinZ / CHUNK_SIZE);
    const textureMaxChunkZ = Math.floor(textureFootprintMaxZ / CHUNK_SIZE);

    for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
      for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
        const chunkKey = `${chunkX},${chunkZ}`;
        const nodes = this.chunkPlacedNodes.get(chunkKey);
        if (nodes) {
          for (const node of nodes) {
            if (seen.has(node)) continue;
            const md = node.metadata as PlacedObjectNodeMetadata | null;
            const assetId = typeof md?.assetId === 'string' ? md.assetId : '';
            if (!assetId) continue;
            if (md?.isNoRoof) continue;

            const ap = node.getAbsolutePosition();
            const isBuildingPart = this.isRoofLikeAsset(assetId) || isRevealStructuralPlacedAsset(assetId);
            if (ap.y <= (isBuildingPart ? minRevealY : hiddenObjectMinY)) continue;
            if (!tileKeys.has(`${Math.floor(ap.x)},${Math.floor(ap.z)}`)) continue;
            seen.add(node);
            result.push(node);
          }
        }

        const structuralSources = this.chunkStructuralThinInstSources.get(chunkKey);
        if (structuralSources) {
          for (const entry of structuralSources) {
            const node = entry.mesh;
            if (seen.has(node) || entry.maxOriginY <= minRevealY) continue;
            if (entry.maxX < footprintMinX || entry.minX > footprintMaxX || entry.maxZ < footprintMinZ || entry.minZ > footprintMaxZ) continue;
            if (entry.tileKeys) {
              let hasRevealTile = false;
              for (const key of entry.tileKeys) {
                if (tileKeys.has(key)) {
                  hasRevealTile = true;
                  break;
                }
              }
              if (!hasRevealTile) continue;
            }
            seen.add(node);
            result.push(node);
          }
        }

        const elevatedSources = this.chunkElevatedThinInstSources.get(chunkKey);
        if (elevatedSources) {
          for (const entry of elevatedSources) {
            const node = entry.mesh;
            if (seen.has(node) || entry.maxOriginY <= hiddenObjectMinY) continue;
            if (entry.maxX < footprintMinX || entry.minX > footprintMaxX || entry.maxZ < footprintMinZ || entry.minZ > footprintMaxZ) continue;
            if (entry.tileKeys) {
              let hasRevealTile = false;
              for (const key of entry.tileKeys) {
                if (tileKeys.has(key)) {
                  hasRevealTile = true;
                  break;
                }
              }
              if (!hasRevealTile) continue;
            }
            seen.add(node);
            result.push(node);
          }
        }
      }
    }

    for (let chunkZ = textureMinChunkZ; chunkZ <= textureMaxChunkZ; chunkZ++) {
      for (let chunkX = textureMinChunkX; chunkX <= textureMaxChunkX; chunkX++) {
        const texturePlanes = this.texturePlaneRevealEntriesByChunk.get(`${chunkX},${chunkZ}`);
        if (!texturePlanes) continue;
        for (const entry of texturePlanes) {
          const node = entry.mesh;
          // noRoof and flatness affect indoor detection, but connected hover
          // reveal still hides any upper-storey texture plane inside the
          // revealed building. Castle cap/ledge planes are sometimes authored
          // a few tiles outside the roof grid, so use the padded bbox instead
          // of exact tile overlap.
          if (seen.has(node) || entry.minY <= texturePlaneMinY) continue;
          if (entry.maxX < textureFootprintMinX || entry.minX > textureFootprintMaxX || entry.maxZ < textureFootprintMinZ || entry.minZ > textureFootprintMaxZ) continue;
          seen.add(node);
          result.push(node);
        }
      }
    }
  }

  getConnectedRoofRevealNodesAt(
    x: number,
    z: number,
    minY: number,
    minRevealY: number,
    wallTriggerRadius: number,
  ): TransformNode[] {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    let seed = this.roofSeedAtTile(tx, tz, minY);
    if (!seed) {
      seed = this.findRevealStructuralRoofSeedNear(x, z, minY, wallTriggerRadius);
      if (!seed) return [];
    }

    const roofTileKeys = this.collectConnectedRoofTileKeys(seed, minY);
    const revealTileKeys = this.expandedTileKeys(roofTileKeys, ROOF_REVEAL_NEARBY_TILE_PADDING);
    const result: TransformNode[] = [];
    const seen = new Set<TransformNode>();
    const seenRoofChunkKeys = new Set<string>();
    // The seed layer only identifies the building footprint. Tall castles can
    // stack lower roof/floor caps under the real top roof, so reveal every
    // roof/structural layer above the player over that connected footprint.
    const firstLayerY = this.firstRoofRevealLayerY(revealTileKeys, minY);
    const hiddenObjectMinY = firstLayerY === null
      ? minRevealY
      : Math.max(minRevealY, firstLayerY - ROOF_REVEAL_OBJECT_LAYER_BELOW_TOLERANCE);
    this.appendRoofEntriesForTileKeys(revealTileKeys, minY, result, seen, seenRoofChunkKeys);
    this.appendPlacedRevealNodesForTileKeys(revealTileKeys, minRevealY, hiddenObjectMinY, minY, result, seen);
    return result;
  }

  /** Get all roof nodes near a position on the given floor or above (for hiding). */
  getRoofNodesNear(x: number, z: number, radius: number, minY: number, _floor: number): TransformNode[] {
    const result: TransformNode[] = [];
    const seen = new Set<TransformNode>();
    const seenRoofChunkKeys = new Set<string>();
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
            this.appendRoofEntryNodes(entry, minY, result, seen, seenRoofChunkKeys);
          }
        }
      }
    }
    return result;
  }

  /** Get all placed object nodes near a position that are above a given Y height.
   *  Excludes door objects so they remain clickable when indoors.
   *  Also includes elevated thin-instance groups and merged flat texture-plane
   *  meshes that sit above the threshold — they're not in `chunkPlacedNodes`
   *  because they are batched sources, not one node per placed object. */
  getNodesAboveHeight(x: number, z: number, radius: number, minY: number): TransformNode[] {
    const result: TransformNode[] = [];
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    const r = Math.ceil(radius);
    const seen = new Set<TransformNode>();
    const minChunkX = Math.floor((tx - r) / CHUNK_SIZE);
    const maxChunkX = Math.floor((tx + r) / CHUNK_SIZE);
    const minChunkZ = Math.floor((tz - r) / CHUNK_SIZE);
    const maxChunkZ = Math.floor((tz + r) / CHUNK_SIZE);
    for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
      for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
        const chunkKey = `${chunkX},${chunkZ}`;
        const nodes = this.chunkPlacedNodes.get(chunkKey);
        if (nodes) {
          for (const node of nodes) {
            if (seen.has(node)) continue;
            // True door panels remain visible while roofs/floor slabs are culled;
            // decorative modular door frames should hide with their storey.
            const assetId = typeof node.metadata?.assetId === 'string' ? node.metadata.assetId.toLowerCase() : '';
            if (isInteractiveDoorPlacedAsset(assetId)) continue;
            if ((node.metadata as PlacedObjectNodeMetadata | null)?.isNoRoof) continue;

            // Door/non-door placed objects can be reparented under pivots, so use
            // absolute position rather than local transform when deciding height.
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

        const elevatedSources = this.chunkElevatedThinInstSources.get(chunkKey);
        if (elevatedSources) {
          const minX = tx - r;
          const maxX = tx + r + 1;
          const minZ = tz - r;
          const maxZ = tz + r + 1;
          for (const entry of elevatedSources) {
            const node = entry.mesh;
            // Match regular placed-node culling: height tests use placement
            // origin, not the generously padded render AABB. Otherwise tall
            // bridge posts can be hidden with the roof while the player is
            // walking beside or over them.
            if (seen.has(node) || entry.maxOriginY <= minY) continue;
            if (entry.maxX < minX || entry.minX > maxX || entry.maxZ < minZ || entry.minZ > maxZ) continue;
            seen.add(node);
            result.push(node);
          }
        }
      }
    }
    // Also fold in flat texture-plane meshes whose lowest plane sits above
    // the threshold. We use chunk-center distance as the spatial filter
    // (each merged mesh is bound to one chunk).
    const playerChunkX = Math.floor(x / CHUNK_SIZE);
    const playerChunkZ = Math.floor(z / CHUNK_SIZE);
    const chunkRadius = Math.ceil(radius / CHUNK_SIZE) + 1;
    const planeMinChunkX = playerChunkX - chunkRadius;
    const planeMaxChunkX = playerChunkX + chunkRadius;
    const planeMinChunkZ = playerChunkZ - chunkRadius;
    const planeMaxChunkZ = playerChunkZ + chunkRadius;
    for (let chunkZ = planeMinChunkZ; chunkZ <= planeMaxChunkZ; chunkZ++) {
      for (let chunkX = planeMinChunkX; chunkX <= planeMaxChunkX; chunkX++) {
        const meshes = this.texturePlanesByChunk.get(`${chunkX},${chunkZ}`);
        if (!meshes) continue;
        for (const m of meshes) {
          const md = m.metadata as { isFlat?: boolean; isNoRoof?: boolean; minY?: number; chunkX?: number; chunkZ?: number } | undefined;
          if (!md || !md.isFlat || md.minY === undefined || md.chunkX === undefined) continue;
          if (md.isNoRoof) continue; // explicitly authored as "never hide"
          if (md.minY <= minY) continue;
          if (seen.has(m)) continue;
          seen.add(m);
          result.push(m);
        }
      }
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

  private createPlacedObjectShadowCaster(
    obj: PlacedObject,
    bounds?: { min: Vector3; max: Vector3 } | null,
  ): ReturnType<typeof createObjectShadowCaster> {
    if (isGroundItemSpawnAssetId(obj.assetId)) return null;
    const width = bounds
      ? Math.max(0.1, bounds.max.x - bounds.min.x)
      : Math.max(0.1, Math.abs(obj.scale?.x ?? 1));
    const depth = bounds
      ? Math.max(0.1, bounds.max.z - bounds.min.z)
      : Math.max(0.1, Math.abs(obj.scale?.z ?? 1));
    return createObjectShadowCaster({
      assetId: obj.assetId,
      x: obj.position.x,
      z: obj.position.z,
      rotationY: obj.rotation?.y ?? 0,
      width,
      depth,
    });
  }

  private applyObjectShadowCaster(caster: NonNullable<ReturnType<typeof createObjectShadowCaster>>, inf: Float32Array, w: number, maxX: number, maxZ: number): void {
    const { x0, x1, z0, z1 } = objectShadowBounds(caster, maxX, maxZ);
    for (let vz = z0; vz <= z1; vz++) {
      for (let vx = x0; vx <= x1; vx++) {
        const factor = objectShadowFactorAt(caster, vx, vz);
        const idx = vz * w + vx;
        if (factor < inf[idx]) inf[idx] = factor;
      }
    }
  }

  private *rootWallShadowEntries(): IterableIterator<readonly [number, number, number]> {
    if (!this.walls) return;

    for (let z = 0; z < this.mapHeight; z++) {
      const row = z * this.mapWidth;
      for (let x = 0; x < this.mapWidth; x++) {
        const mask = this.walls[row + x];
        if (mask !== 0) yield [x, z, mask] as const;
      }
    }
  }

  private getRootWallShadowRuns(): WallShadowRun[] {
    if (!this.rootWallShadowRunsCache) {
      this.rootWallShadowRunsCache = wallShadowRunsFromEntries(this.rootWallShadowEntries());
    }
    return this.rootWallShadowRunsCache;
  }

  private shouldUsePlacedObjectShadowFallback(obj: PlacedObject, caster: NonNullable<ReturnType<typeof createObjectShadowCaster>>): boolean {
    if (!isLinearShadowAsset(obj.assetId)) return true;
    return !isLinearCasterCoveredByWallRuns(caster, this.getRootWallShadowRuns());
  }

  private applyCollisionWallShadows(inf: Float32Array, w: number, maxX: number, maxZ: number): number {
    let runCount = 0;
    for (const run of this.getRootWallShadowRuns()) {
      const caster = createWallEdgeShadowCaster(run.x0, run.z0, run.x1, run.z1);
      if (!caster) continue;
      this.applyObjectShadowCaster(caster, inf, w, maxX, maxZ);
      runCount++;
    }
    return runCount;
  }

  /** Build shadow influences from raw placed object data (no mesh required) */
  private buildShadowInfluences(): void {
    if (!this.mapWidth || !this.mapHeight) return;
    const w = this.mapWidth + 1;
    const h = this.mapHeight + 1;
    const inf = new Float32Array(w * h);
    inf.fill(1.0);

    const wallRunCount = this.applyCollisionWallShadows(inf, w, w - 1, h - 1);

    let count = 0;
    for (const [, objects] of this.placedObjectsByChunk) {
      for (const obj of objects) {
        const bounds = isLinearShadowAsset(obj.assetId)
          ? this.getPlacedObjectTemplateBounds(obj.assetId, obj)
          : null;
        const caster = this.createPlacedObjectShadowCaster(obj, bounds);
        if (!caster) continue;
        if (!this.shouldUsePlacedObjectShadowFallback(obj, caster)) continue;
        this.applyObjectShadowCaster(caster, inf, w, w - 1, h - 1);
        count++;
      }
    }

    this.shadowInf = inf;
    if (import.meta.env.DEV) console.log(`[ChunkManager] Built shadow influences for ${count} objects and ${wallRunCount} wall runs`);
  }

  /** Add shadow contribution from a set of placed objects (used in chunked mode) */
  private async addShadowsForObjects(objects: PlacedObject[], workSlice: { start: number }): Promise<void> {
    if (!this.shadowInf || !this.mapWidth) {
      if (import.meta.env.DEV) console.log(`[ChunkManager] addShadowsForObjects: no shadowInf or mapWidth`);
      return;
    }
    const w = this.mapWidth + 1;
    for (const obj of objects) {
      const bounds = isLinearShadowAsset(obj.assetId)
        ? this.getPlacedObjectTemplateBounds(obj.assetId, obj)
        : null;
      const caster = this.createPlacedObjectShadowCaster(obj, bounds);
      if (caster && !this.shouldUsePlacedObjectShadowFallback(obj, caster)) {
        await this.yieldIfFrameBudgetSpent(workSlice);
        continue;
      }
      if (caster) this.applyObjectShadowCaster(caster, this.shadowInf, w, w - 1, this.mapHeight);
      await this.yieldIfFrameBudgetSpent(workSlice);
    }
  }

  /** Queue ground mesh rebuilds for chunks affected by newly loaded object shadows. */
  private queueGroundShadowRebuildsForObjects(objects: PlacedObject[]): void {
    for (const obj of objects) {
      if (isGroundItemSpawnAssetId(obj.assetId)) continue;
      const bounds = isLinearShadowAsset(obj.assetId)
        ? this.getPlacedObjectTemplateBounds(obj.assetId, obj)
        : null;
      const caster = this.createPlacedObjectShadowCaster(obj, bounds);
      if (!caster) continue;
      if (!this.shouldUsePlacedObjectShadowFallback(obj, caster)) continue;
      const { x0, x1, z0, z1 } = objectShadowBounds(caster, this.mapWidth, this.mapHeight);
      const cx0 = Math.floor(x0 / CHUNK_SIZE);
      const cx1 = Math.floor(x1 / CHUNK_SIZE);
      const cz0 = Math.floor(z0 / CHUNK_SIZE);
      const cz1 = Math.floor(z1 / CHUNK_SIZE);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const key = `${cx},${cz}`;
          if (this.chunks.has(key)) this.pendingShadowGroundRebuildChunks.add(key);
        }
      }
    }
    this.scheduleShadowGroundRebuilds();
  }

  private scheduleShadowGroundRebuilds(): void {
    if (this.shadowGroundRebuildScheduled || this.pendingShadowGroundRebuildChunks.size === 0) return;
    this.shadowGroundRebuildScheduled = true;
    this.scheduleNextFrame(() => this.processShadowGroundRebuilds());
  }

  private processShadowGroundRebuilds(): void {
    this.shadowGroundRebuildScheduled = false;
    const start = performance.now();

    while (this.pendingShadowGroundRebuildChunks.size > 0) {
      let bestKey: string | null = null;
      let bestDist = Infinity;
      for (const key of this.pendingShadowGroundRebuildChunks) {
        const [cx, cz] = key.split(',').map(Number);
        const dist = Math.max(Math.abs(cx - this.lastChunkX), Math.abs(cz - this.lastChunkZ));
        if (dist < bestDist) {
          bestDist = dist;
          bestKey = key;
        }
      }
      if (!bestKey) break;
      this.pendingShadowGroundRebuildChunks.delete(bestKey);
      this.rebuildGroundChunkForShadows(bestKey);
      if (performance.now() - start >= this.shadowGroundRebuildFrameBudgetMs) break;
    }

    this.scheduleShadowGroundRebuilds();
  }

  private rebuildGroundChunkForShadows(key: string): void {
    const existing = this.chunks.get(key);
    if (!existing) return;
    const [cx, cz] = key.split(',').map(Number);
    const startX = cx * CHUNK_SIZE, startZ = cz * CHUNK_SIZE;
    const endX = Math.min(startX + CHUNK_SIZE, this.mapWidth);
    const endZ = Math.min(startZ + CHUNK_SIZE, this.mapHeight);
    const wasEnabled = existing.ground.isEnabled();
    existing.ground.dispose();
    existing.ground = this.buildGroundMesh(cx, cz, startX, startZ, endX, endZ);
    existing.ground.freezeWorldMatrix();
    existing.ground.doNotSyncBoundingInfo = true;
    existing.ground.setEnabled(wasEnabled);
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

  getMinimapMarkers(): readonly MinimapMarker[] {
    return this.mapData?.minimapMarkers ?? [];
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
    const halfRing = (plane as any).__halfRing as { u: number; v: number }[] | undefined;
    const localVerts = halfRing?.length
      ? halfRing.map((p) => new Vector3((p.u - 0.5) * plane.width, (p.v - 0.5) * plane.height, 0))
      : [
        new Vector3(-hw, -hh, 0), new Vector3(hw, -hh, 0),
        new Vector3(hw, hh, 0), new Vector3(-hw, hh, 0),
      ];
    const localNormal = new Vector3(0, 0, 1);

    // Build world matrix
    const { x: rx, y: ry, z: rz } = plane.rotation;
    const quat = Quaternion.FromEulerAngles(rx, ry, rz);
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
    for (let i = 0; i < localVerts.length; i++) normals.push(wn.x, wn.y, wn.z);

    const uvs = halfRing?.length
      ? halfRing.flatMap((p) => [p.u, p.v])
      : [0, 0, 1, 0, 1, 1, 0, 1];
    const indices: number[] = [];
    for (let i = 1; i < localVerts.length - 1; i++) indices.push(0, i, i + 1);
    if (plane.doubleSided) {
      for (let i = 1; i < localVerts.length - 1; i++) indices.push(0, i + 1, i);
    }
    return { positions, normals, uvs, indices };
  }

  private indexFlatTexturePickPlane(plane: FlatTexturePickPlane): void {
    const minYBucket = this.flatTexturePickYBucket(plane.minY - SAME_PLANE_PICK_Y_TOLERANCE);
    const maxYBucket = this.flatTexturePickYBucket(plane.maxY + SAME_PLANE_PICK_Y_TOLERANCE);
    const minCellX = this.flatTexturePickCellCoord(plane.minX);
    const maxCellX = this.flatTexturePickCellCoord(plane.maxX);
    const minCellZ = this.flatTexturePickCellCoord(plane.minZ);
    const maxCellZ = this.flatTexturePickCellCoord(plane.maxZ);

    for (let yBucket = minYBucket; yBucket <= maxYBucket; yBucket++) {
      let yPlanes = this.flatTexturePickPlanesByYBucket.get(yBucket);
      if (!yPlanes) {
        yPlanes = [];
        this.flatTexturePickPlanesByYBucket.set(yBucket, yPlanes);
      }
      yPlanes.push(plane);

      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
          const key = this.flatTexturePickCellKey(yBucket, cellX, cellZ);
          let cellPlanes = this.flatTexturePickPlanesByCell.get(key);
          if (!cellPlanes) {
            cellPlanes = [];
            this.flatTexturePickPlanesByCell.set(key, cellPlanes);
          }
          cellPlanes.push(plane);
        }
      }
    }
  }

  private rebuildFlatTexturePickPlanes(planes: TexturePlane[]): void {
    this.flatTexturePickPlanes = [];
    this.flatTexturePickPlanesByYBucket.clear();
    this.flatTexturePickPlanesByCell.clear();
    for (const plane of planes) {
      if (!isFlatPlane(plane)) continue;

      const { x: rx, y: ry, z: rz } = plane.rotation;
      const quat = Quaternion.FromEulerAngles(rx, ry, rz);
      const scale = new Vector3(plane.scale.x, plane.scale.y, plane.scale.z);
      const pos = new Vector3(plane.position.x, plane.position.y, plane.position.z);
      const halfWidth = plane.width / 2;
      const halfHeight = plane.height / 2;
      const world = Matrix.Compose(scale, quat, pos);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      const localCorner = TmpVectors.Vector3[0];
      const worldCorner = TmpVectors.Vector3[1];
      for (let i = 0; i < 4; i++) {
        localCorner.set(i === 0 || i === 3 ? -halfWidth : halfWidth, i < 2 ? -halfHeight : halfHeight, 0);
        Vector3.TransformCoordinatesToRef(localCorner, world, worldCorner);
        if (worldCorner.x < minX) minX = worldCorner.x;
        if (worldCorner.x > maxX) maxX = worldCorner.x;
        if (worldCorner.y < minY) minY = worldCorner.y;
        if (worldCorner.y > maxY) maxY = worldCorner.y;
        if (worldCorner.z < minZ) minZ = worldCorner.z;
        if (worldCorner.z > maxZ) maxZ = worldCorner.z;
      }
      const invWorld = world;
      invWorld.invert();
      const pickPlane = {
        invWorld,
        halfWidth,
        halfHeight,
        minX,
        maxX,
        minY,
        maxY,
        minZ,
        maxZ,
      };
      this.flatTexturePickPlanes.push(pickPlane);
      this.indexFlatTexturePickPlane(pickPlane);
    }
  }

  private loadTexturePlanes(planes: TexturePlane[]): void {
    this.rebuildFlatTexturePickPlanes(planes);
    this.texturePlaneRevealEntriesByChunk.clear();
    if (planes.length === 0) return;
    if (import.meta.env.DEV) console.log(`[ChunkManager] Loading ${planes.length} texture planes...`);

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

    for (const sourcePlane of planes) {
      const renderPlanes: TexturePlane[] = [];
      if (sourcePlane.textureHalfMode) {
        const { halfA } = computeCutPolygons(sourcePlane.textureCutAngle ?? Math.PI / 4);
        renderPlanes.push({ ...(sourcePlane as any), __halfRing: halfA });
      } else {
        renderPlanes.push(sourcePlane);
      }

      for (const plane of renderPlanes) {
      if (!this.getOrLoadTexture(plane.textureId)) continue;
      const isFlat = isFlatPlane(plane);
      const pcx = Math.floor(plane.position.x / CHUNK_SIZE);
      const pcz = Math.floor(plane.position.z / CHUNK_SIZE);

      let isRoof = false;
      let roofFloor = 0;
      const isNoRoof = !!plane.noRoof;
      if (isRoofCoverPlane(plane)) {
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
    }

    const splitConnectedRoofMergeGroup = (group: MergeGroup): MergeGroup[] => {
      if (!group.isRoof || group.planes.length <= 1) return [group];

      const tileToPlanes = new Map<string, number[]>();
      const planeTiles: Set<string>[] = [];
      for (let i = 0; i < group.planes.length; i++) {
        const tiles = new Set<string>();
        forEachTileInPlaneFootprint(group.planes[i], this.mapWidth, this.mapHeight, (_idx, tx, tz) => {
          const key = `${tx},${tz}`;
          tiles.add(key);
          let list = tileToPlanes.get(key);
          if (!list) {
            list = [];
            tileToPlanes.set(key, list);
          }
          list.push(i);
        });
        planeTiles.push(tiles);
      }

      const result: MergeGroup[] = [];
      const visited = new Set<number>();
      const dirs = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const;
      for (let seed = 0; seed < group.planes.length; seed++) {
        if (visited.has(seed)) continue;
        const indices: number[] = [];
        const queue = [seed];
        visited.add(seed);
        for (let qi = 0; qi < queue.length; qi++) {
          const planeIdx = queue[qi];
          indices.push(planeIdx);
          for (const key of planeTiles[planeIdx]) {
            const [sx, sz] = key.split(',');
            const tx = Number(sx);
            const tz = Number(sz);
            if (!Number.isFinite(tx) || !Number.isFinite(tz)) continue;
            for (const [dx, dz] of dirs) {
              const neighbors = tileToPlanes.get(`${tx + dx},${tz + dz}`);
              if (!neighbors) continue;
              for (const nextIdx of neighbors) {
                if (visited.has(nextIdx)) continue;
                visited.add(nextIdx);
                queue.push(nextIdx);
              }
            }
          }
        }
        result.push({ ...group, planes: indices.map(idx => group.planes[idx]) });
      }
      return result;
    };

    let mergedCount = 0;
    for (const [, sourceGroup] of mergeGroups) {
      for (const group of splitConnectedRoofMergeGroup(sourceGroup)) {
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

      // Compute Y range across all planes in this group so roof reveal/culling
      // can hide upper-floor surfaces even after plane meshes are merged.
      let minPY = Infinity, maxPY = -Infinity;
      for (const plane of group.planes) {
        const py = plane.position.y;
        if (py < minPY) minPY = py;
        if (py > maxPY) maxPY = py;
      }
      let minPX = Infinity, maxPX = -Infinity, minPZ = Infinity, maxPZ = -Infinity;
      for (let i = 0; i < allPositions.length; i += 3) {
        const px = allPositions[i];
        const pz = allPositions[i + 2];
        if (px < minPX) minPX = px;
        if (px > maxPX) maxPX = px;
        if (pz < minPZ) minPZ = pz;
        if (pz > maxPZ) maxPZ = pz;
      }
      let minTileX = Infinity, maxTileX = -Infinity, minTileZ = Infinity, maxTileZ = -Infinity;
      const revealChunkKeys = new Set<string>();
      if (Number.isFinite(minPX) && Number.isFinite(maxPX) && Number.isFinite(minPZ) && Number.isFinite(maxPZ)) {
        minTileX = Math.max(0, Math.floor(minPX));
        maxTileX = Math.min(this.mapWidth - 1, Math.floor(maxPX));
        minTileZ = Math.max(0, Math.floor(minPZ));
        maxTileZ = Math.min(this.mapHeight - 1, Math.floor(maxPZ));
        if (minTileX <= maxTileX && minTileZ <= maxTileZ) {
          for (let tz = minTileZ; tz <= maxTileZ; tz++) {
            for (let tx = minTileX; tx <= maxTileX; tx++) {
              revealChunkKeys.add(`${Math.floor(tx / CHUNK_SIZE)},${Math.floor(tz / CHUNK_SIZE)}`);
            }
          }
        }
      }
      const refChunkX = Math.floor(refPlane.position.x / CHUNK_SIZE);
      const refChunkZ = Math.floor(refPlane.position.z / CHUNK_SIZE);
      mesh.metadata = {
        isTexPlane: true,
        isFlat: group.isFlat,
        isNoRoof: group.isNoRoof,
        minY: minPY,
        maxY: maxPY,
        chunkX: refChunkX,
        chunkZ: refChunkZ,
      };

      this.texturePlaneMeshes.push(mesh);

      const pcx = Math.floor(refPlane.position.x / CHUNK_SIZE);
      const pcz = Math.floor(refPlane.position.z / CHUNK_SIZE);
      const pkey = `${pcx},${pcz}`;
      let arr = this.texturePlanesByChunk.get(pkey);
      if (!arr) { arr = []; this.texturePlanesByChunk.set(pkey, arr); }
      arr.push(mesh);

      if (Number.isFinite(minTileX) && Number.isFinite(minTileZ) && revealChunkKeys.size > 0) {
        const revealEntry: TexturePlaneRevealEntry = {
          mesh,
          minY: minPY,
          minX: minPX,
          maxX: maxPX,
          minZ: minPZ,
          maxZ: maxPZ,
        };
        for (const key of revealChunkKeys) {
          let entries = this.texturePlaneRevealEntriesByChunk.get(key);
          if (!entries) {
            entries = [];
            this.texturePlaneRevealEntriesByChunk.set(key, entries);
          }
          entries.push(revealEntry);
        }
      }

      // Register roof entries for all planes in the group. Only register
      // tiles whose CENTER falls inside the plane's footprint. The previous
      // version used Math.ceil on half-width, which rounded a 1.2-tile plane
      // up to a 3-tile footprint — and an "every cell of 3×3 is covered"
      // indoor test would then fire near any wall with a slightly-oversized
      // decorative plane on it.
      if (group.isRoof) {
        for (const plane of group.planes) {
          forEachTileInPlaneFootprint(plane, this.mapWidth, this.mapHeight, (_idx, tx, tz) => {
            const rk = `${tx},${tz}`;
            this.addRoofGridEntry(rk, { node: mesh, floor: group.roofFloor, y: plane.position.y });
          });
        }
      }

      mergedCount++;
      }
    }
    if (import.meta.env.DEV) console.log(`[ChunkManager] Merged ${planes.length} texture planes into ${mergedCount} batched meshes (${this.texturePlanesByChunk.size} chunks, ${this.flatTexturePickPlanes.length} flat pick planes, ${this.flatTexturePickPlanesByCell.size} pick cells)`);
  }

  disposeAll(): void {
    this.objectLoadGeneration++;
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
    this.placedObjectNodeSet.clear();
    this.placedObjectGrid.clear();
    this.placedObjectsByChunk.clear();
    this.decorBlockedTiles.clear();
    this.decorBlockedTilesByChunk.clear();
    this.objectChunkManifest = null;
    this.chunkPlacedNodes.clear();
    this.chunkAnimGroups.clear();
    this.chunkPlacedEnabled.clear();
    for (const [, srcs] of this.chunkThinInstSources) {
      for (const m of srcs) m.dispose();
    }
    this.chunkThinInstSources.clear();
    this.chunkRoofThinInstSources.clear();
    this.chunkElevatedThinInstSources.clear();
    this.chunkStructuralThinInstSources.clear();
    this.objectChunkQueue = [];
    this.queuedObjectChunks.clear();
    this.objectChunkQueueScheduled = false;
    this.objectChunkQueueProcessing = false;
    this.lastHiddenObjectChunkLoadAt = 0;
    this.chunksKnownEmpty.clear();
    this.pendingShadowGroundRebuildChunks.clear();
    this.shadowGroundRebuildScheduled = false;
    this.templateBaseMatrices.clear();
    this.loadingObjectChunks.clear();
    this.roofObjectGrid.clear();
    this.roofObjectGridKeysByChunk.clear();
    this.elevatedFloorHeights.clear();
    this.bridgeFloorTiles.clear();
    this.nonNoRoofElevatedTiles.clear();
    this.noRoofPlaneTiles.clear();
    for (const m of this.texturePlaneMeshes) m.dispose();
    this.texturePlaneMeshes = [];
    this.flatTexturePickPlanes = [];
    this.flatTexturePickPlanesByYBucket.clear();
    this.flatTexturePickPlanesByCell.clear();
    this.texturePlanesByChunk.clear();
    this.texturePlaneRevealEntriesByChunk.clear();
    this.texturePlaneChunksEnabled.clear();
    this.tilePaintedEntries.clear();
    this.flatPlanesByTexture.clear();
    this.textureAvgColors.clear();
    this.textureAvgColorLoading.clear();
    this.textureOverlayMeshesByChunk.clear();
    for (const [, m] of this.loadedModelCache) m?.dispose();
    this.loadedModelCache.clear();
    this.loadingModelPromises.clear();
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
      meshes.ceiling?.dispose();
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
    this.defaultGround = 'grass';
    this.torchlightPaintTiles.clear();
    this.chunkCols = 0;
    this.chunkRows = 0;
    this.defaultWaterLevel = -0.3;
    this.chunkWaterLevelCache = null;
    this.walls = null;
    this.rootWallShadowRunsCache = null;
    this.shootOverProjectileWallEdges = null;
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
    this.residentGameChunks.clear();
    this.desiredObjectChunks.clear();
    this.objectLoadChunks.clear();
    this.chunkCacheTick = 0;
    this.chunkLastUsed.clear();
    this.chunkMeshesEnabled.clear();
    this.objectChunkLastUsed.clear();
    this.editorChunkApplyTail = Promise.resolve();
    this.lastVisibleGameChunkBuildAt = 0;
    this.lastHiddenGameChunkBuildAt = 0;
    this.lastUpdateTerrainChanged = false;
    this.lastUpdateObjectsChanged = false;
    this.loaded = false;
    this.lastChunkX = -999;
    this.lastChunkZ = -999;
    this.lastRenderDistanceBucket = -999;
    this.lastObjectBucketX = -999;
    this.lastObjectBucketZ = -999;
    this.lastObjectDistanceBucket = -999;
  }
}
