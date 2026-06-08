import {
  getObjectFootprintBounds,
  getObjectFootprintMinTile,
  isTileAdjacentToObject,
  type TileCoord,
} from './objectFootprint';

export interface PathPoint {
  x: number;
  z: number;
}

export interface TargetPathingCollision {
  width?: number;
  height?: number;
  isTileBlocked(tileX: number, tileZ: number): boolean;
  isWallBlocked?(fromTileX: number, fromTileZ: number, toTileX: number, toTileZ: number): boolean;
}

export interface BuildNaiveInteractionPathOptions {
  maxSteps?: number;
  reached?: (x: number, z: number) => boolean;
}

export interface FindPathToReachOptions {
  startX: number;
  startZ: number;
  collision: TargetPathingCollision;
  actorSize?: number;
  maxSearchTiles?: number;
  maxWaypoints?: number;
  compress?: boolean;
  reached(tileX: number, tileZ: number): boolean;
}

function center(tile: number): number {
  return tile + 0.5;
}

function point(tileX: number, tileZ: number): PathPoint {
  return { x: center(tileX), z: center(tileZ) };
}

const TARGET_SEARCH_SIZE = 128;
const TARGET_SEARCH_HALF = TARGET_SEARCH_SIZE / 2;
const TARGET_QUEUE_SIZE = TARGET_SEARCH_SIZE * TARGET_SEARCH_SIZE;
export const DEFAULT_TARGET_MAX_SEARCH_TILES = 4096;
export const DEFAULT_COMPRESSED_TARGET_WAYPOINTS = 50;
const TARGET_CARDINAL_DIRS: ReadonlyArray<readonly [number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const TARGET_DIAGONAL_DIRS: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

const CARDINAL_ESCAPE_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, 1],
  [0, -1],
];

function inBounds(collision: TargetPathingCollision, tileX: number, tileZ: number): boolean {
  if (tileX < 0 || tileZ < 0) return false;
  if (collision.width !== undefined && tileX >= collision.width) return false;
  if (collision.height !== undefined && tileZ >= collision.height) return false;
  return true;
}

export function compressTargetPath(
  path: readonly PathPoint[],
  maxWaypoints: number = DEFAULT_COMPRESSED_TARGET_WAYPOINTS,
): PathPoint[] {
  const waypointLimit = Math.max(1, Math.floor(maxWaypoints));
  if (path.length <= 1) return [...path];

  const compressed: PathPoint[] = [];
  let prevDx = 0;
  let prevDz = 0;
  for (let i = 0; i < path.length; i++) {
    const current = path[i]!;
    if (i === path.length - 1) {
      compressed.push(current);
    } else {
      const next = path[i + 1]!;
      const dx = Math.sign(Math.floor(next.x) - Math.floor(current.x));
      const dz = Math.sign(Math.floor(next.z) - Math.floor(current.z));
      if (dx !== prevDx || dz !== prevDz) {
        compressed.push(current);
        prevDx = dx;
        prevDz = dz;
      }
    }
  }

  if (compressed.length > waypointLimit) compressed.length = waypointLimit;
  return compressed;
}

