import type { PathPoint } from './targetPathing';

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

function center(tile: number): number {
  return tile + 0.5;
}

function point(tileX: number, tileZ: number): PathPoint {
  return { x: center(tileX), z: center(tileZ) };
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
