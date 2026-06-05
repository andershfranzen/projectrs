#!/usr/bin/env bun
/**
 * Regenerate The Sultan's Mine as a sparse chunked dungeon map.
 *
 * This writes only the_sultans_mine data. It intentionally replaces the old
 * authored chunks with a deterministic cave layout using the editor's newer
 * void-first dungeon format.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';

type Ground = 'void' | 'dungeon-floor' | 'dungeon-rock' | 'path' | 'dirt' | 'water';
type TilePartial = {
  ground?: Ground;
  waterPainted?: boolean;
  textureScale?: number;
  textureWorldUV?: boolean;
};

type PlacedObject = {
  assetId: string;
  layerId: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  trigger?: { type: 'teleport'; destChunk: string; entryX: number; entryY: number; entryZ: number };
  interactionTiles?: { x: number; z: number }[];
};

const MAP_ID = 'the_sultans_mine';
const MAP_NAME = "The Sultan's Mine";
const WIDTH = 256;
const HEIGHT = 192;
const CHUNK = 64;
const WATER_LEVEL = -10;
const TERRAIN_GENERATION = 20260605;
const ENTRY = { x: 139.5, z: 146.5 };
const RETURN_TO_KCMAP = { x: 267.5, y: 0.6224362850189209, z: 210.5 };

const mapDir = resolve(import.meta.dir, '../server/data/maps', MAP_ID);
const tiles = new Map<string, TilePartial>();
const floors = new Set<string>();

function key(x: number, z: number): string {
  return `${x},${z}`;
}

function inBounds(x: number, z: number): boolean {
  return x >= 1 && x < WIDTH - 1 && z >= 1 && z < HEIGHT - 1;
}

function setTile(x: number, z: number, tile: TilePartial): void {
  if (!inBounds(x, z)) return;
  tiles.set(key(x, z), tile);
  if (tile.ground === 'dungeon-floor' || tile.ground === 'path' || tile.ground === 'dirt' || tile.ground === 'water') {
    floors.add(key(x, z));
  }
}

function setFloor(x: number, z: number, ground: Ground = 'dungeon-floor'): void {
  setTile(x, z, ground === 'water' ? { ground, waterPainted: true } : { ground });
}

function carveDisc(cx: number, cz: number, radius: number, ground: Ground = 'path'): void {
  const r = Math.ceil(radius);
  for (let z = cz - r; z <= cz + r; z++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx;
      const dz = z - cz;
      if (Math.sqrt(dx * dx + dz * dz) <= radius) setFloor(x, z, ground);
    }
  }
}

function carveEllipse(cx: number, cz: number, rx: number, rz: number, ground: Ground = 'dungeon-floor'): void {
  for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx;
      const dz = (z - cz) / rz;
      if (dx * dx + dz * dz <= 1) setFloor(x, z, ground);
    }
  }
}

function carveCorridor(points: [number, number][], radius = 2, ground: Ground = 'path'): void {
  for (let i = 1; i < points.length; i++) {
    const [x0, z0] = points[i - 1];
    const [x1, z1] = points[i];
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 0 : s / steps;
      const x = Math.round(x0 + (x1 - x0) * t);
      const z = Math.round(z0 + (z1 - z0) * t);
      carveDisc(x, z, radius, ground);
    }
  }
}

function carveWaterPatch(cx: number, cz: number, rx: number, rz: number): void {
  for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx;
      const dz = (z - cz) / rz;
      if (dx * dx + dz * dz <= 1) setFloor(x, z, 'water');
    }
  }
}

function addRockBorder(radius = 3): void {
  const floorKeys = [...floors];
  for (const floorKey of floorKeys) {
    const [fx, fz] = floorKey.split(',').map(Number);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist === 0 || dist > radius) continue;
        const x = fx + dx;
        const z = fz + dz;
        const k = key(x, z);
        if (!inBounds(x, z) || floors.has(k) || tiles.has(k)) continue;
        tiles.set(k, { ground: 'dungeon-rock' });
      }
    }
  }
}

function terrainHeight(x: number, z: number): number {
  const ripple =
    Math.sin(x * 0.13) * 0.035
    + Math.cos(z * 0.11) * 0.025
    + Math.sin((x + z) * 0.055) * 0.018;
  return Number((0.6 + ripple).toFixed(6));
}

function chunkName(x: number, z: number): string {
  return `chunk_${Math.floor(x / CHUNK)}_${Math.floor(z / CHUNK)}.json`;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function writeChunkedTiles(): string[] {
  const dir = resolve(mapDir, 'tiles');
  mkdirSync(dir, { recursive: true });
  const chunks = new Map<string, Record<string, TilePartial>>();
  for (const [k, tile] of tiles) {
    const [x, z] = k.split(',').map(Number);
    const file = chunkName(x, z);
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    let chunk = chunks.get(file);
    if (!chunk) {
      chunk = {};
      chunks.set(file, chunk);
    }
    chunk[`${z - cz * CHUNK},${x - cx * CHUNK}`] = tile;
  }
  for (const [file, data] of chunks) {
    writeFileSync(resolve(dir, file), JSON.stringify(data));
  }
  return [...chunks.keys()].sort();
}

function writeChunkedHeights(activeChunks: string[]): void {
  const dir = resolve(mapDir, 'heights');
  mkdirSync(dir, { recursive: true });
  const touched = new Set<string>();
  for (const k of tiles.keys()) {
    const [x, z] = k.split(',').map(Number);
    for (let dz = 0; dz <= 1; dz++) {
      for (let dx = 0; dx <= 1; dx++) touched.add(key(x + dx, z + dz));
    }
  }

  for (const chunkKey of activeChunks) {
    const [cx, cz] = chunkKey.split(',').map(Number);
    const data: Record<string, number> = {};
    const startX = cx * CHUNK;
    const startZ = cz * CHUNK;
    const endX = Math.min(startX + CHUNK + 1, WIDTH + 1);
    const endZ = Math.min(startZ + CHUNK + 1, HEIGHT + 1);
    for (let z = startZ; z < endZ; z++) {
      for (let x = startX; x < endX; x++) {
        if (!touched.has(key(x, z))) continue;
        data[`${z - startZ},${x - startX}`] = terrainHeight(x, z);
      }
    }
    if (Object.keys(data).length > 0) {
      writeFileSync(resolve(dir, `chunk_${cx}_${cz}.json`), JSON.stringify(data));
    }
  }
}

function objectAt(assetId: string, x: number, z: number, opts: Partial<PlacedObject> = {}): PlacedObject {
  return {
    assetId,
    layerId: 'default',
    position: { x, y: terrainHeight(Math.round(x), Math.round(z)), z },
    rotation: opts.rotation ?? { x: 0, y: 0, z: 0 },
    scale: opts.scale ?? { x: 1, y: 1, z: 1 },
    trigger: opts.trigger,
    interactionTiles: opts.interactionTiles,
  };
}

function writeChunkedObjects(objects: PlacedObject[]): void {
  const dir = resolve(mapDir, 'objects');
  mkdirSync(dir, { recursive: true });
  const chunks = new Map<string, PlacedObject[]>();
  for (const obj of objects) {
    const file = chunkName(obj.position.x, obj.position.z);
    const list = chunks.get(file) ?? [];
    list.push(obj);
    chunks.set(file, list);
  }
  for (const [file, data] of chunks) {
    writeJson(resolve(dir, file), data);
  }
}

function activeChunkKeys(): string[] {
  const chunks = new Set<string>();
  for (const k of tiles.keys()) {
    const [x, z] = k.split(',').map(Number);
    chunks.add(`${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`);
  }
  return [...chunks].sort((a, b) => {
    const [ax, az] = a.split(',').map(Number);
    const [bx, bz] = b.split(',').map(Number);
    return az - bz || ax - bx;
  });
}

function resetMapDir(): void {
  mkdirSync(mapDir, { recursive: true });
  for (const name of ['tiles', 'heights', 'objects']) {
    const dir = resolve(mapDir, name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

// Rooms and corridors.
carveEllipse(139, 146, 17, 11);
carveEllipse(128, 104, 23, 17);
carveEllipse(76, 143, 25, 18);
carveEllipse(184, 131, 27, 18);
carveEllipse(174, 62, 23, 16);
carveEllipse(82, 67, 23, 16);
carveEllipse(214, 82, 17, 12);
carveEllipse(116, 166, 19, 10);

carveCorridor([[139, 146], [136, 128], [128, 104]], 2);
carveCorridor([[126, 119], [104, 134], [76, 143]], 2);
carveCorridor([[144, 112], [164, 122], [184, 131]], 2);
carveCorridor([[180, 116], [176, 89], [174, 62]], 2);
carveCorridor([[111, 96], [96, 80], [82, 67]], 2);
carveCorridor([[96, 67], [130, 63], [151, 62]], 2);
carveCorridor([[190, 118], [203, 99], [214, 82]], 2);
carveCorridor([[111, 117], [111, 142], [116, 166]], 2);
carveCorridor([[100, 155], [122, 148], [139, 146]], 2);

carveWaterPatch(67, 134, 6, 4);
carveWaterPatch(192, 139, 7, 4);
carveWaterPatch(171, 73, 5, 3);

addRockBorder(3);

const activeChunks = activeChunkKeys();
const objects: PlacedObject[] = [
  objectAt('CavernExit1', 135.5, 146.5, {
    rotation: { x: 0, y: Math.PI / 2, z: 0 },
    trigger: {
      type: 'teleport',
      destChunk: 'kcmap',
      entryX: RETURN_TO_KCMAP.x,
      entryY: RETURN_TO_KCMAP.y,
      entryZ: RETURN_TO_KCMAP.z,
    },
  }),
  objectAt('forge', 145.5, 139.5, { rotation: { x: 0, y: Math.PI / 4, z: 0 }, scale: { x: 1.15, y: 1.15, z: 1.15 } }),
  objectAt('anvil', 150.5, 141.5, { rotation: { x: 0, y: Math.PI / 2, z: 0 } }),
  objectAt('CopperRock', 60.5, 141.5),
  objectAt('CopperRock2', 66.5, 153.5, { rotation: { x: 0, y: 0.6, z: 0 } }),
  objectAt('TinRock', 73.5, 128.5, { rotation: { x: 0, y: 1.2, z: 0 } }),
  objectAt('TinRock2', 86.5, 156.5, { rotation: { x: 0, y: 2.2, z: 0 } }),
  objectAt('ClayRock2', 91.5, 139.5, { rotation: { x: 0, y: 1.7, z: 0 } }),
  objectAt('IronRock', 174.5, 122.5, { rotation: { x: 0, y: 0.4, z: 0 } }),
  objectAt('IronRock2', 192.5, 119.5, { rotation: { x: 0, y: 2.4, z: 0 } }),
  objectAt('IronRock3', 202.5, 135.5, { rotation: { x: 0, y: 1.1, z: 0 } }),
  objectAt('CoalRock', 182.5, 144.5, { rotation: { x: 0, y: 2.9, z: 0 } }),
  objectAt('CoalRock2', 196.5, 145.5, { rotation: { x: 0, y: 0.9, z: 0 } }),
  objectAt('MithrilRock', 164.5, 54.5, { rotation: { x: 0, y: 0.2, z: 0 } }),
  objectAt('MithrilRock2', 181.5, 51.5, { rotation: { x: 0, y: 2.1, z: 0 } }),
  objectAt('SilverRock', 188.5, 69.5, { rotation: { x: 0, y: 1.4, z: 0 } }),
  objectAt('MalachiteRock', 209.5, 76.5, { rotation: { x: 0, y: 0.7, z: 0 } }),
  objectAt('CrimsoniteRock', 219.5, 88.5, { rotation: { x: 0, y: 2.8, z: 0 } }),
  objectAt('tier 2 chest', 84.5, 58.5, { rotation: { x: 0, y: Math.PI, z: 0 } }),
  objectAt('Bones', 82.5, 70.5, { rotation: { x: 0, y: 0.5, z: 0 } }),
  objectAt('Bones', 88.5, 66.5, { rotation: { x: 0, y: 2.1, z: 0 } }),
  objectAt('Bones', 211.5, 84.5, { rotation: { x: 0, y: 1.1, z: 0 } }),
];

const spawns = {
  npcs: [
    { id: 1, npcId: 2, x: 122.5, z: 116.5, wanderRange: 5 },
    { id: 2, npcId: 2, x: 115.5, z: 105.5, wanderRange: 5 },
    { id: 3, npcId: 6, x: 76.5, z: 69.5, wanderRange: 4 },
    { id: 4, npcId: 6, x: 91.5, z: 62.5, wanderRange: 4 },
    { id: 5, npcId: 5, x: 177.5, z: 64.5, wanderRange: 5 },
    { id: 6, npcId: 5, x: 167.5, z: 57.5, wanderRange: 5 },
    { id: 7, npcId: 5, x: 207.5, z: 80.5, wanderRange: 4 },
    { id: 8, npcId: 9, x: 219.5, z: 82.5, wanderRange: 3, aggressive: true },
  ],
  objects: [],
  items: [],
};

resetMapDir();
const tileFiles = writeChunkedTiles();
writeChunkedHeights(activeChunks);
writeChunkedObjects(objects);

writeJson(resolve(mapDir, 'meta.json'), {
  id: MAP_ID,
  name: MAP_NAME,
  mapType: 'dungeon',
  dungeon: true,
  width: WIDTH,
  height: HEIGHT,
  waterLevel: WATER_LEVEL,
  spawnPoint: ENTRY,
  fogColor: [0.05, 0.02, 0.08],
  fogStart: 8,
  fogEnd: 25,
  skybox: { color: [0, 0, 0], showSun: false },
  transitions: [],
});

writeJson(resolve(mapDir, 'map.json'), {
  map: {
    width: WIDTH,
    height: HEIGHT,
    mapType: 'dungeon',
    defaultGround: 'void',
    worldOffset: { x: 2000, z: 0 },
    waterLevel: WATER_LEVEL,
    chunkWaterLevels: {},
    chunkWaterFlows: {},
    selectedTexturePlaneId: null,
    texturePlanes: [],
    tiles: [],
    heights: [],
    terrainGeneration: TERRAIN_GENERATION,
    activeChunks,
  },
  layers: [{ id: 'default', name: 'Default', visible: true }],
  activeLayerId: 'default',
  placedObjects: [],
});

writeJson(resolve(mapDir, 'spawns.json'), spawns);
writeJson(resolve(mapDir, 'walls.json'), {
  walls: {},
  wallHeights: {},
  floors: {},
  stairs: {},
  roofs: {},
  tiles: {},
  floorLayers: {},
  holes: {},
});
writeJson(resolve(mapDir, 'biomes.json'), { defs: [], cells: {} });

console.log(`Regenerated ${MAP_ID}`);
console.log(`  tiles: ${tiles.size} cells across ${tileFiles.length} chunks`);
console.log(`  active chunks: ${activeChunks.join(', ')}`);
console.log(`  objects: ${objects.length}`);