export function findPathToReach(options: FindPathToReachOptions): PathPoint[] {
  const startTileX = Math.floor(options.startX);
  const startTileZ = Math.floor(options.startZ);
  if (options.reached(startTileX, startTileZ)) return [];

  const baseX = startTileX - TARGET_SEARCH_HALF;
  const baseZ = startTileZ - TARGET_SEARCH_HALF;
  const sourceLX = startTileX - baseX;
  const sourceLZ = startTileZ - baseZ;
  const maxSearchTiles = options.maxSearchTiles ?? DEFAULT_TARGET_MAX_SEARCH_TILES;
  const actorSize = options.actorSize ?? 1;

  const visited = new Uint8Array(TARGET_QUEUE_SIZE);
  const parent = new Int32Array(TARGET_QUEUE_SIZE);
  const queueX = new Int16Array(TARGET_QUEUE_SIZE);
  const queueZ = new Int16Array(TARGET_QUEUE_SIZE);
  parent.fill(-1);

  const idx = (lx: number, lz: number): number => lz * TARGET_SEARCH_SIZE + lx;
  let read = 0;
  let write = 0;
  let visitedTiles = 0;
  let found = -1;

  const enqueue = (lx: number, lz: number, parentIdx: number): void => {
    const i = idx(lx, lz);
    visited[i] = 1;
    parent[i] = parentIdx;
    queueX[write] = lx;
    queueZ[write] = lz;
    write++;
  };

  enqueue(sourceLX, sourceLZ, -1);

  while (read < write && visitedTiles < maxSearchTiles) {
    const lx = queueX[read]!;
    const lz = queueZ[read]!;
    const currentIdx = idx(lx, lz);
    read++;
    visitedTiles++;

    const tileX = baseX + lx;
    const tileZ = baseZ + lz;
    if (options.reached(tileX, tileZ)) {
      found = currentIdx;
      break;
    }

    for (const [dx, dz] of TARGET_CARDINAL_DIRS) {
      const nx = lx + dx;
      const nz = lz + dz;
      if (nx < 0 || nx >= TARGET_SEARCH_SIZE || nz < 0 || nz >= TARGET_SEARCH_SIZE) continue;
      const nextIdx = idx(nx, nz);
      if (visited[nextIdx]) continue;
      if (!canTravel(options.collision, tileX, tileZ, dx, dz, actorSize)) continue;
      enqueue(nx, nz, currentIdx);
    }

    for (const [dx, dz] of TARGET_DIAGONAL_DIRS) {
      const nx = lx + dx;
      const nz = lz + dz;
      if (nx < 0 || nx >= TARGET_SEARCH_SIZE || nz < 0 || nz >= TARGET_SEARCH_SIZE) continue;
      const nextIdx = idx(nx, nz);
      if (visited[nextIdx]) continue;
      if (!canTravel(options.collision, tileX, tileZ, dx, dz, actorSize)) continue;
      enqueue(nx, nz, currentIdx);
    }
  }

  if (found < 0) return [];

  const tiles: PathPoint[] = [];
  for (let current = found; current >= 0; current = parent[current]!) {
    const lx = current % TARGET_SEARCH_SIZE;
    const lz = (current / TARGET_SEARCH_SIZE) | 0;
    if (lx === sourceLX && lz === sourceLZ) break;
    tiles.push(point(baseX + lx, baseZ + lz));
  }
  tiles.reverse();

  return options.compress ? compressTargetPath(tiles, options.maxWaypoints) : tiles;
}

export function isFootprintBlocked(collision: TargetPathingCollision, anchorTileX: number, anchorTileZ: number, size: number): boolean {
  const span = Math.max(1, Math.round(size));
  if (span <= 1) {
    return !inBounds(collision, anchorTileX, anchorTileZ) || collision.isTileBlocked(anchorTileX, anchorTileZ);
  }
  const minX = getObjectFootprintMinTile(center(anchorTileX), span);
  const minZ = getObjectFootprintMinTile(center(anchorTileZ), span);
  for (let dx = 0; dx < span; dx++) {
    for (let dz = 0; dz < span; dz++) {
      const tileX = minX + dx;
      const tileZ = minZ + dz;
      if (!inBounds(collision, tileX, tileZ) || collision.isTileBlocked(tileX, tileZ)) return true;
    }
  }
  return false;
}

export function isFootprintWallBlocked(
  collision: TargetPathingCollision,
  fromTileX: number,
  fromTileZ: number,
  toTileX: number,
  toTileZ: number,
  size: number,
): boolean {
  if (!collision.isWallBlocked) return false;
  const span = Math.max(1, Math.round(size));
  if (span <= 1) {
    return collision.isWallBlocked(fromTileX, fromTileZ, toTileX, toTileZ);
  }

  const dx = Math.sign(toTileX - fromTileX);
  const dz = Math.sign(toTileZ - fromTileZ);
  if (dx === 0 && dz === 0) return false;

  if (dx !== 0 && dz !== 0) {
    const viaX = !isFootprintBlocked(collision, fromTileX + dx, fromTileZ, span)
      && !isFootprintWallBlocked(collision, fromTileX, fromTileZ, fromTileX + dx, fromTileZ, span)
      && !isFootprintWallBlocked(collision, fromTileX + dx, fromTileZ, toTileX, toTileZ, span);
    const viaZ = !isFootprintBlocked(collision, fromTileX, fromTileZ + dz, span)
      && !isFootprintWallBlocked(collision, fromTileX, fromTileZ, fromTileX, fromTileZ + dz, span)
      && !isFootprintWallBlocked(collision, fromTileX, fromTileZ + dz, toTileX, toTileZ, span);
    return !viaX && !viaZ;
  }

  const minX = getObjectFootprintMinTile(center(fromTileX), span);
  const minZ = getObjectFootprintMinTile(center(fromTileZ), span);
  const maxX = minX + span - 1;
  const maxZ = minZ + span - 1;
  if (dx !== 0) {
    const sourceX = dx > 0 ? maxX : minX;
    const targetX = sourceX + dx;
    for (let z = minZ; z <= maxZ; z++) {
      if (collision.isWallBlocked(sourceX, z, targetX, z)) return true;
    }
    return false;
  }

  const sourceZ = dz > 0 ? maxZ : minZ;
  const targetZ = sourceZ + dz;
  for (let x = minX; x <= maxX; x++) {
    if (collision.isWallBlocked(x, sourceZ, x, targetZ)) return true;
  }
  return false;
}

