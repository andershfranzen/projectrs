import { SERVER_PORT, GAME_WS_PATH, CHAT_WS_PATH, CHUNK_SIZE, validateDeviceId, gearFitTierForName, resolveEquipmentModelPath, validateNpcDefsForAuthoring, validateNpcSpawnsForAuthoring, formatNpcAuthoringIssues, readPngDimensions, CUSTOM_COLOR_SLOTS, isValidAppearance, normalizeAppearance, RELIC_ITEM_IDS, isValidMinimapIconFilename, normalizeMinimapMarkers, diagnosticFlagsFromPayload, diagnosticRecordField, measuredFpsFromDiagnosticPayload, rendererFromWebGlDiagnostics, validateItemDefs } from '@projectrs/shared';
import { resolve, dirname, sep, relative } from 'path';
import { statSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync, realpathSync } from 'fs';
import { promises as fsp } from 'fs';
import { randomUUID } from 'crypto';
import type { CustomColors, FloorLayerData, GroundType, KCMapFile, KCTile, MapMeta, PlayerAppearance, WallsFile, SpawnsFile, PlacedObject, BiomesFile, ItemDef } from '@projectrs/shared';
import { ASSET_TO_OBJECT_DEF, classifyTileType, defaultKCTile, defaultGroundForMap, getObjectInteractionTiles, localSidesToWorldSides, TileType } from '@projectrs/shared';
import { World } from './World';
import { canFetchScopedGameplayMapDataPath, gameplayMapPlayerWindowFromWorldPosition, isGameplayObjectManifestPath, mapIdFromGameplayMapPath, type GameplayMapPlayerWindow } from './data/MapDataAccess';
import { invalidatePublicDataCache, isPublicDataFile, readPublicDataContent } from './data/PublicData';
import { preserveExistingFloorLayerTiles } from './data/WallsMerge';
import { extractWsToken, hasMatchingCookie, isAllowedWsOrigin, isProductionLike, parseAllowedOrigins, readCookie, wsAcceptHeaders } from './network/WsSecurity';
import { requestClientIp } from './network/clientIp';
import { hasForbiddenStaticSourceExtension, requiresAdminStaticAsset, requiresAuthenticatedGameStaticAsset, staticGameAssetCacheControl } from './security/StaticAssetAccess';
import { maybeCompressResponse } from './network/compress';
import type { Server } from 'bun';
import { audit } from './Audit';
import { sanitizeForumUpload } from './forumUploadSecurity';
import { parseOAuthClients, validateOAuthAuthorizeParams, verifyPkceS256, type OAuthAuthorizeParams, type OAuthAuthorizeRequest } from './oauth';

// Mob-kill leaderboard display tweaks — scoped to the hiscores only; these do
// NOT rename or remove the NPC in-world. Override placeholder/dev names and
// keep non-public mobs out of the picker.
const MOB_KILL_NAME_OVERRIDES: Record<number, string> = { 102: 'Man' };
const MOB_KILL_HIDDEN_IDS = new Set<number>([19]);

type MobKillVisual = {
  appearance?: PlayerAppearance;
  equipment?: number[];
  customColors?: CustomColors;
};

type DiscordGuildEmojiPayload = {
  id?: string | null;
  name?: string | null;
  animated?: boolean;
  available?: boolean;
};

const MOB_KILL_VISUAL_CACHE_TTL_MS = 30_000;
const MOB_KILL_EQUIPMENT_SLOT_COUNT = 11;
let mobKillVisualCache: { expiresAt: number; profiles: Map<number, MobKillVisual> } | null = null;

function sanitizeRgbTriplet(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const rgb = value.slice(0, 3);
  if (!rgb.every((channel) => typeof channel === 'number' && Number.isFinite(channel))) return undefined;
  return [
    Math.max(0, Math.min(1, rgb[0])),
    Math.max(0, Math.min(1, rgb[1])),
    Math.max(0, Math.min(1, rgb[2])),
  ];
}

function sanitizeCustomColors(value: unknown): CustomColors | undefined {
  if (!isPlainRecord(value)) return undefined;
  const customColors: CustomColors = {};
  for (const slot of CUSTOM_COLOR_SLOTS) {
    const rgb = sanitizeRgbTriplet(value[slot]);
    if (rgb) customColors[slot] = rgb;
  }
  return Object.keys(customColors).length > 0 ? customColors : undefined;
}

function sanitizeAppearance(value: unknown): PlayerAppearance | undefined {
  if (!isPlainRecord(value)) return undefined;
  const appearance = normalizeAppearance(value as Partial<PlayerAppearance>);
  return isValidAppearance(appearance) ? appearance : undefined;
}

function sanitizeEquipment(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const equipment = value.slice(0, MOB_KILL_EQUIPMENT_SLOT_COUNT).map((itemId) => (
    Number.isInteger(itemId) && itemId > 0 && itemId < 100_000 ? itemId : 0
  ));
  // Public hiscores thumbnails intentionally omit hand gear/ammo. It avoids
  // exposing weapon loadouts through this API and mirrors the preview renderer,
  // which only needs outfit pieces such as helmet/body/legs.
  equipment[0] = 0;  // weapon
  equipment[1] = 0;  // shield
  equipment[10] = 0; // ammo
  return equipment.some((itemId) => itemId > 0) ? equipment : undefined;
}

function sanitizeMobKillVisual(spawn: unknown): { npcId: number; visual: MobKillVisual } | undefined {
  if (!isPlainRecord(spawn)) return undefined;
  const rawNpcId = spawn.npcId;
  if (!Number.isInteger(rawNpcId) || (rawNpcId as number) < 0) return undefined;
  const npcId = rawNpcId as number;
  const visual: MobKillVisual = {};
  const appearance = sanitizeAppearance(spawn.appearance);
  const equipment = sanitizeEquipment(spawn.equipment);
  const customColors = sanitizeCustomColors(spawn.customColors);
  if (appearance) visual.appearance = appearance;
  if (equipment) visual.equipment = equipment;
  if (customColors) visual.customColors = customColors;
  return hasMobKillVisual(visual) ? { npcId, visual } : undefined;
}

function hasMobKillVisual(visual: MobKillVisual | undefined): boolean {
  return !!visual?.appearance || !!visual?.equipment?.some((itemId) => itemId > 0) || !!visual?.customColors;
}

function visualScore(visual: MobKillVisual): number {
  let score = 0;
  if (visual.appearance) score += 10;
  if (visual.customColors) score += 5;
  score += visual.equipment?.filter((itemId) => itemId > 0).length ?? 0;
  return score;
}

function getMobKillVisualProfiles(): Map<number, MobKillVisual> {
  const now = Date.now();
  if (mobKillVisualCache && mobKillVisualCache.expiresAt > now) {
    return mobKillVisualCache.profiles;
  }

  const profiles = new Map<number, MobKillVisual>();
  try {
    for (const entry of readdirSync(MAPS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const spawnsPath = resolve(MAPS_DIR, entry.name, 'spawns.json');
      if (!existsSync(spawnsPath)) continue;
      const spawns = JSON.parse(readFileSync(spawnsPath, 'utf-8')) as Partial<SpawnsFile>;
      for (const spawn of Array.isArray(spawns.npcs) ? spawns.npcs : []) {
        const sanitized = sanitizeMobKillVisual(spawn);
        if (!sanitized) continue;

        const current = profiles.get(sanitized.npcId);
        if (!current || visualScore(sanitized.visual) > visualScore(current)) {
          profiles.set(sanitized.npcId, sanitized.visual);
        }
      }
    }
  } catch (error) {
    console.warn('[hiscores] Failed to read mob visual profiles:', error);
  }
  mobKillVisualCache = { expiresAt: now + MOB_KILL_VISUAL_CACHE_TTL_MS, profiles };
  return profiles;
}

function getHiscoreMobs(world: World): { id: number; name: string; visual?: MobKillVisual }[] {
  const visualProfiles = getMobKillVisualProfiles();
  return world.data.getAllNpcs()
    .filter((def) => !def.shop && !def.bankAccess && !def.dialogue && !MOB_KILL_HIDDEN_IDS.has(def.id))
    .map((def) => ({
      id: def.id,
      name: MOB_KILL_NAME_OVERRIDES[def.id] ?? def.name,
      visual: visualProfiles.get(def.id),
    }));
}

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

function stablePlacementStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stablePlacementStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${stablePlacementStringify(record[key])}`
    ).join(',')}}`;
  }
  const primitive = JSON.stringify(value);
  return primitive === undefined ? 'undefined' : primitive;
}

function dedupePlacedObjects(objects: PlacedObject[], context = 'placed objects'): PlacedObject[] {
  if (!Array.isArray(objects) || objects.length === 0) return [];
  const seen = new Set<string>();
  const unique: PlacedObject[] = [];
  let removed = 0;
  for (const obj of objects) {
    const key = stablePlacementStringify(obj);
    if (seen.has(key)) {
      removed++;
      continue;
    }
    seen.add(key);
    unique.push(obj);
  }
  if (removed > 0) {
    console.warn(`[editor] Removed ${removed} exact duplicate ${context}`);
  }
  return unique;
}

/** Save placed objects as per-chunk JSON files, removing chunks that are now empty.
 *  Async fs so the main thread stays responsive — editor saves no longer freeze
 *  ticks for connected players. */
async function saveChunkedObjects(mapDir: string, objects: PlacedObject[]): Promise<void> {
  const objectsDir = resolve(mapDir, 'objects');
  await fsp.mkdir(objectsDir, { recursive: true });

  const written = new Set<string>();
  const chunks = splitObjectsByChunk(dedupePlacedObjects(objects, 'placed object(s) before saving'));
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
  const unique = dedupePlacedObjects(objects, 'placed object(s) while loading chunks');
  return unique.length > 0 ? unique : null;
}

function loadEditorMapPlacedObjects(mapDir: string): PlacedObject[] {
  const chunked = loadChunkedObjects(mapDir);
  if (chunked) return chunked;
  try {
    const mapFile = JSON.parse(readFileSync(resolve(mapDir, 'map.json'), 'utf-8')) as Partial<KCMapFile>;
    return Array.isArray(mapFile.placedObjects) ? mapFile.placedObjects : [];
  } catch {
    return [];
  }
}

type PlacedObjectWipeRisk = {
  existingCount: number;
  incomingCount: number;
  missingObjectCount: number;
  missingChunks: { key: string; existingCount: number }[];
  thinnedChunks: { key: string; existingCount: number; incomingCount: number }[];
};

function countObjectsByChunk(objects: PlacedObject[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [key, chunkObjects] of splitObjectsByChunk(objects)) {
    counts.set(key, chunkObjects.length);
  }
  return counts;
}

function detectPlacedObjectWipeRisk(existingObjects: PlacedObject[] | null, incomingObjects: PlacedObject[]): PlacedObjectWipeRisk | null {
  if (!existingObjects || existingObjects.length === 0 || incomingObjects.length === 0) return null;

  const existingChunks = countObjectsByChunk(existingObjects);
  const incomingChunks = countObjectsByChunk(incomingObjects);
  const existingCount = existingObjects.length;
  const incomingCount = incomingObjects.length;
  let missingObjectCount = 0;
  const missingChunks: PlacedObjectWipeRisk['missingChunks'] = [];
  const thinnedChunks: PlacedObjectWipeRisk['thinnedChunks'] = [];

  for (const [key, existingChunkCount] of existingChunks) {
    const incomingChunkCount = incomingChunks.get(key) ?? 0;
    const missingInChunk = Math.max(0, existingChunkCount - incomingChunkCount);
    missingObjectCount += missingInChunk;

    if (incomingChunkCount === 0 && existingChunkCount >= 3) {
      missingChunks.push({ key, existingCount: existingChunkCount });
      continue;
    }
    if (existingChunkCount >= 40 && missingInChunk >= 20 && incomingChunkCount <= existingChunkCount * 0.75) {
      thinnedChunks.push({ key, existingCount: existingChunkCount, incomingCount: incomingChunkCount });
    }
  }

  const hasNetObjectLoss = incomingCount < existingCount;
  const largeTotalDrop = Math.max(0, existingCount - incomingCount) >= Math.max(20, Math.ceil(existingCount * 0.02));
  const largeChunkDrop = missingObjectCount >= Math.max(20, Math.ceil(existingCount * 0.02));
  if (!largeTotalDrop && (!hasNetObjectLoss || (!largeChunkDrop && missingChunks.length === 0 && thinnedChunks.length === 0))) return null;

  return { existingCount, incomingCount, missingObjectCount, missingChunks, thinnedChunks };
}

function formatPlacedObjectWipeRisk(risk: PlacedObjectWipeRisk): string {
  const examples = [
    ...risk.missingChunks.slice(0, 4).map(chunk => `${chunk.key} missing ${chunk.existingCount}`),
    ...risk.thinnedChunks.slice(0, 4).map(chunk => `${chunk.key} ${chunk.existingCount}->${chunk.incomingCount}`),
  ];
  const moreCount = risk.missingChunks.length + risk.thinnedChunks.length - examples.length;
  const chunkSummary = examples.length > 0
    ? ` Affected chunks: ${examples.join(', ')}${moreCount > 0 ? `, and ${moreCount} more` : ''}.`
    : '';
  return `Refusing to save placed objects: incoming payload appears partial and would drop ${risk.missingObjectCount}/${risk.existingCount} existing object placements.${chunkSummary} Reload the editor map before saving. For intentional large removals, edit the object chunk files manually after taking a backup.`;
}

function editorFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const DUNGEON_EXIT_ASSET_IDS = new Set(['CavernExit1']);

type EditorTeleportEntry = {
  targetMap: string;
  targetX: number;
  targetY?: number;
  targetZ: number;
  sourceMap: string;
  sourceX: number;
  sourceY?: number;
  sourceZ: number;
  assetId: string;
  objectName?: string;
  custom: boolean;
};

type EditorDungeonExit = {
  mapId: string;
  x: number;
  y?: number;
  z: number;
  landingX?: number;
  landingY?: number;
  landingZ?: number;
  assetId: string;
  objectName?: string;
};

function editorPlacedObjectName(obj: PlacedObject): string | undefined {
  return typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : undefined;
}

function rotateEditorLocalTile(tile: { x: number; z: number }, rotY: number): { x: number; z: number } {
  const q = (((Math.round(rotY / (Math.PI / 2)) % 4) + 4) % 4);
  if (q === 1) return { x: tile.z, z: -tile.x };
  if (q === 2) return { x: -tile.x, z: -tile.z };
  if (q === 3) return { x: -tile.z, z: tile.x };
  return { x: tile.x, z: tile.z };
}

