import { describe, expect, test } from 'bun:test';
import {
  canFetchScopedGameplayMapDataPath,
  gameplayMapPlayerWindowFromWorldPosition,
  isGameplayMapChunkInPlayerWindow,
  isGameplayObjectManifestPath,
  parseGameplayMapChunkPath,
  type GameplayMapPlayerWindow,
} from '../src/data/MapDataAccess';

const player: GameplayMapPlayerWindow = {
  currentMapLevel: 'kcmap',
  currentChunkX: 10,
  currentChunkZ: 20,
};

describe('map data access hardening', () => {
  test('hides the global object chunk manifest from normal players', () => {
    expect(isGameplayObjectManifestPath('kcmap/objects/manifest.json')).toBe(true);
    expect(isGameplayObjectManifestPath('kcmap/objects/chunk_1_2.json')).toBe(false);
  });

  test('allows nearby runtime object chunks and rejects far scans', () => {
    const near = parseGameplayMapChunkPath('kcmap/objects/chunk_12_22.json');
    const far = parseGameplayMapChunkPath('kcmap/objects/chunk_30_22.json');
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    expect(isGameplayMapChunkInPlayerWindow(near!, player)).toBe(true);
    expect(isGameplayMapChunkInPlayerWindow(far!, player)).toBe(false);
  });

  test('allows editor tile chunks needed for normal render slack and rejects distant chunks', () => {
    expect(canFetchScopedGameplayMapDataPath('kcmap/tiles/chunk_7_11.json', player)).toBe(true);
    expect(canFetchScopedGameplayMapDataPath('kcmap/heights/chunk_20_20.json', player)).toBe(false);
  });

  test('allows map chunks around an alternate legitimate stream center', () => {
    const savedFarFromWarmStart: GameplayMapPlayerWindow = {
      currentMapLevel: 'kcmap',
      currentChunkX: 10,
      currentChunkZ: 20,
      alternateChunks: [{ chunkX: 6, chunkZ: 4 }],
    };
    expect(canFetchScopedGameplayMapDataPath('kcmap/tiles/chunk_1_0.json', savedFarFromWarmStart)).toBe(true);
    expect(canFetchScopedGameplayMapDataPath('kcmap/heights/chunk_3_0.json', savedFarFromWarmStart)).toBe(true);
    expect(canFetchScopedGameplayMapDataPath('kcmap/heights/chunk_20_20.json', savedFarFromWarmStart)).toBe(false);
  });

  test('allows the pre-login warm-start height chunks around the kcmap spawn', () => {
    const spawnWindow = gameplayMapPlayerWindowFromWorldPosition('kcmap', 224.5, 170.5);
    expect(spawnWindow).not.toBeNull();
    expect(canFetchScopedGameplayMapDataPath('kcmap/heights/chunk_2_1.json', spawnWindow)).toBe(true);
    expect(canFetchScopedGameplayMapDataPath('kcmap/heights/chunk_5_3.json', spawnWindow)).toBe(true);
    expect(canFetchScopedGameplayMapDataPath('kcmap/heights/chunk_20_20.json', spawnWindow)).toBe(false);
  });

  test('does not let an active player fetch another map level', () => {
    expect(canFetchScopedGameplayMapDataPath('the_sultans_mine/map.json', player)).toBe(false);
    expect(canFetchScopedGameplayMapDataPath('the_sultans_mine/objects/chunk_10_20.json', player)).toBe(false);
  });

  test('permits metadata bootstrap only before an active player exists', () => {
    expect(canFetchScopedGameplayMapDataPath('kcmap/map.json', null)).toBe(true);
    expect(canFetchScopedGameplayMapDataPath('kcmap/tiles/chunk_0_0.json', null)).toBe(false);
  });
});
