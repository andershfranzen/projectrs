import { WallEdge } from './types';

export interface ObjectShadowSource {
  assetId?: string;
  x: number;
  z: number;
  rotationY?: number;
  width?: number;
  depth?: number;
}

export interface ObjectShadowCaster {
  type: 'round' | 'linear';
  x: number;
  z: number;
  radius: number;
  maxDark: number;
  tangentX: number;
  tangentZ: number;
  normalX: number;
  normalZ: number;
  halfLength: number;
  halfThickness: number;
  castLength: number;
  shadowDirX: number;
  shadowDirZ: number;
}

export interface ObjectShadowBounds {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface WallShadowRun {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface WallShadowCoverageOptions {
  maxAcrossDistance?: number;
  minDirectionDot?: number;
  spanPadding?: number;
}

const SHADOW_DIR_X = -0.86;
const SHADOW_DIR_Z = -0.51;
const WALL_EDGE_MASK = WallEdge.N | WallEdge.E | WallEdge.S | WallEdge.W;

function lowerAssetId(assetId: string | undefined): string {
  return (assetId || '').toLowerCase();
}

export function isLinearShadowAsset(assetId: string | undefined): boolean {
  const name = lowerAssetId(assetId);
  if (!name) return false;
  if (name.includes('torch')) return false;
  return name.includes('wall')
    || name.includes('window')
    || name.includes('door')
    || name.includes('doorframe')
    || name.includes('arrowslit')
    || name.includes('fence')
    || name.includes('gate')
    || name.includes('modular');
}

function roundShadowProfile(assetId: string | undefined, footprint: number): { radius: number; maxDark: number } {
  const name = lowerAssetId(assetId);
  const isTree = name.includes('tree');
  const isBush = name.includes('bush');
  const isRock = name.includes('rock');
  const isLarge = name.includes('house');
  if (isRock) return { radius: Math.max(1.8, footprint + 1.3), maxDark: 0.72 };
  if (isBush) return { radius: Math.max(3.2, footprint + 2.2), maxDark: 0.45 };
  if (isTree || isLarge) return { radius: Math.max(3.6, footprint + 2.5), maxDark: 0.82 };
  return { radius: Math.max(1.8, footprint + 1.0), maxDark: 0.40 };
}

export function createObjectShadowCaster(source: ObjectShadowSource): ObjectShadowCaster | null {
  if (!Number.isFinite(source.x) || !Number.isFinite(source.z)) return null;
  const width = Math.max(0.1, Math.abs(source.width ?? 1));
  const depth = Math.max(0.1, Math.abs(source.depth ?? 1));
  const footprint = Math.max(width, depth) * 0.5;

  if (!isLinearShadowAsset(source.assetId)) {
    const profile = roundShadowProfile(source.assetId, footprint);
    return {
      type: 'round',
      x: source.x,
      z: source.z,
      radius: profile.radius,
      maxDark: profile.maxDark,
      tangentX: 1,
      tangentZ: 0,
      normalX: 0,
      normalZ: 1,
      halfLength: footprint,
      halfThickness: Math.min(width, depth) * 0.5,
      castLength: profile.radius,
      shadowDirX: SHADOW_DIR_X,
      shadowDirZ: SHADOW_DIR_Z,
    };
  }

  const rotY = source.rotationY ?? 0;
  const rightX = Math.cos(rotY);
  const rightZ = -Math.sin(rotY);
  const forwardX = Math.sin(rotY);
  const forwardZ = Math.cos(rotY);
  const widthIsLength = width >= depth;
  const tangentX = widthIsLength ? rightX : forwardX;
  const tangentZ = widthIsLength ? rightZ : forwardZ;
  let normalX = widthIsLength ? forwardX : rightX;
  let normalZ = widthIsLength ? forwardZ : rightZ;

  // Put the long cast on the side away from the key light. This avoids the
  // old centered blob that made walls look like they glowed from the middle.
  if (normalX * SHADOW_DIR_X + normalZ * SHADOW_DIR_Z < 0) {
    normalX = -normalX;
    normalZ = -normalZ;
  }

  const halfLength = Math.max(width, depth) * 0.5;
  const halfThickness = Math.max(0.35, Math.min(width, depth) * 0.5);
  const castLength = Math.max(2.8, Math.min(5.0, halfLength * 0.55 + 2.6));
  const radius = Math.hypot(halfLength, halfThickness + castLength) + 0.75;

  return {
    type: 'linear',
    x: source.x,
    z: source.z,
    radius,
    maxDark: 0.74,
    tangentX,
    tangentZ,
    normalX,
    normalZ,
    halfLength,
    halfThickness,
    castLength,
    shadowDirX: SHADOW_DIR_X,
    shadowDirZ: SHADOW_DIR_Z,
  };
}

export function createWallEdgeShadowCaster(x0: number, z0: number, x1: number, z1: number): ObjectShadowCaster | null {
  if (!Number.isFinite(x0) || !Number.isFinite(z0) || !Number.isFinite(x1) || !Number.isFinite(z1)) return null;

  const dx = x1 - x0;
  const dz = z1 - z0;
  const length = Math.hypot(dx, dz);
  if (length < 0.001) return null;

  const tangentX = dx / length;
  const tangentZ = dz / length;
  let normalX = -tangentZ;
  let normalZ = tangentX;

  if (normalX * SHADOW_DIR_X + normalZ * SHADOW_DIR_Z < 0) {
    normalX = -normalX;
    normalZ = -normalZ;
  }

  const halfLength = length * 0.5;
  const halfThickness = 0.42;
  const castLength = Math.max(3.2, Math.min(5.4, halfLength * 0.35 + 3.0));
  const radius = Math.hypot(halfLength, halfThickness + castLength) + 1.0;

  return {
    type: 'linear',
    x: (x0 + x1) * 0.5,
    z: (z0 + z1) * 0.5,
    radius,
    maxDark: 0.68,
    tangentX,
    tangentZ,
    normalX,
    normalZ,
    halfLength,
    halfThickness,
    castLength,
    shadowDirX: SHADOW_DIR_X,
    shadowDirZ: SHADOW_DIR_Z,
  };
}

export function objectShadowBounds(caster: ObjectShadowCaster, maxX: number, maxZ: number): ObjectShadowBounds {
  const x0 = Math.max(0, Math.floor(caster.x - caster.radius));
  const x1 = Math.min(maxX, Math.ceil(caster.x + caster.radius));
  const z0 = Math.max(0, Math.floor(caster.z - caster.radius));
  const z1 = Math.min(maxZ, Math.ceil(caster.z + caster.radius));
  return { x0, x1, z0, z1 };
}

function addSetValue(map: Map<number, Set<number>>, key: number, value: number): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function pushMergedRunsForAxis(
  runs: WallShadowRun[],
  fixedAxisEdges: Map<number, Set<number>>,
  isVertical: boolean,
): void {
  for (const [fixed, starts] of fixedAxisEdges) {
    const sorted = Array.from(starts).sort((a, b) => a - b);
    if (sorted.length === 0) continue;

    let runStart = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      const next = sorted[i];
      if (next === prev + 1) {
        prev = next;
        continue;
      }

      if (isVertical) {
        runs.push({ x0: fixed, z0: runStart, x1: fixed, z1: prev + 1 });
      } else {
        runs.push({ x0: runStart, z0: fixed, x1: prev + 1, z1: fixed });
      }

      runStart = next;
      prev = next;
    }
  }
}

export function wallShadowRunsFromEntries(entries: Iterable<readonly [number, number, number]>): WallShadowRun[] {
  const horizontalByZ = new Map<number, Set<number>>();
  const verticalByX = new Map<number, Set<number>>();

  for (const [x, z, rawMask] of entries) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const mask = rawMask & WALL_EDGE_MASK;
    if (mask === 0) continue;

    if (mask & WallEdge.N) addSetValue(horizontalByZ, z, x);
    if (mask & WallEdge.S) addSetValue(horizontalByZ, z + 1, x);
    if (mask & WallEdge.W) addSetValue(verticalByX, x, z);
    if (mask & WallEdge.E) addSetValue(verticalByX, x + 1, z);
  }