export function canTravel(
  collision: TargetPathingCollision,
  fromTileX: number,
  fromTileZ: number,
  offsetX: number,
  offsetZ: number,
  size: number = 1,
  allowLargeDiagonal: boolean = true,
): boolean {
  const dx = Math.sign(offsetX);
  const dz = Math.sign(offsetZ);
  if (dx === 0 && dz === 0) return false;
  if (dx !== offsetX || dz !== offsetZ) return false;

  const span = Math.max(1, Math.round(size));
  const toTileX = fromTileX + dx;
  const toTileZ = fromTileZ + dz;

  if (dx !== 0 && dz !== 0) {
    if (span > 1 && !allowLargeDiagonal) return false;
    if (span <= 1) {
      if (!canTravel(collision, fromTileX, fromTileZ, dx, 0, span, allowLargeDiagonal)) return false;
      if (!canTravel(collision, fromTileX, fromTileZ, 0, dz, span, allowLargeDiagonal)) return false;
      if (isFootprintBlocked(collision, toTileX, toTileZ, span)) return false;
      return !isFootprintWallBlocked(collision, fromTileX, fromTileZ, toTileX, toTileZ, span);
    }
    return (
      canTravel(collision, fromTileX, fromTileZ, dx, 0, span, allowLargeDiagonal)
        && canTravel(collision, fromTileX + dx, fromTileZ, 0, dz, span, allowLargeDiagonal)
    ) || (
      canTravel(collision, fromTileX, fromTileZ, 0, dz, span, allowLargeDiagonal)
        && canTravel(collision, fromTileX, fromTileZ + dz, dx, 0, span, allowLargeDiagonal)
    );
  }

  if (isFootprintBlocked(collision, toTileX, toTileZ, span)) return false;
  return !isFootprintWallBlocked(collision, fromTileX, fromTileZ, toTileX, toTileZ, span);
}

function intersects(
  srcX: number,
  srcZ: number,
  srcWidth: number,
  srcHeight: number,
  destX: number,
  destZ: number,
  destWidth: number,
  destHeight: number,
): boolean {
  return !(destX >= srcX + srcWidth || destX + destWidth <= srcX || destZ >= srcZ + srcHeight || destZ + destHeight <= srcZ);
}

function isDiagonalTouching(
  srcX: number,
  srcZ: number,
  srcWidth: number,
  srcHeight: number,
  destX: number,
  destZ: number,
  destWidth: number,
  destHeight: number,
): boolean {
  if (srcX + srcWidth === destX && srcZ + srcHeight === destZ) return true;
  if (srcX - 1 === destX + destWidth - 1 && srcZ - 1 === destZ + destHeight - 1) return true;
  if (srcX + srcWidth === destX && srcZ - 1 === destZ + destHeight - 1) return true;
  return srcX - 1 === destX + destWidth - 1 && srcZ + srcHeight === destZ;
}

function coerceAtMost(value: number, max: number): number {
  return value > max ? max : value;
}

function coerceAtLeast(value: number, min: number): number {
  return value < min ? min : value;
}

