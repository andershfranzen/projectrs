import { describe, expect, test } from 'bun:test';
import { ASSET_TO_OBJECT_DEF } from '@projectrs/shared';
import type { WorldObjectDef } from '@projectrs/shared';
import type { ItemDef } from '@projectrs/shared';

const objects = await Bun.file(new URL('../../data/objects.json', import.meta.url)).json() as WorldObjectDef[];
const items = await Bun.file(new URL('../../data/items.json', import.meta.url)).json() as ItemDef[];
const assetData = await Bun.file(new URL('../../../client/public/assets/assets.json', import.meta.url)).json() as {
  assets: Array<{ id: string; name?: string; section?: string; group?: string; tags?: string[] }>;
};

function fishingXpByItemId(itemId: number): number | null {
  for (const def of objects) {
    if (def.category !== 'fishingspot') continue;
    for (const option of def.harvestOptions ?? []) {
      if (option.harvestItemId === itemId) return option.xpReward;
    }
    if (def.harvestItemId === itemId) return def.xpReward ?? null;
  }
  return null;
}

function cookingXpByRawItemId(itemId: number): number | null {
  const cookingRange = objects.find(def => def.category === 'cookingrange');
  const recipe = cookingRange?.recipes?.find(candidate => candidate.inputItemId === itemId);
  return recipe?.xpReward ?? null;
}

function cookingLevelByRawItemId(itemId: number): number | null {
  const cookingRange = objects.find(def => def.category === 'cookingrange');
  const recipe = cookingRange?.recipes?.find(candidate => candidate.inputItemId === itemId);
  return recipe?.levelRequired ?? null;
}

function cookingRecipeByRawItemId(itemId: number) {
  const cookingRange = objects.find(def => def.category === 'cookingrange');
  return cookingRange?.recipes?.find(candidate => candidate.inputItemId === itemId) ?? null;
}

function itemName(itemId: number): string | null {
  return items.find(item => item.id === itemId)?.name ?? null;
}

function itemHealAmount(itemId: number): number | null {
  const item = items.find(candidate => candidate.id === itemId);
  return item?.healAmount ?? null;
}

function fishingSpotByHarvestItemId(itemId: number): WorldObjectDef | null {
  return objects.find(def => def.category === 'fishingspot' && def.harvestItemId === itemId) ?? null;
}

function editorAsset(assetId: string) {
  return assetData.assets.find(asset => asset.id === assetId) ?? null;
}