  const runs: WallShadowRun[] = [];
  pushMergedRunsForAxis(runs, horizontalByZ, false);
  pushMergedRunsForAxis(runs, verticalByX, true);
  return runs;
}

export function wallShadowRunsFromWallRecord(walls: Record<string, unknown> | null | undefined): WallShadowRun[] {
  if (!walls) return [];
  const wallRecord = walls;

  function* entries(): Generator<readonly [number, number, number]> {
    for (const [key, value] of Object.entries(wallRecord)) {
      const [xStr, zStr] = key.split(',');
      const x = Number(xStr);
      const z = Number(zStr);
      const mask = Number(value);
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(mask)) continue;
      yield [x, z, mask] as const;
    }
  }

  return wallShadowRunsFromEntries(entries());
}

export function isLinearCasterCoveredByWallRuns(
  caster: ObjectShadowCaster,
  runs: readonly WallShadowRun[],
  options: WallShadowCoverageOptions = {},
): boolean {
  if (caster.type !== 'linear') return false;

  const maxAcrossDistance = options.maxAcrossDistance ?? Math.max(0.9, caster.halfThickness + 0.55);
  const minDirectionDot = options.minDirectionDot ?? 0.78;
  const spanPadding = options.spanPadding ?? Math.max(0.75, caster.halfThickness + 0.5);

  for (const run of runs) {
    const dx = run.x1 - run.x0;
    const dz = run.z1 - run.z0;
    const length = Math.hypot(dx, dz);
    if (length < 0.001) continue;

    const tangentX = dx / length;
    const tangentZ = dz / length;
    const directionMatch = Math.abs(caster.tangentX * tangentX + caster.tangentZ * tangentZ);
    if (directionMatch < minDirectionDot) continue;

    const runCenterX = (run.x0 + run.x1) * 0.5;
    const runCenterZ = (run.z0 + run.z1) * 0.5;
    const toCasterX = caster.x - runCenterX;
    const toCasterZ = caster.z - runCenterZ;
    const across = Math.abs(toCasterX * -tangentZ + toCasterZ * tangentX);
    if (across > maxAcrossDistance) continue;

    const along = Math.abs(toCasterX * tangentX + toCasterZ * tangentZ);
    if (along <= length * 0.5 + caster.halfLength + spanPadding) return true;
  }

  return false;
}

