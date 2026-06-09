import { CHUNK_LOAD_RADIUS, CHUNK_SIZE, EDITOR_CHUNK_SIZE } from '@projectrs/shared';

export type GameplayMapChunkKind = 'tiles' | 'heights' | 'objects';

export interface GameplayMapPlayerWindow {
  currentMapLevel: string;
  currentChunkX: number;
  currentChunkZ: number;
}

export interface GameplayMapChunkPath {
  mapId: string;
  kind: GameplayMapChunkKind;
  chunkX: number;
  chunkZ: number;
}

const OBJECT_CHUNK_RADIUS_SLACK = 1;
const EDITOR_CHUNK_RADIUS_SLACK = 3;

export function gameplayMapPlayerWindowFromWorldPosition(
  currentMapLevel: string,
  x: number,
  z: number,
): GameplayMapPlayerWindow | null {
  if (!/^[-\w]+$/.test(currentMapLevel)) return null;
  if (!Number.isFinite(x) || !Number.isFinite(z) || x < 0 || z < 0) return null;
  return {
    currentMapLevel,
    currentChunkX: Math.floor(x / CHUNK_SIZE),
    currentChunkZ: Math.floor(z / CHUNK_SIZE),
  };
}

export function mapIdFromGameplayMapPath(mapPath: string): string | null {
  const slash = mapPath.indexOf('/');
  if (slash <= 0) return null;
  const mapId = mapPath.slice(0, slash);
  return /^[-\w]+$/.test(mapId) ? mapId : null;
}

export function isGameplayObjectManifestPath(mapPath: string): boolean {
  return /^[-\w]+\/objects\/manifest\.json$/.test(mapPath);
}

export function parseGameplayMapChunkPath(mapPath: string): GameplayMapChunkPath | null {
  const match = mapPath.match(/^([-\w]+)\/(tiles|heights|objects)\/chunk_(-?\d+)_(-?\d+)\.json$/);
  if (!match) return null;
  const chunkX = Number(match[3]);
  const chunkZ = Number(match[4]);
  if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) return null;
  return {
    mapId: match[1],
    kind: match[2] as GameplayMapChunkKind,
    chunkX,
    chunkZ,
  };
}

export function isGameplayMapChunkInPlayerWindow(
  chunk: GameplayMapChunkPath,
  player: GameplayMapPlayerWindow,
): boolean {
  if (player.currentMapLevel !== chunk.mapId) return false;

  if (chunk.kind === 'objects') {
    const radius = CHUNK_LOAD_RADIUS + OBJECT_CHUNK_RADIUS_SLACK;
    return Math.abs(chunk.chunkX - player.currentChunkX) <= radius
      && Math.abs(chunk.chunkZ - player.currentChunkZ) <= radius;
  }

  const radius = CHUNK_LOAD_RADIUS + EDITOR_CHUNK_RADIUS_SLACK;
  const minGameChunkX = Math.floor((chunk.chunkX * EDITOR_CHUNK_SIZE) / CHUNK_SIZE);
  const maxGameChunkX = Math.floor((((chunk.chunkX + 1) * EDITOR_CHUNK_SIZE) - 1) / CHUNK_SIZE);
  const minGameChunkZ = Math.floor((chunk.chunkZ * EDITOR_CHUNK_SIZE) / CHUNK_SIZE);
  const maxGameChunkZ = Math.floor((((chunk.chunkZ + 1) * EDITOR_CHUNK_SIZE) - 1) / CHUNK_SIZE);

  return maxGameChunkX >= player.currentChunkX - radius
    && minGameChunkX <= player.currentChunkX + radius
    && maxGameChunkZ >= player.currentChunkZ - radius
    && minGameChunkZ <= player.currentChunkZ + radius;
}

export function canFetchScopedGameplayMapDataPath(
  mapPath: string,
  player: GameplayMapPlayerWindow | null,
): boolean {
  const mapId = mapIdFromGameplayMapPath(mapPath);
  if (!mapId) return false;

  const chunk = parseGameplayMapChunkPath(mapPath);
  if (!player) return chunk === null;
  if (player.currentMapLevel !== mapId) return false;
  return chunk === null || isGameplayMapChunkInPlayerWindow(chunk, player);
}
