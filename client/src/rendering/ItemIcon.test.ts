import { describe, expect, test } from 'bun:test';
import type { ItemDef } from '@projectrs/shared';
import {
  findThumbnailOverrideForItem,
  itemThumbnailFamily,
  itemThumbnailFamilyKey,
  parseBakedThumbnailManifest,
  resolveBakedThumbnailUrl,
  type ThumbnailOverride,
} from './ItemIcon';

function item(id: number, name: string, equipSlot = 'weapon'): ItemDef {
  return { id, name, equipSlot } as ItemDef;
}

describe('item thumbnail families', () => {
  test('normalizes same equipment family across tiers and naming variants', () => {
    expect(itemThumbnailFamily(item(63, 'Bronze Battle Axe'))).toBe('Battle Axe');
    expect(itemThumbnailFamilyKey(item(63, 'Bronze Battle Axe'))).toBe('weapon:battleaxe');
    expect(itemThumbnailFamilyKey(item(119, 'Black Bronze Battle Axe'))).toBe('weapon:battleaxe');
    expect(itemThumbnailFamilyKey(item(900, 'Dragon Battleaxe'))).toBe('weapon:battleaxe');
    expect(itemThumbnailFamilyKey(item(901, 'Dragon 2h Sword'))).toBe('weapon:2handedsword');
    expect(itemThumbnailFamilyKey(item(902, 'Dragon Long Sword'))).toBe('weapon:longsword');
    expect(itemThumbnailFamilyKey(item(903, 'Dragon Cuirass', 'body'))).toBe('body:cuirass');
    expect(itemThumbnailFamilyKey(item(904, 'Royal Great Helm', 'head'))).toBe('head:greathelm');
    expect(itemThumbnailFamilyKey(item(905, 'Royal Face Mask (F)', 'head'))).toBe('head:facemaskf');
    expect(itemThumbnailFamilyKey(item(33, 'Bronze Pickaxe'))).toBe('weapon:pickaxe');
  });

  test('direct item override wins, family override seeds items without direct poses', () => {
    const familyPose: ThumbnailOverride = { alpha: 1.25, beta: 0.75, distanceMult: 0.9 };
    const directPose: ThumbnailOverride = { alpha: 9 };
    const futureBattleaxe = item(900, 'Dragon Battleaxe');
    const anotherBattleaxe = item(901, 'Royal Battleaxe');

    expect(findThumbnailOverrideForItem(futureBattleaxe, {
      items: { 900: directPose },
      families: { 'weapon:battleaxe': familyPose },
    })).toBe(directPose);

    expect(findThumbnailOverrideForItem(anotherBattleaxe, {
      items: { 900: directPose },
      families: { 'weapon:battleaxe': familyPose },
    })).toBe(familyPose);
  });

  test('legacy single item override still seeds future family members when no family override exists', () => {
    const bronzeBattleaxe = item(63, 'Bronze Battle Axe');
    const futureBattleaxe = item(900, 'Dragon Battleaxe');
    const bronzePose: ThumbnailOverride = { alpha: -1.1, beta: 0.6, distanceMult: 0.75 };

    expect(findThumbnailOverrideForItem(
      futureBattleaxe,
      { 63: bronzePose },
      [bronzeBattleaxe, futureBattleaxe],
    )).toBe(bronzePose);
  });

  test('baked thumbnail manifest only resolves pose-matched entries', () => {
    const poseKey = 'thumb:v11|/assets/equipment/weapon/BronzeDagger.glb|id:item:58|cam:1.00000,2.00000,0.75000';
    const manifest = parseBakedThumbnailManifest({
      version: 2,
      ids: [58, 59],
      entries: {
        58: { file: '/items/3d/58.png', poseKey, rendererVersion: 11 },
        59: { file: '/items/3d/59.png', poseKey: 'old-pose', rendererVersion: 10 },
      },
    });

    expect(resolveBakedThumbnailUrl(manifest, 58, poseKey)).toBe('/items/3d/58.png');
    expect(resolveBakedThumbnailUrl(manifest, 59, poseKey)).toBeNull();
  });

  test('legacy baked manifest ids do not override runtime item poses', () => {
    const manifest = parseBakedThumbnailManifest([58]);

    expect(manifest.legacyIds.has(58)).toBe(true);
    expect(resolveBakedThumbnailUrl(manifest, 58, 'thumb:v11|current')).toBeNull();
  });
});