function editorExplicitInteractionTiles(obj: PlacedObject): { x: number; z: number }[] {
  if (!Array.isArray(obj.interactionTiles) || obj.interactionTiles.length === 0) return [];
  const baseX = Math.floor(editorFiniteNumber(obj.position?.x, 0));
  const baseZ = Math.floor(editorFiniteNumber(obj.position?.z, 0));
  const rotY = editorFiniteNumber(obj.rotation?.y, 0);
  const seen = new Set<string>();
  const out: { x: number; z: number }[] = [];
  for (const local of obj.interactionTiles) {
    if (!Number.isFinite(local?.x) || !Number.isFinite(local?.z)) continue;
    const rotated = rotateEditorLocalTile({ x: Math.round(local.x), z: Math.round(local.z) }, rotY);
    const tile = { x: baseX + rotated.x, z: baseZ + rotated.z };
    const key = `${tile.x},${tile.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tile);
  }
  return out;
}

function editorTileIsWalkable(tiles: KCTile[][], width: number, height: number, x: number, z: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(z)) return false;
  if (x < 0 || z < 0 || x >= width || z >= height) return false;
  const tile = tiles[z]?.[x];
  return !!tile && tile.ground !== 'void';
}

function editorExitLandingPoint(mapDir: string, obj: PlacedObject): { x: number; y?: number; z: number } {
  const defId = ASSET_TO_OBJECT_DEF[obj.assetId];
  const def = defId ? world.data.getObject(defId) : undefined;
  const center = {
    x: editorFiniteNumber(obj.position?.x, 0),
    y: typeof obj.position?.y === 'number' && Number.isFinite(obj.position.y) ? obj.position.y : undefined,
    z: editorFiniteNumber(obj.position?.z, 0),
  };
  if (!def) return center;

  try {
    const mapFile = JSON.parse(readFileSync(resolve(mapDir, 'map.json'), 'utf-8')) as KCMapFile;
    const width = mapFile.map.width;
    const height = mapFile.map.height;
    const defaultGround = defaultGroundForMap(mapFile.map);
    const tiles = loadChunkedTiles(mapDir, width, height, defaultGround) ?? mapFile.map.tiles ?? [];
    const rotY = editorFiniteNumber(obj.rotation?.y, 0);
    const candidates = editorExplicitInteractionTiles(obj);
    if (candidates.length === 0) {
      candidates.push(...getObjectInteractionTiles(center.x, center.z, def, {
        allowedWorldSides: obj.interactionSides
          ? localSidesToWorldSides(obj.interactionSides, rotY, def)
          : undefined,
        rotationY: rotY,
      }));
    }

    candidates.sort((a, b) => {
      const da = teleportDistance2dForServer(a.x + 0.5, a.z + 0.5, center.x, center.z);
      const db = teleportDistance2dForServer(b.x + 0.5, b.z + 0.5, center.x, center.z);
      return da - db;
    });
    const best = candidates.find(tile => editorTileIsWalkable(tiles, width, height, tile.x, tile.z));
    if (best) return { x: best.x + 0.5, y: center.y, z: best.z + 0.5 };
  } catch {
    // Fall back to the placed object's center if the map cannot be inspected.
  }

  return center;
}

function teleportDistance2dForServer(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

function buildEditorTeleportData(): { teleports: EditorTeleportEntry[]; exits: EditorDungeonExit[] } {
  const teleports: EditorTeleportEntry[] = [];
  const exits: EditorDungeonExit[] = [];

  for (const dirEntry of readdirSync(MAPS_DIR, { withFileTypes: true })) {
    if (!dirEntry.isDirectory()) continue;
    const sourceMap = dirEntry.name;
    const mapDir = resolve(MAPS_DIR, sourceMap);
    for (const obj of loadEditorMapPlacedObjects(mapDir)) {
      if (!obj || typeof obj.assetId !== 'string') continue;
      if (DUNGEON_EXIT_ASSET_IDS.has(obj.assetId) && Number.isFinite(obj.position?.x) && Number.isFinite(obj.position?.z)) {
        const landing = editorExitLandingPoint(mapDir, obj);
        exits.push({
          mapId: sourceMap,
          x: editorFiniteNumber(obj.position.x, 0),
          y: typeof obj.position?.y === 'number' && Number.isFinite(obj.position.y) ? obj.position.y : undefined,
          z: editorFiniteNumber(obj.position.z, 0),
          landingX: landing.x,
          landingY: landing.y,
          landingZ: landing.z,
          assetId: obj.assetId,
          objectName: editorPlacedObjectName(obj),
        });
      }

      let targetMap = '';
      let targetX = 32.5;
      let targetY: number | undefined;
      let targetZ = 32.5;
      let custom = false;

      if (obj.trigger?.type === 'teleport' && typeof obj.trigger.destChunk === 'string' && obj.trigger.destChunk.trim()) {
        targetMap = obj.trigger.destChunk.trim();
        targetX = editorFiniteNumber(obj.trigger.entryX, targetX);
        targetY = typeof obj.trigger.entryY === 'number' && Number.isFinite(obj.trigger.entryY) ? obj.trigger.entryY : undefined;
        targetZ = editorFiniteNumber(obj.trigger.entryZ, targetZ);
        custom = true;
      } else {
        const defId = ASSET_TO_OBJECT_DEF[obj.assetId];
        const transition = defId ? world.data.getObject(defId)?.transition : undefined;
        if (!transition) continue;
        targetMap = transition.targetMap;
        targetX = transition.targetX;
        targetZ = transition.targetZ;
      }

      if (!targetMap || !Number.isFinite(targetX) || !Number.isFinite(targetZ)) continue;
      teleports.push({
        targetMap,
        targetX,
        targetY,
        targetZ,
        sourceMap,
        sourceX: editorFiniteNumber(obj.position?.x, 0),
        sourceY: typeof obj.position?.y === 'number' && Number.isFinite(obj.position.y) ? obj.position.y : undefined,
        sourceZ: editorFiniteNumber(obj.position?.z, 0),
        assetId: obj.assetId,
        objectName: editorPlacedObjectName(obj),
        custom,
      });
    }
  }

  return { teleports, exits };
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

function isRelicLootDrop(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value)
    && Number.isInteger(value.itemId)
    && RELIC_ITEM_IDS.has(value.itemId as number);
}

function npcId(value: unknown): number | null {
  return isPlainRecord(value) && Number.isInteger(value.id) ? value.id as number : null;
}

function protectNpcLootTablesOnSave(incomingNpcs: any[], existingNpcs: any[] | null): { npcs: any[]; preservedRelicDrops: number; preservedMissingLootTables: number } {
  if (!Array.isArray(existingNpcs) || existingNpcs.length === 0) {
    return { npcs: incomingNpcs, preservedRelicDrops: 0, preservedMissingLootTables: 0 };
  }

  const existingById = new Map<number, any>();
  for (const npc of existingNpcs) {
    const id = npcId(npc);
    if (id !== null) existingById.set(id, npc);
  }

  let incomingRelicDropCount = 0;
  let existingRelicDropCount = 0;
  for (const npc of incomingNpcs) {
    const lootTable = isPlainRecord(npc) && Array.isArray(npc.lootTable) ? npc.lootTable : [];
    incomingRelicDropCount += lootTable.filter(isRelicLootDrop).length;
  }
  for (const npc of existingNpcs) {
    const lootTable = isPlainRecord(npc) && Array.isArray(npc.lootTable) ? npc.lootTable : [];
    existingRelicDropCount += lootTable.filter(isRelicLootDrop).length;
  }

  const preserveRelics = existingRelicDropCount > 0 && incomingRelicDropCount === 0;
  let preservedRelicDrops = 0;
  let preservedMissingLootTables = 0;

  const npcs = incomingNpcs.map((npc) => {
    if (!isPlainRecord(npc)) return npc;
    const id = npcId(npc);
    const existing = id !== null ? existingById.get(id) : null;
    const existingLootTable = isPlainRecord(existing) && Array.isArray(existing.lootTable) ? existing.lootTable : null;

    if (!Array.isArray(npc.lootTable)) {
      if (existingLootTable) {
        preservedMissingLootTables++;
        return { ...npc, lootTable: existingLootTable };
      }
      return npc;
    }

    if (!preserveRelics || !existingLootTable) return npc;
    const existingRelicDrops = existingLootTable.filter(isRelicLootDrop);
    if (existingRelicDrops.length === 0) return npc;

    preservedRelicDrops += existingRelicDrops.length;
    const nonRelicDrops = npc.lootTable.filter((drop: unknown) => !isRelicLootDrop(drop));
    return { ...npc, lootTable: [...nonRelicDrops, ...existingRelicDrops] };
  });

  return { npcs, preservedRelicDrops, preservedMissingLootTables };
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

function tileDefaults(defaultGround: GroundType): KCTile {
  return defaultKCTile(defaultGround);
}

/** Strip default fields from a tile, returning only non-default values */
function stripTileDefaults(tile: KCTile, defaultGround: GroundType = 'grass'): Partial<KCTile> | null {
  const defaults = tileDefaults(defaultGround);
  const stripped: Partial<KCTile> = {};
  let hasNonDefault = false;
  for (const key of Object.keys(defaults) as (keyof KCTile)[]) {
    if (tile[key] !== defaults[key]) {
      (stripped as Record<string, unknown>)[key] = tile[key];
      hasNonDefault = true;
    }
  }
  return hasNonDefault ? stripped : null;
}

/** Expand a partial tile back to a full KCTile */
function expandTile(partial: Partial<KCTile>, defaultGround: GroundType = 'grass'): KCTile {
  return {
    ...defaultKCTile(defaultGround),
    ...partial,
    waterSurfaceB: partial.waterSurfaceB ?? partial.waterSurface ?? false,
  };
}

/** Save tiles as per-chunk JSON files */
async function saveChunkedTiles(mapDir: string, tiles: KCTile[][], width: number, height: number, defaultGround: GroundType = 'grass'): Promise<void> {
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
          const stripped = stripTileDefaults(tile, defaultGround);
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
  if (written.size === 0 && defaultGround === 'grass') return;

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
function loadChunkedTiles(mapDir: string, width: number, height: number, defaultGround: GroundType = 'grass'): KCTile[][] | null {
  const tilesDir = resolve(mapDir, 'tiles');
  if (!existsSync(tilesDir)) return null;

  // Initialize full array with defaults
  const tiles: KCTile[][] = [];
  for (let z = 0; z < height; z++) {
    const row: KCTile[] = [];
    for (let x = 0; x < width; x++) {
      row.push(defaultKCTile(defaultGround));
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
          tiles[z][x] = expandTile(partial, defaultGround);
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
  const defaultGround = defaultGroundForMap(mapFile.map);
  const chunkedTiles = loadChunkedTiles(mapDir, w, h, defaultGround);
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
  const defaultGround = defaultGroundForMap(mapFile.map);
  const tiles = loadChunkedTiles(mapDir, width, height, defaultGround) ?? mapFile.map.tiles ?? [];
  const heights = loadChunkedHeights(mapDir, width, height) ?? mapFile.map.heights ?? null;
  const counts: Record<WorldMapTileCode, number> = { g: 0, d: 0, p: 0, s: 0, r: 0, w: 0, m: 0, u: 0 };
  const rows: string[] = [];

  for (let z = 0; z < height; z++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      const code = visualTileCode(tiles[z]?.[x] ?? defaultKCTile(defaultGround), heights, x, z, waterLevel);
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
import { GameDatabase, WORLD_RESPAWN_VERSION } from './Database';
import { flushAuditSync } from './Audit';
import {
  handleGameSocketOpen,
  handleGameSocketMessage,
  handleGameSocketClose,
  type GameSocketData,
} from './network/GameSocket';
import {
  adminTeleportPlayerToPlayer,
  handleChatSocketOpen,
  handleChatSocketMessage,
  handleChatSocketClose,
  setChatAccountAdmin,
  setChatAccountModerator,
  type ChatSocketData,
} from './network/ChatSocket';

const ROOT_DIR = resolve(import.meta.dir, '../..');
const CLIENT_DIST = resolve(ROOT_DIR, 'client/dist');
const WEBSITE_DIST = resolve(ROOT_DIR, 'website/dist');
const WEBSITE_PUBLIC = resolve(ROOT_DIR, 'website/public');
const MAPS_DIR = resolve(import.meta.dir, '../data/maps');
const DATA_DIR = resolve(import.meta.dir, '../data');
const AUDIT_LOG_PATH = resolve(DATA_DIR, 'audit.log');
const RUNTIME_DATA_DIR = process.env.PROJECTRS_RUNTIME_DATA_DIR ? resolve(process.env.PROJECTRS_RUNTIME_DATA_DIR) : DATA_DIR;
const FORUM_MEDIA_DIR = resolve(RUNTIME_DATA_DIR, 'forum-media');
const FORUM_AVATAR_DIR = resolve(RUNTIME_DATA_DIR, 'forum-avatars');
const FORUM_AVATAR_BAKE_SECRET = process.env.FORUM_AVATAR_BAKE_SECRET || randomUUID();
const DEFAULT_DISCORD_GUILD_ID = '1504534632799010816';
const CLIENT_DIAGNOSTICS_DEFAULT_LIMIT = 50;
const CLIENT_DIAGNOSTICS_MAX_LIMIT = 500;
const CLIENT_DIAGNOSTICS_DEFAULT_TAIL_BYTES = 1024 * 1024;
const CLIENT_DIAGNOSTICS_MAX_TAIL_BYTES = 4 * 1024 * 1024;
const DISCORD_EMOJI_SYNC_INTERVAL_MS = (() => {
  const raw = Number(process.env.DISCORD_EMOJI_SYNC_INTERVAL_MS ?? 15 * 60_000);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 15 * 60_000;
})();
let forumDiscordEmojiLastSyncAt = 0;
let forumDiscordEmojiLastError = '';
let forumDiscordEmojiSyncInFlight: Promise<number> | null = null;

function forumDiscordEmojiConfig(): { guildId: string; botToken: string; enabled: boolean } {
  const guildId = (process.env.DISCORD_GUILD_ID || process.env.LEFT_HAND_DISCORD_GUILD_ID || DEFAULT_DISCORD_GUILD_ID).trim();
  const botToken = (process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || process.env.LEFT_HAND_DISCORD_TOKEN || '').trim();
  return { guildId, botToken, enabled: guildId.length > 0 && botToken.length > 0 };
}

const initialDiscordEmojiConfig = forumDiscordEmojiConfig();
if ((initialDiscordEmojiConfig.guildId || initialDiscordEmojiConfig.botToken) && !initialDiscordEmojiConfig.enabled) {
  console.warn('[forums] Discord emoji sync disabled; set DISCORD_GUILD_ID plus DISCORD_BOT_TOKEN, DISCORD_TOKEN, or LEFT_HAND_DISCORD_TOKEN');
}
const WEBSITE_DEV_ORIGIN = (() => {
  const raw = (process.env.WEBSITE_DEV_ORIGIN || '').trim();
  if (!raw || isProductionLike()) return null;
  try {
    return new URL(raw).origin;
  } catch {
    console.warn(`[website-dev] Ignoring invalid WEBSITE_DEV_ORIGIN=${JSON.stringify(raw)}`);
    return null;
  }
})();

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
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf('.'));
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function gameStaticAssetCacheControl(decodedPath: string): string {
  if (requiresAdminStaticAsset(decodedPath)) return 'private, no-store';
  return staticGameAssetCacheControl(decodedPath, isProductionLike());
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
  if (isProductionLike() && requiresAdminStaticAsset(decoded) && !getStaticAssetAdminSession(req)) {
    return new Response('Not Found', { status: 404 });
  }
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
    } else if (requiresAdminStaticAsset(decoded)) {
      cacheControl = gameStaticAssetCacheControl(decoded);
    } else if (decoded.startsWith('/assets/') && (filePath.endsWith('.js') || filePath.endsWith('.css'))) {
      cacheControl = 'public, max-age=31536000, immutable';
    } else if (requiresAuthenticatedGameStaticAsset(decoded)) {
      cacheControl = gameStaticAssetCacheControl(decoded);
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
    && normalized !== '/forums'
    && !normalized.startsWith('/news/')
    && !normalized.startsWith('/forums/')
    && !normalized.startsWith('/_next/')
  ) {
    return null;
  }

  const routePath = normalized === '/'
    ? 'index'
    : normalized === '/forums/avatar-bake'
      ? 'forums/avatar-bake'
      : normalized.startsWith('/forums/')
        ? 'forums'
        : normalized.slice(1);
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

function serveWebsitePublic(pathname: string): Response | null {
  const decoded = decodeURIComponent(pathname);
  const normalizedPath = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  const publicPath = resolvePossiblyMissingWithinBase(WEBSITE_PUBLIC, normalizedPath);
  const exportedPath = resolvePossiblyMissingWithinBase(WEBSITE_DIST, normalizedPath);

  for (const filePath of [publicPath, exportedPath]) {
    if (!filePath) continue;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      return new Response(readCachedStaticFile(filePath), {
        headers: {
          'Content-Type': getMimeType(filePath),
          'Cache-Control': 'no-cache, must-revalidate',
        },
      });
    } catch {
      // Try the next possible website asset location.
    }
  }

  return null;
}

function isWebsiteDevProxyRoute(pathname: string): boolean {
  const decoded = decodeURIComponent(pathname);
  const normalized = decoded !== '/' && decoded.endsWith('/') ? decoded.slice(0, -1) : decoded;
  return normalized === '/'
    || normalized === '/hiscores'
    || normalized === '/world-map'
    || normalized === '/news'
    || normalized === '/forums'
    || normalized.startsWith('/news/')
    || normalized.startsWith('/forums/')
    || normalized.startsWith('/_next/');
}

async function serveWebsiteDev(req: Request, pathname: string): Promise<Response | null> {
  if (!WEBSITE_DEV_ORIGIN || !isWebsiteDevProxyRoute(pathname)) return null;

  const target = new URL(req.url);
  const origin = new URL(WEBSITE_DEV_ORIGIN);
  target.protocol = origin.protocol;
  target.host = origin.host;
  if (pathname.startsWith('/forums/') && !pathname.startsWith('/forums/avatar-bake')) target.pathname = '/forums';

  const headers = new Headers(req.headers);
  headers.set('host', origin.host);
  headers.set('x-forwarded-host', req.headers.get('host') ?? `localhost:${SERVER_PORT}`);
  headers.set('x-forwarded-proto', new URL(req.url).protocol.replace(':', ''));

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      redirect: 'manual',
    });
    const responseHeaders = new Headers(upstream.headers);
    // Bun's fetch can hand us a decoded body while preserving upstream
    // compression headers. Strip size/encoding metadata so browsers consume
    // the dev proxy response exactly as sent by this server.
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    responseHeaders.delete('transfer-encoding');
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return null;
  }
}

function getWebsiteDevWebSocketUrl(reqUrl: string): string | null {
  if (!WEBSITE_DEV_ORIGIN) return null;
  const target = new URL(reqUrl);
  const origin = new URL(WEBSITE_DEV_ORIGIN);
  target.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  target.host = origin.host;
  return target.toString();
}

function jsonResponse(data: any, status: number = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function jsonResponseWithSetCookies(data: any, status: number, cookies: string[]): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

function htmlResponse(html: string, status: number = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

type ClientDiagnosticLogEntry = {
  ts: string;
  tick: number | null;
  event: string;
  username: string;
  clientAt: number | null;
  payload: unknown;
};

function boundedIntegerParam(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = raw === null ? fallback : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(clampNumber(parsed, min, max));
}

async function readRecentClientDiagnostics(options: {
  limit: number;
  tailBytes: number;
  event?: string | null;
  username?: string | null;
  query?: string | null;
}): Promise<{ events: ClientDiagnosticLogEntry[]; bytesScanned: number }> {
  let size = 0;
  try {
    size = (await fsp.stat(AUDIT_LOG_PATH)).size;
  } catch {
    return { events: [], bytesScanned: 0 };
  }

  const start = Math.max(0, size - options.tailBytes);
  const bytesToRead = size - start;
  if (bytesToRead <= 0) return { events: [], bytesScanned: 0 };

  const handle = await fsp.open(AUDIT_LOG_PATH, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf-8').split('\n');
    if (start > 0) lines.shift();

    const eventFilter = options.event?.trim().toLowerCase() || '';
    const usernameFilter = options.username?.trim().toLowerCase() || '';
    const queryFilter = options.query?.trim().toLowerCase() || '';
    const events: ClientDiagnosticLogEntry[] = [];

    for (let i = lines.length - 1; i >= 0 && events.length < options.limit; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainRecord(parsed) || parsed.type !== 'client.log' || !isPlainRecord(parsed.details)) continue;

      const details = parsed.details;
      const event = String(details.event ?? 'unknown');
      const username = String(details.username ?? 'unknown');
      if (eventFilter && event.toLowerCase() !== eventFilter) continue;
      if (usernameFilter && !username.toLowerCase().includes(usernameFilter)) continue;

      const payload = details.payload ?? {};
      if (queryFilter) {
        const haystack = `${event} ${username} ${JSON.stringify(payload)}`.toLowerCase();
        if (!haystack.includes(queryFilter)) continue;
      }

      const tick = Number(parsed.tick);
      const clientAt = Number(details.clientAt);
      events.push({
        ts: typeof parsed.ts === 'string' ? parsed.ts : '',
        tick: Number.isFinite(tick) ? tick : null,
        event,
        username,
        clientAt: Number.isFinite(clientAt) ? clientAt : null,
        payload,
      });
    }

    return { events, bytesScanned: bytesRead };
  } finally {
    await handle.close();
  }
}

function clientLogConsoleSummary(event: string, username: string, payload: unknown): string {
  if (event === 'client_camera_snap' && isPlainRecord(payload)) {
    const numberField = (key: string, digits: number = 1): string => {
      const value = payload[key];
      return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
    };
    const player = isPlainRecord(payload.player) ? payload.player : {};
    const path = isPlainRecord(payload.path) ? payload.path : {};
    const framePace = isPlainRecord(payload.framePace) ? payload.framePace : {};
    const px = typeof player.x === 'number' && Number.isFinite(player.x) ? player.x.toFixed(2) : 'n/a';
    const pz = typeof player.z === 'number' && Number.isFinite(player.z) ? player.z.toFixed(2) : 'n/a';
    const pathIndex = typeof path.index === 'number' && Number.isFinite(path.index) ? path.index : 'n/a';
    const pathLength = typeof path.length === 'number' && Number.isFinite(path.length) ? path.length : 'n/a';
    const map = String(payload.currentMap ?? 'n/a').slice(0, 48);
    const floor = typeof payload.currentFloor === 'number' && Number.isFinite(payload.currentFloor) ? payload.currentFloor : 'n/a';
    const reason = String(payload.reason ?? 'unknown').slice(0, 48);
    const visibility = String(payload.visibilityState ?? 'n/a').slice(0, 24);
    const paceMode = String(framePace.mode ?? 'n/a').slice(0, 24);
    return `[client-log] ${event} user=${username} reason=${reason} dist=${numberField('distance')} dx=${numberField('dx')} dz=${numberField('dz')} dt=${numberField('dtMs')}ms map=${map}/f${floor} pos=${px},${pz} path=${pathIndex}/${pathLength} vis=${visibility} pace=${paceMode}`;
  }
  if (event === 'client_frame_spike' && isPlainRecord(payload)) {
    const numberField = (key: string): string => {
      const value = payload[key];
      return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'n/a';
    };
    const player = isPlainRecord(payload.player) ? payload.player : {};
    const px = typeof player.x === 'number' && Number.isFinite(player.x) ? player.x.toFixed(2) : 'n/a';
    const pz = typeof player.z === 'number' && Number.isFinite(player.z) ? player.z.toFixed(2) : 'n/a';
    const map = String(payload.currentMap ?? 'n/a').slice(0, 48);
    const floor = typeof payload.currentFloor === 'number' && Number.isFinite(payload.currentFloor) ? payload.currentFloor : 'n/a';
    const topSlices = Array.isArray(payload.topSlices)
      ? payload.topSlices
        .slice(0, 4)
        .map((slice) => isPlainRecord(slice) ? `${String(slice.label ?? '?')}:${typeof slice.ms === 'number' ? slice.ms.toFixed(1) : 'n/a'}` : '')
        .filter(Boolean)
        .join(',')
      : 'n/a';
    const longTasks = Array.isArray(payload.longTasks)
      ? payload.longTasks
        .slice(0, 4)
        .map((task) => isPlainRecord(task) && typeof task.durationMs === 'number' ? task.durationMs.toFixed(1) : '')
        .filter(Boolean)
        .join(',')
      : '';
    const longTaskText = longTasks ? ` longTasks=${longTasks}ms` : ' longTasks=none';
    const gpuText = typeof payload.gpuFrameMs === 'number' && Number.isFinite(payload.gpuFrameMs)
      ? ` gpu=${payload.gpuFrameMs.toFixed(1)}ms`
      : ' gpu=n/a';
    const framePace = isPlainRecord(payload.framePace) ? payload.framePace : {};
    const paceMode = String(framePace.mode ?? 'n/a').slice(0, 24);
    const targetRenderFps = typeof framePace.targetRenderFps === 'number' && Number.isFinite(framePace.targetRenderFps)
      ? framePace.targetRenderFps.toFixed(1)
      : 'native';
    return `[client-log] ${event} user=${username} gap=${numberField('rafGapMs')}ms update=${numberField('updateMs')}ms render=${numberField('renderMs')}ms outside=${numberField('outsideMeasuredFrameMs')}ms pace=${paceMode}/${targetRenderFps} map=${map}/f${floor} pos=${px},${pz}${longTaskText}${gpuText} top=${topSlices}`;
  }
  const fps = measuredFpsFromDiagnosticPayload(payload);
  const fpsText = fps === null ? 'n/a' : (fps >= 100 ? Math.round(fps).toString() : fps.toFixed(1));
  const flags = diagnosticFlagsFromPayload(payload);
  const payloadRecord = isPlainRecord(payload) ? payload : {};
  const map = String(payloadRecord.currentMap ?? 'n/a').slice(0, 48);
  const renderer = rendererFromWebGlDiagnostics(diagnosticRecordField(payload, 'webgl')).slice(0, 120);
  const flagText = flags.length > 0 ? flags.slice(0, 8).join(',') : 'none';
  return `[client-log] ${event} user=${username} fps=${fpsText} map=${map} flags=${flagText} renderer=${renderer}`;
}

function forumAvatarFilePath(urlOrPath: string): string | null {
  let pathname = urlOrPath;
  if (/^https?:\/\//.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return null;
    }
  }
  const name = pathname.replace(/^\/forum-avatars\/?/, '');
  if (!/^[0-9]+-[a-f0-9]{16}\.webp$/.test(name)) return null;
  return resolveWithinBase(FORUM_AVATAR_DIR, name);
}

function bakedForumAvatarUrl(url: string, reason: string): string {
  if (!url.startsWith('/forum-avatars/') && !/^https?:\/\/[^/]+\/forum-avatars\//.test(url)) return url;
  const filePath = forumAvatarFilePath(url);
  if (filePath && existsSync(filePath)) return url;
  scheduleForumAvatarBake(`missing:${reason}`, 100);
  return '';
}

function stripMissingForumAvatarUrls<T>(value: T, reason: string): T {
  if (typeof value === 'string') return bakedForumAvatarUrl(value, reason) as T;
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => stripMissingForumAvatarUrls(entry, reason)) as T;
  const source = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    next[key] = key === 'avatarUrl' && typeof entry === 'string'
      ? bakedForumAvatarUrl(entry, reason)
      : stripMissingForumAvatarUrls(entry, reason);
  }
  return next as T;
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
const oauthTokenAttempts = new Map<string, RateBucket>();
const preauthBootstraps = new Map<string, number>();
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;
const SIGNUP_LIMIT = 20;
const SIGNUP_WINDOW_MS = 10 * 60_000;
const DEVICE_ID_LIMIT = 20;
const DEVICE_ID_WINDOW_MS = 10 * 60_000;
const OAUTH_TOKEN_LIMIT = 30;
const OAUTH_TOKEN_WINDOW_MS = 60_000;
const OAUTH_CLIENTS = parseOAuthClients(Bun.env.OAUTH_CLIENTS_JSON);
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
const OAUTH_RECAPTCHA_SITE_KEY = Bun.env.OAUTH_RECAPTCHA_SITE_KEY || Bun.env.VITE_RECAPTCHA_SITE_KEY || Bun.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || '';
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

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function oauthParamsFromSearch(params: URLSearchParams): OAuthAuthorizeParams {
  return {
    responseType: params.get('response_type') ?? '',
    clientId: params.get('client_id') ?? '',
    redirectUri: params.get('redirect_uri') ?? '',
    codeChallenge: params.get('code_challenge') ?? '',
    codeChallengeMethod: params.get('code_challenge_method') ?? '',
    state: params.get('state') ?? '',
    scope: params.get('scope') ?? '',
  };
}

function renderOAuthAuthorizePage(request: OAuthAuthorizeRequest, error: string = ''): string {
  const hidden = [
    ['response_type', 'code'],
    ['client_id', request.client.id],
    ['redirect_uri', request.redirectUri],
    ['code_challenge', request.codeChallenge],
    ['code_challenge_method', 'S256'],
    ['state', request.state],
    ['scope', request.scopeText],
  ].map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join('\n');
  const recaptchaScript = OAUTH_RECAPTCHA_SITE_KEY
    ? `<script src="https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(OAUTH_RECAPTCHA_SITE_KEY)}"></script>`
    : '';
  const recaptchaNotice = OAUTH_RECAPTCHA_SITE_KEY
    ? '<p class="notice">Protected by reCAPTCHA. Google Privacy Policy and Terms apply.</p>'
    : '';
  const recaptchaSubmit = OAUTH_RECAPTCHA_SITE_KEY
    ? `
      const siteKey = ${JSON.stringify(OAUTH_RECAPTCHA_SITE_KEY)};
      form.addEventListener('submit', async (event) => {
        if (token.value) return;
        event.preventDefault();
        button.disabled = true;
        button.textContent = 'Checking...';
        try {
          await new Promise((resolve) => grecaptcha.ready(resolve));
          token.value = await grecaptcha.execute(siteKey, { action: 'login' });
          form.submit();
        } catch {
          error.textContent = 'Captcha unavailable. Refresh and try again.';
          button.disabled = false;
          button.textContent = 'Authorize';
        }
      });
    `
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize ${escapeHtml(request.client.name)} - EvilQuest</title>
  ${recaptchaScript}
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #15120e; color: #f3ead8; font: 16px system-ui, sans-serif; }
    main { width: min(420px, calc(100vw - 32px)); border: 1px solid #5d4a31; background: #211a13; padding: 28px; box-sizing: border-box; }
    h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.2; }
    p { margin: 0 0 18px; color: #cdbd9f; line-height: 1.45; }
    label { display: grid; gap: 6px; margin: 14px 0; color: #f3ead8; }
    input { min-height: 42px; box-sizing: border-box; border: 1px solid #6b5638; background: #100d0a; color: #fff7e6; padding: 8px 10px; font: inherit; }
    button { width: 100%; min-height: 44px; margin-top: 10px; border: 0; background: #d7a84a; color: #171009; font: inherit; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .7; cursor: wait; }
    .error { min-height: 20px; color: #ff9b8b; }
    .notice { margin-top: 14px; font-size: 12px; color: #9f927d; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize ${escapeHtml(request.client.name)}</h1>
    <p>${escapeHtml(request.client.name)} wants access to your EvilQuest account for: ${escapeHtml(request.scopeText)}.</p>
    <form method="post" action="/oauth/authorize" autocomplete="on">
      ${hidden}
      <input type="hidden" id="recaptchaToken" name="recaptchaToken" value="">
      <label>Username <input name="username" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <div id="error" class="error">${escapeHtml(error)}</div>
      <button id="authorizeButton" type="submit">Authorize</button>
      ${recaptchaNotice}
    </form>
  </main>
  <script>
    const form = document.querySelector('form');
    const button = document.getElementById('authorizeButton');
    const token = document.getElementById('recaptchaToken');
    const error = document.getElementById('error');
    ${recaptchaSubmit}
  </script>
</body>
</html>`;
}

function renderOAuthErrorPage(title: string, description: string): Response {
  return htmlResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></body></html>`, 400);
}

function redirectOAuthError(redirectUri: string, state: string, error: string, description: string): Response {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state);
  return new Response(null, { status: 302, headers: { Location: target.toString(), 'Cache-Control': 'no-store' } });
}

function redirectOAuthCode(redirectUri: string, state: string, code: string): Response {
  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  target.searchParams.set('state', state);
  return new Response(null, { status: 302, headers: { Location: target.toString(), 'Cache-Control': 'no-store' } });
}

function isAllowedOAuthClientOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  return !origin || parseAllowedOrigins(process.env.CLIENT_ORIGINS).has(origin);
}

async function readOAuthParams(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await req.json() as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') params.set(key, value);
    }
    return params;
  }
  return new URLSearchParams(await req.text());
}

function oauthJsonError(error: string, description: string, status: number = 400): Response {
  return jsonResponse({ error, error_description: description }, status, { 'Cache-Control': 'no-store' });
}

function oauthDeviceIdFromParams(params: URLSearchParams, scopes: string[]): { ok: true; deviceId: string; setCookie?: boolean } | { ok: false; response: Response } {
  const rawDeviceId = params.get('device_id') || params.get('deviceId') || '';
  if (!rawDeviceId && scopes.includes('game')) {
    return { ok: false, response: oauthJsonError('invalid_request', 'device_id is required for the game scope.') };
  }
  if (!rawDeviceId) return { ok: true, deviceId: '' };
  const deviceId = rawDeviceId.trim();
  const deviceError = validateDeviceId(deviceId);
  if (deviceError) {
    return { ok: false, response: oauthJsonError('invalid_request', deviceError) };
  }
  return { ok: true, deviceId, setCookie: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) if (now > v.resetAt) loginAttempts.delete(k);
  for (const [k, v] of signupAttempts) if (now > v.resetAt) signupAttempts.delete(k);
  for (const [k, v] of deviceIdAttempts) if (now > v.resetAt) deviceIdAttempts.delete(k);
  for (const [k, v] of oauthTokenAttempts) if (now > v.resetAt) oauthTokenAttempts.delete(k);
  for (const map of FORUM_RATE_MAPS) for (const [k, v] of map) if (now > v.resetAt) map.delete(k);
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
const world = new World(db, {
  onPlayerAvatarDirty: (_accountId, username) => scheduleForumAvatarBake(`logout:${username}`),
});
world.start();
try {
  getWorldMapSnapshot(world);
} catch (e) {
  console.warn('[world-map] initial snapshot build failed:', e instanceof Error ? e.message : e);
}

function discordEmojiCdnUrl(id: string, animated: boolean): string {
  return `https://cdn.discordapp.com/emojis/${id}.webp${animated ? '?animated=true' : ''}`;
}

async function syncForumDiscordEmojis(reason: string = 'startup'): Promise<number> {
  const config = forumDiscordEmojiConfig();
  if (!config.enabled) {
    forumDiscordEmojiLastError = 'missing-token';
    return 0;
  }
  if (forumDiscordEmojiSyncInFlight) return forumDiscordEmojiSyncInFlight;
  forumDiscordEmojiSyncInFlight = (async () => {
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${config.guildId}/emojis`, {
      headers: {
        Authorization: `Bot ${config.botToken}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      forumDiscordEmojiLastError = `HTTP ${res.status}`;
      console.warn(`[forums] Discord emoji sync failed (${reason}): HTTP ${res.status}`);
      return 0;
    }

    const payload = await res.json() as unknown;
    if (!Array.isArray(payload)) {
      forumDiscordEmojiLastError = 'unexpected-response';
      console.warn(`[forums] Discord emoji sync failed (${reason}): unexpected response`);
      return 0;
    }

    const emojis = payload.flatMap((item: DiscordGuildEmojiPayload) => {
      const id = typeof item.id === 'string' ? item.id : '';
      const name = typeof item.name === 'string' ? item.name : '';
      if (!/^\d{8,32}$/.test(id) || !/^[A-Za-z0-9_]{2,64}$/.test(name)) return [];
      const animated = item.animated === true;
      return [{
        id,
        name,
        animated,
        available: item.available !== false,
        url: discordEmojiCdnUrl(id, animated),
      }];
    });
    const count = db.replaceForumDiscordEmojis(config.guildId, emojis);
    forumDiscordEmojiLastSyncAt = Math.floor(Date.now() / 1000);
    forumDiscordEmojiLastError = '';
    console.log(`[forums] synced ${count} Discord emoji (${reason})`);
    return count;
  } catch (error) {
    forumDiscordEmojiLastError = error instanceof Error ? error.message : String(error);
    console.warn('[forums] Discord emoji sync failed:', forumDiscordEmojiLastError);
    return 0;
  }
  })();
  try {
    return await forumDiscordEmojiSyncInFlight;
  } finally {
    forumDiscordEmojiSyncInFlight = null;
  }
}

