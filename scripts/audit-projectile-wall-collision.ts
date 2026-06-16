import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_WALL_HEIGHT,
  PROJECTILE_BLOCKING_WALL_HEIGHT,
  WallEdge,
  isShootOverProjectileFenceAssetId,
  type FloorLayerData,
  type WallsFile,
} from '../shared/index';

interface EdgeDef {
  name: string;
  bit: number;
  dx: number;
  dz: number;
  oppositeName: string;
  oppositeBit: number;
}

interface CollisionSide {
  x: number;
  z: number;
  edge: string;
  height: number;
  shootOver: boolean;
  projectileBlocks: boolean;
}

interface ProjectileClearBoundary {
  mapId: string;
  floor: number;
  boundary: string;
  sides: CollisionSide[];
  maxHeight: number;
}

interface LowOrphanHeight {
  mapId: string;
  floor: number;
  x: number;
  z: number;
  height: number;
}

interface PlacedObjectLike {
  assetId?: unknown;
  position?: {
    x?: unknown;
    z?: unknown;
  };
  rotation?: {
    y?: unknown;
  };
}

const rootDir = join(import.meta.dir, '..');
const mapsDir = join(rootDir, 'server/data/maps');

const EDGE_DEFS: EdgeDef[] = [
  { name: 'N', bit: WallEdge.N, dx: 0, dz: -1, oppositeName: 'S', oppositeBit: WallEdge.S },
  { name: 'E', bit: WallEdge.E, dx: 1, dz: 0, oppositeName: 'W', oppositeBit: WallEdge.W },
  { name: 'S', bit: WallEdge.S, dx: 0, dz: 1, oppositeName: 'N', oppositeBit: WallEdge.N },
  { name: 'W', bit: WallEdge.W, dx: -1, dz: 0, oppositeName: 'E', oppositeBit: WallEdge.E },
];

// Anything this high but still below projectile-blocking height is usually a
// mis-authored full wall, not a deliberately shoot-over fence.
const SUSPICIOUS_PROJECTILE_CLEAR_HEIGHT = 1.2;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function parseTileKey(key: string): [number, number] | null {
  const [xRaw, zRaw] = key.split(',');
  const x = Number(xRaw);
  const z = Number(zRaw);
  if (!Number.isInteger(x) || !Number.isInteger(z)) return null;
  return [x, z];
}

