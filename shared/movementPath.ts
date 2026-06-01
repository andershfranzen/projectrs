export interface PathTilePoint {
  x: number;
  z: number;
}

export function compressedPathTileSteps(start: PathTilePoint, path: readonly PathTilePoint[]): number {
  let steps = 0;
  let sx = Math.floor(start.x);
  let sz = Math.floor(start.z);

  for (const point of path) {
    const tx = Math.floor(point.x);
    const tz = Math.floor(point.z);
    steps += Math.max(Math.abs(tx - sx), Math.abs(tz - sz));
    sx = tx;
    sz = tz;
  }

  return steps;
}
