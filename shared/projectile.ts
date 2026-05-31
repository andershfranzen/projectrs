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

export function isShootOverProjectileFenceAssetId(assetId: string): boolean {
  return SHOOT_OVER_FENCE_ASSET_RE.test(assetId);
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
