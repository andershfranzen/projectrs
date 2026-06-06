import type { GroundType } from './types';

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function sampleNoise(x: number, z: number, scaleA = 1, scaleB = 1): number {
  return (Math.sin(x * scaleA + z * scaleB) + Math.cos(x * (scaleB * 0.73) - z * (scaleA * 0.81))) * 0.5;
}

export interface RGB { r: number; g: number; b: number; }

export const CLIFF_R = 0.38, CLIFF_G = 0.28, CLIFF_B = 0.18;
export const DESERT_SLOPE_TYPES = new Set<GroundType>(['desert', 'sand', 'sandstone', 'drysand']);
export const WATER_UV_SCALE = 5;
export const WATER_TEXTURE_ALPHA = 0.55;
export const SURFACE_WATER_ALPHA = 0.25;
export const WATER_TEXTURE_TINT: RGB = { r: 0.83, g: 0.91, b: 1.0 };
export const SURFACE_WATER_TEXTURE_TINT: RGB = { r: 0.88, g: 0.96, b: 0.97 };
export const WATER_FALLBACK_TINT: RGB = { r: 0.42, g: 0.52, b: 0.70 };
export const SURFACE_WATER_FALLBACK_TINT: RGB = { r: 0.54, g: 0.78, b: 0.85 };
export const WATER_SURFACE_VERTEX_COLOR: RGB = { r: 0.40, g: 0.47, b: 0.66 };
export const SURFACE_WATER_VERTEX_COLOR: RGB = { r: 0.55, g: 0.72, b: 0.78 };
export const WATER_EDGE_MUD_COLOR: RGB = { r: 0.34, g: 0.22, b: 0.09 };
export const WATER_EDGE_MUD_STRENGTH = 0.46;
export const WATER_EDGE_MUD_MAX_BLEND = 0.56;
export const DUNGEON_TORCHLIGHT_VISUAL_BASE: GroundType = 'dungeon-floor';
export const TORCHLIGHT_GLOW_RADIUS_TILES = 3.15;
export const TORCHLIGHT_GLOW_MAX_BLEND = 0.68;
export const TORCHLIGHT_GLOW_FALLOFF_STRENGTH = 0.72;
export const TORCHLIGHT_GLOW_SUBDIVISIONS = 4;
export const TORCHLIGHT_GLOW_COLOR: RGB = { r: 0.78, g: 0.45, b: 0.16 };

export function isTorchlightGround(type: GroundType | null | undefined): type is 'dungeon-torchlight' {
  return type === 'dungeon-torchlight';
}

export function hasTorchlightPaint(
  ground: GroundType | null | undefined,
  groundB: GroundType | null | undefined,
): boolean {
  return isTorchlightGround(ground) || isTorchlightGround(groundB);
}

export function visualGroundForTorchlight(
  ground: GroundType | null | undefined,
  groundB: GroundType | null | undefined,
  fallback: GroundType = DUNGEON_TORCHLIGHT_VISUAL_BASE,
): GroundType {
  const base = ground ?? fallback;
  if (isTorchlightGround(base)) {
    return groundB && !isTorchlightGround(groundB) ? groundB : fallback;
  }
  return base;
}

export function applyTorchlightTint(color: RGB, influence: number): void {
  const t = clamp(influence, 0, TORCHLIGHT_GLOW_MAX_BLEND);
  if (t <= 0) return;
  color.r = clamp(color.r * (1 - t * 0.42) + TORCHLIGHT_GLOW_COLOR.r * t, 0, 1);
  color.g = clamp(color.g * (1 - t * 0.32) + TORCHLIGHT_GLOW_COLOR.g * t, 0, 1);
  color.b = clamp(color.b * (1 - t * 0.22) + TORCHLIGHT_GLOW_COLOR.b * t, 0, 1);
}

export interface TorchlightPaintTile {
  x: number;
  z: number;
}

export interface TorchlightInfluenceGrid {
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  steps: number;
  width: number;
  height: number;
  values: Float32Array;
}

export function bilerpRGB(tl: RGB, tr: RGB, bl: RGB, br: RGB, u: number, v: number): RGB {
  const topR = tl.r * (1 - u) + tr.r * u;
  const topG = tl.g * (1 - u) + tr.g * u;
  const topB = tl.b * (1 - u) + tr.b * u;
  const botR = bl.r * (1 - u) + br.r * u;
  const botG = bl.g * (1 - u) + br.g * u;
  const botB = bl.b * (1 - u) + br.b * u;
  return {
    r: topR * (1 - v) + botR * v,
    g: topG * (1 - v) + botG * v,
    b: topB * (1 - v) + botB * v,
  };
}