describe('fishing data', () => {
  test('only real fishing spot object definitions are authored', () => {
    expect(objects
      .filter(def => def.category === 'fishingspot')
      .map(def => def.id)
      .sort((a, b) => a - b)
    ).toEqual([5, 46, 47, 48, 67, 68, 69]);
  });

  test('fish XP rewards match the authored progression table', () => {
    expect(fishingXpByItemId(27)).toBe(10); // Raw Shrimp
    expect(fishingXpByItemId(501)).toBe(20); // Raw Crayfish
    expect(fishingXpByItemId(560)).toBe(26); // Raw Sardine
    expect(fishingXpByItemId(510)).toBe(70); // Raw Tuna
    expect(fishingXpByItemId(558)).toBe(90); // Raw Lobster
    expect(fishingXpByItemId(562)).toBe(110); // Raw Octopus
    expect(fishingXpByItemId(523)).toBe(150); // Raw Oarfish
  });

  test('fish cooking XP is 20 percent higher than fishing XP', () => {
    for (const itemId of [27, 501, 560, 510, 558, 562, 523]) {
      const fishingXp = fishingXpByItemId(itemId);
      expect(fishingXp).not.toBeNull();
      expect(cookingXpByRawItemId(itemId)).toBe(Math.ceil((fishingXp ?? 0) * 1.2));
    }
  });

  test('early fish cooking levels are in the intended order', () => {
    expect(cookingLevelByRawItemId(27)).toBe(1); // Raw Shrimp
    expect(cookingLevelByRawItemId(501)).toBe(5); // Raw Crayfish
    expect(cookingLevelByRawItemId(560)).toBe(15); // Raw Sardine
  });

  test('fish cooking recipes have burn rolls and burnt outputs', () => {
    const expected = new Map<number, { roll: [number, number]; burntItemId: number }>([
      [27, { roll: [128, 512], burntItemId: 565 }], // 2004scape shrimp
      [501, { roll: [98, 452], burntItemId: 566 }], // level-10 fish curve
      [560, { roll: [118, 492], burntItemId: 567 }], // 2004scape sardine
      [510, { roll: [58, 372], burntItemId: 568 }], // 2004scape tuna
      [558, { roll: [38, 332], burntItemId: 569 }], // 2004scape lobster
      [562, { roll: [8, 260], burntItemId: 570 }], // high-level fish curve
      [523, { roll: [1, 222], burntItemId: 571 }], // sea turtle/manta ray curve
    ]);

    for (const [rawItemId, { roll, burntItemId }] of expected) {
      const recipe = cookingRecipeByRawItemId(rawItemId);
      expect(recipe?.successRoll).toEqual(roll);
      expect(recipe?.failureOutputItemId).toBe(burntItemId);
      expect(itemName(burntItemId)?.startsWith('Burnt ')).toBe(true);
    }
  });

  test('cooked fish heal amounts match the authored balance table', () => {
    expect(itemHealAmount(28)).toBe(2); // Cooked Shrimp
    expect(itemHealAmount(526)).toBe(3); // Crayfish
    expect(itemHealAmount(561)).toBe(4); // Sardine
    expect(itemHealAmount(535)).toBe(8); // Tuna
    expect(itemHealAmount(559)).toBe(11); // Lobster
    expect(itemHealAmount(563)).toBe(17); // Octopus
    expect(itemHealAmount(548)).toBe(20); // Oarfish
  });

  test('tuna spot is a harpoon spot, not a bait spot', () => {
    const tunaSpot = fishingSpotByHarvestItemId(510);

    expect(tunaSpot?.name).toBe('Tuna Harpoon Fishing Spot');
    expect(tunaSpot?.modelAssetId).toBe('FishingSpotBubblesTuna');
    expect(tunaSpot?.skillAnimation).toBe('fish_harpoon');
    expect(tunaSpot?.visualToolItemId).toBe(554);
    expect(tunaSpot?.requiredItemId).toBeUndefined();
    expect(tunaSpot?.consumeRequiredItem).toBeUndefined();
    expect(tunaSpot?.successChances?.['554']).toEqual([50, 79]);
    expect(tunaSpot?.successChances?.['553']).toBeUndefined();
  });

  test('editor exposes only explicit fishing spots as resource assets', () => {
    const fishingResourceAssets = [
      'FishingSpotBubblesNet',
      'FishingSpotBubblesSardine',
      'FishingSpotBubblesTuna',
      'FishingSpotBubblesCrayfish',
      'FishingSpotBubblesLobster',
      'FishingSpotBubblesOctopus',
      'FishingSpotBubblesOarfish',
    ];

    for (const assetId of fishingResourceAssets) {
      expect(typeof ASSET_TO_OBJECT_DEF[assetId]).toBe('number');
      expect(editorAsset(assetId)?.section).toBe('Resources');
      expect(editorAsset(assetId)?.group).toBe('Fishing Spots');
      expect(editorAsset(assetId)?.tags?.includes('resource')).toBe(true);
    }

    for (const assetId of [
      'FishingSpotBubblesRod',
      'FishingSpotBubblesRodDeep',
      'FishingSpotBubblesHarpoon',
    ]) {
      expect(ASSET_TO_OBJECT_DEF[assetId]).toBeUndefined();
      expect(editorAsset(assetId)).toBeNull();
    }

    expect(ASSET_TO_OBJECT_DEF.FishingSpotBubbles).toBeUndefined();
    expect(editorAsset('FishingSpotBubbles')?.section).toBe('Runtime');
  });
});
