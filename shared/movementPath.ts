export interface PathTilePoint {
  x: number;
  z: number;
}

function tileX(point: PathTilePoint): number {
  return Math.floor(point.x);
}

function tileZ(point: PathTilePoint): number {
  return Math.floor(point.z);
}

export function samePathTile(a: PathTilePoint, b: PathTilePoint): boolean {
  return tileX(a) === tileX(b) && tileZ(a) === tileZ(b);
}

export function compressedPathTileStepsFromIndex(
  start: PathTilePoint,
  path: readonly PathTilePoint[],
  startIndex: number = 0,
): number {
  let steps = 0;
  let sx = tileX(start);
  let sz = tileZ(start);
  const first = Math.max(0, Math.floor(startIndex));

  for (let i = first; i < path.length; i++) {
    const point = path[i]!;
    const tx = tileX(point);
    const tz = tileZ(point);
    steps += Math.max(Math.abs(tx - sx), Math.abs(tz - sz));
    sx = tx;
    sz = tz;
  }

  return steps;
}

export function compressedPathTileSteps(start: PathTilePoint, path: readonly PathTilePoint[]): number {
  return compressedPathTileStepsFromIndex(start, path, 0);
}

export function tileOnCompressedPathSegment(
  start: PathTilePoint,
  end: PathTilePoint,
  tx: number,
  tz: number,
): boolean {
  const sx = tileX(start);
  const sz = tileZ(start);
  const ex = tileX(end);
  const ez = tileZ(end);
  const dx = Math.sign(ex - sx);
  const dz = Math.sign(ez - sz);
  if (tx === sx && tz === sz) return true;
  if (dx === 0 && dz === 0) return tx === ex && tz === ez;
  if (dx === 0 && tx !== sx) return false;
  if (dz === 0 && tz !== sz) return false;
  if (dx !== 0 && Math.sign(tx - sx) !== dx) return false;
  if (dz !== 0 && Math.sign(tz - sz) !== dz) return false;
  if (dx !== 0 && dz !== 0 && Math.abs(tx - sx) !== Math.abs(tz - sz)) return false;
  return Math.abs(tx - sx) <= Math.abs(ex - sx) && Math.abs(tz - sz) <= Math.abs(ez - sz);
}

export function compressedRouteSegmentIndexForTile(
  start: PathTilePoint,
  path: readonly PathTilePoint[],
  tx: number,
  tz: number,
  startIndex: number = 0,
): number {
  const first = Math.max(0, Math.floor(startIndex));
  for (let i = first; i < path.length; i++) {
    const segmentStart = i === first ? start : path[i - 1]!;
    if (tileOnCompressedPathSegment(segmentStart, path[i]!, tx, tz)) return i;
  }
  return -1;
}

export function compressedRouteStepIndexForTile(
  start: PathTilePoint,
  path: readonly PathTilePoint[],
  x: number,
  z: number,
): number {
  const tx = Math.floor(x);
  const tz = Math.floor(z);
  let sx = tileX(start);
  let sz = tileZ(start);
  if (sx === tx && sz === tz) return 0;

  let routeSteps = 0;
  for (const waypoint of path) {
    const ex = tileX(waypoint);
    const ez = tileZ(waypoint);
    const dx = Math.sign(ex - sx);
    const dz = Math.sign(ez - sz);
    const segmentSteps = Math.max(Math.abs(ex - sx), Math.abs(ez - sz));
    for (let step = 1; step <= segmentSteps; step++) {
      if (sx + dx * step === tx && sz + dz * step === tz) return routeSteps + step;
    }
    routeSteps += segmentSteps;
    sx = ex;
    sz = ez;
  }

  return -1;
}

export function compressedRouteProgressSteps(
  start: PathTilePoint,
  path: readonly PathTilePoint[],
  pathIndex: number,
  tileProgress: number,
): number {
  if (path.length === 0) return 0;
  let sx = tileX(start);
  let sz = tileZ(start);
  let routeSteps = 0;
  const activeIndex = Math.max(0, Math.floor(pathIndex));

  for (let i = 0; i < path.length; i++) {
    const waypoint = path[i]!;
    const ex = tileX(waypoint);
    const ez = tileZ(waypoint);
    const segmentSteps = Math.max(Math.abs(ex - sx), Math.abs(ez - sz));
    if (i < activeIndex) {
      routeSteps += segmentSteps;
    } else if (i === activeIndex) {
      return routeSteps + Math.max(0, Math.min(segmentSteps, tileProgress * segmentSteps));
    } else {
      return routeSteps;
    }
    sx = ex;
    sz = ez;
  }

  return routeSteps;
}

export function collectCompressedRouteTileKeys(
  start: PathTilePoint,
  path: readonly PathTilePoint[],
): Set<string> {
  const tiles = new Set<string>();
  let sx = tileX(start);
  let sz = tileZ(start);
  tiles.add(`${sx},${sz}`);

  for (const waypoint of path) {
    const ex = tileX(waypoint);
    const ez = tileZ(waypoint);
    const dx = Math.sign(ex - sx);
    const dz = Math.sign(ez - sz);
    const segmentSteps = Math.max(Math.abs(ex - sx), Math.abs(ez - sz));
    for (let step = 1; step <= segmentSteps; step++) {
      tiles.add(`${sx + dx * step},${sz + dz * step}`);
    }
    sx = ex;
    sz = ez;
  }

  return tiles;
}