function startForumDiscordEmojiSync(): void {
  if (!forumDiscordEmojiConfig().enabled) return;
  void syncForumDiscordEmojis('startup');
  setInterval(() => void syncForumDiscordEmojis('interval'), DISCORD_EMOJI_SYNC_INTERVAL_MS);
}

startForumDiscordEmojiSync();

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
  const bakeSecret = req.headers.get('x-forum-avatar-bake-secret') || '';
  if (bakeSecret && bakeSecret === FORUM_AVATAR_BAKE_SECRET) return true;

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
const BODY_LIMIT_OAUTH = 16 * 1024;        // 16 KB — OAuth form/token params
const BODY_LIMIT_CLIENT_LOG = 64 * 1024;   // 64 KB — perf snapshots include scene/GPU diagnostics
const BODY_LIMIT_DEV = 1 * 1024 * 1024;     // 1 MB — gear-overrides config
const BODY_LIMIT_EDITOR = 200 * 1024 * 1024; // 200 MB — full map import / save
const BODY_LIMIT_SPELL_ICON = 512 * 1024;   // 512 KB — one PNG icon
const BODY_LIMIT_FORUM_JSON = 64 * 1024;
const BODY_LIMIT_FORUM_UPLOAD = 15 * 1024 * 1024;
const MAX_SPELL_ICON_DIMENSION = 512;
const forumThreadAttempts = new Map<string, RateBucket>();
const forumReplyAttempts = new Map<string, RateBucket>();
const forumReactionAttempts = new Map<string, RateBucket>();
const forumReportAttempts = new Map<string, RateBucket>();
const forumUploadAttempts = new Map<string, RateBucket>();
const forumEditAttempts = new Map<string, RateBucket>();
const forumProfileAttempts = new Map<string, RateBucket>();
const forumGetAttempts = new Map<string, RateBucket>();
const FORUM_RATE_MAPS = [forumThreadAttempts, forumReplyAttempts, forumReactionAttempts, forumReportAttempts, forumUploadAttempts, forumEditAttempts, forumProfileAttempts, forumGetAttempts];

