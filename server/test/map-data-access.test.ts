import { describe, expect, test } from 'bun:test';
import {
  canFetchScopedGameplayMapDataPath,
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
    const near = parseGameplayMapChunkPath('kcmap/objects/chunk_13_22.json');
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

  test('does not let an active player fetch another map level', () => {
    expect(canFetchScopedGameplayMapDataPath('the_sultans_mine/map.json', player)).toBe(false);
    expect(canFetchScopedGameplayMapDataPath('the_sultans_mine/objects/chunk_10_20.json', player)).toBe(false);
  });

  test('permits metadata bootstrap only before an active player exists', () => {
    expect(canFetchScopedGameplayMapDataPath('kcmap/map.json', null)).toBe(true);
    expect(canFetchScopedGameplayMapDataPath('kcmap/tiles/chunk_0_0.json', null)).toBe(false);
  });
});
