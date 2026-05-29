import { SERVER_PORT, GAME_WS_PATH, CHAT_WS_PATH, CHUNK_SIZE, DEFAULT_CUT_ANGLE, HEAD_RENDER_MODES, validateDeviceId, gearFitTierForName, resolveEquipmentModelPath, validateBankAccessSpawns, readPngDimensions } from '@projectrs/shared';
import { resolve, dirname, sep, relative } from 'path';
import { statSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync, realpathSync } from 'fs';
import { promises as fsp } from 'fs';
import type { FloorLayerData, KCMapFile, KCTile, MapMeta, WallsFile, SpawnsFile, PlacedObject, BiomesFile, ItemDef } from '@projectrs/shared';
import { ASSET_TO_OBJECT_DEF, classifyTileType, defaultKCTile, TileType } from '@projectrs/shared';
import { World } from './World';
import { invalidatePublicDataCache, isPublicDataFile, readPublicDataContent } from './data/PublicData';
import { preserveExistingFloorLayerTiles } from './data/WallsMerge';
import { extractWsToken, hasMatchingCookie, isAllowedWsOrigin, isProductionLike, parseAllowedOrigins, readCookie, wsAcceptHeaders } from './network/WsSecurity';
import { requestClientIp } from './network/clientIp';
import { audit } from './Audit';

// Mob-kill leaderboard display tweaks — scoped to the hiscores only; these do
// NOT rename or remove the NPC in-world. Override placeholder/dev names and
// keep non-public mobs out of the picker.
const MOB_KILL_NAME_OVERRIDES: Record<number, string> = { 102: 'Man' };
const MOB_KILL_HIDDEN_IDS = new Set<number>([19]);

// --- Chunked object storage helpers ---

/** Split placed objects into per-chunk buckets keyed by "chunk_{cx}_{cz}" */
function splitObjectsByChunk(objects: PlacedObject[]): Map<string, PlacedObject[]> {
  const chunks = new Map<string, PlacedObject[]>();
  for (const obj of objects) {
    if (obj.position.x == null || obj.position.z == null || isNaN(obj.position.x) || isNaN(obj.position.z)) continue;
    const cx = Math.floor(obj.position.x / CHUNK_SIZE);
    const cz = Math.floor(obj.position.z / CHUNK_SIZE);
    const key = `chunk_${cx}_${cz}`;
    let arr = chunks.get(key);
    if (!arr) { arr = []; chunks.set(key, arr); }
    arr.push(obj);
  }
  return chunks;
}

/** Save placed objects as per-chunk JSON files, removing chunks that are now empty.
 *  Async fs so the main thread stays responsive — editor saves no longer freeze
 *  ticks for connected players. */
async function saveChunkedObjects(mapDir: string, objects: PlacedObject[]): Promise<void> {
  const objectsDir = resolve(mapDir, 'objects');
  await fsp.mkdir(objectsDir, { recursive: true });

  const written = new Set<string>();
  const chunks = splitObjectsByChunk(objects);
  const writes: Promise<void>[] = [];
  for (const [key, objs] of chunks) {
    writes.push(fsp.writeFile(resolve(objectsDir, `${key}.json`), JSON.stringify(objs, null, 2)));
    written.add(`${key}.json`);
  }
  await Promise.all(writes);

  // Remove chunk files that no longer have objects
  try {
    const files = await fsp.readdir(objectsDir);
    await Promise.all(files.map(async (file) => {
      if (file.startsWith('chunk_') && file.endsWith('.json') && !written.has(file)) {
        await fsp.rm(resolve(objectsDir, file));
      }
    }));
  } catch { /* dir may not exist yet */ }
}

/** Load placed objects from per-chunk files, falling back to map.json for backwards compat */
function loadChunkedObjects(mapDir: string): PlacedObject[] | null {
  const objectsDir = resolve(mapDir, 'objects');
  if (!existsSync(objectsDir)) return null;
  const objects: PlacedObject[] = [];
  try {
    for (const file of readdirSync(objectsDir)) {
      if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
      const chunk: PlacedObject[] = JSON.parse(readFileSync(resolve(objectsDir, file), 'utf-8'));
      objects.push(...chunk);
    }
  } catch { return null; }
  return objects.length > 0 ? objects : null;
}

function buildObjectChunkManifest(mapDir: string): { chunks: Record<string, string[]> } {
  const objectsDir = resolve(mapDir, 'objects');
  const chunks: Record<string, string[]> = {};
  if (!existsSync(objectsDir)) return { chunks };
  try {
    for (const file of readdirSync(objectsDir)) {
      const match = file.match(/^chunk_(-?\d+)_(-?\d+)\.json$/);
      if (!match) continue;
      const objects: PlacedObject[] = JSON.parse(readFileSync(resolve(objectsDir, file), 'utf-8'));
      if (!Array.isArray(objects) || objects.length === 0) continue;
      const assetIds = new Set<string>();
      for (const obj of objects) {
        if (typeof obj?.assetId === 'string' && obj.assetId) assetIds.add(obj.assetId);
      }
      chunks[`${match[1]},${match[2]}`] = [...assetIds];
    }
  } catch {
    return { chunks: {} };
  }
  return { chunks };
}

function detectUniformNpcSpawnOffset(existing: SpawnsFile | null, incoming: SpawnsFile | undefined): { dx: number; dz: number; count: number; matched: number } | null {
  const oldNpcs = existing?.npcs ?? [];
  const newNpcs = incoming?.npcs ?? [];
  if (oldNpcs.length < 5 || newNpcs.length < 5) return null;

  const oldById = new Map<number, SpawnsFile['npcs'][number]>();
  for (const spawn of oldNpcs) {
    const id = (spawn as { id?: unknown }).id;
    if (typeof id === 'number') oldById.set(id, spawn);
  }

  const counts = new Map<string, { dx: number; dz: number; count: number }>();
  let matched = 0;
  for (let i = 0; i < newNpcs.length; i++) {
    const next = newNpcs[i];
    const id = (next as { id?: unknown }).id;
    const prev = typeof id === 'number' ? oldById.get(id) : oldNpcs[i];
    if (!prev) continue;
    const dx = Number((next.x - prev.x).toFixed(6));
    const dz = Number((next.z - prev.z).toFixed(6));
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) continue;
    matched++;
    if (dx === 0 && dz === 0) continue;
    const key = `${dx},${dz}`;
    const entry = counts.get(key) ?? { dx, dz, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }

  if (matched < 5) return null;
  let best: { dx: number; dz: number; count: number } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  if (!best) return null;

  const isChunkOffset = (n: number) => Math.abs(n) >= EDITOR_CHUNK_SIZE && Math.abs(n % EDITOR_CHUNK_SIZE) < 0.000001;
  const threshold = Math.max(5, Math.floor(matched * 0.8));
  if (best.count >= threshold && (isChunkOffset(best.dx) || isChunkOffset(best.dz))) {
    return { ...best, matched };
  }
  return null;
}

function sameStringSet(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const set = new Set(a.filter((value): value is string => typeof value === 'string'));
  return b.every((value) => typeof value === 'string' && set.has(value));
}

function mapShapeChanged(existing: KCMapFile | null, incoming: KCMapFile): boolean {
  const oldMap = existing?.map;
  const newMap = incoming.map;
  if (!oldMap || !newMap) return false;
  return oldMap.width !== newMap.width
    || oldMap.height !== newMap.height
    || !sameStringSet(oldMap.activeChunks, newMap.activeChunks);
}

/** Read + parse JSON, returning null on any failure (missing file, bad JSON, etc.). */
async function loadJsonOrNull<T = unknown>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Atomic JSON save + timestamped backup of the prior file. Shape shared by
 * the NPC / quest / gear-overrides editor endpoints, all of which need:
 *   - tmp file + rename → atomic publish
 *   - copy old file into a rotated backup dir before publishing
 *   - keep last `maxKeep` snapshots, drop the rest
 *
 * Backup IO runs in parallel with the tmp-file write since the rename at the
 * end commits regardless of which finishes first.
 */
async function saveJsonWithBackup(opts: {
  path: string;
  data: unknown;
  backupDir: string;
  backupPrefix: string;
  backupExt: string;
  maxKeep: number;
}): Promise<void> {
  const { path, data, backupDir, backupPrefix, backupExt, maxKeep } = opts;
  const tmpPath = path + '.tmp';
  const filenameRe = new RegExp(`^${backupPrefix}\\..+\\.${backupExt.replace(/^\./, '')}$`);

  await Promise.all([
    (async () => {
      try {
        await fsp.mkdir(backupDir, { recursive: true });
        const sourceExists = await fsp.stat(path).then(() => true).catch(() => false);
        if (sourceExists) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          await fsp.cp(path, resolve(backupDir, `${backupPrefix}.${ts}.${backupExt.replace(/^\./, '')}`));
          const snaps = (await fsp.readdir(backupDir)).filter((n) => filenameRe.test(n)).sort();
          const excess = Math.max(0, snaps.length - maxKeep);
          await Promise.all(
            snaps.slice(0, excess).map((n) => fsp.rm(resolve(backupDir, n)).catch(() => {})),
          );
        }
      } catch (err) {
        console.warn(`[save-${backupPrefix}] backup failed:`, (err as Error)?.message);
      }
    })(),
    fsp.writeFile(tmpPath, JSON.stringify(data, null, 2)),
  ]);
  await fsp.rename(tmpPath, path);
}

const EQUIP_SLOTS = new Set(['weapon', 'head', 'body', 'legs', 'shield', 'neck', 'ring', 'hands', 'feet', 'cape', 'ammo']);
const EQUIP_SKILLS = new Set(['accuracy', 'strength', 'defence', 'goodmagic', 'evilmagic', 'archery', 'hitpoints', 'woodcut', 'fishing', 'cooking', 'mining', 'smithing', 'crafting', 'roguery']);
const WEAPON_STYLES = new Set(['stab', 'slash', 'crush', 'bow', 'crossbow']);
const TOOL_TYPES = new Set(['axe', 'pickaxe', 'hammer']);
const HEAD_RENDER_MODE_SET: ReadonlySet<string> = new Set(HEAD_RENDER_MODES);

function validateItemDefs(items: unknown): { ok: true; items: ItemDef[] } | { ok: false; error: string } {
  if (!Array.isArray(items)) return { ok: false, error: 'Body must be { items: ItemDef[] }' };
  const seen = new Set<number>();
  const finiteNumberFields = [
    'value', 'attackSpeed', 'stabAttack', 'slashAttack', 'crushAttack',
    'stabDefence', 'slashDefence', 'crushDefence', 'rangedDefence',
    'magicDefence', 'magicAccuracy', 'meleeStrength', 'rangedAccuracy',
    'rangedStrength', 'healAmount', 'toolLevel', 'toolBonus', 'levelRequired',
  ];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Every item must be an object' };
    const item = raw as Record<string, unknown>;
    if (!Number.isInteger(item.id) || (item.id as number) <= 0) return { ok: false, error: `Invalid item id: ${String(item.id)}` };
    if (seen.has(item.id as number)) return { ok: false, error: `Duplicate item id: ${item.id}` };
    seen.add(item.id as number);
    if (typeof item.name !== 'string' || item.name.trim().length === 0) return { ok: false, error: `Item ${item.id} is missing a name` };
    if (typeof item.description !== 'string') return { ok: false, error: `Item ${item.id} is missing a description` };
    if (typeof item.stackable !== 'boolean') return { ok: false, error: `Item ${item.id} has invalid stackable` };
    if (typeof item.equippable !== 'boolean') return { ok: false, error: `Item ${item.id} has invalid equippable` };
    if (item.equipSlot !== undefined && !EQUIP_SLOTS.has(String(item.equipSlot))) return { ok: false, error: `Item ${item.id} has invalid equipSlot` };
    if (item.equipSkill !== undefined && !EQUIP_SKILLS.has(String(item.equipSkill))) return { ok: false, error: `Item ${item.id} has invalid equipSkill` };
    if (item.weaponStyle !== undefined && !WEAPON_STYLES.has(String(item.weaponStyle))) return { ok: false, error: `Item ${item.id} has invalid weaponStyle` };
    if (item.toolType !== undefined && !TOOL_TYPES.has(String(item.toolType))) return { ok: false, error: `Item ${item.id} has invalid toolType` };
    if (item.headRenderMode !== undefined && !HEAD_RENDER_MODE_SET.has(String(item.headRenderMode))) return { ok: false, error: `Item ${item.id} has invalid headRenderMode` };
    if (item.bodyTypeModels !== undefined) {
      if (!item.bodyTypeModels || typeof item.bodyTypeModels !== 'object' || Array.isArray(item.bodyTypeModels)) {
        return { ok: false, error: `Item ${item.id} has invalid bodyTypeModels` };
      }
      for (const [bodyType, model] of Object.entries(item.bodyTypeModels as Record<string, unknown>)) {
        if (!/^\d+$/.test(bodyType) || typeof model !== 'string' || model.trim().length === 0) {
          return { ok: false, error: `Item ${item.id} has invalid bodyTypeModels.${bodyType}` };
        }
      }
    }
    if (item.stackModels !== undefined) {
      if (!Array.isArray(item.stackModels)) return { ok: false, error: `Item ${item.id} has invalid stackModels` };
      for (const [index, variant] of item.stackModels.entries()) {
        if (!variant || typeof variant !== 'object') return { ok: false, error: `Item ${item.id} has invalid stackModels.${index}` };
        const stackVariant = variant as Record<string, unknown>;
        if (!Number.isInteger(stackVariant.minQuantity) || (stackVariant.minQuantity as number) <= 0) {
          return { ok: false, error: `Item ${item.id} has invalid stackModels.${index}.minQuantity` };
        }
        if (typeof stackVariant.model !== 'string' || stackVariant.model.trim().length === 0) {
          return { ok: false, error: `Item ${item.id} has invalid stackModels.${index}.model` };
        }
        if (stackVariant.scale !== undefined && (typeof stackVariant.scale !== 'number' || !Number.isFinite(stackVariant.scale) || stackVariant.scale <= 0)) {
          return { ok: false, error: `Item ${item.id} has invalid stackModels.${index}.scale` };
        }
      }
    }
    for (const field of finiteNumberFields) {
      const value = item[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        return { ok: false, error: `Item ${item.id} has invalid ${field}` };
      }
    }
  }
  return { ok: true, items: items as ItemDef[] };
}

// --- Backup helper ---

/** Copy the current map dir into server/data/backups/maps/{mapId}/{timestamp}
 *  and prune to maxKeep snapshots. Any error is logged and swallowed.
 *  Async so it doesn't pin the libuv thread pool during editor saves. */
const mapBackupQueues = new Map<string, Promise<void>>();

function mapIdFromMapDir(mapDir: string): string {
  const mapParts = mapDir.split(/[\\/]/).filter(Boolean);
  return mapParts[mapParts.length - 1] ?? 'unknown-map';
}

