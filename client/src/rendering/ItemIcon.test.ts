import { describe, expect, test } from 'bun:test';
import type { ItemDef } from '@projectrs/shared';
import {
  findThumbnailOverrideForItem,
  itemThumbnailFamily,
  itemThumbnailFamilyKey,
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

  test('family override is authoritative for future family members', () => {
    const familyPose: ThumbnailOverride = { alpha: 1.25, beta: 0.75, distanceMult: 0.9 };
    const directPose: ThumbnailOverride = { alpha: 9 };
    const futureBattleaxe = item(900, 'Dragon Battleaxe');

    expect(findThumbnailOverrideForItem(futureBattleaxe, {
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
});
