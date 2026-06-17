import {
  expandAndValidateWaypointPath,
  type PathPoint,
  type ValidatedWaypointPath,
  type WaypointStep,
} from '../pathing/Pathing';

export interface MovementCollision<State> {
  canStep(step: WaypointStep<State>): boolean;
  afterStep?(step: WaypointStep<State>): State;
}

export interface ValidateMovementWaypointsOptions<State> {
  startX: number;
  startZ: number;
  waypoints: readonly PathPoint[];
  initialState: State;
  collision: MovementCollision<State>;
  maxSegmentTiles?: number;
  maxRequestedTiles?: number;
}

export function validateMovementWaypoints<State>(
  options: ValidateMovementWaypointsOptions<State>,
): ValidatedWaypointPath<State> {
  return expandAndValidateWaypointPath({
    startX: options.startX,
    startZ: options.startZ,
    waypoints: options.waypoints,
    initialState: options.initialState,
    maxSegmentTiles: options.maxSegmentTiles,
    maxRequestedTiles: options.maxRequestedTiles,
    canStep: step => options.collision.canStep(step),
    afterStep: options.collision.afterStep
      ? step => options.collision.afterStep!(step)
      : undefined,
  });
}
