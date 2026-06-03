import { WallEdge } from './types.js';

export type ProjectileWallBlocker<TContext> = (
  context: TContext,
  x: number,
  z: number,
  edge: number,
  floor: number,
  projectileY: number,
) => boolean;

const SHOOT_OVER_FENCE_ASSET_RE = /fence/i;

export const RANGED_PROJECTILE_MIN_TRAVEL_MS = 280;
export const RANGED_PROJECTILE_MAX_TRAVEL_MS = 620;
export const RANGED_PROJECTILE_MS_PER_TILE = 48;
export const RANGED_PROJECTILE_BASE_TRAVEL_MS = 250;
export const RANGED_PROJECTILE_TRAVEL_TIME_SCALE = 0.9 / 1.1;
export const RANGED_PROJECTILE_MIN_ARC_HEIGHT = 0.14;
export const RANGED_PROJECTILE_MAX_ARC_HEIGHT = 0.62;
export const RANGED_PROJECTILE_ARC_HEIGHT_PER_TILE = 0.075;

export function isShootOverProjectileFenceAssetId(assetId: string): boolean {
  return SHOOT_OVER_FENCE_ASSET_RE.test(assetId);
}

function clampNumber(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function rangedProjectileTravelMsForDistance(horizontalDistance: number): number {
  const distance = Number.isFinite(horizontalDistance) && horizontalDistance > 0 ? horizontalDistance : 0;
  return clampNumber(
    RANGED_PROJECTILE_BASE_TRAVEL_MS + distance * RANGED_PROJECTILE_MS_PER_TILE,
    RANGED_PROJECTILE_MIN_TRAVEL_MS,
    RANGED_PROJECTILE_MAX_TRAVEL_MS,
  ) * RANGED_PROJECTILE_TRAVEL_TIME_SCALE;
}

export function rangedProjectileArcHeightForDistance(horizontalDistance: number): number {
  const distance = Number.isFinite(horizontalDistance) && horizontalDistance > 0 ? horizontalDistance : 0;
  return clampNumber(
    RANGED_PROJECTILE_MIN_ARC_HEIGHT + distance * RANGED_PROJECTILE_ARC_HEIGHT_PER_TILE,
    RANGED_PROJECTILE_MIN_ARC_HEIGHT,
    RANGED_PROJECTILE_MAX_ARC_HEIGHT,
  );
}

function isProjectileWallBlockedBetweenTiles<TContext>(
  context: TContext,
  wallBlocksAt: ProjectileWallBlocker<TContext>,
  fromTileX: number,
  fromTileZ: number,
  toTileX: number,
  toTileZ: number,
  floor: number,
  projectileY: number,
): boolean {
  const dx = Math.sign(toTileX - fromTileX);
  const dz = Math.sign(toTileZ - fromTileZ);
  if (dx === 0 && dz === 0) return false;

  if (dx > 0) {
    if (wallBlocksAt(context, fromTileX, fromTileZ, WallEdge.E, floor, projectileY)
      || wallBlocksAt(context, toTileX, fromTileZ, WallEdge.W, floor, projectileY)) return true;
  } else if (dx < 0) {
    if (wallBlocksAt(context, fromTileX, fromTileZ, WallEdge.W, floor, projectileY)
      || wallBlocksAt(context, toTileX, fromTileZ, WallEdge.E, floor, projectileY)) return true;
  }

  if (dz > 0) {
    if (wallBlocksAt(context, fromTileX, fromTileZ, WallEdge.S, floor, projectileY)
      || wallBlocksAt(context, fromTileX, toTileZ, WallEdge.N, floor, projectileY)) return true;
  } else if (dz < 0) {
    if (wallBlocksAt(context, fromTileX, fromTileZ, WallEdge.N, floor, projectileY)
      || wallBlocksAt(context, fromTileX, toTileZ, WallEdge.S, floor, projectileY)) return true;
  }

  if (dx !== 0 && dz !== 0) {
    const xEntryEdge = dx > 0 ? WallEdge.W : WallEdge.E;
    const zEntryEdge = dz > 0 ? WallEdge.N : WallEdge.S;
    if (wallBlocksAt(context, toTileX, toTileZ, xEntryEdge, floor, projectileY)
      || wallBlocksAt(context, toTileX, toTileZ, zEntryEdge, floor, projectileY)) return true;
  }

  return false;
}

export function hasProjectileGridLineOfSight<TContext>(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  floor: number,
  fromY: number,
  toY: number,
  context: TContext,
  wallBlocksAt: ProjectileWallBlocker<TContext>,
): boolean {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const maxDelta = Math.max(Math.abs(dx), Math.abs(dz));
  if (maxDelta <= 0.001) return true;

  let tileX = Math.floor(fromX);
  let tileZ = Math.floor(fromZ);
  const endTileX = Math.floor(toX);
  const endTileZ = Math.floor(toZ);
  const stepX = Math.sign(dx);
  const stepZ = Math.sign(dz);
  let tMaxX = Number.POSITIVE_INFINITY;
  let tMaxZ = Number.POSITIVE_INFINITY;
  const tDeltaX = stepX !== 0 ? 1 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const tDeltaZ = stepZ !== 0 ? 1 / Math.abs(dz) : Number.POSITIVE_INFINITY;

  if (stepX > 0) tMaxX = (tileX + 1 - fromX) / dx;
  else if (stepX < 0) tMaxX = (tileX - fromX) / dx;
  if (stepZ > 0) tMaxZ = (tileZ + 1 - fromZ) / dz;
  else if (stepZ < 0) tMaxZ = (tileZ - fromZ) / dz;

  const maxSteps = Math.abs(endTileX - tileX) + Math.abs(endTileZ - tileZ) + 2;
  for (let i = 0; i < maxSteps && (tileX !== endTileX || tileZ !== endTileZ); i++) {
    const fromTileX = tileX;
    const fromTileZ = tileZ;
    let t: number;
    if (tMaxX < tMaxZ) {
      t = tMaxX;
      tileX += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxZ < tMaxX) {
      t = tMaxZ;
      tileZ += stepZ;
      tMaxZ += tDeltaZ;
    } else {
      t = tMaxX;
      tileX += stepX;
      tileZ += stepZ;
      tMaxX += tDeltaX;
      tMaxZ += tDeltaZ;
    }
    const projectileY = fromY + (toY - fromY) * t;
    if (isProjectileWallBlockedBetweenTiles(context, wallBlocksAt, fromTileX, fromTileZ, tileX, tileZ, floor, projectileY)) {
      return false;
    }
  }
  return true;
}
