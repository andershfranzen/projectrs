import {
  getObjectFootprintBounds,
  getObjectFootprintMinTile,
  getObjectInteractionTiles,
  type TileCoord,
} from '@projectrs/shared';

export interface PathPoint {
  x: number;
  z: number;
}

export interface PathingCollision {
  width?: number;
  height?: number;
  isTileBlocked(tileX: number, tileZ: number): boolean;
  isWallBlocked?(fromTileX: number, fromTileZ: number, toTileX: number, toTileZ: number): boolean;
}

export interface FindPathOptions {
  startX: number;
  startZ: number;
  collision: PathingCollision;
  actorSize?: number;
  maxSearchTiles?: number;
}

export interface WaypointStep<State> {
  state: State;
  fromTileX: number;
  fromTileZ: number;
  toTileX: number;
  toTileZ: number;
  stepX: number;
  stepZ: number;
}

export interface ValidateWaypointPathOptions<State> {
  startX: number;
  startZ: number;
  waypoints: readonly PathPoint[];
  initialState: State;
  maxSegmentTiles?: number;
  maxRequestedTiles?: number;
  canStep(step: WaypointStep<State>): boolean;
  afterStep?(step: WaypointStep<State>): State;
}

export interface ValidatedWaypointPath<State> {
  path: PathPoint[];
  state: State;
  requestedTileCount: number;
  truncated: boolean;
}

const SEARCH_SIZE = 128;
const SEARCH_HALF = SEARCH_SIZE / 2;
const QUEUE_SIZE = SEARCH_SIZE * SEARCH_SIZE;
export const DEFAULT_MAX_SEARCH_TILES = 4096;

const CARDINAL_DIRS: ReadonlyArray<readonly [number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const DIAGONAL_DIRS: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

function center(tile: number): number {
  return tile + 0.5;
}

function point(tileX: number, tileZ: number): PathPoint {
  return { x: center(tileX), z: center(tileZ) };
}

function tileKey(tileX: number, tileZ: number): string {
  return `${tileX},${tileZ}`;
}

export function expandAndValidateWaypointPath<State>(
  options: ValidateWaypointPathOptions<State>,
): ValidatedWaypointPath<State> {
  const validPath: PathPoint[] = [];
  let prevX = options.startX;
  let prevZ = options.startZ;
  let state = options.initialState;
  let requestedTileCount = 0;
  let truncated = false;
  const maxSegmentTiles = options.maxSegmentTiles ?? 64;
  const maxRequestedTiles = options.maxRequestedTiles ?? 200;

  outer: for (const step of options.waypoints) {
    const targetTileX = Math.floor(step.x);
    const targetTileZ = Math.floor(step.z);
    const startTileX = Math.floor(prevX);
    const startTileZ = Math.floor(prevZ);
    const dxTotal = targetTileX - startTileX;
    const dzTotal = targetTileZ - startTileZ;
    const stepX = Math.sign(dxTotal);
    const stepZ = Math.sign(dzTotal);
    const distance = Math.max(Math.abs(dxTotal), Math.abs(dzTotal));
    if (distance === 0) continue;
    if (distance > maxSegmentTiles) {
      truncated = true;
      break;
    }
    if (stepX !== 0 && stepZ !== 0 && Math.abs(dxTotal) !== Math.abs(dzTotal)) {
      truncated = true;
      break;
    }

    requestedTileCount += distance;
    if (requestedTileCount > maxRequestedTiles) {
      truncated = true;
      break;
    }

    let curTileX = startTileX;
    let curTileZ = startTileZ;
    for (let i = 0; i < distance; i++) {
      const toTileX = curTileX + stepX;
      const toTileZ = curTileZ + stepZ;
      const waypointStep: WaypointStep<State> = {
        state,
        fromTileX: curTileX,
        fromTileZ: curTileZ,
        toTileX,
        toTileZ,
        stepX,
        stepZ,
      };
      if (!options.canStep(waypointStep)) {
        truncated = true;
        break outer;
      }

      validPath.push(point(toTileX, toTileZ));
      state = options.afterStep ? options.afterStep(waypointStep) : state;
      curTileX = toTileX;
      curTileZ = toTileZ;
    }

    prevX = center(curTileX);
    prevZ = center(curTileZ);
  }

  return { path: validPath, state, requestedTileCount, truncated };
}

function inBounds(collision: PathingCollision, tileX: number, tileZ: number): boolean {
  if (tileX < 0 || tileZ < 0) return false;
  if (collision.width !== undefined && tileX >= collision.width) return false;
  if (collision.height !== undefined && tileZ >= collision.height) return false;
  return true;
}

export function isFootprintBlocked(collision: PathingCollision, anchorTileX: number, anchorTileZ: number, size: number): boolean {
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
  collision: PathingCollision,
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
  collision: PathingCollision,
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

function findPathToReach(options: FindPathOptions & { reached(tileX: number, tileZ: number): boolean }): PathPoint[] {
  const startTileX = Math.floor(options.startX);
  const startTileZ = Math.floor(options.startZ);
  if (options.reached(startTileX, startTileZ)) return [];

  const baseX = startTileX - SEARCH_HALF;
  const baseZ = startTileZ - SEARCH_HALF;
  const sourceLX = startTileX - baseX;
  const sourceLZ = startTileZ - baseZ;
  const maxSearchTiles = options.maxSearchTiles ?? DEFAULT_MAX_SEARCH_TILES;

  const visited = new Uint8Array(QUEUE_SIZE);
  const parent = new Int32Array(QUEUE_SIZE);
  const queueX = new Int16Array(QUEUE_SIZE);
  const queueZ = new Int16Array(QUEUE_SIZE);
  parent.fill(-1);

  const idx = (lx: number, lz: number): number => lz * SEARCH_SIZE + lx;
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
    const lx = queueX[read];
    const lz = queueZ[read];
    const currentIdx = idx(lx, lz);
    read++;
    visitedTiles++;

    const tileX = baseX + lx;
    const tileZ = baseZ + lz;
    if (options.reached(tileX, tileZ)) {
      found = currentIdx;
      break;
    }

    for (const [dx, dz] of CARDINAL_DIRS) {
      const nx = lx + dx;
      const nz = lz + dz;
      if (nx < 0 || nx >= SEARCH_SIZE || nz < 0 || nz >= SEARCH_SIZE) continue;
      const nextIdx = idx(nx, nz);
      if (visited[nextIdx]) continue;
      if (!canTravel(options.collision, tileX, tileZ, dx, dz, options.actorSize ?? 1)) continue;
      enqueue(nx, nz, currentIdx);
    }
    for (const [dx, dz] of DIAGONAL_DIRS) {
      const nx = lx + dx;
      const nz = lz + dz;
      if (nx < 0 || nx >= SEARCH_SIZE || nz < 0 || nz >= SEARCH_SIZE) continue;
      const nextIdx = idx(nx, nz);
      if (visited[nextIdx]) continue;
      if (!canTravel(options.collision, tileX, tileZ, dx, dz, options.actorSize ?? 1)) continue;
      enqueue(nx, nz, currentIdx);
    }
  }

  if (found < 0) return [];

  const tiles: PathPoint[] = [];
  for (let current = found; current >= 0; current = parent[current]) {
    const lx = current % SEARCH_SIZE;
    const lz = (current / SEARCH_SIZE) | 0;
    if (lx === sourceLX && lz === sourceLZ) break;
    tiles.push(point(baseX + lx, baseZ + lz));
  }
  tiles.reverse();
  return tiles;
}

export function findPathToTile(
  options: FindPathOptions & {
    goalX: number;
    goalZ: number;
  },
): PathPoint[] {
  const goalTileX = Math.floor(options.goalX);
  const goalTileZ = Math.floor(options.goalZ);
  if (isFootprintBlocked(options.collision, goalTileX, goalTileZ, 1)) return [];
  return findPathToReach({
    ...options,
    reached: (tileX, tileZ) => tileX === goalTileX && tileZ === goalTileZ,
  });
}

export function findPathToAnyTile(
  options: FindPathOptions & {
    goals: readonly TileCoord[];
  },
): PathPoint[] {
  const goals = new Set<string>();
  for (const goal of options.goals) {
    const tileX = Math.floor(goal.x);
    const tileZ = Math.floor(goal.z);
    if (isFootprintBlocked(options.collision, tileX, tileZ, 1)) continue;
    goals.add(tileKey(tileX, tileZ));
  }
  if (goals.size === 0) return [];
  return findPathToReach({
    ...options,
    reached: (tileX, tileZ) => goals.has(tileKey(tileX, tileZ)),
  });
}

export function hasClearInteractionEdge(
  collision: Pick<PathingCollision, 'isWallBlocked'>,
  tileX: number,
  tileZ: number,
  targetX: number,
  targetZ: number,
  targetSize: number,
): boolean {
  const bounds = getObjectFootprintBounds(targetX, targetZ, targetSize);
  if (tileX >= bounds.minX && tileX <= bounds.maxX && tileZ >= bounds.minZ && tileZ <= bounds.maxZ) return false;
  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
      if (Math.abs(x - tileX) + Math.abs(z - tileZ) !== 1) continue;
      if (!collision.isWallBlocked || !collision.isWallBlocked(tileX, tileZ, x, z)) return true;
    }
  }
  return false;
}