export function buildTorchlightInfluenceGrid(
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  torchTiles: readonly TorchlightPaintTile[],
  steps: number = TORCHLIGHT_GLOW_SUBDIVISIONS,
): TorchlightInfluenceGrid | null {
  const tileWidth = Math.max(0, endX - startX);
  const tileHeight = Math.max(0, endZ - startZ);
  if (tileWidth <= 0 || tileHeight <= 0 || torchTiles.length === 0) return null;

  const width = tileWidth * steps + 1;
  const height = tileHeight * steps + 1;
  const values = new Float32Array(width * height);
  const radius = TORCHLIGHT_GLOW_RADIUS_TILES;
  const radiusSq = radius * radius;
  const invRadius = 1 / radius;

  for (const tile of torchTiles) {
    const centerX = tile.x + 0.5;
    const centerZ = tile.z + 0.5;
    if (centerX < startX - radius || centerX > endX + radius || centerZ < startZ - radius || centerZ > endZ + radius) {
      continue;
    }

    const gx0 = Math.max(0, Math.floor((centerX - radius - startX) * steps));
    const gx1 = Math.min(width - 1, Math.ceil((centerX + radius - startX) * steps));
    const gz0 = Math.max(0, Math.floor((centerZ - radius - startZ) * steps));
    const gz1 = Math.min(height - 1, Math.ceil((centerZ + radius - startZ) * steps));

    for (let gz = gz0; gz <= gz1; gz++) {
      const worldZ = startZ + gz / steps;
      const dz = worldZ - centerZ;
      for (let gx = gx0; gx <= gx1; gx++) {
        const worldX = startX + gx / steps;
        const dx = worldX - centerX;
        const distSq = dx * dx + dz * dz;
        if (distSq >= radiusSq) continue;

        const t = 1 - Math.sqrt(distSq) * invRadius;
        const idx = gz * width + gx;
        values[idx] = clamp(values[idx] + t * t * TORCHLIGHT_GLOW_FALLOFF_STRENGTH, 0, 1);
      }
    }
  }

  return { startX, startZ, endX, endZ, steps, width, height, values };
}

export function sampleTorchlightInfluenceGrid(
  grid: TorchlightInfluenceGrid | null,
  worldX: number,
  worldZ: number,
): number {
  if (!grid) return 0;
  const gx = Math.round((worldX - grid.startX) * grid.steps);
  const gz = Math.round((worldZ - grid.startZ) * grid.steps);
  if (gx < 0 || gz < 0 || gx >= grid.width || gz >= grid.height) return 0;
  return grid.values[gz * grid.width + gx] ?? 0;
}

export function maxTorchlightInfluenceForTile(
  grid: TorchlightInfluenceGrid | null,
  tileX: number,
  tileZ: number,
): number {
  return Math.max(
    sampleTorchlightInfluenceGrid(grid, tileX, tileZ),
    sampleTorchlightInfluenceGrid(grid, tileX + 1, tileZ),
    sampleTorchlightInfluenceGrid(grid, tileX, tileZ + 1),
    sampleTorchlightInfluenceGrid(grid, tileX + 1, tileZ + 1),
    sampleTorchlightInfluenceGrid(grid, tileX + 0.5, tileZ),
    sampleTorchlightInfluenceGrid(grid, tileX + 1, tileZ + 0.5),
    sampleTorchlightInfluenceGrid(grid, tileX + 0.5, tileZ + 1),
    sampleTorchlightInfluenceGrid(grid, tileX, tileZ + 0.5),
    sampleTorchlightInfluenceGrid(grid, tileX + 0.5, tileZ + 0.5),
  );
}

export function applyWaterEdgeMudTint(color: RGB, proximity: number): void {
  const t = clamp(proximity * WATER_EDGE_MUD_STRENGTH, 0, WATER_EDGE_MUD_MAX_BLEND);
  if (t <= 0) return;
  color.r = color.r * (1 - t) + WATER_EDGE_MUD_COLOR.r * t;
  color.g = color.g * (1 - t) + WATER_EDGE_MUD_COLOR.g * t;
  color.b = color.b * (1 - t) + WATER_EDGE_MUD_COLOR.b * t;
}