function naiveDestinationMinTile(
  srcX: number,
  srcZ: number,
  srcWidth: number,
  srcHeight: number,
  destX: number,
  destZ: number,
  destWidth: number,
  destHeight: number,
): TileCoord {
  const diagonal = srcX - destX + (srcZ - destZ);
  const anti = srcX - destX - (srcZ - destZ);
  const southWestClockwise = anti < 0;
  const northWestClockwise = diagonal >= destHeight - 1 - (srcWidth - 1);
  const northEastClockwise = anti > srcWidth - srcHeight;
  const southEastClockwise = diagonal <= destWidth - 1 - (srcHeight - 1);

  if (southWestClockwise && !northWestClockwise) {
    let offZ = 0;
    if (diagonal >= -srcWidth) {
      offZ = coerceAtMost(diagonal + srcWidth, destHeight - 1);
    } else if (anti > -srcWidth) {
      offZ = -(srcWidth + anti);
    }
    return { x: -srcWidth + destX, z: offZ + destZ };
  }

  if (northWestClockwise && !northEastClockwise) {
    let offX = 0;
    if (anti >= -destHeight) {
      offX = coerceAtMost(anti + destHeight, destWidth - 1);
    } else if (diagonal < destHeight) {
      offX = coerceAtLeast(diagonal - destHeight, -(srcWidth - 1));
    }
    return { x: offX + destX, z: destHeight + destZ };
  }

  if (northEastClockwise && !southEastClockwise) {
    let offZ = 0;
    if (anti <= destWidth) {
      offZ = destHeight - anti;
    } else if (diagonal < destWidth) {
      offZ = coerceAtLeast(diagonal - destWidth, -(srcHeight - 1));
    }
    return { x: destWidth + destX, z: offZ + destZ };
  }

  let offX = 0;
  if (diagonal > -srcHeight) {
    offX = coerceAtMost(diagonal + srcHeight, destWidth - 1);
  } else if (anti < srcHeight) {
    offX = coerceAtLeast(anti - srcHeight, -(srcHeight - 1));
  }
  return { x: offX + destX, z: -srcHeight + destZ };
}

function anchorTileFromMinTile(minTile: number, size: number): number {
  return minTile + Math.floor(Math.max(1, Math.round(size)) / 2);
}

