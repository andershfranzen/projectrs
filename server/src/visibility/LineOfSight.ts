export type TileBlocker = (tileX: number, tileZ: number) => boolean;

const EPSILON = 1e-9;

/** Grid LOS for full-tile blockers. The start and destination tiles are ignored
 *  so an actor standing in, or targeting, a blocked tile does not block itself. */
export function hasTileLineOfSight(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  isTileBlocked: TileBlocker,
): boolean {
  if (!Number.isFinite(fromX) || !Number.isFinite(fromZ) || !Number.isFinite(toX) || !Number.isFinite(toZ)) {
    return false;
  }

  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const maxDelta = Math.max(Math.abs(dx), Math.abs(dz));
  if (maxDelta <= 0.001) return true;

  let tileX = Math.floor(fromX);
  let tileZ = Math.floor(fromZ);
  const startTileX = tileX;
  const startTileZ = tileZ;
  const endTileX = Math.floor(toX);
  const endTileZ = Math.floor(toZ);
  if (tileX === endTileX && tileZ === endTileZ) return true;

  const blocksSight = (x: number, z: number): boolean => {
    if (x === startTileX && z === startTileZ) return false;
    if (x === endTileX && z === endTileZ) return false;
    return isTileBlocked(x, z);
  };

  const stepX = Math.sign(dx);
  const stepZ = Math.sign(dz);
  const tDeltaX = stepX !== 0 ? 1 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const tDeltaZ = stepZ !== 0 ? 1 / Math.abs(dz) : Number.POSITIVE_INFINITY;
  let tMaxX = Number.POSITIVE_INFINITY;
  let tMaxZ = Number.POSITIVE_INFINITY;

  if (stepX > 0) tMaxX = (tileX + 1 - fromX) / dx;
  else if (stepX < 0) tMaxX = (tileX - fromX) / dx;
  if (stepZ > 0) tMaxZ = (tileZ + 1 - fromZ) / dz;
  else if (stepZ < 0) tMaxZ = (tileZ - fromZ) / dz;

  const maxSteps = Math.abs(endTileX - tileX) + Math.abs(endTileZ - tileZ) + 2;
  for (let i = 0; i < maxSteps && (tileX !== endTileX || tileZ !== endTileZ); i++) {
    if (tMaxX < tMaxZ - EPSILON) {
      tileX += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxZ < tMaxX - EPSILON) {
      tileZ += stepZ;
      tMaxZ += tDeltaZ;
    } else {
      const sideTileX = tileX + stepX;
      const sideTileZ = tileZ + stepZ;
      if (blocksSight(sideTileX, tileZ) || blocksSight(tileX, sideTileZ)) return false;
      tileX += stepX;
      tileZ += stepZ;
      tMaxX += tDeltaX;
      tMaxZ += tDeltaZ;
    }

    if (blocksSight(tileX, tileZ)) return false;
  }

  return true;
}