// Anti-spam policy knobs (env-overridable; set the age vars to 0 to disable the
// gate, e.g. for a brand-new community where waiting is undesirable).
const FORUM_MIN_THREAD_AGE_SEC = Number(process.env.FORUM_MIN_THREAD_AGE_SEC ?? 24 * 60 * 60);
const FORUM_MIN_REPLY_AGE_SEC = Number(process.env.FORUM_MIN_REPLY_AGE_SEC ?? 6 * 60 * 60);
const FORUM_MEDIA_QUOTA_BYTES = Number(process.env.FORUM_MEDIA_QUOTA_BYTES ?? 500 * 1024 * 1024);

// True when the account is younger than minAgeSec. Fails open on unknown age
// (auth is already required upstream, so this only blocks fresh signups).
function forumAccountTooNew(accountId: number, minAgeSec: number): boolean {
  if (minAgeSec <= 0) return false;
  const createdAt = db.getAccountCreatedAt(accountId);
  if (createdAt == null) return false;
  return Math.floor(Date.now() / 1000) - createdAt < minAgeSec;
}

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

function boundSessionHasAnyScope(session: NonNullable<ReturnType<typeof getBoundBearerSession>>, scopes: string[]): boolean {
  return !session.oauthClientId || scopes.some(scope => session.oauthScopes.includes(scope));
}

function getBoundBearerSessionForScope(req: Request, scope: string) {
  const session = getBoundBearerSession(req);
  if (!session || !boundSessionHasAnyScope(session, [scope])) return null;
  return session;
}

function getBoundCookieSession(req: Request) {
  const wsSecret = parseCookie(req, WS_SESSION_COOKIE);
  const session = db.getSessionByWsSecret(wsSecret);
  if (!session) return null;
  if (session.deviceId && !hasMatchingCookie(req, DEVICE_COOKIE, session.deviceId)) return null;
  return session;
}

function getStaticAssetSessionForScope(req: Request, scope: string) {
  const bearerSession = getBoundBearerSessionForScope(req, scope);
  if (bearerSession) return bearerSession;
  const cookieSession = getBoundCookieSession(req);
  if (!cookieSession || !boundSessionHasAnyScope(cookieSession, [scope])) return null;
  return cookieSession;
}

function getStaticAssetAdminSession(req: Request) {
  const bearerSession = getBoundBearerSession(req);
  if (bearerSession?.isAdmin) return bearerSession;
  const cookieSession = getBoundCookieSession(req);
  return cookieSession?.isAdmin ? cookieSession : null;
}

function getForumSession(req: Request, srv: { requestIP(req: Request): { address: string } | null }) {
  const session = getBoundBearerSession(req);
  if (!session) return null;
  if (!boundSessionHasAnyScope(session, ['forum', 'website'])) return null;
  const ip = requestClientIp(req, srv);
  if (db.isAccountBanned(session.accountId) || db.isIpBanned(ip)) return null;
  return session;
}

function isForumStaff(session: NonNullable<ReturnType<typeof getBoundBearerSession>>): boolean {
  return db.isForumModerator(session.accountId, session.isAdmin);
}

let forumAvatarBakeTimer: ReturnType<typeof setTimeout> | null = null;
let forumAvatarBakeRunning = false;
let forumAvatarBakeQueuedReason = '';
const forumAvatarBakeLog: string[] = [];

function rememberForumAvatarBakeLog(line: string): void {
  const timestamp = new Date().toISOString();
  forumAvatarBakeLog.push(`${timestamp} ${line}`);
  if (forumAvatarBakeLog.length > 80) forumAvatarBakeLog.splice(0, forumAvatarBakeLog.length - 80);
}

function scheduleForumAvatarBake(reason: string, delayMs = 2_000): void {
  if (process.env.FORUM_AVATAR_AUTO_BAKE === '0') return;
  forumAvatarBakeQueuedReason = forumAvatarBakeQueuedReason ? `${forumAvatarBakeQueuedReason},${reason}` : reason;
  if (forumAvatarBakeTimer) clearTimeout(forumAvatarBakeTimer);
  forumAvatarBakeTimer = setTimeout(() => {
    forumAvatarBakeTimer = null;
    void runForumAvatarBake(forumAvatarBakeQueuedReason || reason);
    forumAvatarBakeQueuedReason = '';
  }, delayMs);
}

async function logForumAvatarBakeStream(stream: ReadableStream<Uint8Array> | null, label: string): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk).trimEnd();
    if (text) {
      const line = `[forum-avatar-bake:${label}] ${text}`;
      rememberForumAvatarBakeLog(line);
      console.log(line);
    }
  }
}

async function runForumAvatarBake(reason: string): Promise<void> {
  if (forumAvatarBakeRunning) {
    forumAvatarBakeQueuedReason = forumAvatarBakeQueuedReason ? `${forumAvatarBakeQueuedReason},${reason}` : reason;
    return;
  }
  forumAvatarBakeRunning = true;
  try {
    const startLine = `[forum-avatar-bake] scheduling missing avatar bake (${reason})`;
    rememberForumAvatarBakeLog(startLine);
    console.log(startLine);
    const proc = Bun.spawn([
      'sh',
      '-lc',
      `bun scripts/bake-forum-avatars.ts --origin http://localhost:${SERVER_PORT}`,
    ], {
      cwd: ROOT_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FORUM_AVATAR_BAKE_SECRET, PROJECTRS_DB_PATH: DB_PATH, FORUM_AVATAR_DIR, FORUM_AVATAR_BAKE_HEADLESS: process.env.FORUM_AVATAR_BAKE_HEADLESS ?? '1' },
    });
    void logForumAvatarBakeStream(proc.stdout, 'out');
    void logForumAvatarBakeStream(proc.stderr, 'err');
    const code = await proc.exited;
    const exitLine = `[forum-avatar-bake] exited with code ${code}`;
    rememberForumAvatarBakeLog(exitLine);
    if (code !== 0) console.warn(exitLine);
    else console.log(exitLine);
  } catch (error) {
    const line = `[forum-avatar-bake] could not start: ${error instanceof Error ? error.message : String(error)}`;
    rememberForumAvatarBakeLog(line);
    console.warn(line);
  } finally {
    forumAvatarBakeRunning = false;
    if (forumAvatarBakeQueuedReason) scheduleForumAvatarBake(forumAvatarBakeQueuedReason, 1_000);
  }
}

function forumAuthError(): Response {
  return jsonResponse({ ok: false, error: 'Sign in to use the forums.' }, 401, { 'Cache-Control': 'no-store' });
}

function forumForbidden(): Response {
  return jsonResponse({ ok: false, error: 'Forum moderator permission required.' }, 403, { 'Cache-Control': 'no-store' });
}