function stableEscapeStart(srcTileX: number, srcTileZ: number, targetTileX: number, targetTileZ: number): number {
  let hash = 0x811c9dc5;
  for (const value of [srcTileX, srcTileZ, targetTileX, targetTileZ]) {
    hash ^= value | 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % CARDINAL_ESCAPE_DIRS.length;
}

function overlapEscapeDestination(
  srcTileX: number,
  srcTileZ: number,
  srcSize: number,
  targetTileX: number,
  targetTileZ: number,
  dstBounds: ReturnType<typeof getObjectFootprintBounds>,
): TileCoord {
  // rsmod uses runtime RNG here. Keep deterministic cardinal-only tie-breaking
  // so client prediction matches server validation, but choose a destination
  // outside the overlapped footprint rather than another tile inside a large NPC.
  const candidates = [
    { x: anchorTileFromMinTile(dstBounds.minX - srcSize, srcSize), z: srcTileZ, dir: 0 },
    { x: anchorTileFromMinTile(dstBounds.maxX + 1, srcSize), z: srcTileZ, dir: 1 },
    { x: srcTileX, z: anchorTileFromMinTile(dstBounds.maxZ + 1, srcSize), dir: 2 },
    { x: srcTileX, z: anchorTileFromMinTile(dstBounds.minZ - srcSize, srcSize), dir: 3 },
  ];
  const tieStart = stableEscapeStart(srcTileX, srcTileZ, targetTileX, targetTileZ);
  candidates.sort((a, b) =>
    Math.abs(a.x - srcTileX) + Math.abs(a.z - srcTileZ)
    - (Math.abs(b.x - srcTileX) + Math.abs(b.z - srcTileZ))
    || ((a.dir - tieStart + CARDINAL_ESCAPE_DIRS.length) % CARDINAL_ESCAPE_DIRS.length)
    - ((b.dir - tieStart + CARDINAL_ESCAPE_DIRS.length) % CARDINAL_ESCAPE_DIRS.length));
  return { x: candidates[0]!.x, z: candidates[0]!.z };
}

export function naiveInteractionDestination(
  sourceX: number,
  sourceZ: number,
  sourceSize: number,
  targetX: number,
  targetZ: number,
  targetSize: number,
): TileCoord {
  const srcSize = Math.max(1, Math.round(sourceSize));
  const dstSize = Math.max(1, Math.round(targetSize));
  const srcBounds = getObjectFootprintBounds(sourceX, sourceZ, srcSize);
  const dstBounds = getObjectFootprintBounds(targetX, targetZ, dstSize);

  if (intersects(srcBounds.minX, srcBounds.minZ, srcSize, srcSize, dstBounds.minX, dstBounds.minZ, dstSize, dstSize)) {
    return overlapEscapeDestination(Math.floor(sourceX), Math.floor(sourceZ), srcSize, Math.floor(targetX), Math.floor(targetZ), dstBounds);
  }

  const dest = naiveDestinationMinTile(srcBounds.minX, srcBounds.minZ, srcSize, srcSize, dstBounds.minX, dstBounds.minZ, dstSize, dstSize);
  if (
    isDiagonalTouching(dest.x, dest.z, srcSize, srcSize, dstBounds.minX, dstBounds.minZ, dstSize, dstSize)
    || intersects(dest.x, dest.z, srcSize, srcSize, dstBounds.minX, dstBounds.minZ, dstSize, dstSize)
  ) {
    return {
      x: anchorTileFromMinTile(dest.x, srcSize),
      z: anchorTileFromMinTile(dest.z, srcSize),
    };
  }

  return {
    x: anchorTileFromMinTile(dest.x, srcSize),
    z: anchorTileFromMinTile(dest.z, srcSize),
  };
}

export function stepTowardTile(
  collision: TargetPathingCollision,
  sourceX: number,
  sourceZ: number,
  targetTileX: number,
  targetTileZ: number,
  size: number = 1,
  allowLargeDiagonal: boolean = false,
): PathPoint | null {
  const fromTileX = Math.floor(sourceX);
  const fromTileZ = Math.floor(sourceZ);
  const dx = Math.sign(targetTileX - fromTileX);
  const dz = Math.sign(targetTileZ - fromTileZ);
  if (dx === 0 && dz === 0) return null;

  const tryStep = (stepX: number, stepZ: number): PathPoint | null => {
    if (!canTravel(collision, fromTileX, fromTileZ, stepX, stepZ, size, allowLargeDiagonal)) return null;
    return point(fromTileX + stepX, fromTileZ + stepZ);
  };

  if (dx !== 0 && dz !== 0) {
    const diagonal = tryStep(dx, dz);
    if (diagonal) return diagonal;
  }

  return (dx !== 0 ? tryStep(dx, 0) : null) ?? (dz !== 0 ? tryStep(0, dz) : null);
}

export function stepTowardNaiveInteraction(
  collision: TargetPathingCollision,
  sourceX: number,
  sourceZ: number,
  sourceSize: number,
  targetX: number,
  targetZ: number,
  targetSize: number,
): PathPoint | null {
  const destination = naiveInteractionDestination(sourceX, sourceZ, sourceSize, targetX, targetZ, targetSize);
  return stepTowardTile(collision, sourceX, sourceZ, destination.x, destination.z, sourceSize, false);
}

export function buildNaiveInteractionPath(
  collision: TargetPathingCollision,
  sourceX: number,
  sourceZ: number,
  sourceSize: number,
  targetX: number,
  targetZ: number,
  targetSize: number,
  options: BuildNaiveInteractionPathOptions = {},
): PathPoint[] {
  const maxSteps = Math.max(0, Math.floor(options.maxSteps ?? 50));
  const reached = options.reached ?? ((x, z) =>
    isTileAdjacentToObject(Math.floor(x), Math.floor(z), targetX, targetZ, { width: targetSize }));
  const path: PathPoint[] = [];
  let curX = sourceX;
  let curZ = sourceZ;

  for (let i = 0; i < maxSteps; i++) {
    if (reached(curX, curZ)) break;
    const step = stepTowardNaiveInteraction(collision, curX, curZ, sourceSize, targetX, targetZ, targetSize);
    if (!step) break;
    if (Math.floor(step.x) === Math.floor(curX) && Math.floor(step.z) === Math.floor(curZ)) break;
    path.push(step);
    curX = step.x;
    curZ = step.z;
  }

  return path;
}