export function isRectInteractionTileReachable(
  collision: Pick<PathingCollision, 'isWallBlocked'>,
  tileX: number,
  tileZ: number,
  targetX: number,
  targetZ: number,
  targetSize: number,
): boolean {
  return hasClearInteractionEdge(collision, Math.floor(tileX), Math.floor(tileZ), targetX, targetZ, targetSize);
}

export function findPathToRectInteraction(
  options: FindPathOptions & {
    targetX: number;
    targetZ: number;
    targetSize: number;
  },
): PathPoint[] {
  const blockedBounds = getObjectFootprintBounds(options.targetX, options.targetZ, options.targetSize);
  const collision: PathingCollision = {
    ...options.collision,
    isTileBlocked: (tileX, tileZ) => {
      if (
        tileX >= blockedBounds.minX
        && tileX <= blockedBounds.maxX
        && tileZ >= blockedBounds.minZ
        && tileZ <= blockedBounds.maxZ
      ) {
        return true;
      }
      return options.collision.isTileBlocked(tileX, tileZ);
    },
  };

  return findPathToReach({
    ...options,
    collision,
    reached: (tileX, tileZ) => hasClearInteractionEdge(
      options.collision,
      tileX,
      tileZ,
      options.targetX,
      options.targetZ,
      options.targetSize,
    ),
  });
}

export function interactionTilesForRect(targetX: number, targetZ: number, targetSize: number): TileCoord[] {
  return getObjectInteractionTiles(targetX, targetZ, { width: targetSize });
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
    return { x: Math.floor(sourceX) + 1, z: Math.floor(sourceZ) };
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
  collision: PathingCollision,
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

  if (Math.abs(targetTileX - fromTileX) >= Math.abs(targetTileZ - fromTileZ)) {
    return (dx !== 0 ? tryStep(dx, 0) : null) ?? (dz !== 0 ? tryStep(0, dz) : null);
  }
  return (dz !== 0 ? tryStep(0, dz) : null) ?? (dx !== 0 ? tryStep(dx, 0) : null);
}

export function stepTowardNaiveInteraction(
  collision: PathingCollision,
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
