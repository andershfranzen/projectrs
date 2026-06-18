/**
 * RS2-style BFS pathfinding (based on 2004Scape/rsmod-pathfinder).
 *
 * Uses breadth-first search on a local 128x128 grid with ring buffer queue.
 * Supports collision flags, diagonal movement with 3-way checking,
 * and closest-approach-point when destination is unreachable.
 */

const SEARCH_SIZE = 128;
const SEARCH_HALF = 64;
const QUEUE_SIZE = SEARCH_SIZE * SEARCH_SIZE;
const MAX_APPROACH_DISTANCE = 10;
const MAX_WAYPOINTS = 50;
const UNVISITED_DISTANCE = 99999;

const directions = new Uint8Array(SEARCH_SIZE * SEARCH_SIZE);
const distances = new Int32Array(SEARCH_SIZE * SEARCH_SIZE);
const queueX = new Int32Array(QUEUE_SIZE);
const queueZ = new Int32Array(QUEUE_SIZE);

// Direction flags for backtracking
const DIR_WEST  = 0x01;
const DIR_EAST  = 0x02;
const DIR_SOUTH = 0x04;
const DIR_NORTH = 0x08;
const DIR_SW = DIR_SOUTH | DIR_WEST;
const DIR_SE = DIR_SOUTH | DIR_EAST;
const DIR_NW = DIR_NORTH | DIR_WEST;
const DIR_NE = DIR_NORTH | DIR_EAST;