function numberRecordValue(record: Record<string, number> | undefined, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function wallMaskAt(layer: FloorLayerData, x: number, z: number): number {
  return numberRecordValue(layer.walls, `${x},${z}`) ?? 0;
}

function wallHeightAt(layer: FloorLayerData, x: number, z: number): number {
  const height = numberRecordValue(layer.wallHeights, `${x},${z}`);
  return height !== undefined && height > 0 ? height : DEFAULT_WALL_HEIGHT;
}

function hasExplicitWallHeight(layer: FloorLayerData, x: number, z: number): boolean {
  return numberRecordValue(layer.wallHeights, `${x},${z}`) !== undefined;
}

function hasWallEdge(layer: FloorLayerData, x: number, z: number, edge: number): boolean {
  return (wallMaskAt(layer, x, z) & edge) !== 0;
}

function boundaryId(x: number, z: number, edge: EdgeDef): string {
  if (edge.name === 'E') return `V:${x + 1}:${z}`;
  if (edge.name === 'W') return `V:${x}:${z}`;
  if (edge.name === 'S') return `H:${x}:${z + 1}`;
  return `H:${x}:${z}`;
}

function boundaryLabel(id: string): string {
  const [axis, aRaw, bRaw] = id.split(':');
  const a = Number(aRaw);
  const b = Number(bRaw);
  if (axis === 'V') return `vertical edge x=${a}, z=${b}`;
  if (axis === 'H') return `horizontal edge x=${a}, z=${b}`;
  return id;
}

function shootOverMaskAt(shootOverMasks: Map<string, number> | undefined, x: number, z: number): number {
  return shootOverMasks?.get(`${x},${z}`) ?? 0;
}

function collisionSide(
  layer: FloorLayerData,
  shootOverMasks: Map<string, number> | undefined,
  x: number,
  z: number,
  edgeName: string,
  edgeBit: number,
): CollisionSide {
  const height = wallHeightAt(layer, x, z);
  const shootOver = (shootOverMaskAt(shootOverMasks, x, z) & edgeBit) !== 0;
  return {
    x,
    z,
    edge: edgeName,
    height,
    shootOver,
    projectileBlocks: !shootOver && height >= PROJECTILE_BLOCKING_WALL_HEIGHT,
  };
}

function collectBoundarySides(
  layer: FloorLayerData,
  shootOverMasks: Map<string, number> | undefined,
  x: number,
  z: number,
  edge: EdgeDef,
): CollisionSide[] {
  const sides: CollisionSide[] = [];
  if (hasWallEdge(layer, x, z, edge.bit)) {
    sides.push(collisionSide(layer, shootOverMasks, x, z, edge.name, edge.bit));
  }

  const nx = x + edge.dx;
  const nz = z + edge.dz;
  if (hasWallEdge(layer, nx, nz, edge.oppositeBit)) {
    sides.push(collisionSide(layer, shootOverMasks, nx, nz, edge.oppositeName, edge.oppositeBit));
  }

  return sides;
}

function auditLayer(
  mapId: string,
  floor: number,
  layer: FloorLayerData,
  shootOverMasks?: Map<string, number>,
): {
  projectileClear: ProjectileClearBoundary[];
  lowOrphans: LowOrphanHeight[];
} {
  const projectileClear: ProjectileClearBoundary[] = [];
  const lowOrphans: LowOrphanHeight[] = [];
  const seenBoundaries = new Set<string>();

  for (const [key, mask] of Object.entries(layer.walls ?? {})) {
    const coords = parseTileKey(key);
    if (!coords || typeof mask !== 'number') continue;
    const [x, z] = coords;

    for (const edge of EDGE_DEFS) {
      if ((mask & edge.bit) === 0) continue;
      const id = boundaryId(x, z, edge);
      if (seenBoundaries.has(id)) continue;
      seenBoundaries.add(id);

      const sides = collectBoundarySides(layer, shootOverMasks, x, z, edge);
      if (sides.length === 0) continue;
      const maxHeight = Math.max(...sides.map((side) => side.height));
      if (!sides.some((side) => side.projectileBlocks)) {
        projectileClear.push({ mapId, floor, boundary: boundaryLabel(id), sides, maxHeight });
      }
    }
  }

  for (const [key, height] of Object.entries(layer.wallHeights ?? {})) {
    if (typeof height !== 'number' || !Number.isFinite(height) || height >= PROJECTILE_BLOCKING_WALL_HEIGHT) continue;
    const coords = parseTileKey(key);
    if (!coords) continue;
    const [x, z] = coords;
    if (wallMaskAt(layer, x, z) !== 0) continue;
    lowOrphans.push({ mapId, floor, x, z, height });
  }

  return { projectileClear, lowOrphans };
}

function layerEntries(walls: WallsFile): Array<{ floor: number; layer: FloorLayerData }> {
  const entries: Array<{ floor: number; layer: FloorLayerData }> = [{ floor: 0, layer: walls }];
  for (const [floorRaw, layer] of Object.entries(walls.floorLayers ?? {})) {
    const floor = Number(floorRaw);
    if (!Number.isInteger(floor)) continue;
    entries.push({ floor, layer });
  }
  return entries;
}

function loadPlacedObjects(mapDir: string): PlacedObjectLike[] {
  const objectsDir = join(mapDir, 'objects');
  const chunked: PlacedObjectLike[] = [];
  if (existsSync(objectsDir)) {
    for (const file of readdirSync(objectsDir).sort()) {
      if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
      const entries = readJson<unknown>(join(objectsDir, file));
      if (Array.isArray(entries)) chunked.push(...entries.filter((entry): entry is PlacedObjectLike => !!entry && typeof entry === 'object'));
    }
  }
  if (chunked.length > 0) return chunked;

  const mapPath = join(mapDir, 'map.json');
  if (!existsSync(mapPath)) return [];
  const mapFile = readJson<{ placedObjects?: unknown }>(mapPath);
  return Array.isArray(mapFile.placedObjects)
    ? mapFile.placedObjects.filter((entry): entry is PlacedObjectLike => !!entry && typeof entry === 'object')
    : [];
}

function markShootOverEdge(masks: Map<string, number>, layer: FloorLayerData, x: number, z: number, edge: number): void {
  if ((wallMaskAt(layer, x, z) & edge) === 0 || hasExplicitWallHeight(layer, x, z)) return;
  const key = `${x},${z}`;
  masks.set(key, (masks.get(key) ?? 0) | edge);
}

function markShootOverBoundary(
  masks: Map<string, number>,
  layer: FloorLayerData,
  boundaryX: number,
  boundaryZ: number,
  axis: 'horizontal' | 'vertical',
): void {
  if (axis === 'horizontal') {
    markShootOverEdge(masks, layer, boundaryX, boundaryZ - 1, WallEdge.S);
    markShootOverEdge(masks, layer, boundaryX, boundaryZ, WallEdge.N);
    return;
  }
  markShootOverEdge(masks, layer, boundaryX - 1, boundaryZ, WallEdge.E);
  markShootOverEdge(masks, layer, boundaryX, boundaryZ, WallEdge.W);
}

function markShootOverTileEdges(masks: Map<string, number>, layer: FloorLayerData, x: number, z: number, edgeMask: number): void {
  markShootOverEdge(masks, layer, x, z, edgeMask & WallEdge.N);
  markShootOverEdge(masks, layer, x, z, edgeMask & WallEdge.E);
  markShootOverEdge(masks, layer, x, z, edgeMask & WallEdge.S);
  markShootOverEdge(masks, layer, x, z, edgeMask & WallEdge.W);
}

function markShootOverPlacement(masks: Map<string, number>, layer: FloorLayerData, x: number, z: number, rotY: number): void {
  const tileX = Math.floor(x);
  const tileZ = Math.floor(z);
  const centerX = tileX + 0.5;
  const centerZ = tileZ + 0.5;
  if (Math.abs(x - centerX) <= 0.2 && Math.abs(z - centerZ) <= 0.2) {
    const cos = Math.abs(Math.cos(rotY));
    const sin = Math.abs(Math.sin(rotY));
    if (Math.abs(cos - sin) < 0.25) {
      markShootOverTileEdges(masks, layer, tileX, tileZ, wallMaskAt(layer, tileX, tileZ));
    } else if (sin > cos) {
      markShootOverTileEdges(masks, layer, tileX, tileZ, WallEdge.E | WallEdge.W);
    } else {
      markShootOverTileEdges(masks, layer, tileX, tileZ, WallEdge.N | WallEdge.S);
    }
    return;
  }

  const cos = Math.abs(Math.cos(rotY));
  const sin = Math.abs(Math.sin(rotY));
  if (Math.abs(cos - sin) < 0.25) {
    markShootOverTileEdges(masks, layer, tileX, tileZ, wallMaskAt(layer, tileX, tileZ));
    return;
  }

  const boundaryX = Math.round(x);
  const boundaryZ = Math.round(z);
  const distToVerticalBoundary = Math.abs(x - boundaryX);
  const distToHorizontalBoundary = Math.abs(z - boundaryZ);
  if (distToVerticalBoundary < distToHorizontalBoundary) {
    markShootOverBoundary(masks, layer, boundaryX, Math.floor(z), 'vertical');
  } else {
    markShootOverBoundary(masks, layer, Math.floor(x), boundaryZ, 'horizontal');
  }
}

function buildShootOverMasks(layer: FloorLayerData, placedObjects: PlacedObjectLike[]): Map<string, number> {
  const masks = new Map<string, number>();
  for (const placed of placedObjects) {
    if (typeof placed.assetId !== 'string' || !isShootOverProjectileFenceAssetId(placed.assetId)) continue;
    const px = placed.position?.x;
    const pz = placed.position?.z;
    if (typeof px !== 'number' || typeof pz !== 'number' || !Number.isFinite(px) || !Number.isFinite(pz)) continue;
    const rotY = typeof placed.rotation?.y === 'number' && Number.isFinite(placed.rotation.y) ? placed.rotation.y : 0;
    markShootOverPlacement(masks, layer, px, pz, rotY);
  }
  return masks;
}

function formatSide(side: CollisionSide): string {
  const reason = side.shootOver ? ' shoot-over-asset' : '';
  return `${side.x},${side.z} ${side.edge} h=${side.height.toFixed(2)}${reason}`;
}

function formatBoundary(report: ProjectileClearBoundary): string {
  const sides = report.sides.map(formatSide).join(' | ');
  return `${report.mapId} floor ${report.floor} ${report.boundary}: ${sides}`;
}

function printReports(title: string, reports: ProjectileClearBoundary[]): void {
  if (reports.length === 0) return;
  console.log(`${title} (${reports.length}):`);
  for (const report of reports) console.log(`- ${formatBoundary(report)}`);
}

function printGroupedCounts(title: string, reports: ProjectileClearBoundary[]): void {
  if (reports.length === 0) return;
  const counts = new Map<string, number>();
  for (const report of reports) {
    const key = `${report.mapId} floor ${report.floor}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log(`${title} (${reports.length}):`);
  for (const [key, count] of [...counts.entries()].sort()) {
    console.log(`- ${key}: ${count}`);
  }
}

function auditProjectileWallCollision(): number {
  const projectileClear: ProjectileClearBoundary[] = [];
  const lowOrphans: LowOrphanHeight[] = [];

  for (const entry of readdirSync(mapsDir).sort()) {
    const mapDir = join(mapsDir, entry);
    if (!statSync(mapDir).isDirectory()) continue;
    const wallsPath = join(mapDir, 'walls.json');
    if (!existsSync(wallsPath)) continue;

    const walls = readJson<WallsFile>(wallsPath);
    const shootOverMasks = buildShootOverMasks(walls, loadPlacedObjects(mapDir));
    for (const { floor, layer } of layerEntries(walls)) {
      const result = auditLayer(entry, floor, layer, floor === 0 ? shootOverMasks : undefined);
      projectileClear.push(...result.projectileClear);
      lowOrphans.push(...result.lowOrphans);
    }
  }

  const assetMarked = projectileClear.filter((report) => report.sides.some((side) => side.shootOver));
  const heightAuthored = projectileClear.filter((report) => !report.sides.some((side) => side.shootOver));
  const suspicious = heightAuthored.filter((report) => report.maxHeight >= SUSPICIOUS_PROJECTILE_CLEAR_HEIGHT);
  const likelyFences = heightAuthored.filter((report) => report.maxHeight < SUSPICIOUS_PROJECTILE_CLEAR_HEIGHT);

  console.log(
    `Projectile wall collision audit: projectile-blocking threshold=${PROJECTILE_BLOCKING_WALL_HEIGHT}, default wall height=${DEFAULT_WALL_HEIGHT}.`,
  );

  if (suspicious.length > 0) {
    printReports('Suspicious projectile-clear collision boundaries', suspicious);
  }
  printReports('Low projectile-clear collision boundaries, likely fences/railings', likelyFences);
  printGroupedCounts('Asset-marked projectile-clear collision boundaries, likely fence assets', assetMarked);

  if (lowOrphans.length > 0) {
    console.log(`Low wallHeight overrides on tiles with no wall bits (${lowOrphans.length}):`);
    for (const orphan of lowOrphans) {
      console.log(`- ${orphan.mapId} floor ${orphan.floor} ${orphan.x},${orphan.z} h=${orphan.height.toFixed(2)}`);
    }
  }

  if (suspicious.length > 0) {
    console.error(`Projectile wall collision audit failed: ${suspicious.length} suspicious projectile-clear boundary/boundaries.`);
    return 1;
  }

  console.log(
    `Projectile wall collision audit passed: ${projectileClear.length} projectile-clear boundary/boundaries, ${assetMarked.length} asset-marked, 0 suspicious.`,
  );
  return 0;
}

process.exitCode = auditProjectileWallCollision();