export function groundColor(type: GroundType, shade: number): RGB {
  let r: number, g: number, b: number;
  switch (type) {
    case 'dirt':          r = 0.45; g = 0.31; b = 0.14; break;
    case 'sand':          r = 0.72; g = 0.60; b = 0.24; break;
    case 'path':          r = 0.42; g = 0.30; b = 0.13; break;
    case 'road':          r = 0.47; g = 0.46; b = 0.43; break;
    // Editor label: Mud. Actual rendered water is controlled by waterPainted / waterLevel.
    case 'water':         r = 0.35; g = 0.24; b = 0.10; break;
    case 'desert':        r = 0.82; g = 0.72; b = 0.50; break;
    case 'sandstone':     r = 0.68; g = 0.48; b = 0.28; break;
    case 'rock':          r = 0.42; g = 0.40; b = 0.36; break;
    case 'drysand':       r = 0.62; g = 0.42; b = 0.22; break;
    case 'dungeon-floor': r = 0.22; g = 0.17; b = 0.11; break;
    case 'dungeon-stone': r = 0.36; g = 0.36; b = 0.34; break;
    case 'dungeon-slate': r = 0.24; g = 0.29; b = 0.32; break;
    case 'dungeon-rubble': r = 0.30; g = 0.27; b = 0.23; break;
    case 'dungeon-basalt': r = 0.13; g = 0.13; b = 0.14; break;
    case 'dungeon-moss':  r = 0.18; g = 0.28; b = 0.17; break;
    case 'dungeon-torchlight': r = 0.64; g = 0.40; b = 0.16; break;
    case 'dungeon-rock':  r = 0.28; g = 0.20; b = 0.12; break;
    case 'dungeon-grey-rock': r = 0.32; g = 0.33; b = 0.32; break;
    case 'dungeon-dark-rock': r = 0.12; g = 0.11; b = 0.10; break;
    case 'void':          r = 0.00; g = 0.00; b = 0.00; break;
    default:              r = 0.13; g = 0.43; b = 0.07; break; // grass
  }

  if (DESERT_SLOPE_TYPES.has(type) && shade < 0.85) {
    const t = Math.min(1.0, (0.85 - shade) * 2.5);
    r = r * (1 - t) + CLIFF_R * t;
    g = g * (1 - t) + CLIFF_G * t;
    b = b * (1 - t) + CLIFF_B * t;
  }

  return { r: r * shade, g: g * shade, b: b * shade };
}

export function getNoiseExtra(type: GroundType, vx: number, vz: number): number {
  if (type === 'grass') {
    return sampleNoise(vx * 0.18, vz * 0.18, 1.0, 1.2) * 0.10
      + sampleNoise(vx * 0.42, vz * 0.42, 0.8, 1.0) * 0.038
      + sampleNoise(vx * 2.4, vz * 2.4, 1.5, 1.9) * 0.014;
  } else if (type === 'path') {
    return sampleNoise(vx * 0.22, vz * 0.22, 1.0, 1.1) * 0.04
      + sampleNoise(vx * 1.8, vz * 1.8, 1.3, 1.7) * 0.012;
  } else if (type === 'road') {
    return sampleNoise(vx * 1.2, vz * 1.2, 1.5, 0.9) * 0.025
      + sampleNoise(vx * 3.0, vz * 3.0, 2.0, 1.5) * 0.01;
  } else if (
    type === 'dungeon-stone'
    || type === 'dungeon-slate'
    || type === 'dungeon-rubble'
    || type === 'dungeon-basalt'
    || type === 'dungeon-moss'
    || type === 'dungeon-torchlight'
    || type === 'dungeon-grey-rock'
    || type === 'dungeon-dark-rock'
  ) {
    return sampleNoise(vx * 0.9, vz * 0.9, 1.4, 1.1) * 0.024
      + sampleNoise(vx * 3.2, vz * 3.2, 1.7, 2.2) * 0.014;
  } else if (type === 'dirt' || type === 'sand') {
    return sampleNoise(vx * 0.5, vz * 0.5, 0.8, 1.1) * 0.02;
  }
  return 0;
}

export interface CornerHeights { tl: number; tr: number; bl: number; br: number; }

export function getSlopeShade(h: CornerHeights): number {
  const dx = ((h.tr + h.br) - (h.tl + h.bl)) * 0.5;
  const dz = ((h.bl + h.br) - (h.tl + h.tr)) * 0.5;
  const steepness = Math.abs(dx) + Math.abs(dz);

  let shade = 1.0 - steepness * 0.22;
  const directional = (-dx * 0.18) + (-dz * 0.12);
  shade += directional;

  return clamp(shade, 0.46, 1.04);
}

export function getTileAverageHeight(h: CornerHeights): number {
  return (h.tl + h.tr + h.bl + h.br) / 4;
}

export function getVertexAO(
  vx: number, vz: number,
  mapWidth: number, mapHeight: number,
  getVertexHeight: (x: number, z: number) => number,
): number {
  const h = getVertexHeight(vx, vz);
  let sum = 0, count = 0;
  for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as [number, number][]) {
    const nx = vx + dx, nz = vz + dz;
    if (nx < 0 || nx > mapWidth || nz < 0 || nz > mapHeight) continue;
    sum += getVertexHeight(nx, nz);
    count++;
  }
  if (count === 0) return 1.0;
  const depression = (sum / count) - h;
  return 1.0 - clamp(depression * 0.16, 0, 0.40);
}

export function getVertexWaterProximity(
  vx: number, vz: number,
  isWaterTile: (tx: number, tz: number) => boolean,
): number {
  let maxProx = 0;
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const tx = vx + dx, tz = vz + dz;
      if (!isWaterTile(tx, tz)) continue;
      const cx = clamp(vx, tx, tx + 1);
      const cz = clamp(vz, tz, tz + 1);
      const dist = Math.sqrt((vx - cx) * (vx - cx) + (vz - cz) * (vz - cz));
      const prox = Math.max(0, 1 - dist / 2.5);
      if (prox > maxProx) maxProx = prox;
    }
  }
  return maxProx;
}
