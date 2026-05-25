import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { GameMap } from '../server/src/GameMap';
import { validateBankAccessSpawns } from '../shared/npcSafety';

const mapId = process.argv[2] || 'kcmap';
const root = resolve(import.meta.dir, '..');
const mapDir = resolve(root, 'server/data/maps', mapId);

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (!existsSync(mapDir)) fail(`map directory not found: ${mapDir}`);

const meta = readJson(resolve(mapDir, 'meta.json'));
const mapFile = readJson(resolve(mapDir, 'map.json'));
const spawnsFile = readJson(resolve(mapDir, 'spawns.json'));
const npcDefs = readJson(resolve(root, 'server/data/npcs.json'));
const npcDefById = new Map((Array.isArray(npcDefs) ? npcDefs : []).map((def: any) => [def.id, def]));
const map = new GameMap(mapId);
const errors: string[] = [];
const warnings: string[] = [];

const width = mapFile?.map?.width;
const height = mapFile?.map?.height;
if (meta.width !== width || meta.height !== height) {
  errors.push(`meta size ${meta.width}x${meta.height} does not match map.json ${width}x${height}`);
}

const activeChunks: string[] = Array.isArray(mapFile?.map?.activeChunks) ? mapFile.map.activeChunks : [];
const activeSet = new Set(activeChunks);
if (activeSet.size !== activeChunks.length) errors.push('activeChunks contains duplicate entries');

const maxChunkX = Math.ceil(width / 64) - 1;
const maxChunkZ = Math.ceil(height / 64) - 1;
for (const key of activeSet) {
  const [cxRaw, czRaw] = key.split(',');
  const cx = Number(cxRaw);
  const cz = Number(czRaw);
  if (!Number.isInteger(cx) || !Number.isInteger(cz)) {
    errors.push(`active chunk key is malformed: ${key}`);
    continue;
  }
  if (cx < 0 || cx > maxChunkX || cz < 0 || cz > maxChunkZ) {
    errors.push(`active chunk ${key} is outside map bounds`);
  }
  for (const kind of ['tiles', 'heights'] as const) {
    const file = resolve(mapDir, kind, `chunk_${cx}_${cz}.json`);
    if (!existsSync(file)) warnings.push(`active chunk ${key} has no ${kind}/chunk_${cx}_${cz}.json; server will use defaults for that layer`);
  }
}

for (const kind of ['tiles', 'heights', 'objects'] as const) {
  const dir = resolve(mapDir, kind);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir)) {
    const match = /^chunk_(-?\d+)_(-?\d+)\.json$/.exec(file);
    if (!match) continue;
    const key = `${Number(match[1])},${Number(match[2])}`;
    if (kind !== 'objects' && !activeSet.has(key)) {
      warnings.push(`${kind}/${file} exists but ${key} is not active`);
    }
  }
}

const spawn = meta.spawnPoint;
const spawnValid = spawn
  && Number.isFinite(spawn.x)
  && Number.isFinite(spawn.z)
  && spawn.x >= 0
  && spawn.x < map.width
  && spawn.z >= 0
  && spawn.z < map.height
  && !map.isBlocked(spawn.x, spawn.z);
if (!spawnValid) {
  errors.push(`spawnPoint (${spawn?.x},${spawn?.z}) is out of bounds, inactive, or blocked`);
}

const foundSpawn = map.findSpawnPoint();
if (Math.abs(foundSpawn.x - spawn.x) > 0.001 || Math.abs(foundSpawn.z - spawn.z) > 0.001) {
  warnings.push(`findSpawnPoint resolves to (${foundSpawn.x},${foundSpawn.z}) instead of authored spawn (${spawn.x},${spawn.z})`);
}

for (const t of meta.transitions ?? []) {
  const targetDir = resolve(root, 'server/data/maps', t.targetMap);
  if (!existsSync(targetDir)) errors.push(`transition at (${t.tileX},${t.tileZ}) targets missing map ${t.targetMap}`);
}

for (const error of validateBankAccessSpawns(mapId, spawnsFile?.npcs ?? [], npcId => npcDefById.get(npcId))) {
  errors.push(error);
}

for (const warning of warnings) console.warn(`WARN: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`OK: ${mapId} ${map.width}x${map.height}, ${activeSet.size} active chunks, spawn (${spawn.x},${spawn.z}) is walkable`);
