export interface MovementPoint {
  x: number;
  z: number;
}

export interface ActiveMovementStep {
  from: MovementPoint;
  target: MovementPoint;
  progress: number;
}

export interface MovementRouteState {
  anchor: MovementPoint;
  path: readonly MovementPoint[];
  pathIndex?: number;
  tileProgress?: number;
}

export interface NormalizedMovementRoute {
  path: MovementPoint[];
  preserveCurrentStep: boolean;
}

function tileX(point: MovementPoint): number {
  return Math.floor(point.x);
}

function tileZ(point: MovementPoint): number {
  return Math.floor(point.z);
}

function centered(tile: number): number {
  return tile + 0.5;
}

export function sameMovementTile(a: MovementPoint, b: MovementPoint): boolean {
  return tileX(a) === tileX(b) && tileZ(a) === tileZ(b);
}

export function getActiveMovementStep(state: MovementRouteState): ActiveMovementStep | null {
  const pathIndex = Math.max(0, Math.floor(state.pathIndex ?? 0));
  if (pathIndex >= state.path.length) return null;

  const target = state.path[pathIndex]!;
  const anchor = state.anchor;
  const dx = Math.sign(tileX(target) - tileX(anchor));
  const dz = Math.sign(tileZ(target) - tileZ(anchor));
  const tileSteps = Math.max(
    Math.abs(tileX(target) - tileX(anchor)),
    Math.abs(tileZ(target) - tileZ(anchor)),
  );
  const progress = state.tileProgress ?? 0;

  if (tileSteps <= 1) {
    return {
      from: { x: anchor.x, z: anchor.z },
      target: { x: target.x, z: target.z },
      progress,
    };
  }

  const progressedTiles = Math.max(0, Math.min(tileSteps - 0.0001, progress * tileSteps));
  const completedTiles = Math.floor(progressedTiles);
  const fromTileX = tileX(anchor) + dx * completedTiles;
  const fromTileZ = tileZ(anchor) + dz * completedTiles;
  const targetTileX = fromTileX + dx;
  const targetTileZ = fromTileZ + dz;

  return {
    from: { x: centered(fromTileX), z: centered(fromTileZ) },
    target: { x: centered(targetTileX), z: centered(targetTileZ) },
    progress: progressedTiles - completedTiles,
  };
}

export function normalizeMovementRouteForActiveStep(
  requestedPath: readonly MovementPoint[],
  state: MovementRouteState,
  preserveCurrentStep: boolean = false,
): NormalizedMovementRoute {
  const path = requestedPath.map(point => ({ x: point.x, z: point.z }));
  if (path.length === 0) return { path, preserveCurrentStep: false };

  const pathIndex = Math.max(0, Math.floor(state.pathIndex ?? 0));
  const tileProgress = state.tileProgress ?? 0;
  const activeStep = getActiveMovementStep(state);
  const shouldPreserveCurrentStep = (preserveCurrentStep || pathIndex < state.path.length)
    && !!activeStep
    && tileProgress > 0;

  if (!shouldPreserveCurrentStep || !activeStep) {
    return { path, preserveCurrentStep: false };
  }

  if (sameMovementTile(path[0]!, activeStep.target)) {
    return { path, preserveCurrentStep: true };
  }

  return {
    path: [{ x: activeStep.target.x, z: activeStep.target.z }, ...path],
    preserveCurrentStep: true,
  };
}

export function remainingMovementQueueMatches(
  queue: readonly MovementPoint[],
  queueIndex: number,
  path: readonly MovementPoint[],
): boolean {
  const first = Math.max(0, Math.floor(queueIndex));
  if (Math.max(0, queue.length - first) !== path.length) return false;

  for (let i = 0; i < path.length; i++) {
    const queued = queue[first + i];
    const next = path[i];
    if (!queued || !next) return false;
    if (!sameMovementTile(queued, next)) return false;
  }

  return true;
}

export function trimMovementQueueToNextStep(
  queue: readonly MovementPoint[],
  queueIndex: number,
): MovementPoint[] | null {
  const next = queue[Math.max(0, Math.floor(queueIndex))];
  return next ? [{ x: next.x, z: next.z }] : null;
}