async function createMapBackup(mapDir: string, maxKeep: number = 20): Promise<void> {
  try {
    const mapId = mapIdFromMapDir(mapDir);
    const backupsRoot = resolve(DATA_DIR, 'backups', 'maps', mapId);
    await fsp.mkdir(backupsRoot, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = resolve(backupsRoot, ts);

    const entries = await fsp.readdir(mapDir);
    for (const entry of entries) {
      if (entry === 'backups' || /^backup(?:[.\-_].*)?\.json$/i.test(entry)) continue;
      await fsp.cp(resolve(mapDir, entry), resolve(dest, entry), { recursive: true });
    }

    // Rotate: keep the N newest snapshots. Everything under backups/ is a
    // timestamped snapshot directory by construction, so we can sort the
    // readdir output directly without per-entry stat() calls.
    const snapshots = (await fsp.readdir(backupsRoot))
      .filter((n) => n !== '.' && n !== '..')
      .sort(); // ISO timestamps sort lexicographically oldest-first
    const toDelete = snapshots.slice(0, Math.max(0, snapshots.length - maxKeep));
    await Promise.all(toDelete.map((n) =>
      fsp.rm(resolve(backupsRoot, n), { recursive: true, force: true }).catch(() => {}),
    ));
  } catch (err) {
    console.warn('[save-map] backup failed:', (err as Error)?.message);
  }
}

function queueMapBackup(mapDir: string, maxKeep: number = 20): Promise<void> {
  const mapId = mapIdFromMapDir(mapDir);
  const previous = mapBackupQueues.get(mapId) ?? Promise.resolve();
  let queued: Promise<void>;
  queued = previous
    .catch(() => {})
    .then(() => createMapBackup(mapDir, maxKeep))
    .finally(() => {
      if (mapBackupQueues.get(mapId) === queued) mapBackupQueues.delete(mapId);
    });
  mapBackupQueues.set(mapId, queued);
  return queued;
}

// --- Chunked tile/height storage helpers ---

const EDITOR_CHUNK_SIZE = 64;

/** Default tile values for stripping unchanged fields */
const TILE_DEFAULTS: Record<string, any> = {
  ground: 'grass',
  groundB: null,
  split: 'forward',
  textureId: null,
  textureRotation: 0,
  textureScale: 1,
  textureWorldUV: false,
  textureHalfMode: false,
  textureIdB: null,
  textureRotationB: 0,
  textureScaleB: 1,
  textureCutAngle: DEFAULT_CUT_ANGLE,
  textureCutOffset: 0,
  waterPainted: false,
  waterSurface: false,
};

/** Strip default fields from a tile, returning only non-default values */
function stripTileDefaults(tile: KCTile): Partial<KCTile> | null {
  const stripped: Partial<KCTile> = {};
  let hasNonDefault = false;
  for (const key of Object.keys(TILE_DEFAULTS) as (keyof KCTile)[]) {
    if (tile[key] !== TILE_DEFAULTS[key]) {
      (stripped as Record<string, unknown>)[key] = tile[key];
      hasNonDefault = true;
    }
  }
  return hasNonDefault ? stripped : null;
}

/** Expand a partial tile back to a full KCTile */
function expandTile(partial: Partial<KCTile>): KCTile {
  return { ...defaultKCTile(), ...partial };
}

/** Save tiles as per-chunk JSON files */
async function saveChunkedTiles(mapDir: string, tiles: KCTile[][], width: number, height: number): Promise<void> {
  const tilesDir = resolve(mapDir, 'tiles');
  await fsp.mkdir(tilesDir, { recursive: true });

  const chunksX = Math.ceil(width / EDITOR_CHUNK_SIZE);
  const chunksZ = Math.ceil(height / EDITOR_CHUNK_SIZE);
  const written = new Set<string>();
  const writes: Promise<void>[] = [];

  for (let cz = 0; cz < chunksZ; cz++) {
    for (let cx = 0; cx < chunksX; cx++) {
      const chunkData: Record<string, Partial<KCTile>> = {};
      const startZ = cz * EDITOR_CHUNK_SIZE;
      const startX = cx * EDITOR_CHUNK_SIZE;
      const endZ = Math.min(startZ + EDITOR_CHUNK_SIZE, height);
      const endX = Math.min(startX + EDITOR_CHUNK_SIZE, width);

      for (let z = startZ; z < endZ; z++) {
        for (let x = startX; x < endX; x++) {
          const tile = tiles[z]?.[x];
          if (!tile) continue;
          const stripped = stripTileDefaults(tile);
          if (stripped) {
            const localZ = z - startZ;
            const localX = x - startX;
            chunkData[`${localZ},${localX}`] = stripped;
          }
        }
      }

      if (Object.keys(chunkData).length > 0) {
        const filename = `chunk_${cx}_${cz}.json`;
        writes.push(fsp.writeFile(resolve(tilesDir, filename), JSON.stringify(chunkData)));
        written.add(filename);
      }
    }
  }
  await Promise.all(writes);

  // Partial-payload guard: if the editor sent a tiles array with zero
  // non-default tiles across the entire map, treat it as an empty payload
  // and preserve existing chunk files instead of deleting them.
  if (written.size === 0) return;

  try {
    const files = await fsp.readdir(tilesDir);
    await Promise.all(files.map(async (file) => {
      if (file.startsWith('chunk_') && file.endsWith('.json') && !written.has(file)) {
        await fsp.rm(resolve(tilesDir, file));
      }
    }));
  } catch { /* dir may not exist yet */ }
}

/** Save heights as per-chunk JSON files (vertex grid: 65x65 per chunk including shared boundaries) */
async function saveChunkedHeights(mapDir: string, heights: number[][], width: number, height: number): Promise<void> {
  const heightsDir = resolve(mapDir, 'heights');
  await fsp.mkdir(heightsDir, { recursive: true });

  const chunksX = Math.ceil(width / EDITOR_CHUNK_SIZE);
  const chunksZ = Math.ceil(height / EDITOR_CHUNK_SIZE);
  const written = new Set<string>();
  const writes: Promise<void>[] = [];

  for (let cz = 0; cz < chunksZ; cz++) {
    for (let cx = 0; cx < chunksX; cx++) {
      const chunkData: Record<string, number> = {};
      const startZ = cz * EDITOR_CHUNK_SIZE;
      const startX = cx * EDITOR_CHUNK_SIZE;
      const endZ = Math.min(startZ + EDITOR_CHUNK_SIZE + 1, height + 1);
      const endX = Math.min(startX + EDITOR_CHUNK_SIZE + 1, width + 1);

      for (let z = startZ; z < endZ; z++) {
        for (let x = startX; x < endX; x++) {
          const val = heights[z]?.[x] ?? 0;
          if (val !== 0) {
            const localZ = z - startZ;
            const localX = x - startX;
            chunkData[`${localZ},${localX}`] = val;
          }
        }
      }

      if (Object.keys(chunkData).length > 0) {
        const filename = `chunk_${cx}_${cz}.json`;
        writes.push(fsp.writeFile(resolve(heightsDir, filename), JSON.stringify(chunkData)));
        written.add(filename);
      }
    }
  }
  await Promise.all(writes);

  // Partial-payload guard: zero non-zero vertices across the whole map almost
  // always means a bad payload, not a deliberate flatten. Preserve existing
  // chunk files; for a real flatten, delete heights/ manually.
  if (written.size === 0) return;

  try {
    const files = await fsp.readdir(heightsDir);
    await Promise.all(files.map(async (file) => {
      if (file.startsWith('chunk_') && file.endsWith('.json') && !written.has(file)) {
        await fsp.rm(resolve(heightsDir, file));
      }
    }));
  } catch { /* dir may not exist yet */ }
}

/** Load tiles from per-chunk files. Returns null if tiles/ dir doesn't exist (fall back to map.json). */
function loadChunkedTiles(mapDir: string, width: number, height: number): KCTile[][] | null {
  const tilesDir = resolve(mapDir, 'tiles');
  if (!existsSync(tilesDir)) return null;

  // Initialize full array with defaults
  const tiles: KCTile[][] = [];
  for (let z = 0; z < height; z++) {
    const row: KCTile[] = [];
    for (let x = 0; x < width; x++) {
      row.push(defaultKCTile());
    }
    tiles.push(row);
  }

  try {
    for (const file of readdirSync(tilesDir)) {
      if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
      // Parse chunk coordinates from filename: chunk_cx_cz.json
      const match = file.match(/^chunk_(\d+)_(\d+)\.json$/);
      if (!match) continue;
      const cx = parseInt(match[1]);
      const cz = parseInt(match[2]);
      const startX = cx * EDITOR_CHUNK_SIZE;
      const startZ = cz * EDITOR_CHUNK_SIZE;

      const chunkData: Record<string, Partial<KCTile>> = JSON.parse(
        readFileSync(resolve(tilesDir, file), 'utf-8')
      );

      for (const [key, partial] of Object.entries(chunkData)) {
        const [localZStr, localXStr] = key.split(',');
        const z = startZ + parseInt(localZStr);
        const x = startX + parseInt(localXStr);
        if (z >= 0 && z < height && x >= 0 && x < width) {
          tiles[z][x] = expandTile(partial);
        }
      }
    }
  } catch { return null; }

  return tiles;
}

/** Load heights from per-chunk files. Returns null if heights/ dir doesn't exist (fall back to map.json). */
function loadChunkedHeights(mapDir: string, width: number, height: number): number[][] | null {
  const heightsDir = resolve(mapDir, 'heights');
  if (!existsSync(heightsDir)) return null;

  // Initialize full array with zeros (vertex grid is width+1 x height+1)
  const heights: number[][] = [];
  for (let z = 0; z <= height; z++) {
    const row: number[] = new Array(width + 1).fill(0);
    heights.push(row);
  }

  try {
    for (const file of readdirSync(heightsDir)) {
      if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
      const match = file.match(/^chunk_(\d+)_(\d+)\.json$/);
      if (!match) continue;
      const cx = parseInt(match[1]);
      const cz = parseInt(match[2]);
      const startX = cx * EDITOR_CHUNK_SIZE;
      const startZ = cz * EDITOR_CHUNK_SIZE;

      const chunkData: Record<string, number> = JSON.parse(
        readFileSync(resolve(heightsDir, file), 'utf-8')
      );

      for (const [key, val] of Object.entries(chunkData)) {
        const [localZStr, localXStr] = key.split(',');
        const z = startZ + parseInt(localZStr);
        const x = startX + parseInt(localXStr);
        if (z >= 0 && z <= height && x >= 0 && x <= width) {
          heights[z][x] = val;
        }
      }
    }
  } catch { return null; }

  return heights;
}

/** Reassemble tiles and heights from chunk files into a KCMapFile (mutates in place) */
function reassembleChunkedMapData(mapDir: string, mapFile: KCMapFile): void {
  const w = mapFile.map.width;
  const h = mapFile.map.height;
  const chunkedTiles = loadChunkedTiles(mapDir, w, h);
  if (chunkedTiles) mapFile.map.tiles = chunkedTiles;
  const chunkedHeights = loadChunkedHeights(mapDir, w, h);
  if (chunkedHeights) mapFile.map.heights = chunkedHeights;
}

type WorldMapTileCode = 'g' | 'd' | 'p' | 's' | 'r' | 'w' | 'm' | 'u';
type WorldMapObjectKind = 'building' | 'wall' | 'vegetation' | 'resource' | 'interactive' | 'decor';

const WORLD_MAP_SOURCE_MAP_ID = 'kcmap';
const WORLD_MAP_PUBLIC_MAP_ID = 'world-map';

interface PublicWorldMap {
  id: string;
  sourceMapId: string;
  name: string;
  width: number;
  height: number;
  chunkSize: number;
  waterLevel: number;
  spawnPoint: { x: number; z: number } | null;
  tileRows: string[];
  tileCounts: Record<WorldMapTileCode, number>;
  objects: PublicWorldMapObject[];
  walls: PublicWorldMapWall[];
  objectCount: number;
  wallCount: number;
  buildingCount: number;
  npcSpawns: PublicWorldMapNpcSpawn[];
  updatedAt: number;
}

interface PublicWorldMapNpcSpawn {
  x: number;
  z: number;
  floor: number;
  npcId: number;
  name: string;
}

interface PublicWorldMapSnapshot {
  ok: true;
  generatedAt: number;
  map: PublicWorldMap;
}

interface PublicWorldMapObject {
  x: number;
  z: number;
  y: number;
  rotationY: number;
  assetId: string;
  kind: WorldMapObjectKind;
  size: number;
}

interface PublicWorldMapWall {
  x: number;
  z: number;
  floor: number;
  edges: number;
}

let worldMapSnapshotCache: PublicWorldMapSnapshot | null = null;

function invalidateWorldMapSnapshotCache(): void {
  worldMapSnapshotCache = null;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function maxMtimeSeconds(paths: string[]): number {
  let max = 0;
  for (const path of paths) {
    try {
      const stat = statSync(path);
      max = Math.max(max, Math.floor(stat.mtimeMs / 1000));
      if (stat.isDirectory()) {
        for (const child of readdirSync(path)) {
          max = Math.max(max, maxMtimeSeconds([resolve(path, child)]));
        }
      }
    } catch {
      // A chunk can disappear while the editor is saving; the next request
      // will see the settled filesystem state.
    }
  }
  return max;
}

function getHeightAt(heights: number[][] | null, x: number, z: number): number {
  return heights?.[z]?.[x] ?? 0;
}

function visualTileCode(tile: KCTile, heights: number[][] | null, x: number, z: number, waterLevel: number): WorldMapTileCode {
  const tileType = classifyTileType(
    tile,
    {
      tl: getHeightAt(heights, x, z),
      tr: getHeightAt(heights, x + 1, z),
      bl: getHeightAt(heights, x, z + 1),
      br: getHeightAt(heights, x + 1, z + 1),
    },
    waterLevel,
  );

  if (tileType === TileType.WATER) return 'w';
  if (tileType === TileType.MUD) return 'm';
  if (tile.ground === 'path' || tile.ground === 'road') return 'p';
  if (tileType === TileType.SAND) return 's';
  if (tileType === TileType.STONE || tile.ground === 'dungeon-floor' || tile.ground === 'dungeon-rock') return 'r';
  if (tileType === TileType.DIRT) return 'd';
  if (tileType === TileType.WALL) return 'u';
  return 'g';
}

function makeTileRows(mapFile: KCMapFile, mapDir: string, width: number, height: number, waterLevel: number): {
  rows: string[];
  counts: Record<WorldMapTileCode, number>;
} {
  const tiles = loadChunkedTiles(mapDir, width, height) ?? mapFile.map.tiles ?? [];
  const heights = loadChunkedHeights(mapDir, width, height) ?? mapFile.map.heights ?? null;
  const counts: Record<WorldMapTileCode, number> = { g: 0, d: 0, p: 0, s: 0, r: 0, w: 0, m: 0, u: 0 };
  const rows: string[] = [];

  for (let z = 0; z < height; z++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      const code = visualTileCode(tiles[z]?.[x] ?? defaultKCTile(), heights, x, z, waterLevel);
      counts[code]++;
      row += code;
    }
    rows.push(row);
  }

  return { rows, counts };
}

function publicMapNumber(value: number): number {
  return Number(value.toFixed(2));
}

function parseWorldMapTileKey(key: string): { x: number; z: number } | null {
  const [xRaw, zRaw] = key.split(',');
  const x = Number(xRaw);
  const z = Number(zRaw);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}

function classifyWorldMapObject(obj: PlacedObject, world: World): WorldMapObjectKind {
  const lower = obj.assetId.toLowerCase();
  if (
    lower.includes('roof')
    || lower.includes('slab')
    || lower.includes('stair')
    || lower.includes('ladder')
    || lower.includes('tile roofing')
  ) return 'building';
  if (lower.includes('wall') || lower.includes('fence') || lower.includes('pole') || lower.includes('door')) return 'wall';
  if (
    lower.includes('tree')
    || lower.includes('bush')
    || lower.includes('grass')
    || lower.includes('plant')
    || lower.includes('wheat')
    || lower.includes('rice')
  ) return 'vegetation';

  const defId = ASSET_TO_OBJECT_DEF[obj.assetId];
  const category = defId ? world.data.getObject(defId)?.category : undefined;
  if (category === 'tree' || category === 'crop') return 'vegetation';
  if (category === 'rock') return 'resource';
  if (category === 'door' || category === 'ladder' || category === 'scenery') return 'building';
  if (category) return 'interactive';
  if (lower.includes('rock') || lower.includes('ore')) return 'resource';
  return 'decor';
}

function buildWorldMapObjects(mapDir: string, mapFile: KCMapFile, world: World): PublicWorldMapObject[] {
  const objects = loadChunkedObjects(mapDir) ?? mapFile.placedObjects ?? [];
  return objects
    .filter((obj) => Number.isFinite(obj.position?.x) && Number.isFinite(obj.position?.z))
    .map((obj) => {
      const sx = Number.isFinite(obj.scale?.x) ? Math.abs(obj.scale.x) : 1;
      const sz = Number.isFinite(obj.scale?.z) ? Math.abs(obj.scale.z) : 1;
      return {
        x: publicMapNumber(obj.position.x),
        z: publicMapNumber(obj.position.z),
        y: publicMapNumber(Number.isFinite(obj.position.y) ? obj.position.y : 0),
        rotationY: publicMapNumber(Number.isFinite(obj.rotation?.y) ? obj.rotation.y : 0),
        assetId: (obj.assetId || 'Unknown').slice(0, 48),
        kind: classifyWorldMapObject(obj, world),
        size: publicMapNumber(clampNumber(Math.max(sx, sz, 0.5), 0.5, 4)),
      };
    })
    .sort((a, b) => a.z - b.z || a.x - b.x || a.assetId.localeCompare(b.assetId));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function addWorldMapWallsFromLayer(target: PublicWorldMapWall[], layer: Partial<FloorLayerData> | null | undefined, floor: number): void {
  if (!layer?.walls) return;
  for (const [key, rawEdges] of Object.entries(layer.walls)) {
    const coords = parseWorldMapTileKey(key);
    const edges = Number(rawEdges);
    if (!coords || !Number.isFinite(edges) || edges <= 0) continue;
    target.push({ x: coords.x, z: coords.z, floor, edges: Math.floor(edges) & 15 });
  }
}

function buildWorldMapWalls(mapDir: string): PublicWorldMapWall[] {
  const wallsFile = readJsonFile<WallsFile>(resolve(mapDir, 'walls.json'));
  if (!wallsFile) return [];

  const walls: PublicWorldMapWall[] = [];
  addWorldMapWallsFromLayer(walls, wallsFile, 0);
  for (const [floorRaw, layer] of Object.entries(wallsFile.floorLayers ?? {})) {
    const floor = Number(floorRaw);
    if (!Number.isFinite(floor)) continue;
    addWorldMapWallsFromLayer(walls, layer, floor);
  }
  return walls.sort((a, b) => a.floor - b.floor || a.z - b.z || a.x - b.x);
}

function countWallEdges(walls: PublicWorldMapWall[]): number {
  let count = 0;
  for (const wall of walls) {
    if (wall.edges & 1) count++;
    if (wall.edges & 2) count++;
    if (wall.edges & 4) count++;
    if (wall.edges & 8) count++;
  }
  return count;
}

function buildWorldMapNpcSpawns(world: World): PublicWorldMapNpcSpawn[] {
  const spawns = world.data.loadSpawns(WORLD_MAP_SOURCE_MAP_ID);
  return (spawns.npcs ?? [])
    .filter((spawn) => Number.isFinite(spawn.x) && Number.isFinite(spawn.z))
    .map((spawn) => ({
      x: publicMapNumber(spawn.x),
      z: publicMapNumber(spawn.z),
      floor: Math.floor(Number.isFinite(spawn.floor) ? Number(spawn.floor) : 0),
      npcId: spawn.npcId,
      name: (spawn.name || world.data.getNpc(spawn.npcId)?.name || 'NPC').slice(0, 48),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.z - b.z || a.x - b.x);
}

function buildWorldMapSnapshot(world: World): PublicWorldMapSnapshot {
  const mapDir = resolve(MAPS_DIR, WORLD_MAP_SOURCE_MAP_ID);
  const mapFile = readJsonFile<KCMapFile>(resolve(mapDir, 'map.json'));
  if (!mapFile?.map) throw new Error('World Map data is unavailable');

  const meta = readJsonFile<MapMeta>(resolve(mapDir, 'meta.json'));
  const width = Math.max(1, Math.floor(Number(mapFile.map.width ?? meta?.width ?? 1)));
  const height = Math.max(1, Math.floor(Number(mapFile.map.height ?? meta?.height ?? 1)));
  const waterLevel = Number.isFinite(Number(mapFile.map.waterLevel))
    ? Number(mapFile.map.waterLevel)
    : Number(meta?.waterLevel ?? 0);
  const { rows, counts } = makeTileRows(mapFile, mapDir, width, height, waterLevel);
  const objects = buildWorldMapObjects(mapDir, mapFile, world);
  const walls = buildWorldMapWalls(mapDir);
  const npcSpawns = buildWorldMapNpcSpawns(world);
  const buildingCount = objects.filter((obj) => obj.kind === 'building' || obj.kind === 'wall').length;

  return {
    ok: true,
    generatedAt: Math.floor(Date.now() / 1000),
    map: {
      id: WORLD_MAP_PUBLIC_MAP_ID,
      sourceMapId: WORLD_MAP_SOURCE_MAP_ID,
      name: 'World Map',
      width,
      height,
      chunkSize: CHUNK_SIZE,
      waterLevel,
      spawnPoint: meta?.spawnPoint ?? null,
      tileRows: rows,
      tileCounts: counts,
      objects,
      walls,
      objectCount: objects.length,
      wallCount: countWallEdges(walls),
      buildingCount,
      npcSpawns,
      updatedAt: maxMtimeSeconds([
        resolve(mapDir, 'meta.json'),
        resolve(mapDir, 'map.json'),
        resolve(mapDir, 'tiles'),
        resolve(mapDir, 'heights'),
        resolve(mapDir, 'objects'),
        resolve(mapDir, 'walls.json'),
        resolve(mapDir, 'spawns.json'),
      ]),
    },
  };
}

function getWorldMapSnapshot(world: World): PublicWorldMapSnapshot {
  if (!worldMapSnapshotCache) {
    worldMapSnapshotCache = buildWorldMapSnapshot(world);
  }
  return worldMapSnapshotCache;
}
import { GameDatabase } from './Database';
import { flushAuditSync } from './Audit';
import {
  handleGameSocketOpen,
  handleGameSocketMessage,
  handleGameSocketClose,
  type GameSocketData,
} from './network/GameSocket';
import {
  handleChatSocketOpen,
  handleChatSocketMessage,
  handleChatSocketClose,
  type ChatSocketData,
} from './network/ChatSocket';

const CLIENT_DIST = resolve(import.meta.dir, '../../client/dist');
const WEBSITE_DIST = resolve(import.meta.dir, '../../website/dist');
const MAPS_DIR = resolve(import.meta.dir, '../data/maps');
const DATA_DIR = resolve(import.meta.dir, '../data');

/** Resolve `child` against `base` and verify the *real* path (symlinks
 *  followed) still lives under `base`. Without realpath, an attacker who
 *  could create a symlink inside `base` pointing elsewhere would defeat the
 *  startsWith check — resolve() handles `..` but doesn't follow links.
 *  Returns the canonical path if safe, null if out-of-bounds or missing. */
function resolveWithinBase(base: string, child: string): string | null {
  const candidate = resolve(base, child);
  try {
    const real = realpathSync(candidate);
    const realBase = realpathSync(base);
    return real.startsWith(realBase + sep) || real === realBase ? real : null;
  } catch {
    return null;
  }
}

function resolvePossiblyMissingWithinBase(base: string, child: string): string | null {
  const candidate = resolve(base, child);
  const rel = relative(base, candidate);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith(`..${sep}`))) return candidate;
  return null;
}

function isSafeMapId(mapId: unknown): mapId is string {
  return typeof mapId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(mapId);
}

// MIME type lookup
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf('.'));
  return MIME_TYPES[ext] || 'application/octet-stream';
}