async function readForumJson(req: Request): Promise<Record<string, unknown> | null> {
  if (!bodyWithinLimit(req, BODY_LIMIT_FORUM_JSON)) return null;
  try {
    const body = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function forumRateLimit(map: Map<string, RateBucket>, session: NonNullable<ReturnType<typeof getBoundBearerSession>>, ip: string, limit: number, windowMs: number): boolean {
  return checkRate(map, `${session.accountId}:${ip}`, limit, windowMs);
}

function serveForumMedia(pathname: string): Response | null {
  const rel = pathname.replace(/^\/forum-media\/?/, '');
  if (!rel || rel.includes('\0')) return null;
  const filePath = resolveWithinBase(FORUM_MEDIA_DIR, rel);
  if (!filePath) return null;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    return new Response(readCachedStaticFile(filePath), {
      headers: {
        'Content-Type': getMimeType(filePath),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Disposition': `inline; filename="${filePath.split(sep).pop() ?? 'media'}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return null;
  }
}

function serveForumAvatar(pathname: string): Response | null {
  const name = pathname.replace(/^\/forum-avatars\/?/, '');
  const filePath = forumAvatarFilePath(pathname);
  if (!filePath) return null;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    return new Response(readCachedStaticFile(filePath), {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Disposition': `inline; filename="${name}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    scheduleForumAvatarBake(`request:${name}`, 100);
    return null;
  }
}

async function handleForumUpload(req: Request, session: NonNullable<ReturnType<typeof getBoundBearerSession>>, ip: string): Promise<Response> {
  if (!forumRateLimit(forumUploadAttempts, session, ip, 50, 24 * 60 * 60 * 1000)) {
    return jsonResponse({ ok: false, error: 'Too many uploads today.' }, 429);
  }
  if (!bodyWithinLimit(req, BODY_LIMIT_FORUM_UPLOAD)) return tooLarge();
  if (db.countForumUploadsSince(session.accountId, Math.floor(Date.now() / 1000) - 24 * 3600) >= 50) {
    return jsonResponse({ ok: false, error: 'Daily upload limit reached.' }, 429);
  }
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return jsonResponse({ ok: false, error: 'Choose an image or GIF.' }, 400);
    const upload = await sanitizeForumUpload({ bytes: new Uint8Array(await file.arrayBuffer()), browserMime: file.type });
    if (db.sumForumMediaBytes(session.accountId) + upload.sizeBytes > FORUM_MEDIA_QUOTA_BYTES) {
      return jsonResponse({ ok: false, error: 'Storage limit reached. Delete some old images first.' }, 413);
    }
    const accountDir = resolve(FORUM_MEDIA_DIR, String(session.accountId));
    mkdirSync(accountDir, { recursive: true });
    const filename = `${crypto.randomUUID()}${upload.ext}`;
    const storagePath = resolve(accountDir, filename);
    writeFileSync(storagePath, upload.bytes);
    const url = `/forum-media/${session.accountId}/${filename}`;
    let record;
    try {
      record = db.saveForumMedia(session.accountId, storagePath, url, upload.kind, upload.mimeType, file.name || filename, upload.sizeBytes);
    } catch (dbError) {
      rmSync(storagePath, { force: true }); // don't orphan the file if the DB row fails
      throw dbError;
    }
    return jsonResponse({ ok: true, media: { id: record.id, url: record.url } });
  } catch (error) {
    console.error('[forums] upload failed:', error);
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : 'Upload failed.' }, 400);
  }
}

async function handleForumApi(req: Request, srv: { requestIP(req: Request): { address: string } | null }): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/forums')) return null;
  if (!isAllowedOrigin(req)) return new Response('Forbidden', { status: 403 });

  const rawParts = url.pathname.split('/').filter(Boolean).slice(2);
  const [resource, ...parts] = rawParts;
  const maybeSession = getForumSession(req, srv);
  const includeHidden = maybeSession ? isForumStaff(maybeSession) : false;
  const ip = requestClientIp(req, srv);

  if (req.method === 'GET') {
    if (!checkRate(forumGetAttempts, ip, 60, 10 * 1000)) return jsonResponse({ ok: false, error: 'Too many requests. Slow down.' }, 429, { 'Cache-Control': 'no-store' });
    if (!resource) {
      return jsonResponse(db.listForumThreads({
        query: url.searchParams.get('q') ?? '',
        sort: url.searchParams.get('sort') ?? 'latest',
        page: Number(url.searchParams.get('page') ?? 1),
        limit: Number(url.searchParams.get('limit') ?? 20),
        includeHidden,
      }), 200, { 'Cache-Control': 'no-store' });
    }
    if (resource === 'categories') return jsonResponse({ categories: db.listForumCategories(includeHidden) }, 200, { 'Cache-Control': 'no-store' });
    if (resource === 'emojis') {
      let emojis = db.listForumDiscordEmojis();
      const config = forumDiscordEmojiConfig();
      if (emojis.length === 0 && config.enabled && !forumDiscordEmojiSyncInFlight) {
        await syncForumDiscordEmojis('api');
        emojis = db.listForumDiscordEmojis();
      }
      return jsonResponse({
        emojis,
        discord: {
          enabled: config.enabled,
          guildId: config.guildId,
          lastSyncAt: forumDiscordEmojiLastSyncAt || null,
          lastError: forumDiscordEmojiLastError || null,
        },
      }, 200, { 'Cache-Control': 'no-store' });
    }
    if (resource === 'category' && parts[0]) {
      return jsonResponse(db.listForumThreads({
        categorySlug: parts[0],
        query: url.searchParams.get('q') ?? '',
        sort: url.searchParams.get('sort') ?? 'latest',
        page: Number(url.searchParams.get('page') ?? 1),
        limit: Number(url.searchParams.get('limit') ?? 20),
        includeHidden,
      }), 200, { 'Cache-Control': 'no-store' });
    }
    if (resource === 'thread' && parts[0] && parts[1]) {
      const thread = db.getForumThread(
        parts[0],
        parts[1],
        maybeSession?.accountId ?? null,
        includeHidden,
        Number(url.searchParams.get('page') ?? 1),
        Number(url.searchParams.get('limit') ?? 20),
      );
      return thread ? jsonResponse(stripMissingForumAvatarUrls(thread, `thread:${parts[0]}/${parts[1]}`), 200, { 'Cache-Control': 'no-store' }) : jsonResponse({ ok: false, error: 'Thread not found.' }, 404);
    }
    if (resource === 'profile' && parts[0]) {
      const profile = db.getForumProfile(parts[0]);
      return profile ? jsonResponse(stripMissingForumAvatarUrls(profile, `profile:${parts[0]}`), 200, { 'Cache-Control': 'no-store' }) : jsonResponse({ ok: false, error: 'Profile not found.' }, 404);
    }
    if (resource === 'me') {
      return maybeSession ? jsonResponse({ ok: true, accountId: maybeSession.accountId, username: maybeSession.username, isAdmin: maybeSession.isAdmin, isModerator: isForumStaff(maybeSession) }, 200, { 'Cache-Control': 'no-store' }) : jsonResponse({ ok: false }, 401);
    }
    if (resource === 'notifications') {
      if (!maybeSession) return forumAuthError();
      return jsonResponse(db.listForumNotifications(maybeSession.accountId), 200, { 'Cache-Control': 'no-store' });
    }
    if (resource === 'online') {
      return jsonResponse(stripMissingForumAvatarUrls({ users: db.listForumOnlineUsers() }, 'online'), 200, { 'Cache-Control': 'no-store' });
    }
    if (resource === 'moderation') {
      if (!maybeSession) return forumAuthError();
      if (!isForumStaff(maybeSession)) return forumForbidden();
      return jsonResponse({ reports: db.listForumReports(), moderators: db.listForumModerators(), categories: db.listForumCategories(true) }, 200, { 'Cache-Control': 'no-store' });
    }
    return jsonResponse({ ok: false, error: 'Forum endpoint not found.' }, 404);
  }

  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405);
  if (!isAllowedAuthOrigin(req)) return new Response('Forbidden', { status: 403 });
  const session = maybeSession;
  if (!session) return forumAuthError();

  if (resource === 'upload') return handleForumUpload(req, session, ip);
  if (resource === 'presence') return jsonResponse(db.touchForumPresence(session.accountId), 200, { 'Cache-Control': 'no-store' });

  const body = await readForumJson(req);
  if (!body) return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400);

  if (resource === 'thread') {
    if (forumAccountTooNew(session.accountId, FORUM_MIN_THREAD_AGE_SEC)) return jsonResponse({ ok: false, error: 'New accounts need to be a little older before starting threads. Play a bit and come back soon.' }, 403);
    if (!forumRateLimit(forumThreadAttempts, session, ip, 5, 60 * 60 * 1000)) return jsonResponse({ ok: false, error: 'Too many new threads. Try later.' }, 429);
    const result = db.createForumThread(session.accountId, Math.floor(Number(body.categoryId)), String(body.title ?? ''), String(body.body ?? ''));
    if (!result.ok) return jsonResponse(result, 400);
    audit({ type: 'forum.thread.create', tick: world.getCurrentTick(), accountId: session.accountId, details: { threadId: result.thread.id } });
    return jsonResponse(result);
  }
  if (resource === 'reply') {
    if (forumAccountTooNew(session.accountId, FORUM_MIN_REPLY_AGE_SEC)) return jsonResponse({ ok: false, error: 'New accounts need to be a little older before replying. Play a bit and come back soon.' }, 403);
    if (!forumRateLimit(forumReplyAttempts, session, ip, 30, 60 * 60 * 1000)) return jsonResponse({ ok: false, error: 'Too many replies. Try later.' }, 429);
    const result = db.createForumReply(
      session.accountId,
      Math.floor(Number(body.threadId)),
      String(body.body ?? ''),
      body.replyToPostId == null ? undefined : Math.floor(Number(body.replyToPostId)),
    );
    return jsonResponse(result, result.ok ? 200 : 400);
  }
  if (resource === 'notifications' && parts[0] === 'read') {
    return jsonResponse(db.markForumNotificationsRead(session.accountId, body.notificationId == null ? undefined : Math.floor(Number(body.notificationId))));
  }
  if (resource === 'post' && parts[0] === 'edit') {
    if (!forumRateLimit(forumEditAttempts, session, ip, 20, 60 * 60 * 1000)) return jsonResponse({ ok: false, error: 'Too many edits. Try later.' }, 429);
    const result = db.editForumPost(session.accountId, Math.floor(Number(body.postId)), String(body.body ?? ''), isForumStaff(session));
    return jsonResponse(result, result.ok ? 200 : 400);
  }
  if (resource === 'post' && parts[0] === 'delete') {
    const result = db.deleteForumPost(session.accountId, Math.floor(Number(body.postId)), isForumStaff(session));
    return jsonResponse(result, result.ok ? 200 : 400);
  }
  if (resource === 'reaction') {
    if (!forumRateLimit(forumReactionAttempts, session, ip, 120, 60 * 60 * 1000)) return jsonResponse({ ok: false, error: 'Too many reactions. Try later.' }, 429);
    const result = db.reactToForumPost(session.accountId, Math.floor(Number(body.postId)), String(body.reaction ?? ''));
    return jsonResponse(result, result.ok ? 200 : 400);
  }
  if (resource === 'report') {
    if (!forumRateLimit(forumReportAttempts, session, ip, 20, 24 * 60 * 60 * 1000)) return jsonResponse({ ok: false, error: 'Too many reports today.' }, 429);
    const result = db.reportForumPost(session.accountId, Math.floor(Number(body.postId)), String(body.reason ?? ''));
    return jsonResponse(result, result.ok ? 200 : 400);
  }
  if (resource === 'profile') {
    if (!forumRateLimit(forumProfileAttempts, session, ip, 10, 60 * 60 * 1000)) return jsonResponse({ ok: false, error: 'Too many profile updates. Try later.' }, 429);
    const hasAvatarMediaId = Object.prototype.hasOwnProperty.call(body, 'avatarMediaId');
    const result = db.updateForumProfile(session.accountId, {
      bio: body.bio === undefined ? undefined : String(body.bio),
      title: body.title === undefined ? undefined : String(body.title),
      signature: body.signature === undefined ? undefined : String(body.signature),
      avatarMediaId: hasAvatarMediaId ? (body.avatarMediaId == null ? null : Math.floor(Number(body.avatarMediaId))) : undefined,
    });
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  if (!isForumStaff(session)) return forumForbidden();
  if (resource === 'moderate' && parts[0] === 'thread') {
    const result = db.moderateForumThread(Math.floor(Number(body.threadId)), String(body.action ?? ''), body.categoryId == null ? undefined : Math.floor(Number(body.categoryId)));
    if (result.ok) audit({ type: 'forum.thread.moderate', tick: world.getCurrentTick(), accountId: session.accountId, details: body });
    return jsonResponse(result, result.ok ? 200 : 400);
  }
  if (resource === 'moderate' && parts[0] === 'post') {
    const result = db.moderateForumPost(Math.floor(Number(body.postId)), String(body.action ?? ''), String(body.reason ?? ''));
    if (result.ok) audit({ type: 'forum.post.moderate', tick: world.getCurrentTick(), accountId: session.accountId, details: body });
    return jsonResponse(result, result.ok ? 200 : 400);
  }
  if (resource === 'moderate' && parts[0] === 'category') {
    const result = db.upsertForumCategory({
      id: body.id == null ? undefined : Math.floor(Number(body.id)),
      name: String(body.name ?? ''),
      description: String(body.description ?? ''),
      sortOrder: Math.floor(Number(body.sortOrder ?? 0)),
      isHidden: body.isHidden === true,
      isLocked: body.isLocked === true,
      staffOnlyWrite: body.staffOnlyWrite === true,
    });
    return jsonResponse(result, result.ok ? 200 : 400);
  }
  if (resource === 'moderate' && parts[0] === 'report') {
    const result = db.resolveForumReport(Math.floor(Number(body.reportId)), session.accountId);
    return jsonResponse(result, result.ok ? 200 : 400);
  }
  if (resource === 'admin' && parts[0] === 'moderator') {
    if (!session.isAdmin) return adminForbidden();
    const username = String(body.username ?? '');
    const result = body.action === 'revoke'
      ? db.revokeForumModerator(username)
      : db.grantForumModerator(username, session.accountId);
    return jsonResponse(result, result.ok ? 200 : 400);
  }
  return jsonResponse({ ok: false, error: 'Forum endpoint not found.' }, 404);
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

interface HttpMapDataScanWindow {
  startedAt: number;
  lastSeenAt: number;
  requests: number;
  files: Set<string>;
  burstRecorded: boolean;
}

const HTTP_MAP_DATA_SCAN_WINDOW_MS = 60_000;
const HTTP_MAP_DATA_SCAN_UNIQUE_THRESHOLD = 180;
const HTTP_MAP_DATA_SCAN_REQUEST_THRESHOLD = 260;
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

function gameplayMapWindowForSession(
  session: NonNullable<ReturnType<typeof getBoundBearerSession>>,
  mapPath: string,
): GameplayMapPlayerWindow | null {
  const addAlternateCenter = (
    window: GameplayMapPlayerWindow | null,
    x: number,
    z: number,
  ): GameplayMapPlayerWindow | null => {
    if (!window || !Number.isFinite(x) || !Number.isFinite(z) || x < 0 || z < 0) return window;
    const chunkX = Math.floor(x / CHUNK_SIZE);
    const chunkZ = Math.floor(z / CHUNK_SIZE);
    if (chunkX === window.currentChunkX && chunkZ === window.currentChunkZ) return window;
    if (window.alternateChunks?.some(center => center.chunkX === chunkX && center.chunkZ === chunkZ)) return window;
    return {
      ...window,
      alternateChunks: [...(window.alternateChunks ?? []), { chunkX, chunkZ }],
    };
  };

  const addMapSpawnCenter = (window: GameplayMapPlayerWindow | null, mapId: string): GameplayMapPlayerWindow | null => {
    if (!window) return null;
    try {
      const spawn = world.getMap(mapId).findSpawnPoint();
      return addAlternateCenter(window, spawn.x, spawn.z);
    } catch {
      return window;
    }
  };

  const activePlayer = world.getActivePlayerByAccountId(session.accountId);
  if (activePlayer) {
    let window: GameplayMapPlayerWindow | null = {
      currentMapLevel: activePlayer.currentMapLevel,
      currentChunkX: activePlayer.currentChunkX,
      currentChunkZ: activePlayer.currentChunkZ,
    };
    const destination = activePlayer.getMoveDestination();
    if (destination) window = addAlternateCenter(window, destination.x, destination.z);
    window = addMapSpawnCenter(window, activePlayer.currentMapLevel);
    return window;
  }

  const requestedMapId = mapIdFromGameplayMapPath(mapPath);
  if (!requestedMapId) return null;

  const saved = db.loadPlayerState(session.accountId);
  const savedMapId = saved?.mapLevel ?? 'kcmap';
  if (savedMapId !== requestedMapId) return null;

  try {
    const map = world.getMap(savedMapId);
    const useSpawn = !saved
      || (saved.respawnVersion ?? 0) < WORLD_RESPAWN_VERSION
      || !Number.isFinite(saved.x)
      || !Number.isFinite(saved.z)
      || saved.x < 0
      || saved.z < 0
      || saved.x >= map.width
      || saved.z >= map.height;
    const spawn = map.findSpawnPoint();
    const pos = useSpawn ? spawn : { x: saved.x, z: saved.z };
    let window = gameplayMapPlayerWindowFromWorldPosition(savedMapId, pos.x, pos.z);
    window = addAlternateCenter(window, spawn.x, spawn.z);
    return window;
  } catch {
    return null;
  }
}

// Clean expired sessions every 10 minutes
setInterval(() => {
  db.cleanExpiredSessions();
  db.cleanupOldForumNotifications(Math.floor(Date.now() / 1000) - 90 * 24 * 3600);
  db.flushGameEventLog();
}, 10 * 60 * 1000);

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
  try { db.flushGameEventLog(); } catch (e) { console.error('[shutdown] flushGameEventLog() failed:', e); }
  // Drain any in-memory audit events synchronously so we don't lose the last
  // ~1s of forensic log on restart.
  try { flushAuditSync(); } catch (e) { console.error('[shutdown] flushAuditSync() failed:', e); }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

type WebsiteDevSocketData = {
  type: 'website-dev';
  targetUrl: string;
  upstream?: WebSocket;
  upstreamOpen?: boolean;
  pendingMessages: string[];
};

type SocketData = GameSocketData | ChatSocketData | WebsiteDevSocketData;

async function rawFetch(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
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

    if (url.pathname.startsWith('/forum-media/')) {
      const media = serveForumMedia(url.pathname);
      if (media) return media;
      return new Response('Not Found', { status: 404 });
    }

    if (url.pathname.startsWith('/forum-avatars/')) {
      const avatar = serveForumAvatar(url.pathname);
      if (avatar) return avatar;
      return new Response('Not Found', { status: 404 });
    }

    const forumApiResponse = await handleForumApi(req, server);
    if (forumApiResponse) return forumApiResponse;

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
      if (!bodyWithinLimit(req, BODY_LIMIT_CLIENT_LOG)) return tooLarge();
      try {
        const body = await req.json() as { event?: string; username?: string; details?: unknown; at?: number };
        const event = String(body.event ?? 'unknown').slice(0, 96);
        const username = String(body.username ?? 'unknown').slice(0, 64);
        console.warn(clientLogConsoleSummary(event, username, body.details ?? {}));
        audit({
          type: 'client.log',
          tick: world.getCurrentTick(),
          details: {
            event,
            username,
            clientAt: Number.isFinite(body.at) ? body.at : undefined,
            payload: body.details ?? {},
          },
        });
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
        url.searchParams.get('sort') ?? 'rank',
        url.searchParams.get('dir') ?? 'asc',
      ));
    }

    if (url.pathname === '/api/hiscores/player' && req.method === 'GET') {
      const profile = db.getHiscoreProfile(url.searchParams.get('username') ?? '', getHiscoreMobs(world));
      if (!profile) return jsonResponse({ ok: false, error: 'Player profile not found.' }, 404);
      return jsonResponse(stripMissingForumAvatarUrls(profile, `hiscores:${profile.username}`));
    }

    if (url.pathname === '/api/forum-avatar-bake-status' && req.method === 'GET') {
      const targets = db.listForumAvatarBakeTargets();
      let baked = 0;
      for (const target of targets) {
        if (existsSync(resolve(FORUM_AVATAR_DIR, `${target.accountId}-${target.hash}.webp`))) baked++;
      }
      return jsonResponse({
        running: forumAvatarBakeRunning,
        queuedReason: forumAvatarBakeQueuedReason,
        targetCount: targets.length,
        baked,
        missing: Math.max(0, targets.length - baked),
        log: forumAvatarBakeLog.slice(-30),
      }, 200, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/api/hiscores/kills' && req.method === 'GET') {
      // Selectable mobs = attackable NPCs only. Vendors/bankers (shop /
      // bankAccess / dialogue) are not killable, so they never appear in the
      // picker. Derived live from the NPC defs so editor changes flow through.
      const mobs = getHiscoreMobs(world);
      const npcParam = url.searchParams.get('npc');
      return jsonResponse(db.getMobKillHiscores(
        npcParam ? Number(npcParam) : null,
        Number(url.searchParams.get('limit') ?? 25),
        Number(url.searchParams.get('page') ?? 1),
        url.searchParams.get('q') ?? '',
        mobs,
        url.searchParams.get('sort') ?? 'rank',
        url.searchParams.get('dir') ?? 'asc',
      ));
    }

    if (url.pathname === '/api/world-map' && req.method === 'GET') {
      return jsonResponse(getWorldMapSnapshot(world), 200, { 'Cache-Control': 'public, max-age=60' });
    }

    if (url.pathname === '/api/world-map/live' && req.method === 'GET') {
      return jsonResponse({ ok: false, error: 'The public World Map does not expose live player tracking.' }, 410, { 'Cache-Control': 'no-store' });
    }

    // --- OAuth Endpoints (Authorization Code + PKCE for approved native clients) ---

    if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
      const validation = validateOAuthAuthorizeParams(oauthParamsFromSearch(url.searchParams), OAUTH_CLIENTS);
      if (!validation.ok) {
        return renderOAuthErrorPage(validation.error, validation.description);
      }
      const preauthCookie = maybeIssuePreauthBootstrap(req);
      return htmlResponse(
        renderOAuthAuthorizePage(validation.request),
        200,
        preauthCookie ? { 'Set-Cookie': preauthCookie } : {},
      );
    }

    if (url.pathname === '/oauth/authorize' && req.method === 'POST') {
      if (!isAllowedOAuthClientOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_OAUTH)) return tooLarge();
      const ip = requestClientIp(req, server);
      try {
        const params = await readOAuthParams(req);
        const validation = validateOAuthAuthorizeParams(oauthParamsFromSearch(params), OAUTH_CLIENTS);
        if (!validation.ok) {
          const redirectUri = params.get('redirect_uri') ?? '';
          const state = params.get('state') ?? '';
          const clientId = params.get('client_id') ?? '';
          const client = OAUTH_CLIENTS.get(clientId);
          if (client && redirectUri) {
            const redirectValidation = validateOAuthAuthorizeParams({
              ...oauthParamsFromSearch(params),
              responseType: 'code',
              codeChallengeMethod: 'S256',
            }, OAUTH_CLIENTS);
            if (redirectValidation.ok) return redirectOAuthError(redirectUri, state, validation.error, validation.description);
          }
          return renderOAuthErrorPage(validation.error, validation.description);
        }
        const request = validation.request;
        const preauthReason = validatePreauthBootstrap(req);
        if (preauthReason) {
          console.warn(`[auth] rejected oauth authorize: preauth=${preauthReason} ip=${ip} ua=${(req.headers.get('user-agent') || 'unknown').slice(0, 120)}`);
          return htmlResponse(renderOAuthAuthorizePage(request, 'Please refresh the page and try again.'), 400);
        }
        const username = (params.get('username') || '').toLowerCase();
        const password = params.get('password') || '';
        if (!username || !password) {
          return htmlResponse(renderOAuthAuthorizePage(request, 'Enter your username and password.'), 400);
        }
        const key = `${username}:${ip}`;
        if (!checkRate(loginAttempts, key, LOGIN_LIMIT, LOGIN_WINDOW_MS)) {
          return htmlResponse(renderOAuthAuthorizePage(request, 'Too many login attempts. Try again in a minute.'), 429);
        }
        const captcha = await verifyRecaptchaToken(params.get('recaptchaToken') || undefined, 'login', ip);
        if (!captcha.ok) {
          return htmlResponse(renderOAuthAuthorizePage(request, captcha.error || 'Captcha failed.'), 400);
        }
        if (db.isIpBanned(ip)) {
          return htmlResponse(renderOAuthAuthorizePage(request, 'Banned'), 403);
        }
        const account = await db.verifyAccountPassword(username, password);
        if (!account) {
          return htmlResponse(renderOAuthAuthorizePage(request, 'Invalid username or password.'), 400);
        }
        if (db.isAccountBanned(account.accountId)) {
          return htmlResponse(renderOAuthAuthorizePage(request, 'Banned'), 403);
        }
        loginAttempts.delete(key);
        const { code } = db.createOAuthAuthorizationCode({
          accountId: account.accountId,
          clientId: request.client.id,
          redirectUri: request.redirectUri,
          scopes: request.scopes,
          codeChallenge: request.codeChallenge,
        });
        return redirectOAuthCode(request.redirectUri, request.state, code);
      } catch {
        return renderOAuthErrorPage('invalid_request', 'Invalid OAuth authorization request.');
      }
    }

    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      if (!isAllowedOAuthClientOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_OAUTH)) return tooLarge();
      const ip = requestClientIp(req, server);
      try {
        const params = await readOAuthParams(req);
        const grantType = params.get('grant_type') || '';
        const clientId = params.get('client_id') || '';
        const client = OAUTH_CLIENTS.get(clientId);
        const rateKey = `${clientId || 'missing'}:${ip}`;
        if (!checkRate(oauthTokenAttempts, rateKey, OAUTH_TOKEN_LIMIT, OAUTH_TOKEN_WINDOW_MS)) {
          return oauthJsonError('slow_down', 'Too many token requests. Try again later.', 429);
        }
        if (!client) return oauthJsonError('invalid_client', 'Unknown OAuth client.', 400);

        let tokenResult: ReturnType<typeof db.createOAuthSession> = null;
        let deviceId = '';
        let setDeviceCookie = false;

        if (grantType === 'authorization_code') {
          const code = params.get('code') || '';
          const redirectUri = params.get('redirect_uri') || '';
          const codeVerifier = params.get('code_verifier') || '';
          if (!code || !redirectUri || !codeVerifier) {
            return oauthJsonError('invalid_request', 'code, redirect_uri, and code_verifier are required.');
          }
          const codeRecord = db.consumeOAuthAuthorizationCode(code, client.id, redirectUri);
          if (!codeRecord || !verifyPkceS256(codeVerifier, codeRecord.codeChallenge)) {
            return oauthJsonError('invalid_grant', 'Authorization code is invalid or expired.');
          }
          const device = oauthDeviceIdFromParams(params, codeRecord.scopes);
          if (!device.ok) return device.response;
          deviceId = device.deviceId;
          setDeviceCookie = device.setCookie === true;
          const account = db.getAccountAuthInfo(codeRecord.accountId);
          if (!account) return oauthJsonError('invalid_grant', 'Account no longer exists.');
          if (db.isAccountBanned(account.accountId) || db.isIpBanned(ip)) {
            return oauthJsonError('access_denied', 'This account cannot log in.', 403);
          }
          if (!account.isAdmin && deviceId && world.hasOtherActiveAccountFromDevice(deviceId, account.accountId)) {
            return oauthJsonError('access_denied', 'Another account is already logged in on this device.', 403);
          }
          tokenResult = db.createOAuthSession(account.accountId, client.id, codeRecord.scopes, deviceId);
        } else if (grantType === 'refresh_token') {
          const refreshToken = params.get('refresh_token') || '';
          if (!refreshToken) return oauthJsonError('invalid_request', 'refresh_token is required.');
          const refreshInfo = db.getOAuthRefreshTokenInfo(refreshToken, client.id);
          if (!refreshInfo) return oauthJsonError('invalid_grant', 'Refresh token is invalid or expired.');
          const device = oauthDeviceIdFromParams(params, refreshInfo.scopes);
          if (!device.ok) return device.response;
          deviceId = device.deviceId;
          setDeviceCookie = device.setCookie === true;
          const account = db.getAccountAuthInfo(refreshInfo.accountId);
          if (!account) return oauthJsonError('invalid_grant', 'Account no longer exists.');
          if (db.isAccountBanned(account.accountId) || db.isIpBanned(ip)) {
            return oauthJsonError('access_denied', 'This account cannot log in.', 403);
          }
          if (!account.isAdmin && deviceId && world.hasOtherActiveAccountFromDevice(deviceId, account.accountId)) {
            return oauthJsonError('access_denied', 'Another account is already logged in on this device.', 403);
          }
          tokenResult = db.refreshOAuthSession(refreshToken, client.id, deviceId);
        } else {
          return oauthJsonError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
        }

        if (!tokenResult) return oauthJsonError('invalid_grant', 'Token grant could not be completed.');
        const cookies = [wsSessionCookieHeader(tokenResult.wsSecret, req)];
        if (setDeviceCookie) cookies.push(deviceCookieHeader(deviceId, req));
        return jsonResponseWithSetCookies({
          access_token: tokenResult.token,
          token_type: 'Bearer',
          expires_in: tokenResult.expiresIn,
          refresh_token: tokenResult.refreshToken,
          scope: tokenResult.scopes.join(' '),
          client_id: tokenResult.clientId,
          username: tokenResult.username,
        }, 200, cookies);
      } catch {
        return oauthJsonError('invalid_request', 'Invalid token request.');
      }
    }

    if (url.pathname === '/oauth/revoke' && req.method === 'POST') {
      if (!isAllowedOAuthClientOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_OAUTH)) return tooLarge();
      try {
        const params = await readOAuthParams(req);
        const clientId = params.get('client_id') || '';
        if (clientId && !OAUTH_CLIENTS.has(clientId)) return oauthJsonError('invalid_client', 'Unknown OAuth client.', 400);
        const token = params.get('token') || '';
        if (token) db.revokeOAuthToken(token);
        return jsonResponse({ ok: true }, 200, { 'Cache-Control': 'no-store' });
      } catch {
        return oauthJsonError('invalid_request', 'Invalid revoke request.');
      }
    }

    // --- REST Auth Endpoints ---

    if (url.pathname === '/api/signup' && req.method === 'POST') {
      if (!isAllowedAuthOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      if (!PUBLIC_SIGNUPS_ENABLED) {
        return jsonResponse({ ok: false, error: ACCOUNT_CREATION_CLOSED_MESSAGE }, 403);
      }
      const ip = requestClientIp(req, server);
      if (db.isIpBanned(ip)) {
        return jsonResponse({ ok: false, error: 'Banned' }, 403);
      }
      const preauthFailure = preauthFailureResponse(req, ip, 'signup');
      if (preauthFailure) return preauthFailure;
      try {
        const body = await req.json() as { username?: string; password?: string; deviceId?: string; recaptchaToken?: string };
        const device = validateSignupDevice(req, body.deviceId);
        if (!device.ok) return jsonResponse({ ok: false, error: device.error }, 400);
        const username = typeof body.username === 'string' ? body.username : '';
        const key = ip;
        if (!checkRate(signupAttempts, key, SIGNUP_LIMIT, SIGNUP_WINDOW_MS)) {
          return jsonResponse({ ok: false, error: 'Too many signup attempts. Try again later.' }, 429);
        }
        const captcha = await verifyRecaptchaToken(body.recaptchaToken, 'signup', ip);
        if (!captcha.ok) return jsonResponse({ ok: false, error: captcha.error || 'Captcha failed' }, 400);
        const result = await db.createAccount(username, body.password || '', device.deviceId, ip);
        if (result.ok) {
          signupAttempts.delete(key);
          return jsonResponse(
            { ok: true, token: result.token, username, lastLoginTs: null, isAdmin: result.isAdmin, isModerator: result.isModerator },
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
        if (db.isIpBanned(ip)) {
          return jsonResponse({ ok: false, error: 'Banned' }, 403);
        }
        const password = body.password || '';
        const useFallbackLogin = FALLBACK_LOGIN_ENABLED
          && username === FALLBACK_LOGIN_USERNAME
          && password === FALLBACK_LOGIN_PASSWORD;
        const result = useFallbackLogin
          ? db.loginFallbackAccount(FALLBACK_LOGIN_USERNAME, deviceId)
          : await db.login(body.username || '', password, deviceId);
        if (result.ok) {
          const lastLoginTs = db.getLastLoginTs(result.accountId);
          // Account-ban gate runs AFTER successful auth so we don't reveal
          // ban status to someone who can't even produce the password.
          if (db.isAccountBanned(result.accountId)) {
            db.logout(result.token);
            return jsonResponse({ ok: false, error: 'Banned' }, 403);
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
            { ok: true, token: result.token, username: result.username, lastLoginTs, isAdmin: result.isAdmin, isModerator: result.isModerator },
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
          { ok: true, username: session.username, lastLoginTs: db.getLastLoginTs(session.accountId) },
          200,
          wsSecret ? { 'Set-Cookie': wsSessionCookieHeader(wsSecret, req) } : {},
        );
      } catch {
        return jsonResponse({ ok: false });
      }
    }

    if (url.pathname === '/api/session' && req.method === 'GET') {
      if (!isAllowedOrigin(req)) return new Response('Forbidden', { status: 403 });
      const session = getBoundBearerSession(req);
      if (!session) return jsonResponse({ ok: false }, 401, { 'Cache-Control': 'no-store' });
      const ip = requestClientIp(req, server);
      if (db.isAccountBanned(session.accountId) || db.isIpBanned(ip)) {
        return jsonResponse({ ok: false }, 403, { 'Cache-Control': 'no-store' });
      }
      return jsonResponse(
        { ok: true, username: session.username, isAdmin: session.isAdmin, isModerator: session.isModerator },
        200,
        { 'Cache-Control': 'no-store' },
      );
    }

    if (url.pathname === '/api/device-key' && req.method === 'POST') {
      if (!isAllowedAuthOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const session = getBoundBearerSessionForScope(req, 'game');
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
      const query = url.searchParams.get('q') ?? url.searchParams.get('query') ?? '';
      return jsonResponse({
        ok: true,
        generatedAt: Math.floor(Date.now() / 1000),
        accounts: db.listAdminBotReviewAccounts(limit, query).map(account => ({
          ...account,
          online: !!world.getActivePlayerByAccountId(account.accountId),
        })),
      });
    }

    if (url.pathname === '/api/admin/bot-review/clear' && req.method === 'POST') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      const cleared = db.clearBotStats();
      const resetActive = world.resetActiveBotStats();
      audit({
        type: 'admin',
        tick: world.getCurrentTick(),
        accountId: session.accountId,
        details: { action: 'clear_bot_review_stats', cleared, resetActive },
      });
      return jsonResponse({ ok: true, cleared, resetActive });
    }

    if (url.pathname === '/api/admin/bot-review/clear-account' && req.method === 'POST') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { accountId?: unknown };
        const accountId = Number(body.accountId);
        if (!Number.isInteger(accountId) || accountId <= 0) {
          return jsonResponse({ ok: false, error: 'Invalid accountId' }, 400);
        }
        const cleared = db.clearBotStatsForAccount(accountId);
        const resetActive = world.resetActiveBotStatsForAccount(accountId);
        audit({
          type: 'admin',
          tick: world.getCurrentTick(),
          accountId: session.accountId,
          details: { action: 'clear_account_bot_review_stats', targetAccountId: accountId, cleared, resetActive },
        });
        return jsonResponse({ ok: true, cleared, resetActive });
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/admin/bot-review/teleport' && req.method === 'POST') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { accountId?: unknown; direction?: unknown };
        const accountId = Number(body.accountId);
        const direction = String(body.direction ?? '');
        if (!Number.isInteger(accountId) || accountId <= 0) {
          return jsonResponse({ ok: false, error: 'Invalid accountId' }, 400);
        }
        if (direction !== 'to-target' && direction !== 'to-admin') {
          return jsonResponse({ ok: false, error: 'Invalid teleport direction' }, 400);
        }
        const adminPlayer = world.getActivePlayerByAccountId(session.accountId);
        if (!adminPlayer) return jsonResponse({ ok: false, error: 'You are not online in game' }, 409);
        const target = world.getActivePlayerByAccountId(accountId);
        if (!target) return jsonResponse({ ok: false, error: 'Target player is not online' }, 404);
        if (direction === 'to-target') {
          adminTeleportPlayerToPlayer(world, adminPlayer, target);
        } else {
          if (target.id === adminPlayer.id) return jsonResponse({ ok: false, error: 'Cannot teleport yourself to yourself' }, 400);
          adminTeleportPlayerToPlayer(world, target, adminPlayer);
        }
        audit({
          type: 'admin',
          tick: world.getCurrentTick(),
          accountId: session.accountId,
          details: { action: 'admin_bot_review_teleport', direction, targetAccountId: accountId },
        });
        return jsonResponse({ ok: true });
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/admin/game-events' && req.method === 'GET') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      const limit = Number(url.searchParams.get('limit') ?? '200');
      const afterId = Number(url.searchParams.get('afterId') ?? '0');
      const excludeTypes = [
        ...url.searchParams.getAll('excludeType'),
        ...(url.searchParams.get('excludeTypes') ?? '').split(','),
      ].map(value => value.trim()).filter(Boolean);
      const snapshot = db.getGameEventLogSnapshot({
        afterId,
        limit,
        excludeTypes,
        user: url.searchParams.get('user'),
        query: url.searchParams.get('q') ?? url.searchParams.get('query'),
      });
      return jsonResponse({
        ok: true,
        generatedAt: Math.floor(Date.now() / 1000),
        latestId: snapshot.latestId,
        events: snapshot.events,
      });
    }

    if (url.pathname === '/api/admin/client-diagnostics' && req.method === 'GET') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      const limit = boundedIntegerParam(
        url.searchParams.get('limit'),
        CLIENT_DIAGNOSTICS_DEFAULT_LIMIT,
        1,
        CLIENT_DIAGNOSTICS_MAX_LIMIT,
      );
      const tailBytes = boundedIntegerParam(
        url.searchParams.get('bytes'),
        CLIENT_DIAGNOSTICS_DEFAULT_TAIL_BYTES,
        1024,
        CLIENT_DIAGNOSTICS_MAX_TAIL_BYTES,
      );
      const diagnostics = await readRecentClientDiagnostics({
        limit,
        tailBytes,
        event: url.searchParams.get('event'),
        username: url.searchParams.get('user') ?? url.searchParams.get('username'),
        query: url.searchParams.get('q') ?? url.searchParams.get('query'),
      });
      return jsonResponse({
        ok: true,
        generatedAt: Math.floor(Date.now() / 1000),
        ...diagnostics,
      }, 200, { 'Cache-Control': 'no-store' });
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

    if (url.pathname === '/api/admin/mute-account' && req.method === 'POST') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { accountId?: unknown; reason?: unknown; durationSeconds?: unknown };
        const accountId = Math.floor(Number(body.accountId));
        if (!Number.isInteger(accountId) || accountId <= 0) return jsonResponse({ ok: false, error: 'Invalid account' }, 400);
        if (accountId === session.accountId) return jsonResponse({ ok: false, error: 'You cannot mute your own account' }, 400);
        const target = db.getAccountModerationInfo(accountId);
        if (!target) return jsonResponse({ ok: false, error: 'Account not found' }, 404);
        if (target.isAdmin) return jsonResponse({ ok: false, error: 'Admin accounts cannot be muted here' }, 400);
        const duration = parseBanExpiresAt(body.durationSeconds);
        if (!duration.ok) return jsonResponse({ ok: false, error: duration.error }, 400);
        const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
        db.muteAccount(accountId, reason, session.username, duration.expiresAt);
        return jsonResponse({
          ok: true,
          message: `Muted ${target.username} (${banLabel(duration.expiresAt)})`,
          mute: db.getAccountMuteRecord(accountId),
        });
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/admin/unmute-account' && req.method === 'POST') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { accountId?: unknown };
        const accountId = Math.floor(Number(body.accountId));
        if (!Number.isInteger(accountId) || accountId <= 0) return jsonResponse({ ok: false, error: 'Invalid account' }, 400);
        return jsonResponse({ ok: true, removed: db.unmuteAccount(accountId) });
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/admin/set-moderator' && req.method === 'POST') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { accountId?: unknown; enabled?: unknown };
        const accountId = Math.floor(Number(body.accountId));
        if (!Number.isInteger(accountId) || accountId <= 0) return jsonResponse({ ok: false, error: 'Invalid account' }, 400);
        if (typeof body.enabled !== 'boolean') return jsonResponse({ ok: false, error: 'Invalid moderator value' }, 400);
        const target = db.setAccountModeratorRole(accountId, body.enabled);
        if (!target) return jsonResponse({ ok: false, error: 'Account not found' }, 404);
        world.setActiveAccountModerator(accountId, target.isModerator);
        setChatAccountModerator(accountId, target.isModerator);
        return jsonResponse({
          ok: true,
          account: target,
          message: `${target.isModerator ? 'Granted' : 'Removed'} moderator role for ${target.username}`,
        });
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/admin/grant-admin' && req.method === 'POST') {
      const session = getBoundBearerSession(req);
      if (!session?.isAdmin) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { accountId?: unknown };
        const accountId = Math.floor(Number(body.accountId));
        if (!Number.isInteger(accountId) || accountId <= 0) return jsonResponse({ ok: false, error: 'Invalid account' }, 400);
        const target = db.setAccountAdminRole(accountId, true);
        if (!target) return jsonResponse({ ok: false, error: 'Account not found' }, 404);
        world.setActiveAccountAdmin(accountId, target.isAdmin);
        setChatAccountAdmin(accountId, target.isAdmin);
        return jsonResponse({
          ok: true,
          account: target,
          message: `Granted admin role for ${target.username}`,
        });
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

    // --- Website Dev WebSocket Proxy (Next HMR) ---

    if (WEBSITE_DEV_ORIGIN && url.pathname === '/_next/webpack-hmr') {
      const targetUrl = getWebsiteDevWebSocketUrl(req.url);
      if (!targetUrl) return new Response('Website dev proxy unavailable', { status: 503 });
      const upgraded = server.upgrade(req, {
        data: { type: 'website-dev', targetUrl, pendingMessages: [] } as WebsiteDevSocketData,
      });
      if (upgraded) return undefined as unknown as Response;
      return new Response('Website dev WebSocket upgrade failed', { status: 400 });
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
      if (!boundSessionHasAnyScope(session, ['game'])) {
        return new Response('Forbidden', { status: 403 });
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
        data: { type: 'game', accountId: session.accountId, username: session.username, isAdmin: session.isAdmin, isModerator: session.isModerator, ip: wsIp, deviceId: session.deviceId, token } as GameSocketData,
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
      if (!boundSessionHasAnyScope(session, ['game'])) {
        return new Response('Forbidden', { status: 403 });
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
        data: { type: 'chat', accountId: session.accountId, username: session.username, isAdmin: session.isAdmin, isModerator: session.isModerator } as ChatSocketData,
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
      const hasBakeSecret = (req.headers.get('x-forum-avatar-bake-secret') || '') === FORUM_AVATAR_BAKE_SECRET;
      const boundDataSession = getBoundBearerSessionForScope(req, 'game');
      if (isProductionLike() && !hasBakeSecret && !boundDataSession) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (isProductionLike() && !hasBakeSecret && !boundDataSession?.isAdmin && !isPublicDataFile(filename)) {
        return new Response('Not Found', { status: 404 });
      }
      // Symlink-safe path resolution. Without realpath, a `server/data/evil ->
      // /etc/passwd` symlink would defeat the startsWith check.
      const filePath = resolveWithinBase(DATA_DIR, filename);
      if (!filePath) return new Response('Forbidden', { status: 403 });
      try {
        const content = readPublicDataContent(filename, filePath, isProductionLike() && !hasBakeSecret && !boundDataSession?.isAdmin);
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
        const body = await req.json() as { id?: unknown; file?: unknown; dataUrl?: unknown };
        const id = Number(body.id);
        const requestedFile = typeof body.file === 'string' ? body.file : `/items/3d/${id}.png`;
        const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
        if (!Number.isInteger(id) || id <= 0 || id > 1_000_000) {
          return jsonResponse({ ok: false, error: 'Invalid item id' }, 400);
        }
        const fileName = requestedFile.startsWith('/items/3d/') ? requestedFile.slice('/items/3d/'.length) : '';
        if (!new RegExp(`^${id}(?:-[0-9]+)?\\.png$`).test(fileName)) {
          return jsonResponse({ ok: false, error: 'Invalid item thumbnail file' }, 400);
        }
        const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
        if (!m) return jsonResponse({ ok: false, error: 'Expected PNG dataURL' }, 400);
        const pngBytes = Buffer.from(m[1], 'base64');
        if (pngBytes.length > 256 * 1024) {
          return jsonResponse({ ok: false, error: `PNG too large: ${pngBytes.length}` }, 400);
        }
        const outDir = resolve(import.meta.dir, '../../client/public/items/3d');
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        const outPath = resolve(outDir, fileName);
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

    if (url.pathname === '/api/dev/forum-avatar-targets' && req.method === 'GET') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      const targets = db.listForumAvatarBakeTargets().map((target) => {
        const filePath = resolve(FORUM_AVATAR_DIR, `${target.accountId}-${target.hash}.webp`);
        return { ...target, baked: existsSync(filePath) };
      });
      return jsonResponse({ targets }, 200, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/api/dev/forum-avatar' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const body = await req.json() as { accountId?: unknown; hash?: unknown; dataUrl?: unknown };
        const accountId = Number(body.accountId);
        const hash = typeof body.hash === 'string' ? body.hash : '';
        const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
        if (!Number.isInteger(accountId) || accountId <= 0 || accountId > 1_000_000) {
          return jsonResponse({ ok: false, error: 'Invalid account id' }, 400);
        }
        if (!/^[a-f0-9]{16}$/.test(hash)) return jsonResponse({ ok: false, error: 'Invalid avatar hash' }, 400);
        const current = db.listForumAvatarBakeTargets().find((target) => target.accountId === accountId);
        if (!current || current.hash !== hash) return jsonResponse({ ok: false, error: 'Avatar target is stale.' }, 409);
        const m = /^data:image\/webp;base64,(.+)$/.exec(dataUrl);
        if (!m) return jsonResponse({ ok: false, error: 'Expected WebP dataURL' }, 400);
        const webpBytes = Buffer.from(m[1], 'base64');
        if (webpBytes.length > 128 * 1024) {
          return jsonResponse({ ok: false, error: `WebP too large: ${webpBytes.length}` }, 400);
        }
        if (!existsSync(FORUM_AVATAR_DIR)) mkdirSync(FORUM_AVATAR_DIR, { recursive: true });
        const outPath = resolve(FORUM_AVATAR_DIR, `${accountId}-${hash}.webp`);
        if (!outPath.startsWith(FORUM_AVATAR_DIR + sep)) return jsonResponse({ ok: false, error: 'Path outside output dir' }, 400);
        writeFileSync(outPath, webpBytes);
        return jsonResponse({ ok: true, url: `/forum-avatars/${accountId}-${hash}.webp`, bytes: webpBytes.length });
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
        type ManifestLeaf = { file: string; poseKey: string; rendererVersion?: number };
        type ManifestEntry = ManifestLeaf | { variants: ManifestLeaf[] };
        const manifestEntries: Record<string, ManifestEntry> = {};
        const sanitizeLeaf = (id: number, raw: unknown): ManifestLeaf | null => {
          if (!raw || typeof raw !== 'object') return null;
          const entry = raw as Record<string, unknown>;
          const file = typeof entry.file === 'string' ? entry.file : `/items/3d/${id}.png`;
          const poseKey = typeof entry.poseKey === 'string' ? entry.poseKey : '';
          const rendererVersion = entry.rendererVersion;
          const fileName = file.startsWith('/items/3d/') ? file.slice('/items/3d/'.length) : '';
          if (!new RegExp(`^${id}(?:-[0-9]+)?\\.png$`).test(fileName)) return null;
          if (!poseKey || poseKey.length > 2048) return null;
          return {
            file,
            poseKey,
            ...(typeof rendererVersion === 'number' && Number.isFinite(rendererVersion)
              ? { rendererVersion }
              : {}),
          };
        };
        const sanitizeEntry = (id: number, raw: unknown): ManifestEntry | null => {
          const direct = sanitizeLeaf(id, raw);
          if (raw && typeof raw === 'object') {
            const variants = (raw as { variants?: unknown }).variants;
            if (Array.isArray(variants)) {
              const sanitized = variants
                .map(variant => sanitizeLeaf(id, variant))
                .filter((variant): variant is ManifestLeaf => !!variant);
              if (direct) sanitized.unshift(direct);
              if (sanitized.length) return { variants: sanitized };
            }
          }
          return direct;
        };
        if (body.entries && typeof body.entries === 'object') {
          for (const [key, raw] of Object.entries(body.entries as Record<string, unknown>)) {
            const id = Number(key);
            if (!Number.isInteger(id) || id <= 0 || id > 1_000_000) continue;
            const entry = sanitizeEntry(id, raw);
            if (entry) manifestEntries[String(id)] = entry;
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
      if (isProductionLike() && !getBoundBearerSessionForScope(req, 'game')) {
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
              let mapType: string | undefined;
              try {
                const mapFile = JSON.parse(readFileSync(resolve(MAPS_DIR, e.name, 'map.json'), 'utf-8'));
                if (typeof mapFile?.map?.mapType === 'string') mapType = mapFile.map.mapType;
              } catch { /* map type is optional for legacy maps */ }
              return { id: meta.id, name: meta.name, width: meta.width, height: meta.height, mapType };
            } catch {
              return { id: e.name, name: e.name, width: 0, height: 0 };
            }
          });
        return jsonResponse({ ok: true, maps });
      } catch {
        return jsonResponse({ ok: false, error: 'Failed to list maps' }, 500);
      }
    }

    if (url.pathname === '/api/editor/teleport-entries' && req.method === 'GET') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      try {
        return jsonResponse({ ok: true, ...buildEditorTeleportData() });
      } catch {
        return jsonResponse({ ok: false, error: 'Failed to scan teleport entries' }, 500);
      }
    }

    if (url.pathname === '/api/editor/minimap-icons' && req.method === 'GET') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      try {
        const iconDir = resolve(import.meta.dir, '../../client/public/minimap/icons');
        if (!existsSync(iconDir)) mkdirSync(iconDir, { recursive: true });
        const icons = readdirSync(iconDir, { withFileTypes: true })
          .filter(entry => entry.isFile() && isValidMinimapIconFilename(entry.name))
          .map(entry => entry.name)
          .sort((a, b) => a.localeCompare(b))
          .map((file) => ({
            file,
            url: `/minimap/icons/${encodeURIComponent(file)}`,
            label: file.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
          }));
        return jsonResponse({ ok: true, icons });
      } catch {
        return jsonResponse({ ok: false, error: 'Failed to list minimap icons' }, 500);
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
        const mapWidth = mapData.map?.width ?? meta.width;
        const mapHeight = mapData.map?.height ?? meta.height;
        const npcSpawnIssues = validateNpcSpawnsForAuthoring({
          mapId,
          width: mapWidth,
          height: mapHeight,
          spawns: mergedSpawns.npcs,
          resolveNpcDef: npcId => world.data.getNpc(npcId),
        });
        const npcSpawnErrors = npcSpawnIssues.filter(issue => issue.severity === 'error');
        if (npcSpawnErrors.length > 0) {
          return jsonResponse({
            ok: false,
            error: `Refusing to save NPC spawns:\n${formatNpcAuthoringIssues(npcSpawnErrors)}`,
          }, 409);
        }
        const bulkNpcOffset = detectUniformNpcSpawnOffset(existingSpawns, mergedSpawns);
        if (bulkNpcOffset && !mapShapeChanged(existingMapForShape, mapData)) {
          return jsonResponse({
            ok: false,
            error: `Refusing to save: ${bulkNpcOffset.count}/${bulkNpcOffset.matched} NPC spawns moved by the same chunk offset (${bulkNpcOffset.dx}, ${bulkNpcOffset.dz}). Reload the editor map before saving.`,
          }, 409);
        }

        let existingObjectsForSave = loadChunkedObjects(mapDir);
        let objectsToSave = dedupePlacedObjects(mapData.placedObjects ?? [], 'placed object(s) from editor payload');
        // Preserve existing objects if editor sends empty (prevents accidental wipe)
        if (objectsToSave.length === 0) {
          if (existingObjectsForSave) objectsToSave = existingObjectsForSave;
          else {
            const existingMap = await loadJsonOrNull<KCMapFile>(mapJsonPath);
            existingObjectsForSave = existingMap?.placedObjects ?? null;
            if (existingMap) objectsToSave = existingMap.placedObjects ?? [];
          }
        } else {
          if (!existingObjectsForSave) {
            const existingMap = await loadJsonOrNull<KCMapFile>(mapJsonPath);
            existingObjectsForSave = existingMap?.placedObjects ?? null;
          }
          const objectWipeRisk = detectPlacedObjectWipeRisk(existingObjectsForSave, objectsToSave);
          if (objectWipeRisk) {
            return jsonResponse({ ok: false, error: formatPlacedObjectWipeRisk(objectWipeRisk) }, 409);
          }
        }

        // Preserve existing metadata fields if editor didn't include them
        // (partial-payload protection).
        const { placedObjects: _, ...mapDataWithoutObjects } = mapData;
        let preservedTexturePlanes = mapDataWithoutObjects.map?.texturePlanes;
        const incomingMinimapMarkers = mapDataWithoutObjects.map?.minimapMarkers;
        let preservedMinimapMarkers = incomingMinimapMarkers === undefined
          ? undefined
          : normalizeMinimapMarkers(incomingMinimapMarkers, mapWidth, mapHeight);
        let preservedChunkWaterLevels = mapDataWithoutObjects.map?.chunkWaterLevels;
        let preservedChunkWaterFlows = mapDataWithoutObjects.map?.chunkWaterFlows;
        const shouldPreserveEmptyChunkWaterLevels = preservedChunkWaterLevels !== undefined
          && Object.keys(preservedChunkWaterLevels).length === 0
          && Object.keys(existingMapForShape?.map?.chunkWaterLevels ?? {}).length > 0;
        if (
          preservedTexturePlanes === undefined
          || preservedMinimapMarkers === undefined
          || preservedChunkWaterLevels === undefined
          || shouldPreserveEmptyChunkWaterLevels
          || preservedChunkWaterFlows === undefined
        ) {
          const existingMap = existingMapForShape ?? await loadJsonOrNull<KCMapFile>(mapJsonPath);
          if (preservedTexturePlanes === undefined) preservedTexturePlanes = existingMap?.map?.texturePlanes ?? [];
          if (preservedMinimapMarkers === undefined) {
            preservedMinimapMarkers = normalizeMinimapMarkers(existingMap?.map?.minimapMarkers, mapWidth, mapHeight);
          }
          if (preservedChunkWaterLevels === undefined || shouldPreserveEmptyChunkWaterLevels) {
            preservedChunkWaterLevels = existingMap?.map?.chunkWaterLevels ?? {};
          }
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
            minimapMarkers: preservedMinimapMarkers,
            chunkWaterLevels: preservedChunkWaterLevels,
            chunkWaterFlows: preservedChunkWaterFlows,
          },
        };
        const mapDefaultGround = defaultGroundForMap(mapFileToSave.map);

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
            ? saveChunkedTiles(mapDir, mapData.map.tiles, mapWidth, mapHeight, mapDefaultGround)
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

    if (url.pathname === '/api/editor/npcs' && req.method === 'GET') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      const npcsPath = resolve(import.meta.dir, '../data/npcs.json');
      try {
        return new Response(readFileSync(npcsPath, 'utf-8'), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
        });
      } catch {
        return new Response('Not Found', { status: 404 });
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
        const npcDefIssues = validateNpcDefsForAuthoring(body.npcs);
        const npcDefErrors = npcDefIssues.filter(issue => issue.severity === 'error');
        if (npcDefErrors.length > 0) {
          return jsonResponse({
            ok: false,
            error: `Refusing to save NPC defs:\n${formatNpcAuthoringIssues(npcDefErrors)}`,
          }, 400);
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
        const protectedPayload = protectNpcLootTablesOnSave(body.npcs, existingNpcs);
        await saveJsonWithBackup({
          path: npcsPath,
          data: protectedPayload.npcs,
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
        return jsonResponse({
          ok: true,
          preservedRelicDrops: protectedPayload.preservedRelicDrops,
          preservedMissingLootTables: protectedPayload.preservedMissingLootTables,
        });
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
          skybox: {
            color: isDungeon ? [0, 0, 0] as [number, number, number] : [0.4, 0.62, 0.92] as [number, number, number],
            showSun: !isDungeon,
          },
          transitions: [],
        };

        // Build metadata-only KC map data (default tiles/heights need no chunk files)
        const mapData: KCMapFile = {
          map: {
            width,
            height,
            mapType: isDungeon ? 'dungeon' : 'overworld',
            defaultGround: isDungeon ? 'void' : 'grass',
            waterLevel: meta.waterLevel,
            chunkWaterLevels: {},
            chunkWaterFlows: {},
            texturePlanes: [],
            minimapMarkers: [],
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
        const importedDefaultGround = defaultGroundForMap(importedMap.map);

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
            ? saveChunkedTiles(mapDir, importedMap.map.tiles, iw, ih, importedDefaultGround)
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
        boundMapSession = getBoundBearerSessionForScope(req, 'game');
        if (isProductionLike() && !boundMapSession) return new Response('Unauthorized', { status: 401 });
        if (boundMapSession && gameplayMapDataPath) recordGameplayMapDataFetch(boundMapSession, mapPath, req, server);
        if (isProductionLike() && boundMapSession && gameplayMapDataPath && !boundMapSession.isAdmin) {
          if (isGameplayObjectManifestPath(mapPath)) return new Response('Not Found', { status: 404 });
          if (!canFetchScopedGameplayMapDataPath(mapPath, gameplayMapWindowForSession(boundMapSession, mapPath))) {
            return new Response('Forbidden', { status: 403 });
          }
        }
        if (isProductionLike() && boundMapSession && isLegacyMapTexturePath(mapPath) && !boundMapSession.isAdmin) {
          const mapId = mapIdFromGameplayMapPath(mapPath);
          const playerWindow = gameplayMapWindowForSession(boundMapSession, mapPath);
          if (!mapId || playerWindow?.currentMapLevel !== mapId) {
            return new Response('Forbidden', { status: 403 });
          }
        }
      }
      // Symlink-safe path resolution
      const filePath = resolvePossiblyMissingWithinBase(MAPS_DIR, mapPath);
      if (!filePath) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        if (isGameplayObjectManifestPath(mapPath)) {
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
      if (isProductionLike() && requiresAdminStaticAsset(decodedPath) && !getStaticAssetAdminSession(req)) {
        return new Response('Not Found', { status: 404 });
      }
      if (isProductionLike() && requiresAuthenticatedGameStaticAsset(decodedPath) && !getStaticAssetSessionForScope(req, 'game')) {
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
          let cacheControl = gameStaticAssetCacheControl(decodedPath);
          if (!requiresAdminStaticAsset(decodedPath) && isHashedBundle) {
            cacheControl = 'public, max-age=31536000, immutable';
          }
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

    if (url.pathname.startsWith('/items/3d/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const decodedPath = decodeURIComponent(url.pathname);
      const isManifest = decodedPath === '/items/3d/manifest.json';
      const isPng = /^\/items\/3d\/[0-9]+(?:-[0-9]+)?\.png$/.test(decodedPath);
      if (!isManifest && !isPng) return new Response('Not Found', { status: 404 });
      if (isProductionLike() && requiresAuthenticatedGameStaticAsset(decodedPath) && !getStaticAssetSessionForScope(req, 'game')) {
        return new Response('Unauthorized', { status: 401 });
      }

      const publicItemsDir = resolve(import.meta.dir, '../../client/public/items/3d');
      const distItemsDir = resolve(CLIENT_DIST, 'items/3d');
      const relativePath = decodedPath.slice('/items/3d/'.length);
      for (const baseDir of [publicItemsDir, distItemsDir]) {
        const filePath = resolvePossiblyMissingWithinBase(baseDir, relativePath);
        if (!filePath) continue;
        try {
          const content = readCachedStaticFile(filePath);
          return new Response(content, {
            headers: { 'Content-Type': getMimeType(filePath), 'Cache-Control': gameStaticAssetCacheControl(decodedPath) },
          });
        } catch { /* try next */ }
      }
      if (!isManifest) return new Response('Not Found', { status: 404 });
      return new Response('[]', {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, must-revalidate' },
      });
    }

    // --- Static File Serving ---

    const websitePublicResponse = serveWebsitePublic(url.pathname);
    if (websitePublicResponse) return websitePublicResponse;

    const websiteDevResponse = await serveWebsiteDev(req, url.pathname);
    if (websiteDevResponse) return websiteDevResponse;

    const websiteResponse = serveWebsite(req, url.pathname);
    if (websiteResponse) return websiteResponse;

    if (isProductionLike() && requiresAdminStaticAsset(url.pathname) && !getStaticAssetAdminSession(req)) {
      return new Response('Not Found', { status: 404 });
    }
    if (isProductionLike() && requiresAuthenticatedGameStaticAsset(url.pathname) && !getStaticAssetSessionForScope(req, 'game')) {
      return new Response('Unauthorized', { status: 401 });
    }

    const response = serveStatic(req, url.pathname, isGameRoute(url.pathname));
    if (response) return response;

    if (shouldServeWebsiteNotFound(req, url.pathname)) return serveWebsiteNotFound();

    return new Response('Not Found', { status: 404 });
}

const server = Bun.serve<SocketData>({
  port: SERVER_PORT,

  async fetch(req, server) {
    const res = await rawFetch(req, server);
    return res ? await maybeCompressResponse(req, res) : res;
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
      if (ws.data.type === 'website-dev') {
        const data = ws.data;
        const upstream = new WebSocket(data.targetUrl);
        data.upstream = upstream;
        upstream.addEventListener('open', () => {
          data.upstreamOpen = true;
          for (const pending of data.pendingMessages.splice(0)) upstream.send(pending);
        });
        upstream.addEventListener('message', (event) => {
          try { ws.send(event.data as string | ArrayBuffer); } catch {}
        });
        upstream.addEventListener('close', (event) => {
          try { ws.close(event.code || 1000, event.reason); } catch {}
        });
        upstream.addEventListener('error', () => {
          try { ws.close(1011, 'Website dev proxy error'); } catch {}
        });
        return;
      }

      const socketData = ws.data;
      // Per-account cap: refuse + close if this account already has too many
      // sockets in flight. Mark the slot as "reserved" via a flag on ws.data
      // so close() knows whether to release.
      if (!tryReserveWsSlot(socketData.accountId)) {
        console.warn(`[ws] Refusing ${socketData.type} socket for account=${socketData.accountId}: too many open sockets`);
        try { ws.close(1008, 'Too many connections for this account'); } catch {}
        return;
      }
      (ws.data as SocketData & { _slotHeld?: boolean })._slotHeld = true;
      if (ws.data.type === 'game') {
        const gameData = ws.data;
        void handleGameSocketOpen(ws as import('bun').ServerWebSocket<GameSocketData>, world)
          .catch((e) => {
            console.warn(`[ws] game socket open failed account=${gameData.accountId}:`, e instanceof Error ? e.message : e);
            try { ws.close(1011, 'handshake setup failed'); } catch {}
          });
      } else {
        handleChatSocketOpen(ws as import('bun').ServerWebSocket<ChatSocketData>, world);
      }
    },
    message(ws: import('bun').ServerWebSocket<SocketData>, message: string | Buffer) {
      if (ws.data.type === 'website-dev') {
        const payload = typeof message === 'string' ? message : message.toString();
        const upstream = ws.data.upstream;
        if (upstream && ws.data.upstreamOpen && upstream.readyState === WebSocket.OPEN) {
          upstream.send(payload);
        } else {
          ws.data.pendingMessages.push(payload);
        }
        return;
      }

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
      if (ws.data.type === 'website-dev') {
        try { ws.data.upstream?.close(); } catch {}
        return;
      }

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
if (WEBSITE_DEV_ORIGIN) {
  console.log(`Website dev proxy: http://localhost:${server.port} -> ${WEBSITE_DEV_ORIGIN}`);
}
console.log(`World tick rate: ${600}ms — ${world.players.size} players online`);
scheduleForumAvatarBake('startup', 3_000);