export function objectShadowFactorAt(caster: ObjectShadowCaster, x: number, z: number): number {
  const dx = x - caster.x;
  const dz = z - caster.z;

  if (caster.type === 'round') {
    const dist = Math.hypot(dx, dz);
    if (dist >= caster.radius) return 1.0;
    const t = 1.0 - dist / caster.radius;
    return 1.0 - t * t * caster.maxDark;
  }

  const along = dx * caster.tangentX + dz * caster.tangentZ;
  const across = dx * caster.normalX + dz * caster.normalZ;
  const outsideEnd = Math.max(0, Math.abs(along) - caster.halfLength);

  // A capsule contact term keeps connected wall pieces grounded. Vertex-color
  // terrain only samples integer grid points, so a thin rectangle fades out
  // too quickly at wall endpoints and leaves bright notches at corners.
  let bestDark = 0;
  const capsuleDist = Math.hypot(outsideEnd, Math.abs(across));
  const contactRadius = Math.max(1.55, caster.halfThickness + 1.05);
  if (capsuleDist < contactRadius) {
    const t = 1.0 - capsuleDist / contactRadius;
    bestDark = Math.max(bestDark, t * t * 0.42);
  }

  const castAcross = across - caster.halfThickness;
  if (castAcross >= 0 && castAcross <= caster.castLength) {
    const dist = Math.hypot(outsideEnd * 0.65, castAcross);
    if (dist < caster.castLength) {
      const t = 1.0 - dist / caster.castLength;
      bestDark = Math.max(bestDark, t * t * caster.maxDark);
    }
  }

  return 1.0 - bestDark;
}