interface StaticFileCacheEntry {
  mtimeMs: number;
  size: number;
  content: ArrayBuffer;
}

const staticFileCache = new Map<string, StaticFileCacheEntry>();

function readCachedStaticFile(filePath: string): ArrayBuffer {
  const stat = statSync(filePath);
  const cached = staticFileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.content;
  }
  const raw = readFileSync(filePath);
  const content = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  staticFileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
  return content;
}

function isGameRoute(pathname: string): boolean {
  const decoded = decodeURIComponent(pathname);
  const normalized = decoded !== '/' && decoded.endsWith('/') ? decoded.slice(0, -1) : decoded;
  return normalized === '/play' || normalized.startsWith('/play/');
}

function shouldServeWebsiteNotFound(req: Request, pathname: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const lastSegment = pathname.split('/').pop() ?? '';
  if (lastSegment.includes('.')) return false;

  const accept = req.headers.get('accept') ?? '';
  return accept.includes('text/html') || accept.includes('*/*') || accept === '';
}

function serveStatic(req: Request, pathname: string, allowIndexFallback = false): Response | null {
  const decoded = decodeURIComponent(pathname);
  let filePath = resolvePossiblyMissingWithinBase(CLIENT_DIST, decoded.startsWith('/') ? decoded.slice(1) : decoded);
  if (!filePath) return null;
  let isIndexFallback = false;

  try {
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      filePath = resolve(filePath, 'index.html');
      isIndexFallback = true;
    }
  } catch {
    if (!allowIndexFallback) return null;
    filePath = resolve(CLIENT_DIST, 'index.html');
    isIndexFallback = true;
  }

  try {
    const content = readCachedStaticFile(filePath);
    // index.html must never be cached so deploys are picked up immediately.
    // Vite-hashed JS/CSS chunks under /assets/ are content-addressed and
    // safe to cache long. All other static GLBs/PNGs use a moderate cache
    // so reloads don't repeatedly re-download multi-MB character models.
    let cacheControl = 'public, max-age=3600';
    if (isIndexFallback || filePath.endsWith('.html')) {
      cacheControl = 'no-cache';
    } else if (decoded.startsWith('/assets/') && (filePath.endsWith('.js') || filePath.endsWith('.css'))) {
      cacheControl = 'public, max-age=31536000, immutable';
    }
    const headers: Record<string, string> = {
      'Content-Type': getMimeType(filePath),
      'Cache-Control': cacheControl,
    };
    const preauthCookie = (isIndexFallback || filePath.endsWith('.html')) ? maybeIssuePreauthBootstrap(req) : undefined;
    if (preauthCookie) headers['Set-Cookie'] = preauthCookie;
    return new Response(content, { headers });
  } catch {
    return null;
  }
}

function serveWebsiteNotFound(): Response {
  const candidates = ['404.html', '_not-found.html'];
  for (const candidate of candidates) {
    const filePath = resolveWithinBase(WEBSITE_DIST, candidate);
    if (!filePath) continue;
    try {
      return new Response(readCachedStaticFile(filePath), {
        status: 404,
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      // Try the next exported not-found page.
    }
  }

  return new Response('Not Found', { status: 404 });
}

function serveWebsite(req: Request, pathname: string): Response | null {
  const decoded = decodeURIComponent(pathname);
  const normalized = decoded !== '/' && decoded.endsWith('/') ? decoded.slice(0, -1) : decoded;
  if (
    normalized !== '/'
    && normalized !== '/hiscores'
    && normalized !== '/world-map'
    && normalized !== '/news'
    && !normalized.startsWith('/news/')
    && !normalized.startsWith('/_next/')
  ) {
    return null;
  }

  const routePath = normalized === '/' ? 'index' : normalized.slice(1);
  const candidates = normalized.startsWith('/_next/')
    ? [routePath]
    : [`${routePath}.html`, routePath, `${routePath}/index.html`];

  let filePath: string | null = null;
  let isHtml = false;

  for (const candidate of candidates) {
    const resolved = resolvePossiblyMissingWithinBase(WEBSITE_DIST, candidate);
    if (!resolved) continue;
    try {
      const stat = statSync(resolved);
      filePath = stat.isDirectory() ? resolve(resolved, 'index.html') : resolved;
      break;
    } catch {
      // Try the next static export shape.
    }
  }

  if (!filePath) return null;

  try {
    const content = readCachedStaticFile(filePath);
    isHtml = filePath.endsWith('.html');
    const headers: Record<string, string> = {
      'Content-Type': getMimeType(filePath),
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    };
    const preauthCookie = isHtml ? maybeIssuePreauthBootstrap(req) : undefined;
    if (preauthCookie) headers['Set-Cookie'] = preauthCookie;
    return new Response(content, { headers });
  } catch {
    return null;
  }
}

function jsonResponse(data: any, status: number = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// --- Auth rate limiting ---
// Bun.serve runs in one process, so an in-memory map is sufficient. If we ever
// shard, this needs to move behind a shared store (Redis). Mirrors 2004scape
// LoginServer.ts:231-249 — login limit per (account, IP), signup limit per IP.
// Production sits behind Caddy, so use forwarded client IPs when the direct
// peer is loopback. Otherwise every signup appears to come from 127.0.0.1.

interface RateBucket { count: number; resetAt: number; }
const loginAttempts = new Map<string, RateBucket>();
const signupAttempts = new Map<string, RateBucket>();
const deviceIdAttempts = new Map<string, RateBucket>();
const preauthBootstraps = new Map<string, number>();
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;
const SIGNUP_LIMIT = 20;
const SIGNUP_WINDOW_MS = 10 * 60_000;
const DEVICE_ID_LIMIT = 20;
const DEVICE_ID_WINDOW_MS = 10 * 60_000;
const ACCOUNT_CREATION_CLOSED_MESSAGE = 'We have decided to close for new accounts until the Alpha launch. Join our Discord for more info.';
const PUBLIC_SIGNUPS_ENABLED = Bun.env.PUBLIC_SIGNUPS_ENABLED !== '0';
const DEVICE_COOKIE = 'eq_device_id';
const WS_SESSION_COOKIE = 'eq_ws_session';
const PREAUTH_BOOTSTRAP_COOKIE = 'eq_preauth';
const WS_SESSION_COOKIE_MAX_AGE = 24 * 60 * 60;
const PREAUTH_BOOTSTRAP_MIN_AGE_MS = (() => {
  const raw = Number.parseInt(Bun.env.PREAUTH_BOOTSTRAP_MIN_MS || '', 10);
  return Number.isFinite(raw) && raw >= 0 && raw <= 10_000 ? raw : 1200;
})();
const PREAUTH_BOOTSTRAP_MAX_AGE_MS = 30 * 60_000;
const FALLBACK_LOGIN_REQUESTED = Bun.env.FALLBACK_LOGIN_ENABLED === '1';
const FALLBACK_LOGIN_USERNAME = Bun.env.FALLBACK_LOGIN_USERNAME || '';
const FALLBACK_LOGIN_PASSWORD = Bun.env.FALLBACK_LOGIN_PASSWORD || '';
if (isProductionLike() && FALLBACK_LOGIN_REQUESTED) {
  throw new Error('[auth] FALLBACK_LOGIN_ENABLED is forbidden in production');
}
const FALLBACK_LOGIN_ENABLED = FALLBACK_LOGIN_REQUESTED
  && !isProductionLike()
  && FALLBACK_LOGIN_USERNAME.length > 0
  && FALLBACK_LOGIN_PASSWORD.length > 0;
if (FALLBACK_LOGIN_REQUESTED && !FALLBACK_LOGIN_ENABLED && !isProductionLike()) {
  console.warn('[auth] FALLBACK_LOGIN_ENABLED=1 but FALLBACK_LOGIN_USERNAME/PASSWORD are missing; fallback login disabled');
}

// reCAPTCHA v3 verification. Local dev may run without Google keys; production
// fails closed so auth cannot silently launch without the bot gate.
const RECAPTCHA_SECRET = Bun.env.RECAPTCHA_SECRET || '';
const RECAPTCHA_MIN_SCORE = (() => {
  const raw = Number.parseFloat(Bun.env.RECAPTCHA_MIN_SCORE || '');
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
})();
const RECAPTCHA_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const RECAPTCHA_TIMEOUT_MS = 5000;
if (!RECAPTCHA_SECRET && isProductionLike()) {
  throw new Error('[auth] RECAPTCHA_SECRET is required in production');
}
if (!RECAPTCHA_SECRET) {
  console.warn('[auth] RECAPTCHA_SECRET unset — reCAPTCHA v3 verification disabled');
}

interface RecaptchaResult {
  ok: boolean;
  /** Surface to the client. Generic on purpose so we don't leak why. */
  error?: string;
  /** Telemetry only — never returned to the client. */
  score?: number;
  action?: string;
}

async function verifyRecaptchaToken(token: string | undefined, expectedAction: string, ip: string): Promise<RecaptchaResult> {
  if (!RECAPTCHA_SECRET) return { ok: true };
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Captcha verification required. Please refresh and try again.' };
  }
  const body = new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token });
  if (ip) body.set('remoteip', ip);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECAPTCHA_TIMEOUT_MS);
  try {
    const res = await fetch(RECAPTCHA_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: 'Captcha verification unavailable. Please try again.' };
    const data = await res.json() as {
      success?: boolean;
      score?: number;
      action?: string;
      'error-codes'?: string[];
    };
    if (!data.success) return { ok: false, error: 'Captcha verification failed. Please refresh and try again.' };
    if (data.action && data.action !== expectedAction) {
      return { ok: false, error: 'Captcha action mismatch. Please refresh and try again.', score: data.score, action: data.action };
    }
    const score = typeof data.score === 'number' ? data.score : 0;
    if (score < RECAPTCHA_MIN_SCORE) {
      return { ok: false, error: 'Captcha score too low. Please try again.', score, action: data.action };
    }
    return { ok: true, score, action: data.action };
  } catch {
    return { ok: false, error: 'Captcha verification unavailable. Please try again.' };
  } finally {
    clearTimeout(timer);
  }
}
// Hard cap on entries so an attacker rotating usernames (or IPs, behind a
// proxy) can't fill the map between sweeps. When the cap is hit, the oldest
// entry is evicted — Map preserves insertion order, so `keys().next()` is O(1).
const RATE_MAP_MAX = 10_000;

function checkRate(map: Map<string, RateBucket>, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  let bucket = map.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    if (map.size >= RATE_MAP_MAX) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= limit;
}

function parseCookie(req: Request, name: string): string {
  return readCookie(req, name);
}

function newDeviceId(): string {
  return crypto.randomUUID();
}

function deviceCookieHeader(deviceId: string, req: Request): string {
  const secure = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
  return `${DEVICE_COOKIE}=${encodeURIComponent(deviceId)}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly${secure ? '; Secure' : ''}`;
}

function wsSessionCookieHeader(secret: string, req: Request): string {
  const secure = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
  return `${WS_SESSION_COOKIE}=${encodeURIComponent(secret)}; Path=/; Max-Age=${WS_SESSION_COOKIE_MAX_AGE}; SameSite=Strict; HttpOnly${secure ? '; Secure' : ''}`;
}

function clearWsSessionCookieHeader(req: Request): string {
  const secure = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
  return `${WS_SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict; HttpOnly${secure ? '; Secure' : ''}`;
}

