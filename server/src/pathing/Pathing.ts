import {
  canTravel,
  findPathToReach as findSharedPathToReach,
  getObjectFootprintBounds,
  getObjectInteractionTiles,
  isFootprintBlocked,
  type FindPathToReachOptions,
  type TargetPathingCollision,
  type TileCoord,
} from '@projectrs/shared';

export {
  buildNaiveInteractionPath,
  canTravel,
  isFootprintBlocked,
  isFootprintWallBlocked,
  stepTowardNaiveInteraction,
  stepTowardTile,
} from '@projectrs/shared';

export interface PathPoint {
  x: number;
  z: number;
}

export type PathingCollision = TargetPathingCollision;

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

export const DEFAULT_MAX_SEARCH_TILES = 4096;

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
    requestedTileCount += distance;
    if (distance > maxSegmentTiles) {
      truncated = true;
      break;
    }
    if (stepX !== 0 && stepZ !== 0 && Math.abs(dxTotal) !== Math.abs(dzTotal)) {
      truncated = true;
      break;
    }

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
      if (stepX !== 0 && stepZ !== 0) {
        const horizontalStep: WaypointStep<State> = {
          state,
          fromTileX: curTileX,
          fromTileZ: curTileZ,
          toTileX,
          toTileZ: curTileZ,
          stepX,
          stepZ: 0,
        };
        const verticalStep: WaypointStep<State> = {
          state,
          fromTileX: curTileX,
          fromTileZ: curTileZ,
          toTileX: curTileX,
          toTileZ,
          stepX: 0,
          stepZ,
        };
        if (!options.canStep(horizontalStep) || !options.canStep(verticalStep)) {
          truncated = true;
          break outer;
        }
      }
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
