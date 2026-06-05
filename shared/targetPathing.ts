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

function center(tile: number): number {
  return tile + 0.5;
}

function point(tileX: number, tileZ: number): PathPoint {
  return { x: center(tileX), z: center(tileZ) };
}

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

function overlapEscapeDestination(srcTileX: number, srcTileZ: number, targetTileX: number, targetTileZ: number): TileCoord {
  // rsmod uses runtime RNG here. Keep the same cardinal-only behavior, but
  // derive the choice from stable coords so client prediction matches server
  // validation in this browser/server-authoritative setup.
  let hash = 0x811c9dc5;
  for (const value of [srcTileX, srcTileZ, targetTileX, targetTileZ]) {
    hash ^= value | 0;
    hash = Math.imul(hash, 0x01000193);
  }
  const dir = CARDINAL_ESCAPE_DIRS[(hash >>> 0) % CARDINAL_ESCAPE_DIRS.length]!;
  return { x: srcTileX + dir[0], z: srcTileZ + dir[1] };
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
    return overlapEscapeDestination(Math.floor(sourceX), Math.floor(sourceZ), Math.floor(targetX), Math.floor(targetZ));
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