function preauthBootstrapCookieHeader(id: string, req: Request): string {
  const secure = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
  return `${PREAUTH_BOOTSTRAP_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${Math.floor(PREAUTH_BOOTSTRAP_MAX_AGE_MS / 1000)}; SameSite=Strict; HttpOnly${secure ? '; Secure' : ''}`;
}

function cleanupPreauthBootstraps(now: number = Date.now()): void {
  for (const [id, issuedAt] of preauthBootstraps) {
    if (now - issuedAt > PREAUTH_BOOTSTRAP_MAX_AGE_MS) preauthBootstraps.delete(id);
  }
  while (preauthBootstraps.size > RATE_MAP_MAX) {
    const oldest = preauthBootstraps.keys().next().value;
    if (oldest === undefined) break;
    preauthBootstraps.delete(oldest);
  }
}

function maybeIssuePreauthBootstrap(req: Request): string | undefined {
  if (!isProductionLike()) return undefined;
  const now = Date.now();
  cleanupPreauthBootstraps(now);
  const existing = parseCookie(req, PREAUTH_BOOTSTRAP_COOKIE);
  const issuedAt = existing ? preauthBootstraps.get(existing) : undefined;
  if (issuedAt !== undefined && now - issuedAt <= PREAUTH_BOOTSTRAP_MAX_AGE_MS) return undefined;
  const id = crypto.randomUUID();
  preauthBootstraps.set(id, now);
  return preauthBootstrapCookieHeader(id, req);
}

function validatePreauthBootstrap(req: Request): string | null {
  if (!isProductionLike()) return null;
  const id = parseCookie(req, PREAUTH_BOOTSTRAP_COOKIE);
  if (!id) return 'missing';
  const issuedAt = preauthBootstraps.get(id);
  if (issuedAt === undefined) return 'unknown';
  const age = Date.now() - issuedAt;
  if (age < PREAUTH_BOOTSTRAP_MIN_AGE_MS) return 'too-fast';
  if (age > PREAUTH_BOOTSTRAP_MAX_AGE_MS) {
    preauthBootstraps.delete(id);
    return 'expired';
  }
  return null;
}

function getOrCreateDeviceId(req: Request): { deviceId: string; setCookie?: string } {
  const existing = parseCookie(req, DEVICE_COOKIE);
  if (!validateDeviceId(existing)) return { deviceId: existing };
  const deviceId = newDeviceId();
  return { deviceId, setCookie: deviceCookieHeader(deviceId, req) };
}

function validateSignupDevice(req: Request, rawDeviceId: unknown): { ok: true; deviceId: string } | { ok: false; error: string } {
  if (typeof rawDeviceId !== 'string') return { ok: false, error: 'Missing or invalid device identifier' };
  const deviceId = rawDeviceId.trim();
  const deviceError = validateDeviceId(deviceId);
  if (deviceError) return { ok: false, error: deviceError };
  const cookieDeviceId = parseCookie(req, DEVICE_COOKIE);
  if (cookieDeviceId !== deviceId) {
    return { ok: false, error: 'Missing or invalid device identifier' };
  }
  return { ok: true, deviceId };
}

function validateLoginDevice(req: Request, rawDeviceId: unknown): { ok: true; deviceId: string } | { ok: false; error: string } {
  return validateSignupDevice(req, rawDeviceId);
}

function preauthFailureResponse(req: Request, ip: string, route: string): Response | null {
  const reason = validatePreauthBootstrap(req);
  if (!reason) return null;
  console.warn(`[auth] rejected ${route}: preauth=${reason} ip=${ip} ua=${(req.headers.get('user-agent') || 'unknown').slice(0, 120)}`);
  return jsonResponse({ ok: false, error: 'Please refresh the page and try again.' }, 400);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) if (now > v.resetAt) loginAttempts.delete(k);
  for (const [k, v] of signupAttempts) if (now > v.resetAt) signupAttempts.delete(k);
  for (const [k, v] of deviceIdAttempts) if (now > v.resetAt) deviceIdAttempts.delete(k);
  cleanupPreauthBootstraps(now);
}, 5 * 60_000);

// Create database and game world. Guard this so starting from the wrong
// checkout cannot silently create an empty account DB and hide the admin login.
const DB_PATH = process.env.PROJECTRS_DB_PATH || resolve('projectrs.db');
const REQUIRED_ADMIN_USERNAME = process.env.REQUIRED_ADMIN_USERNAME || 'mogn';
const ALLOW_EMPTY_DEV_DB = process.env.ALLOW_EMPTY_DEV_DB === '1';
console.log(`[db] using ${DB_PATH}`);
const db = new GameDatabase(DB_PATH);
if (!ALLOW_EMPTY_DEV_DB && !db.isAdminUsername(REQUIRED_ADMIN_USERNAME)) {
  db.close();
  throw new Error(
    `[db] Refusing to start: required admin account "${REQUIRED_ADMIN_USERNAME}" was not found in ${DB_PATH}. ` +
    `Set PROJECTRS_DB_PATH to the populated database, restore the DB backup, or set ALLOW_EMPTY_DEV_DB=1 for intentional fresh-db work.`
  );
}
const world = new World(db);
world.start();
try {
  getWorldMapSnapshot(world);
} catch (e) {
  console.warn('[world-map] initial snapshot build failed:', e instanceof Error ? e.message : e);
}

// --- Admin authorization for editor / dev APIs ---
// A request is admin-authorized if:
//   1. It originates from loopback (local dev / SSH-tunneled use), OR
//   2. It carries a valid `Authorization: Bearer <token>` whose session belongs
//      to an account flagged is_admin=1 in the DB.
// NOTE: behind a reverse proxy, requestIP() will report the proxy's address.
// When a reverse proxy lands, switch to a trusted X-Forwarded-For check
// (or terminate TLS in Bun directly). Until then, loopback ≡ same machine.
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isAdminRequest(req: Request, srv: { requestIP: (r: Request) => { address: string } | null }): boolean {
  const ip = srv.requestIP(req)?.address ?? '';
  if (LOOPBACK_IPS.has(ip)) {
    const host = (req.headers.get('host') || '').toLowerCase().split(':')[0];
    const explicitLoopbackAdmin = process.env.ALLOW_LOOPBACK_ADMIN === '1';
    // Behind a reverse proxy the app often sees public traffic as 127.0.0.1.
    // Only treat loopback as admin for actual localhost hosts, or when an
    // operator explicitly opts in for an SSH-tunneled maintenance session.
    if (explicitLoopbackAdmin || host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  }
  const auth = req.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const session = db.getSession(m[1]);
  return !!session && session.isAdmin;
}

function adminForbidden(): Response {
  return jsonResponse({ ok: false, error: 'Forbidden — admin authorization required' }, 403);
}

function parseBanExpiresAt(rawDurationSeconds: unknown): { ok: true; expiresAt: number | null } | { ok: false; error: string } {
  if (rawDurationSeconds === null || rawDurationSeconds === undefined || rawDurationSeconds === 0 || rawDurationSeconds === '0' || rawDurationSeconds === 'permanent') {
    return { ok: true, expiresAt: null };
  }
  const durationSeconds = typeof rawDurationSeconds === 'number'
    ? rawDurationSeconds
    : typeof rawDurationSeconds === 'string'
      ? Number(rawDurationSeconds)
      : NaN;
  if (!Number.isFinite(durationSeconds)) return { ok: false, error: 'Invalid ban duration' };
  const seconds = Math.floor(durationSeconds);
  if (seconds < 60) return { ok: false, error: 'Temporary bans must be at least 1 minute' };
  if (seconds > 366 * 24 * 3600) return { ok: false, error: 'Temporary bans cannot exceed 366 days' };
  return { ok: true, expiresAt: Math.floor(Date.now() / 1000) + seconds };
}

function banLabel(expiresAt: number | null): string {
  return expiresAt === null ? 'permanent' : `until ${new Date(expiresAt * 1000).toISOString()}`;
}

// --- Body size limits ---
// `req.json()` is unbounded by default — without a cap, a single 1 GB POST to
// any endpoint can OOM the process. We pre-check Content-Length and reject
// oversize requests before reading the body. Streaming requests without a
// Content-Length header are rejected outright (we don't accept chunked uploads).
function tooLarge(): Response {
  return jsonResponse({ ok: false, error: 'Payload too large' }, 413);
}

/** Returns true if the request body fits within `maxBytes`. */
function bodyWithinLimit(req: Request, maxBytes: number): boolean {
  const lenHdr = req.headers.get('content-length');
  if (!lenHdr) return false; // require declared length
  const len = Number(lenHdr);
  if (!Number.isFinite(len) || len < 0) return false;
  return len <= maxBytes;
}

const BODY_LIMIT_AUTH = 4 * 1024;          // 4 KB — username + password JSON
const BODY_LIMIT_DEV = 1 * 1024 * 1024;     // 1 MB — gear-overrides config
const BODY_LIMIT_EDITOR = 200 * 1024 * 1024; // 200 MB — full map import / save
const BODY_LIMIT_SPELL_ICON = 512 * 1024;   // 512 KB — one PNG icon
const MAX_SPELL_ICON_DIMENSION = 512;

// REST/API origin allow-list. Missing Origin stays allowed here because normal
// same-origin browser GETs often omit it. WebSocket upgrades use stricter
// browser-origin rules in WsSecurity.ts.
function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  return parseAllowedOrigins(process.env.CLIENT_ORIGINS).has(origin);
}

function isAllowedAuthOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return !isProductionLike();
  return parseAllowedOrigins(process.env.CLIENT_ORIGINS).has(origin);
}

// --- Per-account WS connection cap ---
// Without this, a single authenticated account can open thousands of WebSockets
// (kickAccountIfOnline only handles game sockets — chat sockets accumulate).
// Cap: game socket (1) + chat socket (1) + 2 slack for refresh races = 4.
// Counted at `open` time, decremented at `close`. Refusing here is graceful;
// the client sees a normal close and can reconnect.
const MAX_WS_PER_ACCOUNT = 4;
const wsCountByAccount: Map<number, number> = new Map();

/** Returns false if the cap is exceeded. Caller must close the socket. */
function tryReserveWsSlot(accountId: number): boolean {
  const cur = wsCountByAccount.get(accountId) ?? 0;
  if (cur >= MAX_WS_PER_ACCOUNT) return false;
  wsCountByAccount.set(accountId, cur + 1);
  return true;
}
function releaseWsSlot(accountId: number): void {
  const cur = wsCountByAccount.get(accountId) ?? 0;
  if (cur <= 1) wsCountByAccount.delete(accountId);
  else wsCountByAccount.set(accountId, cur - 1);
}

/** Returns a 403 Response if the (account, ip) is banned, else null. Tokens
 *  persist 24h so a ban issued after token creation must also block the
 *  WS upgrade — checked on every connection (including refreshes). */
function banGateResponse(accountId: number, ip: string): Response | null {
  if (db.isAccountBanned(accountId) || db.isIpBanned(ip)) {
    return new Response('Banned', { status: 403 });
  }
  return null;
}

function getBearerSession(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? db.getSession(m[1]) : null;
}

function getBoundBearerSession(req: Request) {
  const session = getBearerSession(req);
  if (!session) return null;
  if (!hasMatchingCookie(req, WS_SESSION_COOKIE, session.wsSecret)) return null;
  if (session.deviceId && !hasMatchingCookie(req, DEVICE_COOKIE, session.deviceId)) return null;
  return session;
}

function validateDevicePublicKey(raw: unknown): JsonWebKey | null {
  if (!raw || typeof raw !== 'object') return null;
  const key = raw as Record<string, unknown>;
  if (key.kty !== 'EC' || key.crv !== 'P-256') return null;
  if (typeof key.x !== 'string' || typeof key.y !== 'string') return null;
  if (key.x.length < 40 || key.x.length > 100 || key.y.length < 40 || key.y.length > 100) return null;
  if (key.d !== undefined) return null;
  return {
    kty: 'EC',
    crv: 'P-256',
    x: key.x,
    y: key.y,
    ext: typeof key.ext === 'boolean' ? key.ext : true,
    key_ops: Array.isArray(key.key_ops) ? key.key_ops.filter((op): op is string => typeof op === 'string') : undefined,
  };
}

function isGameplayMapDataPath(mapPath: string): boolean {
  return /^[-\w]+\/(?:meta\.json|map\.json|walls\.json|biomes\.json)$/.test(mapPath)
    || /^[-\w]+\/objects\/manifest\.json$/.test(mapPath)
    || /^[-\w]+\/(?:tiles|heights|objects)\/chunk_-?\d+_-?\d+\.json$/.test(mapPath);
}

function isLegacyMapTexturePath(mapPath: string): boolean {
  return /^[-\w]+\/(?:heightmap|tilemap)\.png$/.test(mapPath);
}

function isServableMapPath(mapPath: string): boolean {
  return isGameplayMapDataPath(mapPath) || isLegacyMapTexturePath(mapPath);
}

function isForbiddenMapPath(mapPath: string): boolean {
  const parts = mapPath.split('/');
  const basename = parts[parts.length - 1] ?? '';
  return parts.includes('backups')
    || /^backup(?:[.\-_].*)?\.json$/i.test(basename);
}

function requiresAuthenticatedJsonAsset(pathname: string): boolean {
  return pathname === '/assets/assets.json' || pathname === '/assets/textures/textures.json';
}

function hasForbiddenStaticSourceExtension(pathname: string): boolean {
  return /\.(?:blend\d*|fbx|psd|kra|xcf)$/i.test(pathname);
}

interface HttpMapDataScanWindow {
  startedAt: number;
  lastSeenAt: number;
  requests: number;
  files: Set<string>;
  burstRecorded: boolean;
}

const HTTP_MAP_DATA_SCAN_WINDOW_MS = 60_000;
const HTTP_MAP_DATA_SCAN_UNIQUE_THRESHOLD = 110;
const HTTP_MAP_DATA_SCAN_REQUEST_THRESHOLD = 160;
const HTTP_MAP_DATA_SCAN_MAX_WINDOWS = 2000;
const httpMapDataScanWindows = new Map<string, HttpMapDataScanWindow>();

function sanitizeMapDataAuditPath(mapPath: string): string {
  return mapPath.replace(/[^a-zA-Z0-9_./-]/g, '?').slice(0, 128);
}

function recordHttpMapDataScanWindow(
  session: NonNullable<ReturnType<typeof getBoundBearerSession>>,
  mapPath: string,
  now: number = Date.now(),
): { requests: number; uniqueFiles: number; sampleFiles: string[] } | null {
  const key = `${session.accountId}:${session.deviceId || 'no-device'}`;
  let window = httpMapDataScanWindows.get(key);
  if (!window || now - window.startedAt > HTTP_MAP_DATA_SCAN_WINDOW_MS) {
    window = {
      startedAt: now,
      lastSeenAt: now,
      requests: 0,
      files: new Set(),
      burstRecorded: false,
    };
    if (httpMapDataScanWindows.size >= HTTP_MAP_DATA_SCAN_MAX_WINDOWS) {
      let oldestKey: string | null = null;
      let oldestSeen = Infinity;
      for (const [k, v] of httpMapDataScanWindows) {
        if (v.lastSeenAt < oldestSeen) {
          oldestSeen = v.lastSeenAt;
          oldestKey = k;
        }
      }
      if (oldestKey) httpMapDataScanWindows.delete(oldestKey);
    }
    httpMapDataScanWindows.set(key, window);
  }
  window.lastSeenAt = now;
  window.requests++;
  window.files.add(sanitizeMapDataAuditPath(mapPath));
  if (
    !window.burstRecorded
    && (
      window.files.size >= HTTP_MAP_DATA_SCAN_UNIQUE_THRESHOLD
      || window.requests >= HTTP_MAP_DATA_SCAN_REQUEST_THRESHOLD
    )
  ) {
    window.burstRecorded = true;
    return {
      requests: window.requests,
      uniqueFiles: window.files.size,
      sampleFiles: [...window.files].slice(0, 12),
    };
  }
  return null;
}

function recordGameplayMapDataFetch(
  session: NonNullable<ReturnType<typeof getBoundBearerSession>>,
  mapPath: string,
  req: Request,
  server: { requestIP(req: Request): { address: string } | null },
): void {
  const player = world.getActivePlayerByAccountId(session.accountId);
  const burst = player?.botStats?.recordMapDataFetch(mapPath)
    ?? recordHttpMapDataScanWindow(session, mapPath);
  if (!burst) return;
  audit({
    type: 'map_data.scan',
    tick: world.getCurrentTick(),
    accountId: session.accountId,
    details: {
      mapPath,
      mode: player ? 'active-session' : 'pre-session',
      ip: requestClientIp(req, server),
      requests: burst.requests,
      uniqueFiles: burst.uniqueFiles,
      sampleFiles: burst.sampleFiles,
    },
  });
}

