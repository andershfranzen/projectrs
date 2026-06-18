import {
  canTravel,
  findPathToReach as findSharedPathToReach,
  getObjectFootprintBounds,
  getObjectInteractionTiles,
  isFootprintBlocked,
  type FindPathToReachOptions,
  type PathPoint,
  type TargetPathingCollision,
  type TileCoord,
} from '@projectrs/shared';

export {
  buildNaiveInteractionPath,
  canTravel,
  expandAndValidateWaypointPath,
  isFootprintBlocked,
  isFootprintWallBlocked,
  stepTowardNaiveInteraction,
  stepTowardTile,
} from '@projectrs/shared';

export type {
  PathPoint,
  ValidateWaypointPathOptions,
  ValidatedWaypointPath,
  WaypointStep,
} from '@projectrs/shared';

export type PathingCollision = TargetPathingCollision;

export interface FindPathOptions {
  startX: number;
  startZ: number;
  collision: PathingCollision;
  actorSize?: number;
  maxSearchTiles?: number;
}

export const DEFAULT_MAX_SEARCH_TILES = 4096;

function tileKey(tileX: number, tileZ: number): string {
  return `${tileX},${tileZ}`;
}

export function findPathToReach(options: FindPathOptions & { reached(tileX: number, tileZ: number): boolean }): PathPoint[] {
  const sharedOptions: FindPathToReachOptions = {
    startX: options.startX,
    startZ: options.startZ,
    collision: options.collision,
    maxSearchTiles: options.maxSearchTiles ?? DEFAULT_MAX_SEARCH_TILES,
    reached: options.reached,
  };
  if (options.actorSize !== undefined) sharedOptions.actorSize = options.actorSize;
  return findSharedPathToReach(sharedOptions);
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