export function findPath(
  startX: number,
  startZ: number,
  goalX: number,
  goalZ: number,
  isBlocked: (x: number, z: number) => boolean,
  mapWidth: number = 1024,
  mapHeight: number = 1024,
  _maxSteps: number = 500,
  isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean
): { x: number; z: number }[] {
  const maxSteps = Math.max(0, Math.floor(_maxSteps));
  const sx = Math.floor(startX);
  const sz = Math.floor(startZ);
  const gx = Math.floor(goalX);
  const gz = Math.floor(goalZ);

  if (mapWidth <= 0 || mapHeight <= 0) return [];
  if (sx === gx && sz === gz) return [];

  const clampedGoalX = Math.max(0, Math.min(mapWidth - 1, gx));
  const clampedGoalZ = Math.max(0, Math.min(mapHeight - 1, gz));

  // Local grid origin (source is at center of 128x128 search area)
  const baseX = sx - SEARCH_HALF;
  const baseZ = sz - SEARCH_HALF;

  // Local coordinates
  const srcLX = sx - baseX;
  const srcLZ = sz - baseZ;
  const dstLX = Math.max(0, Math.min(SEARCH_SIZE - 1, clampedGoalX - baseX));
  const dstLZ = Math.max(0, Math.min(SEARCH_SIZE - 1, clampedGoalZ - baseZ));

  directions.fill(0);
  distances.fill(UNVISITED_DISTANCE);

  // Ring buffer queue
  let queueRead = 0;
  let queueWrite = 0;

  const idx = (lx: number, lz: number) => lz * SEARCH_SIZE + lx;

  // Helper: can move from (lx,lz) to an unvisited neighbor?
  const canMoveCardinal = (lx: number, lz: number, dx: number, dz: number): boolean => {
    const nx = lx + dx, nz = lz + dz;
    if (nx < 0 || nx >= SEARCH_SIZE || nz < 0 || nz >= SEARCH_SIZE) return false;
    if (directions[idx(nx, nz)] !== 0) return false; // already visited
    const wx = baseX + nx, wz = baseZ + nz;
    if (wx < 0 || wx >= mapWidth || wz < 0 || wz >= mapHeight) return false;
    if (isBlocked(wx, wz)) return false;
    if (isWallBlocked) {
      const fx = baseX + lx, fz = baseZ + lz;
      if (isWallBlocked(fx, fz, wx, wz)) return false;
    }
    return true;
  };

  // Helper: is a tile passable (no collision/wall check from source)? Ignores visited state.
  // Used for diagonal intermediate tile checks — the adjacent cardinals may already be visited
  // but we still need to verify they're walkable for corner-cutting prevention.
  const isPassable = (lx: number, lz: number, fromLx: number, fromLz: number): boolean => {
    if (lx < 0 || lx >= SEARCH_SIZE || lz < 0 || lz >= SEARCH_SIZE) return false;
    const wx = baseX + lx, wz = baseZ + lz;
    if (wx < 0 || wx >= mapWidth || wz < 0 || wz >= mapHeight) return false;
    if (isBlocked(wx, wz)) return false;
    if (isWallBlocked) {
      const fx = baseX + fromLx, fz = baseZ + fromLz;
      if (isWallBlocked(fx, fz, wx, wz)) return false;
    }
    return true;
  };

  // Enqueue
  const enqueue = (lx: number, lz: number, dir: number, dist: number) => {
    const i = idx(lx, lz);
    directions[i] = dir;
    distances[i] = dist;
    queueX[queueWrite & (QUEUE_SIZE - 1)] = lx;
    queueZ[queueWrite & (QUEUE_SIZE - 1)] = lz;
    queueWrite++;
  };

  // Seed BFS from source
  directions[idx(srcLX, srcLZ)] = 99; // mark source
  distances[idx(srcLX, srcLZ)] = 0;
  enqueue(srcLX, srcLZ, 99, 0);

  let foundX = -1, foundZ = -1;
  let pathFound = false;

  // BFS loop
  while (queueRead !== queueWrite) {
    const cx = queueX[queueRead & (QUEUE_SIZE - 1)];
    const cz = queueZ[queueRead & (QUEUE_SIZE - 1)];
    queueRead++;

    // Check if reached destination
    if (cx === dstLX && cz === dstLZ) {
      foundX = cx;
      foundZ = cz;
      pathFound = true;
      break;
    }

    const dist = distances[idx(cx, cz)] + 1;
    if (dist > maxSteps) continue;

    // Cardinal directions
    // West
    if (canMoveCardinal(cx, cz, -1, 0)) enqueue(cx - 1, cz, DIR_EAST, dist);
    // East
    if (canMoveCardinal(cx, cz, 1, 0)) enqueue(cx + 1, cz, DIR_WEST, dist);
    // South
    if (canMoveCardinal(cx, cz, 0, -1)) enqueue(cx, cz - 1, DIR_NORTH, dist);
    // North
    if (canMoveCardinal(cx, cz, 0, 1)) enqueue(cx, cz + 1, DIR_SOUTH, dist);

    // Diagonal directions — intermediate cardinals use isPassable (ignores visited state),
    // only the diagonal destination checks visited via directions[].
    // Southwest
    {
      const nx = cx - 1, nz = cz - 1;
      if (nx >= 0 && nz >= 0 && directions[idx(nx, nz)] === 0
        && isPassable(cx - 1, cz, cx, cz) && isPassable(cx, cz - 1, cx, cz) && isPassable(nx, nz, cx, cz)) {
        let wallOk = true;
        if (isWallBlocked) {
          const wx = baseX + cx, wz = baseZ + cz;
          if (isWallBlocked(wx - 1, wz, wx - 1, wz - 1)) wallOk = false;
          if (isWallBlocked(wx, wz - 1, wx - 1, wz - 1)) wallOk = false;
        }
        if (wallOk) enqueue(nx, nz, DIR_NE, dist);
      }
    }
    // Southeast
    {
      const nx = cx + 1, nz = cz - 1;
      if (nx < SEARCH_SIZE && nz >= 0 && directions[idx(nx, nz)] === 0
        && isPassable(cx + 1, cz, cx, cz) && isPassable(cx, cz - 1, cx, cz) && isPassable(nx, nz, cx, cz)) {
        let wallOk = true;
        if (isWallBlocked) {
          const wx = baseX + cx, wz = baseZ + cz;
          if (isWallBlocked(wx + 1, wz, wx + 1, wz - 1)) wallOk = false;
          if (isWallBlocked(wx, wz - 1, wx + 1, wz - 1)) wallOk = false;
        }
        if (wallOk) enqueue(nx, nz, DIR_NW, dist);
      }
    }
    // Northwest
    {
      const nx = cx - 1, nz = cz + 1;
      if (nx >= 0 && nz < SEARCH_SIZE && directions[idx(nx, nz)] === 0
        && isPassable(cx - 1, cz, cx, cz) && isPassable(cx, cz + 1, cx, cz) && isPassable(nx, nz, cx, cz)) {
        let wallOk = true;
        if (isWallBlocked) {
          const wx = baseX + cx, wz = baseZ + cz;
          if (isWallBlocked(wx - 1, wz, wx - 1, wz + 1)) wallOk = false;
          if (isWallBlocked(wx, wz + 1, wx - 1, wz + 1)) wallOk = false;
        }
        if (wallOk) enqueue(nx, nz, DIR_SE, dist);
      }
    }
    // Northeast
    {
      const nx = cx + 1, nz = cz + 1;
      if (nx < SEARCH_SIZE && nz < SEARCH_SIZE && directions[idx(nx, nz)] === 0
        && isPassable(cx + 1, cz, cx, cz) && isPassable(cx, cz + 1, cx, cz) && isPassable(nx, nz, cx, cz)) {
        let wallOk = true;
        if (isWallBlocked) {
          const wx = baseX + cx, wz = baseZ + cz;
          if (isWallBlocked(wx + 1, wz, wx + 1, wz + 1)) wallOk = false;
          if (isWallBlocked(wx, wz + 1, wx + 1, wz + 1)) wallOk = false;
        }
        if (wallOk) enqueue(nx, nz, DIR_SW, dist);
      }
    }
  }

  // If destination not reached, find closest approach point
  if (!pathFound) {
    let bestDist = UNVISITED_DISTANCE;
    let bestCost = UNVISITED_DISTANCE;
    const range = MAX_APPROACH_DISTANCE;

    for (let dz = -range; dz <= range; dz++) {
      for (let dx = -range; dx <= range; dx++) {
        const lx = dstLX + dx;
        const lz = dstLZ + dz;
        if (lx < 0 || lx >= SEARCH_SIZE || lz < 0 || lz >= SEARCH_SIZE) continue;
        const i = idx(lx, lz);
        if (distances[i] >= UNVISITED_DISTANCE) continue; // not reached by BFS

        const cost = dx * dx + dz * dz; // squared distance to goal
        if (cost < bestCost || (cost === bestCost && distances[i] < bestDist)) {
          bestCost = cost;
          bestDist = distances[i];
          foundX = lx;
          foundZ = lz;
        }
      }
    }

    if (foundX < 0) return []; // nothing reachable near goal
  }

  // Backtrack from destination to source using direction flags
  const rawPath: { x: number; z: number }[] = [];
  let cx = foundX, cz = foundZ;

  while (cx !== srcLX || cz !== srcLZ) {
    const dir = directions[idx(cx, cz)];
    if (dir === 0 || dir === 99) break; // shouldn't happen

    rawPath.push({ x: baseX + cx + 0.5, z: baseZ + cz + 0.5 });

    // Move opposite to the direction we arrived from
    if (dir & DIR_EAST) cx++;
    else if (dir & DIR_WEST) cx--;
    if (dir & DIR_NORTH) cz++;
    else if (dir & DIR_SOUTH) cz--;
  }

  rawPath.reverse();

  // Path compression: only keep waypoints where direction changes
  if (rawPath.length <= 1) return rawPath;

  const compressed: { x: number; z: number }[] = [];
  let prevDx = 0, prevDz = 0;
  for (let i = 0; i < rawPath.length; i++) {
    if (i === rawPath.length - 1) {
      compressed.push(rawPath[i]);
    } else {
      const dx = Math.sign(rawPath[i + 1].x - rawPath[i].x);
      const dz = Math.sign(rawPath[i + 1].z - rawPath[i].z);
      if (dx !== prevDx || dz !== prevDz) {
        compressed.push(rawPath[i]);
        prevDx = dx;
        prevDz = dz;
      }
    }
  }

  return compressed.length > MAX_WAYPOINTS ? compressed.slice(0, MAX_WAYPOINTS) : compressed;
}