// Clean expired sessions every 10 minutes
setInterval(() => db.cleanExpiredSessions(), 10 * 60 * 1000);

// Save all players on graceful shutdown so a server restart (SIGTERM from
// `bun --watch`, deploy, or operator Ctrl-C) doesn't lose the last 15 s of
// progress between auto-save ticks. World.stop() flushes one final save
// before clearing the tick/save timers.
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] received ${signal} — saving state and exiting`);
  try { world.stop(); } catch (e) { console.error('[shutdown] world.stop() failed:', e); }
  // Drain any in-memory audit events synchronously so we don't lose the last
  // ~1s of forensic log on restart.
  try { flushAuditSync(); } catch (e) { console.error('[shutdown] flushAuditSync() failed:', e); }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

type SocketData = GameSocketData | ChatSocketData;

const server = Bun.serve<SocketData>({
  port: SERVER_PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/favicon.ico' && (req.method === 'GET' || req.method === 'HEAD')) {
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'public, max-age=86400' },
      });
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      return jsonResponse({ onlinePlayers: world.getOnlinePlayerCount() });
    }

    if (url.pathname === '/api/device-id' && req.method === 'GET') {
      if (!isAllowedOrigin(req)) return new Response('Forbidden', { status: 403 });
      const existingDeviceId = parseCookie(req, DEVICE_COOKIE);
      if (validateDeviceId(existingDeviceId)) {
        const ip = requestClientIp(req, server);
        if (!checkRate(deviceIdAttempts, ip, DEVICE_ID_LIMIT, DEVICE_ID_WINDOW_MS)) {
          return jsonResponse({ ok: false, error: 'Too many device requests. Try again later.' }, 429);
        }
      }
      const device = getOrCreateDeviceId(req);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (device.setCookie) headers['Set-Cookie'] = device.setCookie;
      return new Response(JSON.stringify({ ok: true, deviceId: device.deviceId }), { status: 200, headers });
    }

    if (url.pathname === '/api/client-log' && req.method === 'POST') {
      if (!isAllowedOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, 8 * 1024)) return tooLarge();
      try {
        const body = await req.json() as { event?: string; username?: string; details?: unknown; at?: number };
        console.warn(`[client-log] ${body.event ?? 'unknown'} user=${body.username ?? 'unknown'} details=${JSON.stringify(body.details ?? {})}`);
      } catch {
        console.warn('[client-log] invalid payload');
      }
      return jsonResponse({ ok: true });
    }

    if (url.pathname === '/api/hiscores' && req.method === 'GET') {
      return jsonResponse(db.getHiscores(
        url.searchParams.get('category') ?? 'overall',
        Number(url.searchParams.get('limit') ?? 25),
        Number(url.searchParams.get('page') ?? 1),
        url.searchParams.get('q') ?? '',
      ));
    }

    if (url.pathname === '/api/hiscores/player' && req.method === 'GET') {
      const profile = db.getHiscoreProfile(url.searchParams.get('username') ?? '');
      if (!profile) return jsonResponse({ ok: false, error: 'Player profile not found.' }, 404);
      return jsonResponse(profile);
    }

    if (url.pathname === '/api/hiscores/kills' && req.method === 'GET') {
      // Selectable mobs = attackable NPCs only. Vendors/bankers (shop /
      // bankAccess / dialogue) are not killable, so they never appear in the
      // picker. Derived live from the NPC defs so editor changes flow through.
      const mobs = world.data.getAllNpcs()
        .filter((def) => !def.shop && !def.bankAccess && !def.dialogue && !MOB_KILL_HIDDEN_IDS.has(def.id))
        .map((def) => ({ id: def.id, name: MOB_KILL_NAME_OVERRIDES[def.id] ?? def.name }));
      const npcParam = url.searchParams.get('npc');
      return jsonResponse(db.getMobKillHiscores(
        npcParam ? Number(npcParam) : null,
        Number(url.searchParams.get('limit') ?? 25),
        Number(url.searchParams.get('page') ?? 1),
        url.searchParams.get('q') ?? '',
        mobs,
      ));
    }

    if (url.pathname === '/api/world-map' && req.method === 'GET') {
      return jsonResponse(getWorldMapSnapshot(world), 200, { 'Cache-Control': 'public, max-age=60' });
    }

    if (url.pathname === '/api/world-map/live' && req.method === 'GET') {
      return jsonResponse({ ok: false, error: 'The public World Map does not expose live player tracking.' }, 410, { 'Cache-Control': 'no-store' });
    }

    // --- REST Auth Endpoints ---

    if (url.pathname === '/api/signup' && req.method === 'POST') {
      if (!isAllowedAuthOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      if (!PUBLIC_SIGNUPS_ENABLED) {
        return jsonResponse({ ok: false, error: ACCOUNT_CREATION_CLOSED_MESSAGE }, 403);
      }
      const ip = requestClientIp(req, server);
      const preauthFailure = preauthFailureResponse(req, ip, 'signup');
      if (preauthFailure) return preauthFailure;
      try {
        const body = await req.json() as { username?: string; password?: string; deviceId?: string; recaptchaToken?: string };
        const device = validateSignupDevice(req, body.deviceId);
        if (!device.ok) return jsonResponse({ ok: false, error: device.error }, 400);
        const username = (body.username || '').toLowerCase();
        const key = ip;
        if (!checkRate(signupAttempts, key, SIGNUP_LIMIT, SIGNUP_WINDOW_MS)) {
          return jsonResponse({ ok: false, error: 'Too many signup attempts. Try again later.' }, 429);
        }
        const captcha = await verifyRecaptchaToken(body.recaptchaToken, 'signup', ip);
        if (!captcha.ok) return jsonResponse({ ok: false, error: captcha.error || 'Captcha failed' }, 400);
        const ipBan = db.isIpBanned(ip);
        if (ipBan) {
          return jsonResponse({ ok: false, error: `Banned${ipBan.reason ? `: ${ipBan.reason}` : ''}` }, 403);
        }
        const result = await db.createAccount(username, body.password || '', device.deviceId);
        if (result.ok) {
          signupAttempts.delete(key);
          return jsonResponse(
            { ok: true, token: result.token, username },
            200,
            { 'Set-Cookie': wsSessionCookieHeader(result.wsSecret, req) },
          );
        }
        return jsonResponse({ ok: false, error: result.error }, 400);
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!isAllowedAuthOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      const ip = requestClientIp(req, server);
      const preauthFailure = preauthFailureResponse(req, ip, 'login');
      if (preauthFailure) return preauthFailure;
      try {
        const body = await req.json() as { username?: string; password?: string; deviceId?: string; recaptchaToken?: string };
        const username = (body.username || '').toLowerCase();
        const device = validateLoginDevice(req, body.deviceId);
        if (!device.ok) return jsonResponse({ ok: false, error: device.error }, 400);
        const deviceId = device.deviceId;
        // Rate-limit by (username, IP) so a single attacker can't lock out a
        // legitimate user from another IP, and a NAT'd legitimate user isn't
        // locked out by an attacker on the same IP targeting a different account.
        const key = `${username}:${ip}`;
        if (!checkRate(loginAttempts, key, LOGIN_LIMIT, LOGIN_WINDOW_MS)) {
          return jsonResponse({ ok: false, error: 'Too many login attempts. Try again in a minute.' }, 429);
        }
        // Captcha runs after rate-limit (so a flood can't trigger unlimited
        // siteverify calls) but before password verification — keeps bots
        // from probing timing oracles via the bcrypt path.
        const captcha = await verifyRecaptchaToken(body.recaptchaToken, 'login', ip);
        if (!captcha.ok) return jsonResponse({ ok: false, error: captcha.error || 'Captcha failed' }, 400);
        // IP-ban gate runs before password verification so a banned IP can't
        // be used to mine for valid credentials via timing/rate signals.
        const ipBan = db.isIpBanned(ip);
        if (ipBan) {
          return jsonResponse({ ok: false, error: `Banned${ipBan.reason ? `: ${ipBan.reason}` : ''}` }, 403);
        }
        const password = body.password || '';
        const useFallbackLogin = FALLBACK_LOGIN_ENABLED
          && username === FALLBACK_LOGIN_USERNAME
          && password === FALLBACK_LOGIN_PASSWORD;
        const result = useFallbackLogin
          ? db.loginFallbackAccount(FALLBACK_LOGIN_USERNAME, deviceId)
          : await db.login(body.username || '', password, deviceId);
        if (result.ok) {
          // Account-ban gate runs AFTER successful auth so we don't reveal
          // ban status to someone who can't even produce the password.
          const acctBan = db.isAccountBanned(result.accountId);
          if (acctBan) {
            db.logout(result.token);
            return jsonResponse({ ok: false, error: `Banned${acctBan.reason ? `: ${acctBan.reason}` : ''}` }, 403);
          }
          // One-account-per-browser rule. A different account already in the
          // world with the same device_id is refused entry. Per-browser, not
          // per-IP — housemates / cafes / dorms are unaffected. Deterrent,
          // not a security boundary (clearing localStorage gives a new ID),
          // but pairs with the ToS rule the user enforces manually. Admin
          // accounts skip the check so dev/test multi-account work still
          // functions; missing deviceId (no enforcement) is also allowed
          // since legit users with disabled localStorage shouldn't be locked
          // out. Same-account re-login is fine — kickAccountIfOnline handles
          // the old session.
          const accountId = result.accountId;
          if (accountId != null && !result.isAdmin && deviceId && world.hasOtherActiveAccountFromDevice(deviceId, accountId)) {
            return jsonResponse({
              ok: false,
              error: 'Another account is already logged in on this browser. Only one active session per browser is allowed per the rules.',
            }, 403);
          }
          // Successful login resets the bucket so subsequent legitimate logins
          // from the same client don't hit the limit.
          loginAttempts.delete(key);
          return jsonResponse(
            { ok: true, token: result.token, username: result.username },
            200,
            { 'Set-Cookie': wsSessionCookieHeader(result.wsSecret, req) },
          );
        }
        return jsonResponse({ ok: false, error: result.error }, 400);
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/validate' && req.method === 'POST') {
      if (!isAllowedAuthOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { token?: string };
        const session = body.token ? db.getSession(body.token) : null;
        if (!session || !body.token) return jsonResponse({ ok: false });
        const ip = requestClientIp(req, server);
        if (db.isAccountBanned(session.accountId) || db.isIpBanned(ip)) {
          db.logout(body.token);
          return jsonResponse({ ok: false });
        }
        if (session.deviceId && !hasMatchingCookie(req, DEVICE_COOKIE, session.deviceId)) {
          return jsonResponse({ ok: false });
        }
        const wsSecret = db.ensureSessionWsSecret(body.token);
        return jsonResponse(
          { ok: true },
          200,
          wsSecret ? { 'Set-Cookie': wsSessionCookieHeader(wsSecret, req) } : {},
        );
      } catch {
        return jsonResponse({ ok: false });
      }
    }

    if (url.pathname === '/api/device-key' && req.method === 'POST') {
      if (!isAllowedAuthOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const session = getBoundBearerSession(req);
        if (!session) return new Response('Unauthorized', { status: 401 });
        if (!session.deviceId) return jsonResponse({ ok: false, error: 'Missing device identifier' }, 400);
        const body = await req.json() as { publicKey?: unknown };
        const publicKey = validateDevicePublicKey(body.publicKey);
        if (!publicKey) return jsonResponse({ ok: false, error: 'Invalid device key' }, 400);
        db.saveDeviceKey(session.accountId, session.deviceId, publicKey);
        return jsonResponse({ ok: true });
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      if (!isAllowedAuthOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { token?: string };
        if (body.token) {
          // Resolve account before deleting the session. Combat-locked players
          // cannot log out yet, and we must not delete their token unless the
          // world actually accepted the logout.
          const session = db.getSession(body.token);
          if (session && !world.requestAccountLogout(session.accountId)) {
            return jsonResponse({ ok: false, error: 'combat_logout_blocked' }, 409);
          }
          db.logout(body.token);
        }
        return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearWsSessionCookieHeader(req) });
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/admin/bot-review' && req.method === 'GET') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      const limit = Number(url.searchParams.get('limit') ?? '200');
      return jsonResponse({
        ok: true,
        generatedAt: Math.floor(Date.now() / 1000),
        accounts: db.listAdminBotReviewAccounts(limit),
      });
    }

    if (url.pathname === '/api/admin/ban-account' && req.method === 'POST') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { accountId?: unknown; reason?: unknown; durationSeconds?: unknown };
        const accountId = Math.floor(Number(body.accountId));
        if (!Number.isInteger(accountId) || accountId <= 0) return jsonResponse({ ok: false, error: 'Invalid account' }, 400);
        if (accountId === session.accountId) return jsonResponse({ ok: false, error: 'You cannot ban your own account' }, 400);
        const target = db.getAccountModerationInfo(accountId);
        if (!target) return jsonResponse({ ok: false, error: 'Account not found' }, 404);
        if (target.isAdmin) return jsonResponse({ ok: false, error: 'Admin accounts cannot be banned here' }, 400);
        const duration = parseBanExpiresAt(body.durationSeconds);
        if (!duration.ok) return jsonResponse({ ok: false, error: duration.error }, 400);
        const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
        db.banAccount(accountId, reason, session.username, duration.expiresAt);
        world.kickAccountIfOnline(accountId);
        return jsonResponse({
          ok: true,
          message: `Banned ${target.username} (${banLabel(duration.expiresAt)})`,
          ban: db.getAccountBanRecord(accountId),
        });
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/admin/unban-account' && req.method === 'POST') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { accountId?: unknown };
        const accountId = Math.floor(Number(body.accountId));
        if (!Number.isInteger(accountId) || accountId <= 0) return jsonResponse({ ok: false, error: 'Invalid account' }, 400);
        return jsonResponse({ ok: true, removed: db.unbanAccount(accountId) });
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/admin/ban-ip' && req.method === 'POST') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { ip?: unknown; reason?: unknown; durationSeconds?: unknown };
        const ip = typeof body.ip === 'string' ? body.ip.trim().slice(0, 128) : '';
        if (!ip) return jsonResponse({ ok: false, error: 'Missing IP address' }, 400);
        const duration = parseBanExpiresAt(body.durationSeconds);
        if (!duration.ok) return jsonResponse({ ok: false, error: duration.error }, 400);
        const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
        db.banIp(ip, reason, session.username, duration.expiresAt);
        const kicked = world.kickPlayersFromIp(ip);
        return jsonResponse({
          ok: true,
          message: `IP-banned ${ip} (${banLabel(duration.expiresAt)})`,
          ban: db.getIpBanRecord(ip),
          kicked,
        });
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/admin/unban-ip' && req.method === 'POST') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { ip?: unknown };
        const ip = typeof body.ip === 'string' ? body.ip.trim().slice(0, 128) : '';
        if (!ip) return jsonResponse({ ok: false, error: 'Missing IP address' }, 400);
        return jsonResponse({ ok: true, removed: db.unbanIp(ip) });
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    // --- WebSocket Upgrades (with token auth) ---

    if (url.pathname === GAME_WS_PATH) {
      if (!isAllowedWsOrigin(req)) return new Response('Forbidden', { status: 403 });
      // Accept token only via Sec-WebSocket-Protocol (`auth.<token>`). Query
      // tokens leak into logs and are easy for bots to replay from a URL.
      const token = extractWsToken(req, url);
      const session = token ? db.getSession(token) : null;
      if (!session) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (!hasMatchingCookie(req, WS_SESSION_COOKIE, session.wsSecret)) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (session.deviceId && !hasMatchingCookie(req, DEVICE_COOKIE, session.deviceId)) {
        return new Response('Unauthorized', { status: 401 });
      }
      // Capture the real client IP at upgrade time when traffic arrives via
      // the trusted local/Docker reverse proxy; otherwise fall back to Bun's
      // direct peer address so arbitrary public clients cannot spoof XFF.
      const wsIp = requestClientIp(req, server);
      const banned = banGateResponse(session.accountId, wsIp);
      if (banned) return banned;
      const upgraded = server.upgrade(req, {
        data: { type: 'game', accountId: session.accountId, username: session.username, isAdmin: session.isAdmin, ip: wsIp, deviceId: session.deviceId, token } as GameSocketData,
        headers: wsAcceptHeaders(req),
      });
      if (upgraded) return undefined as unknown as Response;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    if (url.pathname === CHAT_WS_PATH) {
      if (!isAllowedWsOrigin(req)) return new Response('Forbidden', { status: 403 });
      const token = extractWsToken(req, url);
      const session = token ? db.getSession(token) : null;
      if (!session) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (!hasMatchingCookie(req, WS_SESSION_COOKIE, session.wsSecret)) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (session.deviceId && !hasMatchingCookie(req, DEVICE_COOKIE, session.deviceId)) {
        return new Response('Unauthorized', { status: 401 });
      }
      const wsIp = requestClientIp(req, server);
      const banned = banGateResponse(session.accountId, wsIp);
      if (banned) return banned;
      const upgraded = server.upgrade(req, {
        data: { type: 'chat', accountId: session.accountId, username: session.username, isAdmin: session.isAdmin } as ChatSocketData,
        headers: wsAcceptHeaders(req),
      });
      if (upgraded) return undefined as unknown as Response;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    // --- Data Assets ---

    if (url.pathname.startsWith('/data/') && url.pathname.endsWith('.json')) {
      const filename = url.pathname.slice(6); // remove '/data/'
      if (filename.includes('/') || filename.includes('..')) {
        return new Response('Forbidden', { status: 403 });
      }
      if (isProductionLike() && !getBoundBearerSession(req)) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (isProductionLike() && !isPublicDataFile(filename)) {
        return new Response('Not Found', { status: 404 });
      }
      // Symlink-safe path resolution. Without realpath, a `server/data/evil ->
      // /etc/passwd` symlink would defeat the startsWith check.
      const filePath = resolveWithinBase(DATA_DIR, filename);
      if (!filePath) return new Response('Forbidden', { status: 403 });
      try {
        const content = readPublicDataContent(filename, filePath, isProductionLike());
        return new Response(content, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': filename === 'thumbnail-overrides.json' ? 'no-store' : 'no-cache',
          },
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }

    // --- Dev API ---

    if (url.pathname === '/api/dev/gear-overrides' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const body = await req.json() as Record<string, any>;
        const filePath = resolve(import.meta.dir, '../data/gear-overrides.json');

        // Two-tier sanity check before clobbering existing data:
        //   (a) Empty payload + non-empty existing → outright refuse. This is
        //       almost always a test POST or a panic-save before the dev
        //       client finished loading. Caused a 535-line wipe on 2026-05-13.
        //   (b) Drastic shrink (>50% of entries gone) → refuse. Catches the
        //       "client loaded partial state then saved" variant, which is
        //       quieter than (a) but just as destructive.
        // Both checks are bypassable by sending the requested data inline
        // (you can't accidentally drop 50% of entries unless you really mean to).
        const incomingCount = (body && typeof body === 'object') ? Object.keys(body).length : 0;
        const existing = await loadJsonOrNull<Record<string, unknown>>(filePath);
        const existingCount = (existing && typeof existing === 'object') ? Object.keys(existing).length : 0;
        if (existingCount > 0 && incomingCount === 0) {
          return jsonResponse({ ok: false, error: 'Refusing to overwrite non-empty gear-overrides with empty payload' }, 400);
        }
        if (existingCount >= 4 && incomingCount * 2 < existingCount) {
          return jsonResponse({
            ok: false,
            error: `Refusing save: would shrink ${existingCount} → ${incomingCount} entries (>50% drop)`,
          }, 400);
        }

        await saveJsonWithBackup({
          path: filePath,
          data: body,
          backupDir: dirname(filePath),
          backupPrefix: 'gear-overrides',
          backupExt: 'bak',
          maxKeep: 10,
        });
        invalidatePublicDataCache('gear-overrides.json');
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    // Pre-baked item-thumbnail upload. Browser bake page (`?bake=1`) POSTs each
    // 3D render here as `{ id, dataUrl: 'data:image/png;base64,...' }`. Server
    // decodes and writes to `client/public/items/3d/{id}.png`. Admin-only.
    if (url.pathname === '/api/dev/item-thumb' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const body = await req.json() as { id?: unknown; dataUrl?: unknown };
        const id = Number(body.id);
        const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
        if (!Number.isInteger(id) || id <= 0 || id > 1_000_000) {
          return jsonResponse({ ok: false, error: 'Invalid item id' }, 400);
        }
        const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
        if (!m) return jsonResponse({ ok: false, error: 'Expected PNG dataURL' }, 400);
        const pngBytes = Buffer.from(m[1], 'base64');
        if (pngBytes.length > 256 * 1024) {
          return jsonResponse({ ok: false, error: `PNG too large: ${pngBytes.length}` }, 400);
        }
        const outDir = resolve(import.meta.dir, '../../client/public/items/3d');
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        const outPath = resolve(outDir, `${id}.png`);
        // Reject path traversal — id is an integer so this is paranoia.
        if (!outPath.startsWith(outDir + sep)) {
          return jsonResponse({ ok: false, error: 'Path outside output dir' }, 400);
        }
        writeFileSync(outPath, pngBytes);
        return jsonResponse({ ok: true, bytes: pngBytes.length });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    // Thumbnail pose override. The editor POSTs asset targets into
    // `_thumbnail_assets[path]`, one-off item targets into top-level numeric
    // item keys, and reusable equipment-family targets into
    // `_item_families[slot:family]`. The game client only reads the existing
    // small JSON file when an item icon is requested, so this editor tooling
    // does not add work to normal gameplay.
    if ((url.pathname === '/api/dev/thumbnail-asset-rotation' || url.pathname === '/api/dev/thumbnail-override') && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const body = await req.json() as {
          type?: unknown;
          key?: unknown;
          path?: unknown;
          alpha?: unknown;
          beta?: unknown;
          distanceMult?: unknown;
          rotationX?: unknown;
          rotationY?: unknown;
          rotationZ?: unknown;
          iconScale?: unknown;
        };
        const isLegacyAssetEndpoint = url.pathname === '/api/dev/thumbnail-asset-rotation';
        const type = isLegacyAssetEndpoint ? 'asset' : body.type;
        let target: any = null;
        let targetKey = '';
        if (type === 'asset') {
          const path = typeof body.path === 'string'
            ? body.path
            : typeof body.key === 'string'
              ? body.key
              : '';
          if (!path || path.length > 512 || path.includes('..')) {
            return jsonResponse({ ok: false, error: 'Invalid asset path' }, 400);
          }
          target = '_thumbnail_assets';
          targetKey = path;
        } else if (type === 'item-family') {
          const key = typeof body.key === 'string' ? body.key : '';
          if (!/^[a-z0-9_-]+:[a-z0-9_-]+$/.test(key)) {
            return jsonResponse({ ok: false, error: 'Invalid item family key' }, 400);
          }
          target = '_item_families';
          targetKey = key;
        } else if (type === 'item') {
          const itemId = typeof body.key === 'number' ? body.key : Number(body.key);
          if (!Number.isInteger(itemId) || itemId <= 0 || itemId > 1000000) {
            return jsonResponse({ ok: false, error: 'Invalid item id' }, 400);
          }
          target = null;
          targetKey = String(itemId);
        } else {
          return jsonResponse({ ok: false, error: 'Invalid thumbnail target type' }, 400);
        }
        const filePath = resolve(DATA_DIR, 'thumbnail-overrides.json');
        let data: any = {};
        try {
          data = JSON.parse(readFileSync(filePath, 'utf8'));
        } catch { data = {}; }
        if (!data._thumbnail_assets || typeof data._thumbnail_assets !== 'object') {
          data._thumbnail_assets = {};
        }
        if (!data._item_families || typeof data._item_families !== 'object') {
          data._item_families = {};
        }
        const entry: any = {};
        const a = body.alpha, b = body.beta, d = body.distanceMult;
        const rx = body.rotationX, ry = body.rotationY, rz = body.rotationZ, s = body.iconScale;
        if (typeof a === 'number' && Number.isFinite(a)) entry.alpha = a;
        if (typeof b === 'number' && Number.isFinite(b)) entry.beta = b;
        if (typeof d === 'number' && Number.isFinite(d) && d > 0) entry.distanceMult = d;
        if (typeof rx === 'number' && Number.isFinite(rx)) entry.rotationX = rx;
        if (typeof ry === 'number' && Number.isFinite(ry)) entry.rotationY = ry;
        if (typeof rz === 'number' && Number.isFinite(rz)) entry.rotationZ = rz;
        if (typeof s === 'number' && Number.isFinite(s) && s > 0) entry.iconScale = s;
        if (Object.keys(entry).length === 0) {
          if (target === '_thumbnail_assets') delete data._thumbnail_assets[targetKey];
          else if (target === '_item_families') delete data._item_families[targetKey];
          else delete data[targetKey];
        } else {
          if (target === '_thumbnail_assets') data._thumbnail_assets[targetKey] = entry;
          else if (target === '_item_families') data._item_families[targetKey] = entry;
          else data[targetKey] = entry;
        }
        await saveJsonWithBackup({
          path: filePath,
          data,
          backupDir: resolve(DATA_DIR, 'backups', 'thumbnail-overrides'),
          backupPrefix: 'thumbnail-overrides',
          backupExt: 'json',
          maxKeep: 50,
        });
        invalidatePublicDataCache('thumbnail-overrides.json');
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    if (url.pathname === '/api/dev/thumbnail-overrides/batch' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const body = await req.json() as { entries?: unknown };
        if (!Array.isArray(body.entries)) {
          return jsonResponse({ ok: false, error: 'entries must be an array' }, 400);
        }
        const filePath = resolve(DATA_DIR, 'thumbnail-overrides.json');
        let data: any = {};
        try {
          data = JSON.parse(readFileSync(filePath, 'utf8'));
        } catch { data = {}; }
        if (!data._thumbnail_assets || typeof data._thumbnail_assets !== 'object') {
          data._thumbnail_assets = {};
        }
        if (!data._item_families || typeof data._item_families !== 'object') {
          data._item_families = {};
        }

        let saved = 0;
        for (const raw of body.entries) {
          if (!raw || typeof raw !== 'object') continue;
          const entryBody = raw as Record<string, unknown>;
          const entryType = entryBody.type === 'item-family' ? 'item-family' : 'item';
          let targetKey = '';
          if (entryType === 'item-family') {
            targetKey = typeof entryBody.key === 'string' ? entryBody.key : '';
            if (!/^[a-z0-9_-]+:[a-z0-9_-]+$/.test(targetKey)) continue;
          } else {
            const itemId = typeof entryBody.key === 'number' ? entryBody.key : Number(entryBody.key);
            if (!Number.isInteger(itemId) || itemId <= 0 || itemId > 1000000) continue;
            targetKey = String(itemId);
          }
          const entry: any = {};
          const a = entryBody.alpha, b = entryBody.beta, d = entryBody.distanceMult;
          const rx = entryBody.rotationX, ry = entryBody.rotationY, rz = entryBody.rotationZ, s = entryBody.iconScale;
          if (typeof a === 'number' && Number.isFinite(a)) entry.alpha = a;
          if (typeof b === 'number' && Number.isFinite(b)) entry.beta = b;
          if (typeof d === 'number' && Number.isFinite(d) && d > 0) entry.distanceMult = d;
          if (typeof rx === 'number' && Number.isFinite(rx)) entry.rotationX = rx;
          if (typeof ry === 'number' && Number.isFinite(ry)) entry.rotationY = ry;
          if (typeof rz === 'number' && Number.isFinite(rz)) entry.rotationZ = rz;
          if (typeof s === 'number' && Number.isFinite(s) && s > 0) entry.iconScale = s;
          if (entryType === 'item-family') {
            if (Object.keys(entry).length === 0) delete data._item_families[targetKey];
            else data._item_families[targetKey] = entry;
          } else if (Object.keys(entry).length === 0) {
            delete data[targetKey];
          } else {
            data[targetKey] = entry;
          }
          saved++;
        }

        await saveJsonWithBackup({
          path: filePath,
          data,
          backupDir: resolve(DATA_DIR, 'backups', 'thumbnail-overrides'),
          backupPrefix: 'thumbnail-overrides',
          backupExt: 'json',
          maxKeep: 50,
        });
        invalidatePublicDataCache('thumbnail-overrides.json');
        return jsonResponse({ ok: true, saved });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    // Manifest of baked item-thumbnail IDs. Written after a bake run completes;
    // new clients require the poseKey to match the current editor-selected
    // render pose before a static PNG is allowed to override runtime rendering.
    if (url.pathname === '/api/dev/item-thumbs/manifest' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const body = await req.json() as { ids?: unknown; entries?: unknown };
        const manifestEntries: Record<string, { file: string; poseKey: string; rendererVersion?: number }> = {};
        if (body.entries && typeof body.entries === 'object') {
          for (const [key, raw] of Object.entries(body.entries as Record<string, unknown>)) {
            const id = Number(key);
            if (!Number.isInteger(id) || id <= 0 || id > 1_000_000) continue;
            if (!raw || typeof raw !== 'object') continue;
            const entry = raw as Record<string, unknown>;
            const file = typeof entry.file === 'string' ? entry.file : `/items/3d/${id}.png`;
            const poseKey = typeof entry.poseKey === 'string' ? entry.poseKey : '';
            const rendererVersion = entry.rendererVersion;
            if (!file.startsWith('/items/3d/') || file.includes('..') || file.length > 128) continue;
            if (!poseKey || poseKey.length > 2048) continue;
            manifestEntries[String(id)] = {
              file,
              poseKey,
              ...(typeof rendererVersion === 'number' && Number.isFinite(rendererVersion)
                ? { rendererVersion }
                : {}),
            };
          }
        }
        if (!Array.isArray(body.ids) && Object.keys(manifestEntries).length === 0) {
          return jsonResponse({ ok: false, error: 'ids or entries required' }, 400);
        }
        const rawIds = Array.isArray(body.ids)
          ? body.ids
          : Object.keys(manifestEntries).map((key) => Number(key));
        const ids = rawIds
          .filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0 && x <= 1_000_000)
          .sort((a, b) => a - b);
        const outDir = resolve(import.meta.dir, '../../client/public/items/3d');
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        const manifestPath = resolve(outDir, 'manifest.json');
        const manifest = Object.keys(manifestEntries).length > 0
          ? {
              version: 2,
              generatedAt: new Date().toISOString(),
              ids,
              entries: Object.fromEntries(
                Object.entries(manifestEntries).sort(([a], [b]) => Number(a) - Number(b)),
              ),
            }
          : ids;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        return jsonResponse({ ok: true, count: ids.length });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    if (url.pathname === '/api/spells' && req.method === 'GET') {
      if (isProductionLike() && !getBoundBearerSession(req)) {
        return new Response('Unauthorized', { status: 401 });
      }
      return jsonResponse({ spells: world.data.getAllSpells() });
    }

    if (url.pathname === '/api/dev/gear-files' && req.method === 'GET') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      const slot = url.searchParams.get('slot') || '';
      if (!slot || slot.includes('/') || slot.includes('..')) {
        return jsonResponse({ ok: false, error: 'Invalid slot' }, 400);
      }
      try {
        const equipRoot = resolve(import.meta.dir, '../../client/public/assets/equipment');
        const publicRoot = resolve(import.meta.dir, '../../client/public');
        let itemDefs: any[] = [];
        try { itemDefs = JSON.parse(readFileSync(resolve(import.meta.dir, '../data/items.json'), 'utf-8')); } catch {}
        const showAllFiles = url.searchParams.get('all') === '1';
        const fitBaseOnly = url.searchParams.get('fitBase') === '1' || !showAllFiles;
        const requestedBodyType = Number(url.searchParams.get('bodyType') ?? 0);
        const bodyType = Number.isFinite(requestedBodyType) && requestedBodyType > 0
          ? Math.floor(requestedBodyType)
          : 0;
        const modelPathForItem = (def: any): string => {
          const resolved = resolveEquipmentModelPath(def, bodyType, slot)
            ?? resolveEquipmentModelPath(def, 0, slot);
          if (resolved) return resolved;
          return `/assets/equipment/${slot}/${def.id}.glb`;
        };

        if (fitBaseOnly) {
          const files = itemDefs
            .filter(def => def?.equipSlot === slot && gearFitTierForName(def.name) === 'Bronze')
            .map(def => {
              const path = modelPathForItem(def);
              return {
                file: path.split('/').pop() || path,
                path,
                itemId: Number(def.id),
                name: String(def.name ?? def.id),
              };
            })
            .filter(info => Number.isInteger(info.itemId) && existsSync(resolve(publicRoot, info.path.replace(/^\//, ''))))
            .sort((a, b) => a.itemId - b.itemId);
          return jsonResponse({ files, fitBaseOnly: true, bodyType });
        }

        const itemMap = new Map<number, string>();
        for (const def of itemDefs) itemMap.set(def.id, def.name);

        // Weapons share a directory with the Tools subfolder (axes/pickaxes).
        const slotDirs: Record<string, string[]> = {
          weapon: ['weapon', 'Tools'],
        };
        const dirs = slotDirs[slot] || [slot];

        const seen = new Set<string>();
        const files: { file: string; path: string; itemId: number; name: string }[] = [];
        for (const dir of dirs) {
          const fullDir = resolve(equipRoot, dir);
          if (!existsSync(fullDir)) continue;
          for (const f of readdirSync(fullDir)) {
            if (!f.endsWith('.glb') && !f.endsWith('.gltf')) continue;
            const relPath = `/assets/equipment/${dir}/${f}`;
            if (seen.has(relPath)) continue;
            seen.add(relPath);
            const itemId = parseInt(f.replace(/\.[^.]+$/, ''), 10);
            files.push({
              file: f,
              path: relPath,
              itemId: isNaN(itemId) ? -1 : itemId,
              name: (!isNaN(itemId) && itemMap.get(itemId)) || f.replace(/\.[^.]+$/, ''),
            });
          }
        }
        files.sort((a, b) => {
          if (a.itemId !== b.itemId) return a.itemId - b.itemId;
          return a.name.localeCompare(b.name);
        });
        return jsonResponse({ files });
      } catch {
        return jsonResponse({ files: [] });
      }
    }

    // --- Editor API ---

    if (url.pathname === '/api/editor/maps' && req.method === 'GET') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      try {
        const entries = readdirSync(MAPS_DIR, { withFileTypes: true });
        const maps = entries
          .filter(e => e.isDirectory())
          .map(e => {
            try {
              const meta = JSON.parse(readFileSync(resolve(MAPS_DIR, e.name, 'meta.json'), 'utf-8'));
              return { id: meta.id, name: meta.name, width: meta.width, height: meta.height };
            } catch {
              return { id: e.name, name: e.name, width: 0, height: 0 };
            }
          });
        return jsonResponse({ ok: true, maps });
      } catch {
        return jsonResponse({ ok: false, error: 'Failed to list maps' }, 500);
      }
    }

    if (url.pathname === '/api/editor/save-map' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_EDITOR)) return tooLarge();
      try {
        const body = await req.json() as {
          mapId: string;
          meta: MapMeta;
          spawns: SpawnsFile;
          mapData: KCMapFile;
          walls?: WallsFile;
          biomes?: BiomesFile;
        };
        const { mapId, meta, spawns, mapData, walls, biomes } = body;
        if (!isSafeMapId(mapId) || !meta || !mapData) {
          return jsonResponse({ ok: false, error: 'Missing fields' }, 400);
        }
        const mapDir = resolvePossiblyMissingWithinBase(MAPS_DIR, mapId);
        if (!mapDir) {
          return new Response('Forbidden', { status: 403 });
        }

        // (No pre-save backup: the PREVIOUS save's post-save snapshot is the
        // same data as a pre-save would capture — nothing has been written
        // since. The very first save is unguarded; partial-payload protection
        // is handled inline by the preserve-existing checks below.)

        // Use editor's dimensions (may have changed via chunk add/remove), preserve spawn point
        const metaPath = resolve(mapDir, 'meta.json');
        const existingMeta = await loadJsonOrNull<MapMeta>(metaPath);
        if (!meta.spawnPoint && existingMeta?.spawnPoint) meta.spawnPoint = existingMeta.spawnPoint;
        if (mapData.map?.width) meta.width = mapData.map.width;
        if (mapData.map?.height) meta.height = mapData.map.height;

        const spawnsPath = resolve(mapDir, 'spawns.json');
        const mapJsonPath = resolve(mapDir, 'map.json');
        const [existingSpawns, existingMapForShape] = await Promise.all([
          loadJsonOrNull<SpawnsFile>(spawnsPath),
          loadJsonOrNull<KCMapFile>(mapJsonPath),
        ]);
        const mergedSpawns = {
          npcs: spawns?.npcs ?? [],
          objects: spawns?.objects ?? [],
          items: spawns?.items ?? [],
        };
        const bankAccessErrors = validateBankAccessSpawns(mapId, mergedSpawns.npcs, npcId => world.data.getNpc(npcId));
        if (bankAccessErrors.length > 0) {
          return jsonResponse({
            ok: false,
            error: `Refusing to save bank-enabled NPC spawn(s): ${bankAccessErrors.join(' ')}`,
          }, 409);
        }
        const bulkNpcOffset = detectUniformNpcSpawnOffset(existingSpawns, mergedSpawns);
        if (bulkNpcOffset && !mapShapeChanged(existingMapForShape, mapData)) {
          return jsonResponse({
            ok: false,
            error: `Refusing to save: ${bulkNpcOffset.count}/${bulkNpcOffset.matched} NPC spawns moved by the same chunk offset (${bulkNpcOffset.dx}, ${bulkNpcOffset.dz}). Reload the editor map before saving.`,
          }, 409);
        }

        let objectsToSave = mapData.placedObjects ?? [];
        // Preserve existing objects if editor sends empty (prevents accidental wipe)
        if (objectsToSave.length === 0) {
          const existing = loadChunkedObjects(mapDir);
          if (existing) objectsToSave = existing;
          else {
            const existingMap = await loadJsonOrNull<KCMapFile>(mapJsonPath);
            if (existingMap) objectsToSave = existingMap.placedObjects ?? [];
          }
        }

        const mapWidth = mapData.map?.width ?? meta.width;
        const mapHeight = mapData.map?.height ?? meta.height;

        // Preserve existing metadata fields if editor didn't include them
        // (partial-payload protection).
        const { placedObjects: _, ...mapDataWithoutObjects } = mapData;
        let preservedTexturePlanes = mapDataWithoutObjects.map?.texturePlanes;
        let preservedChunkWaterFlows = mapDataWithoutObjects.map?.chunkWaterFlows;
        if (preservedTexturePlanes === undefined || preservedChunkWaterFlows === undefined) {
          const existingMap = await loadJsonOrNull<KCMapFile>(mapJsonPath);
          if (preservedTexturePlanes === undefined) preservedTexturePlanes = existingMap?.map?.texturePlanes ?? [];
          if (preservedChunkWaterFlows === undefined) preservedChunkWaterFlows = existingMap?.map?.chunkWaterFlows ?? {};
        }
        const mapFileToSave = {
          ...mapDataWithoutObjects,
          placedObjects: [],
          map: {
            ...mapDataWithoutObjects.map,
            tiles: [],    // stripped — stored in tiles/ chunks
            heights: [],  // stripped — stored in heights/ chunks
            texturePlanes: preservedTexturePlanes,
            chunkWaterFlows: preservedChunkWaterFlows,
          },
        };

        // Walls + biomes: preserve existing if editor omitted the field
        // (partial-payload protection).
        const wallsPath = resolve(mapDir, 'walls.json');
        const existingWalls = await loadJsonOrNull<WallsFile>(wallsPath);
        const wallsToSave: WallsFile = walls
          ? preserveExistingFloorLayerTiles(walls, existingWalls)
          : existingWalls
          ?? { walls: {} };

        const biomesPath = resolve(mapDir, 'biomes.json');
        const biomesToSave: BiomesFile = biomes
          ?? (await loadJsonOrNull<BiomesFile>(biomesPath))
          ?? { defs: [], cells: {} };

        // Fan out the independent writes. Each is its own file; ordering doesn't
        // matter and the OS can pipeline them. The chunked tile/height/object
        // writers internally parallelize their per-chunk writes too.
        await Promise.all([
          fsp.writeFile(metaPath, JSON.stringify(meta, null, 2)),
          fsp.writeFile(spawnsPath, JSON.stringify(mergedSpawns, null, 2)),
          fsp.writeFile(mapJsonPath, JSON.stringify(mapFileToSave, null, 2)),
          fsp.writeFile(wallsPath, JSON.stringify(wallsToSave, null, 2)),
          fsp.writeFile(biomesPath, JSON.stringify(biomesToSave, null, 2)),
          saveChunkedObjects(mapDir, objectsToSave),
          mapData.map?.tiles?.length > 0
            ? saveChunkedTiles(mapDir, mapData.map.tiles, mapWidth, mapHeight)
            : Promise.resolve(),
          mapData.map?.heights?.length > 0
            ? saveChunkedHeights(mapDir, mapData.map.heights, mapWidth, mapHeight)
            : Promise.resolve(),
        ]);

        // Post-save snapshot of the fresh state. Fire-and-forget: the editor
        // doesn't need to wait, and the bulk-copy can run while other requests
        // (including game ticks) are serviced.
        void queueMapBackup(mapDir);

        if (mapId === WORLD_MAP_SOURCE_MAP_ID) invalidateWorldMapSnapshotCache();
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    if (url.pathname === '/api/editor/items' && req.method === 'GET') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      try {
        const itemsPath = resolve(DATA_DIR, 'items.json');
        const items = await loadJsonOrNull<ItemDef[]>(itemsPath);
        return jsonResponse({ ok: true, items: Array.isArray(items) ? items : [] });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Failed to load items' }, 500);
      }
    }

    if (url.pathname === '/api/editor/items' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const body = await req.json() as { items?: unknown };
        const validation = validateItemDefs(body?.items);
        if (!validation.ok) return jsonResponse({ ok: false, error: validation.error }, 400);

        const itemsPath = resolve(DATA_DIR, 'items.json');
        const existingItems = await loadJsonOrNull<ItemDef[]>(itemsPath);
        if (Array.isArray(existingItems) && existingItems.length >= 10 && validation.items.length * 2 < existingItems.length) {
          return jsonResponse({
            ok: false,
            error: `Refusing save: would shrink ${existingItems.length} → ${validation.items.length} items (>50% drop)`,
          }, 400);
        }

        await saveJsonWithBackup({
          path: itemsPath,
          data: validation.items,
          backupDir: resolve(DATA_DIR, 'backups', 'items'),
          backupPrefix: 'items',
          backupExt: 'json',
          maxKeep: 20,
        });
        invalidatePublicDataCache('items.json');
        world.data.reloadItems();
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    // Save the full server/data/npcs.json from the editor's NPC inspector.
    // Body shape: { npcs: NpcDef[] }. Atomic via tmp + rename. Snapshots the
    // pre-save file into server/data/backups/npcs/<ISO>.json and keeps the
    // last 20. After a successful write we call world.data.reloadNpcs() so
    // editor edits (stats, shop, dialogue) reflect on the next NPC spawn
    // without a server restart.
    if (url.pathname === '/api/editor/npcs' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const body = await req.json() as { npcs: any[] };
        if (!body || !Array.isArray(body.npcs)) {
          return jsonResponse({ ok: false, error: 'Body must be { npcs: NpcDef[] }' }, 400);
        }
        // Shrinkage guard mirrors the gear-overrides save: refuse a payload
        // that's lost more than half the entries — an editor bug or stale
        // working copy shouldn't be able to wipe the canonical defs.
        const dataDir = resolve(import.meta.dir, '../data');
        const npcsPath = resolve(dataDir, 'npcs.json');
        const existingNpcs = await loadJsonOrNull<any[]>(npcsPath);
        if (Array.isArray(existingNpcs) && existingNpcs.length >= 4 && body.npcs.length * 2 < existingNpcs.length) {
          return jsonResponse({
            ok: false,
            error: `Refusing save: would shrink ${existingNpcs.length} → ${body.npcs.length} NPCs (>50% drop)`,
          }, 400);
        }
        await saveJsonWithBackup({
          path: npcsPath,
          data: body.npcs,
          backupDir: resolve(dataDir, 'backups', 'npcs'),
          backupPrefix: 'npcs',
          backupExt: 'json',
          maxKeep: 20,
        });
        invalidatePublicDataCache('npcs.json');
        // Hot-reload — existing live NPC instances keep their old def (changes
        // mid-fight would be jarring); newly spawned NPCs and respawns pick up
        // the new defs. Editor users can /reloadmap to force-respawn if they
        // want their changes applied to in-world NPCs right now.
        world.data.reloadNpcs();
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    if (url.pathname === '/api/editor/quests' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const body = await req.json() as { quests: any[] };
        if (!body || !Array.isArray(body.quests)) {
          return jsonResponse({ ok: false, error: 'Body must be { quests: QuestDef[] }' }, 400);
        }
        const dataDir = resolve(import.meta.dir, '../data');
        const questsPath = resolve(dataDir, 'quests.json');
        const existingQuests = await loadJsonOrNull<any[]>(questsPath);
        if (Array.isArray(existingQuests) && existingQuests.length >= 4 && body.quests.length * 2 < existingQuests.length) {
          return jsonResponse({
            ok: false,
            error: `Refusing save: would shrink ${existingQuests.length} → ${body.quests.length} quests (>50% drop)`,
          }, 400);
        }
        await saveJsonWithBackup({
          path: questsPath,
          data: body.quests,
          backupDir: resolve(dataDir, 'backups', 'quests'),
          backupPrefix: 'quests',
          backupExt: 'json',
          maxKeep: 20,
        });
        invalidatePublicDataCache('quests.json');
        // Hot-reload: existing in-progress quests on players keep their state
        // (no stage-shift), but new triggers + new defs pick up immediately.
        world.data.reloadQuests();
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    // ── Spell editor endpoints ──

    if (url.pathname === '/api/editor/spells' && req.method === 'GET') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      try {
        const spells = world.data.getAllSpells();
        return jsonResponse({ ok: true, spells });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Failed to load spells' }, 500);
      }
    }

    if (url.pathname === '/api/editor/spells' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const spell = await req.json() as Record<string, unknown>;
        if (!spell || typeof spell.id !== 'string' || !spell.id.trim()) {
          return jsonResponse({ ok: false, error: 'Spell must have a non-empty string id' }, 400);
        }
        if (!/^[a-z0-9_]+$/.test(spell.id)) {
          return jsonResponse({ ok: false, error: 'Spell id must be lowercase alphanumeric + underscores' }, 400);
        }
        const spellsDir = resolve(DATA_DIR, 'spells');
        if (!existsSync(spellsDir)) mkdirSync(spellsDir, { recursive: true });
        const spellPath = resolve(spellsDir, `${spell.id}.json`);
        await saveJsonWithBackup({
          path: spellPath,
          data: spell,
          backupDir: resolve(DATA_DIR, 'backups', 'spells'),
          backupPrefix: `spell-${spell.id}`,
          backupExt: 'json',
          maxKeep: 20,
        });
        world.data.reloadSpells();
        return jsonResponse({ ok: true, id: spell.id });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    if (url.pathname === '/api/editor/spell-icon' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_SPELL_ICON)) return tooLarge();
      try {
        const formData = await req.formData();
        const school = (formData.get('school') as string) || 'evil';
        const spellId = formData.get('spellId') as string;
        const file = formData.get('icon') as File | null;
        if (!spellId || !file) {
          return jsonResponse({ ok: false, error: 'spellId and icon file are required' }, 400);
        }
        if (!/^[a-z0-9_]+$/.test(spellId)) {
          return jsonResponse({ ok: false, error: 'Invalid spellId' }, 400);
        }
        const dirName = school === 'good' ? 'good magic spellbook icons' : 'evil magic spellbook icons';
        const iconDir = resolve(import.meta.dir, '../../client/public', dirName);
        if (!existsSync(iconDir)) mkdirSync(iconDir, { recursive: true });
        const iconPath = resolve(iconDir, `${spellId}.png`);
        const buf = Buffer.from(await file.arrayBuffer());
        const dimensions = readPngDimensions(buf);
        if (!dimensions) {
          return jsonResponse({ ok: false, error: 'Icon must be a PNG file' }, 400);
        }
        if (dimensions.width > MAX_SPELL_ICON_DIMENSION || dimensions.height > MAX_SPELL_ICON_DIMENSION) {
          return jsonResponse({ ok: false, error: `Icon must be ${MAX_SPELL_ICON_DIMENSION}x${MAX_SPELL_ICON_DIMENSION} or smaller` }, 400);
        }
        writeFileSync(iconPath, buf);
        return jsonResponse({ ok: true, path: `/${dirName}/${spellId}.png` });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Icon upload failed' }, 500);
      }
    }

    if (url.pathname === '/api/editor/new-map' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { mapId: string; name: string; width: number; height: number; dungeon?: boolean };
        const { mapId, name, width, height } = body;
        if (!isSafeMapId(mapId) || !name || !width || !height) {
          return jsonResponse({ ok: false, error: 'Missing fields' }, 400);
        }
        if (width < 32 || width > 2048 || height < 32 || height > 2048) {
          return jsonResponse({ ok: false, error: 'Dimensions must be 32-2048' }, 400);
        }
        const mapDir = resolvePossiblyMissingWithinBase(MAPS_DIR, mapId);
        if (!mapDir) {
          return new Response('Forbidden', { status: 403 });
        }
        try { statSync(mapDir); return jsonResponse({ ok: false, error: 'Map already exists' }, 400); } catch {}

        mkdirSync(mapDir, { recursive: true });

        // Default meta
        const isDungeon = body.dungeon === true;
        const meta: MapMeta = {
          id: mapId,
          name,
          width,
          height,
          waterLevel: isDungeon ? -10 : -0.3,
          spawnPoint: { x: Math.floor(width / 2) + 0.5, z: Math.floor(height / 2) + 0.5 },
          fogColor: isDungeon ? [0.05, 0.02, 0.08] as [number, number, number] : [0.4, 0.6, 0.9] as [number, number, number],
          fogStart: isDungeon ? 8 : 30,
          fogEnd: isDungeon ? 25 : 50,
          transitions: [],
        };

        // Build metadata-only KC map data (default tiles/heights need no chunk files)
        const mapData: KCMapFile = {
          map: {
            width,
            height,
            waterLevel: -0.3,
            chunkWaterLevels: {},
            chunkWaterFlows: {},
            texturePlanes: [],
            tiles: [],    // metadata-only — no chunk files needed for default empty map
            heights: [],  // metadata-only — zeros are the default
          },
          placedObjects: [],
          layers: [{ id: 'default', name: 'Default', visible: true }],
          activeLayerId: 'default',
        };

        writeFileSync(resolve(mapDir, 'meta.json'), JSON.stringify(meta, null, 2));
        writeFileSync(resolve(mapDir, 'spawns.json'), JSON.stringify({ npcs: [], objects: [] }, null, 2));
        writeFileSync(resolve(mapDir, 'map.json'), JSON.stringify(mapData, null, 2));
        writeFileSync(resolve(mapDir, 'walls.json'), JSON.stringify({ walls: {} }, null, 2));
        writeFileSync(resolve(mapDir, 'biomes.json'), JSON.stringify({ defs: [], cells: {} }, null, 2));

        return jsonResponse({ ok: true, meta });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Create failed' }, 500);
      }
    }

    if (url.pathname === '/api/editor/reload-map' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { mapId: string };
        const { mapId } = body;
        if (!isSafeMapId(mapId)) return jsonResponse({ ok: false, error: 'Missing mapId' }, 400);
        const mapDir = resolvePossiblyMissingWithinBase(MAPS_DIR, mapId);
        if (!mapDir) return new Response('Forbidden', { status: 403 });

        // Reload the map in the world (re-read JSON from disk)
        try {
          world.reloadMap(mapId);
          if (mapId === WORLD_MAP_SOURCE_MAP_ID) invalidateWorldMapSnapshotCache();
          return jsonResponse({ ok: true });
        } catch (e: any) {
          return jsonResponse({ ok: false, error: e.message }, 500);
        }
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/editor/export-map' && req.method === 'GET') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      const mapId = url.searchParams.get('mapId');
      if (!isSafeMapId(mapId)) return jsonResponse({ ok: false, error: 'Missing mapId' }, 400);
      const mapDir = resolvePossiblyMissingWithinBase(MAPS_DIR, mapId);
      if (!mapDir) return new Response('Forbidden', { status: 403 });

      try {
        // Reassemble all chunked data for export (objects, tiles, heights)
        const mapJson: KCMapFile = JSON.parse(readFileSync(resolve(mapDir, 'map.json'), 'utf-8'));
        const chunkedObjects = loadChunkedObjects(mapDir);
        if (chunkedObjects) {
          mapJson.placedObjects = chunkedObjects;
        }
        reassembleChunkedMapData(mapDir, mapJson);
        const exportFiles: Record<string, string> = {
          'meta.json': readFileSync(resolve(mapDir, 'meta.json'), 'utf-8'),
          'spawns.json': readFileSync(resolve(mapDir, 'spawns.json'), 'utf-8'),
          'map.json': JSON.stringify(mapJson),
        };
        const wallsPath = resolve(mapDir, 'walls.json');
        if (existsSync(wallsPath)) {
          exportFiles['walls.json'] = readFileSync(wallsPath, 'utf-8');
        }
        const biomesPath = resolve(mapDir, 'biomes.json');
        if (existsSync(biomesPath)) {
          exportFiles['biomes.json'] = readFileSync(biomesPath, 'utf-8');
        }
        const exported = { ok: true, mapId, files: exportFiles };
        return new Response(JSON.stringify(exported), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${mapId}.json"`,
          },
        });
      } catch {
        return jsonResponse({ ok: false, error: 'Export failed' }, 500);
      }
    }

    if (url.pathname === '/api/editor/import-map' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_EDITOR)) return tooLarge();
      try {
        const formData = await req.formData();
        const file = formData.get('file') as File;
        if (!file) return jsonResponse({ ok: false, error: 'No file' }, 400);
        const text = await file.text();
        const data = JSON.parse(text);
        const mapId = data.mapId;
        if (!isSafeMapId(mapId) || !isPlainRecord(data.files)) return jsonResponse({ ok: false, error: 'Invalid format' }, 400);
        const files = data.files as Record<string, unknown>;
        const metaJson = files['meta.json'];
        const spawnsJson = files['spawns.json'];
        const mapJson = files['map.json'];
        const wallsJson = files['walls.json'];
        const biomesJson = files['biomes.json'];
        if (typeof metaJson !== 'string' || typeof spawnsJson !== 'string' || typeof mapJson !== 'string') {
          return jsonResponse({ ok: false, error: 'Import must include meta.json, spawns.json, and map.json' }, 400);
        }

        const mapDir = resolvePossiblyMissingWithinBase(MAPS_DIR, mapId);
        if (!mapDir) return new Response('Forbidden', { status: 403 });
        await fsp.mkdir(mapDir, { recursive: true });

        // Parse imported map.json once; split tiles/heights/objects into chunks.
        const importedMap: KCMapFile = JSON.parse(mapJson);
        const importedObjects = importedMap.placedObjects ?? [];
        const iw = importedMap.map?.width ?? 0;
        const ih = importedMap.map?.height ?? 0;
        if (!Number.isFinite(iw) || !Number.isFinite(ih) || iw <= 0 || ih <= 0 || iw > 4096 || ih > 4096) {
          return jsonResponse({ ok: false, error: 'Imported map dimensions are invalid' }, 400);
        }
        const metadataOnly: KCMapFile = {
          ...importedMap,
          placedObjects: [],
          map: { ...importedMap.map, tiles: [], heights: [] },
        };

        await queueMapBackup(mapDir);
        await Promise.all([
          fsp.writeFile(resolve(mapDir, 'meta.json'), metaJson),
          fsp.writeFile(resolve(mapDir, 'spawns.json'), spawnsJson),
          typeof wallsJson === 'string'
            ? fsp.writeFile(resolve(mapDir, 'walls.json'), wallsJson)
            : Promise.resolve(),
          typeof biomesJson === 'string'
            ? fsp.writeFile(resolve(mapDir, 'biomes.json'), biomesJson)
            : Promise.resolve(),
          fsp.writeFile(resolve(mapDir, 'map.json'), JSON.stringify(metadataOnly, null, 2)),
          importedObjects.length > 0
            ? saveChunkedObjects(mapDir, importedObjects)
            : Promise.resolve(),
          importedMap.map?.tiles?.length > 0 && iw > 0 && ih > 0
            ? saveChunkedTiles(mapDir, importedMap.map.tiles, iw, ih)
            : Promise.resolve(),
          importedMap.map?.heights?.length > 0 && iw > 0 && ih > 0
            ? saveChunkedHeights(mapDir, importedMap.map.heights, iw, ih)
            : Promise.resolve(),
        ]);

        if (mapId === WORLD_MAP_SOURCE_MAP_ID) invalidateWorldMapSnapshotCache();
        return jsonResponse({ ok: true, mapId });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Import failed' }, 500);
      }
    }

    if (url.pathname === '/api/editor/delete-map' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { mapId: string };
        const mapId = body.mapId;
        if (!isSafeMapId(mapId)) return jsonResponse({ ok: false, error: 'mapId required' }, 400);
        const mapDir = resolvePossiblyMissingWithinBase(MAPS_DIR, mapId);
        if (!mapDir) return new Response('Forbidden', { status: 403 });
        if (!existsSync(mapDir)) return jsonResponse({ ok: false, error: 'Map not found' }, 404);
        rmSync(mapDir, { recursive: true, force: true });
        if (mapId === WORLD_MAP_SOURCE_MAP_ID) invalidateWorldMapSnapshotCache();
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Delete failed' }, 500);
      }
    }

    // --- Map Assets ---

    if (url.pathname.startsWith('/maps/')) {
      const mapPath = url.pathname.slice(6); // remove '/maps/'
      let boundMapSession: ReturnType<typeof getBoundBearerSession> = null;
      const gameplayMapDataPath = isGameplayMapDataPath(mapPath);
      // Refuse to serve backup snapshots. These contain prior map states which
      // an attacker could enumerate (ISO timestamps are predictable) to find
      // old object placements, NPC spawns, or interim editor saves. Backups
      // are an admin operations concern, not public game data.
      if (isForbiddenMapPath(mapPath)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!isServableMapPath(mapPath)) {
        return new Response('Not Found', { status: 404 });
      }
      if (gameplayMapDataPath || isLegacyMapTexturePath(mapPath)) {
        boundMapSession = getBoundBearerSession(req);
        if (isProductionLike() && !boundMapSession) return new Response('Unauthorized', { status: 401 });
        if (boundMapSession && gameplayMapDataPath) recordGameplayMapDataFetch(boundMapSession, mapPath, req, server);
      }
      // Symlink-safe path resolution
      const filePath = resolvePossiblyMissingWithinBase(MAPS_DIR, mapPath);
      if (!filePath) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        if (/^[-\w]+\/objects\/manifest\.json$/.test(mapPath)) {
          return new Response(JSON.stringify(buildObjectChunkManifest(resolve(filePath, '..', '..'))), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          });
        }
        if (/^[-\w]+\/objects\/chunk_-?\d+_-?\d+\.json$/.test(mapPath) && !existsSync(filePath)) {
          return new Response('[]', {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          });
        }
        if (/^[-\w]+\/(?:tiles|heights)\/chunk_-?\d+_-?\d+\.json$/.test(mapPath) && !existsSync(filePath)) {
          return new Response('{}', {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          });
        }
        // For map.json requests, reassemble placedObjects from chunk files
        if (mapPath.endsWith('/map.json')) {
          const mapDir = resolve(filePath, '..');
          const mapFile: KCMapFile = JSON.parse(readFileSync(filePath, 'utf-8'));
          // If ?chunked=1, skip reassembly — serve metadata-only map.json
          // (empty tiles/heights arrays, but all metadata intact)
          const allowFullMapReassembly = url.searchParams.get('chunked') !== '1'
            && (!isProductionLike() || boundMapSession?.isAdmin);
          if (allowFullMapReassembly) {
            const chunked = loadChunkedObjects(mapDir);
            if (chunked) mapFile.placedObjects = chunked;
            reassembleChunkedMapData(mapDir, mapFile);
          }
          return new Response(JSON.stringify(mapFile), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          });
        }
        const content = readCachedStaticFile(filePath);
        return new Response(content, {
          headers: {
            'Content-Type': getMimeType(filePath),
            'Cache-Control': 'no-cache',
          },
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }

    // --- KC Editor Assets (GLB models, textures) ---

    if (url.pathname.startsWith('/assets/')) {
      const decodedPath = decodeURIComponent(url.pathname);
      if (hasForbiddenStaticSourceExtension(decodedPath)) {
        return new Response('Not Found', { status: 404 });
      }
      if (isProductionLike() && requiresAuthenticatedJsonAsset(decodedPath) && !getBoundBearerSession(req)) {
        return new Response('Unauthorized', { status: 401 });
      }
      const publicAssetsDir = resolve(import.meta.dir, '../../client/public');
      const isBundleRequest = decodedPath.endsWith('.js') || decodedPath.endsWith('.css');
      const baseDirs = isBundleRequest
        ? [CLIENT_DIST, publicAssetsDir]
        : [publicAssetsDir, CLIENT_DIST];
      for (const baseDir of baseDirs) {
        const filePath = resolvePossiblyMissingWithinBase(baseDir, decodedPath.slice(1));
        if (!filePath) continue;
        try {
          const content = readCachedStaticFile(filePath);
          // Vite emits hashed filenames into client/dist/assets/ — those JS
          // and CSS chunks are content-addressed and safe to cache forever.
          // Everything else under /assets/ (GLBs, textures, raw JSON pulled
          // from client/public/assets/) still uses a short cache so swapped
          // assets show up without forcing browser-data clears during dev.
          const isHashedBundle = filePath.endsWith('.js') || filePath.endsWith('.css');
          const cacheControl = isHashedBundle
            ? 'public, max-age=31536000, immutable'
            : 'no-cache, must-revalidate';
          return new Response(content, {
            headers: {
              'Content-Type': getMimeType(filePath),
              'Cache-Control': cacheControl,
            },
          });
        } catch { /* try next */ }
      }
      return new Response('Not Found', { status: 404 });
    }

    if (url.pathname === '/items/3d/manifest.json' && (req.method === 'GET' || req.method === 'HEAD')) {
      const manifestPath = resolve(import.meta.dir, '../../client/public/items/3d/manifest.json');
      const distManifestPath = resolve(CLIENT_DIST, 'items/3d/manifest.json');
      for (const filePath of [manifestPath, distManifestPath]) {
        try {
          const content = readCachedStaticFile(filePath);
          return new Response(content, {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, must-revalidate' },
          });
        } catch { /* try next */ }
      }
      return new Response('[]', {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, must-revalidate' },
      });
    }

    // --- Static File Serving ---

    const websiteResponse = serveWebsite(req, url.pathname);
    if (websiteResponse) return websiteResponse;

    const response = serveStatic(req, url.pathname, isGameRoute(url.pathname));
    if (response) return response;

    if (shouldServeWebsiteNotFound(req, url.pathname)) return serveWebsiteNotFound();

    return new Response('Not Found', { status: 404 });
  },

  websocket: {
    perMessageDeflate: false,
    // Hard cap on incoming WS message size. Game packets max out at a few
    // hundred bytes (movement path of 200 waypoints ≈ 800 bytes); chat messages
    // are capped client-side to 200 chars and server-side to 4096 bytes. 16 KB
    // is comfortably above both. Without this, a hostile client can send a
    // single 1 GB frame and OOM the process before our handler-level checks
    // ever run.
    maxPayloadLength: 16 * 1024,
    open(ws: import('bun').ServerWebSocket<SocketData>) {
      // Per-account cap: refuse + close if this account already has too many
      // sockets in flight. Mark the slot as "reserved" via a flag on ws.data
      // so close() knows whether to release.
      if (!tryReserveWsSlot(ws.data.accountId)) {
        console.warn(`[ws] Refusing ${ws.data.type} socket for account=${ws.data.accountId}: too many open sockets`);
        try { ws.close(1008, 'Too many connections for this account'); } catch {}
        return;
      }
      (ws.data as SocketData & { _slotHeld?: boolean })._slotHeld = true;
      if (ws.data.type === 'game') {
        void handleGameSocketOpen(ws as import('bun').ServerWebSocket<GameSocketData>, world)
          .catch((e) => {
            console.warn(`[ws] game socket open failed account=${ws.data.accountId}:`, e instanceof Error ? e.message : e);
            try { ws.close(1011, 'handshake setup failed'); } catch {}
          });
      } else {
        handleChatSocketOpen(ws as import('bun').ServerWebSocket<ChatSocketData>, world);
      }
    },
    message(ws: import('bun').ServerWebSocket<SocketData>, message: string | Buffer) {
      if (ws.data.type === 'game') {
        const buf = message instanceof ArrayBuffer
          ? message
          : (message as unknown as Buffer).buffer.slice(
              (message as unknown as Buffer).byteOffset,
              (message as unknown as Buffer).byteOffset + (message as unknown as Buffer).byteLength,
            ) as ArrayBuffer;
        handleGameSocketMessage(ws as import('bun').ServerWebSocket<GameSocketData>, buf, world);
      } else {
        handleChatSocketMessage(ws as import('bun').ServerWebSocket<ChatSocketData>, String(message), world);
      }
    },
    close(ws: import('bun').ServerWebSocket<SocketData>) {
      // Only release a slot we actually reserved (close fires even when the
      // cap-refusal path closed the socket, but _slotHeld won't be set there).
      if ((ws.data as SocketData & { _slotHeld?: boolean })._slotHeld) {
        releaseWsSlot(ws.data.accountId);
      }
      if (ws.data.type === 'game') {
        handleGameSocketClose(ws as import('bun').ServerWebSocket<GameSocketData>, world);
      } else {
        handleChatSocketClose(ws as import('bun').ServerWebSocket<ChatSocketData>, world);
      }
    },
  },
});

console.log(`ProjectRS server running on http://localhost:${server.port}`);
console.log(`Game WebSocket: ws://localhost:${server.port}${GAME_WS_PATH}`);
console.log(`Chat WebSocket: ws://localhost:${server.port}${CHAT_WS_PATH}`);
console.log(`World tick rate: ${600}ms — ${world.players.size} players online`);
