#!/usr/bin/env bun
/**
 * Generate map.json, meta.json, spawns.json, and walls.json
 * for the underground (256x256) map.
 *
 * Run: bun tools/generate-maps.ts
 *
 * Underground has structured rooms and corridors.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const UNDERGROUND_SIZE = 256;

// Tile type constants (used internally during generation)
const GRASS = 0;
const DIRT = 1;
const STONE = 2;
const WATER = 3;
const WALL = 4;
const SAND = 5;
const WOOD = 6;

// Map old tile type constants to KC ground type strings
const GROUND_TYPE: Record<number, string> = {
  [GRASS]: 'grass',
  [DIRT]:  'dirt',
  [STONE]: 'road',
  [WATER]: 'water',
  [WALL]:  'grass',
  [SAND]:  'sand',
  [WOOD]:  'path',
};

// Wall edge bitmask constants (matching WallEdge in shared/types.ts)
const WALL_N = 1;
const WALL_E = 2;
const WALL_S = 4;
const WALL_W = 8;

// ---------- KC tile helper ----------

function tile(ground: string, waterPainted = false) {
  return {
    ground, groundB: null, split: 'forward' as const,
    textureId: null, textureRotation: 0, textureScale: 1,
    textureWorldUV: false, textureHalfMode: false,
    textureIdB: null, textureRotationB: 0, textureScaleB: 1,
    textureCutAngle: (3 * Math.PI) / 4,
    waterPainted,
  };
}

// Seeded pseudo-random for reproducible generation
let _seed = 12345;
function seededRandom(): number {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
}
function resetSeed(s: number = 12345): void {
  _seed = s;
}

// Type for the KC map file format
interface KCMapFile {
  map: {
    width: number;
    height: number;
    waterLevel: number;
    chunkWaterLevels: Record<string, never>;
    texturePlanes: never[];
    tiles: ReturnType<typeof tile>[][];
    heights: number[][];
  };
  placedObjects: never[];
  layers: { id: string; name: string; visible: boolean }[];
  activeLayerId: string;
}


// ========== UNDERGROUND HEIGHTS (257x257 vertices) ==========

function generateUndergroundHeights(): number[][] {
  const SIZE = UNDERGROUND_SIZE;
  const V = SIZE + 1;

  const heights: number[][] = [];
  for (let vz = 0; vz < V; vz++) {
    heights[vz] = [];
    for (let vx = 0; vx < V; vx++) {
      // Mostly flat with slight variation
      heights[vz][vx] = 0.3 + Math.sin(vx * 0.1) * Math.cos(vz * 0.1) * 0.2;
    }
  }

  return heights;
}

// ========== UNDERGROUND TILEMAP (256x256) ==========

function generateUndergroundTiles(): { tiles: number[][]; walls: Record<string, number> } {
  const SIZE = UNDERGROUND_SIZE;

  // Start everything as WALL (impassable darkness)
  const tiles: number[][] = [];
  for (let x = 0; x < SIZE; x++) {
    tiles[x] = new Array(SIZE).fill(WALL);
  }

  // Edge-based wall data (underground doesn't need many — solid WALL tiles handle blocking)
  const wallEdges: Record<string, number> = {};

  // Carve a rectangular room (stone floor, wall border, doorways)
  function carveRoom(
    rx: number, rz: number, rw: number, rh: number,
    doors: { side: 'n' | 's' | 'e' | 'w'; pos: number }[] = [],
  ): void {
    for (let x = rx; x < rx + rw; x++) {
      for (let z = rz; z < rz + rh; z++) {
        if (x === rx || x === rx + rw - 1 || z === rz || z === rz + rh - 1) {
          tiles[x][z] = WALL;
        } else {
          tiles[x][z] = STONE;
        }
      }
    }
    for (const door of doors) {
      switch (door.side) {
        case 'n':
          for (let dx = -1; dx <= 1; dx++) {
            const tx = rx + door.pos + dx;
            if (tx > rx && tx < rx + rw - 1) tiles[tx][rz] = STONE;
          }
          break;
        case 's':
          for (let dx = -1; dx <= 1; dx++) {
            const tx = rx + door.pos + dx;
            if (tx > rx && tx < rx + rw - 1) tiles[tx][rz + rh - 1] = STONE;
          }
          break;
        case 'w':
          for (let dz = -1; dz <= 1; dz++) {
            const tz = rz + door.pos + dz;
            if (tz > rz && tz < rz + rh - 1) tiles[rx][tz] = STONE;
          }
          break;
        case 'e':
          for (let dz = -1; dz <= 1; dz++) {
            const tz = rz + door.pos + dz;
            if (tz > rz && tz < rz + rh - 1) tiles[rx + rw - 1][tz] = STONE;
          }
          break;
      }
    }
  }

  // Carve a corridor between two points
  function carveCorridor(x1: number, z1: number, x2: number, z2: number, width: number = 4): void {
    const half = Math.floor(width / 2);
    if (x1 === x2) {
      // Vertical
      for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
        for (let w = -half; w < half; w++) {
          const tx = x1 + w;
          if (tx >= 0 && tx < SIZE) tiles[tx][z] = STONE;
        }
      }
    } else if (z1 === z2) {
      // Horizontal
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let w = -half; w < half; w++) {
          const tz = z1 + w;
          if (tz >= 0 && tz < SIZE) tiles[x][tz] = STONE;
        }
      }
    }
  }

  // --- Central hub (110-145, 110-145) - 35x35 room ---
  carveRoom(110, 110, 35, 35, [
    { side: 'n', pos: 17 }, // to north corridor
    { side: 'e', pos: 17 }, // to east corridor
    { side: 's', pos: 17 }, // to south corridor
  ]);

  // --- Entrance area marker inside hub (122-134, 122-134) ---
  // Dirt border marks the transition area
  for (let x = 122; x <= 134; x++) {
    for (let z = 122; z <= 134; z++) {
      if (x === 122 || x === 134 || z === 122 || z === 134) {
        if (x === 128 && (z === 122 || z === 134)) continue; // doorways
        if (z === 128 && (x === 122 || x === 134)) continue;
        tiles[x][z] = DIRT;
      }
    }
  }

  // --- North corridor → Mining chamber ---
  carveCorridor(128, 70, 128, 110, 4);
  carveRoom(115, 50, 25, 20, [
    { side: 's', pos: 13 },
  ]);

  // --- East corridor → Skeleton hall ---
  carveCorridor(145, 128, 180, 128, 4);
  carveRoom(180, 115, 25, 25, [
    { side: 'w', pos: 13 },
  ]);

  // --- South corridor → Boss chamber ---
  carveCorridor(128, 145, 128, 180, 4);
  carveRoom(115, 180, 30, 25, [
    { side: 'n', pos: 13 },
  ]);

  return { tiles, walls: wallEdges };
}

// ========== Convert integer tile grid to KC tile grid ==========

function convertTilesToKC(tiles: number[][], size: number): ReturnType<typeof tile>[][] {
  const kcTiles: ReturnType<typeof tile>[][] = [];
  for (let z = 0; z < size; z++) {
    kcTiles[z] = [];
    for (let x = 0; x < size; x++) {
      const tileType = tiles[x][z];
      const ground = GROUND_TYPE[tileType] || 'grass';
      const waterPainted = tileType === WATER;
      kcTiles[z][x] = tile(ground, waterPainted);
    }
  }
  return kcTiles;
}

// ========== Build KC map file ==========

function buildKCMapFile(
  width: number, height: number, waterLevel: number,
  kcTiles: ReturnType<typeof tile>[][],
  heights: number[][],
): KCMapFile {
  return {
    map: {
      width,
      height,
      waterLevel,
      chunkWaterLevels: {},
      texturePlanes: [],
      tiles: kcTiles,
      heights,
    },
    placedObjects: [],
    layers: [{ id: 'layer_0', name: 'Layer 1', visible: true }],
    activeLayerId: 'layer_0',
  };
}

// ========== WRITE EVERYTHING ==========

const BASE = resolve(import.meta.dir, '../server/data/maps');

// --- Underground ---
{
  const dir = resolve(BASE, 'underground');
  mkdirSync(dir, { recursive: true });

  console.log('Generating underground heights (257x257)...');
  const heights = generateUndergroundHeights();

  console.log('Generating underground tiles (256x256)...');
  const undergroundResult = generateUndergroundTiles();
  const kcTiles = convertTilesToKC(undergroundResult.tiles, UNDERGROUND_SIZE);

  console.log('Writing underground map.json...');
  const kcMap = buildKCMapFile(UNDERGROUND_SIZE, UNDERGROUND_SIZE, -0.5, kcTiles, heights);
  writeFileSync(resolve(dir, 'map.json'), JSON.stringify(kcMap));

  writeFileSync(resolve(dir, 'walls.json'), JSON.stringify({ walls: undergroundResult.walls }, null, 2));
  console.log(`  ${Object.keys(undergroundResult.walls).length} wall edges written.`);

  const meta = {
    id: 'underground',
    name: 'Underground',
    width: UNDERGROUND_SIZE,
    height: UNDERGROUND_SIZE,
    waterLevel: -0.5,
    spawnPoint: { x: 130.5, z: 130.5 }, // away from transition tile at (128,128)
    fogColor: [0.1, 0.08, 0.15],
    fogStart: 8,
    fogEnd: 20,
    transitions: [
      {
        tileX: 128,
        tileZ: 128,
        targetMap: 'kcmap',
        targetX: 96.5,
        targetZ: 96.5,
      },
    ],
  };
  writeFileSync(resolve(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  const spawns = {
    npcs: [
      // Skeletons in skeleton hall (180-205, 115-140)
      { npcId: 5, x: 190.5, z: 125.5 },
      { npcId: 5, x: 195.5, z: 130.5 },
      { npcId: 5, x: 192.5, z: 135.5 },
      { npcId: 5, x: 198.5, z: 120.5 },

      // Dark Knight boss in boss chamber (115-145, 180-205)
      { npcId: 9, x: 130.5, z: 192.5 },
    ],
    objects: [
      // Iron Rocks in mining chamber (115-140, 50-70)
      { objectId: 4, x: 125.5, z: 58.5 },
      { objectId: 4, x: 130.5, z: 55.5 },
      { objectId: 4, x: 135.5, z: 60.5 },
      { objectId: 4, x: 128.5, z: 63.5 },

      // Furnace in mining chamber
      { objectId: 6, x: 120.5, z: 55.5 },
    ],
  };
  writeFileSync(resolve(dir, 'spawns.json'), JSON.stringify(spawns, null, 2));

  console.log('Underground done.');
}

console.log('\nAll maps generated successfully!');
