import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ItemDef, WorldObjectDef } from '@projectrs/shared';
import { World } from '../src/World';

const DATA_DIR = join(import.meta.dir, '../data');

const FISH_TIERS = [
  { level: 1, itemId: 500, name: 'Raw Minnow', xp: 20 },
  { level: 5, itemId: 501, name: 'Raw Crayfish', xp: 30 },
  { level: 10, itemId: 502, name: 'Raw Bluegill', xp: 45 },
  { level: 15, itemId: 503, name: 'Raw Perch', xp: 60 },
  { level: 20, itemId: 504, name: 'Raw Roach', xp: 75 },
  { level: 25, itemId: 505, name: 'Raw Trout', xp: 90 },
  { level: 30, itemId: 506, name: 'Raw Carp', xp: 110 },
  { level: 35, itemId: 507, name: 'Raw Salmon', xp: 130 },
  { level: 40, itemId: 508, name: 'Raw Bass', xp: 150 },
  { level: 45, itemId: 509, name: 'Raw Mackerel', xp: 170 },
  { level: 50, itemId: 510, name: 'Raw Tuna', xp: 195 },
  { level: 55, itemId: 511, name: 'Raw King Crab', xp: 220 },
  { level: 60, itemId: 512, name: 'Raw Catfish', xp: 245 },
  { level: 65, itemId: 513, name: 'Raw Snapper', xp: 275 },
  { level: 70, itemId: 514, name: 'Raw Sturgeon', xp: 305 },
  { level: 75, itemId: 515, name: 'Raw Swordfish', xp: 335 },
  { level: 80, itemId: 516, name: 'Raw Reef Shark', xp: 370 },
  { level: 85, itemId: 517, name: 'Raw Halibut', xp: 405 },
  { level: 90, itemId: 518, name: 'Raw Hammerhead Shark', xp: 440 },
  { level: 95, itemId: 519, name: 'Raw Marlin', xp: 480 },
  { level: 100, itemId: 520, name: 'Raw Thresher Shark', xp: 520 },
  { level: 105, itemId: 521, name: 'Raw Mako Shark', xp: 560 },
  { level: 110, itemId: 522, name: 'Raw Tiger Shark', xp: 605 },
  { level: 115, itemId: 523, name: 'Raw Oarfish', xp: 650 },
  { level: 120, itemId: 524, name: 'Raw Great White Shark', xp: 700 },
] as const;

function loadItems(): ItemDef[] {
  return JSON.parse(readFileSync(join(DATA_DIR, 'items.json'), 'utf8')) as ItemDef[];
}

function loadObjects(): WorldObjectDef[] {
  return JSON.parse(readFileSync(join(DATA_DIR, 'objects.json'), 'utf8')) as WorldObjectDef[];
}

function optionNames(spot: WorldObjectDef, itemsById: Map<number, ItemDef>): string[] {
  return (spot.harvestOptions ?? []).map(option => itemsById.get(option.harvestItemId)?.name ?? `item ${option.harvestItemId}`);
}

function harvestOdds(world: any, spot: WorldObjectDef, playerLevel: number): Map<number, number> {
  const options = (spot.harvestOptions ?? []).filter(option => playerLevel >= option.levelRequired);
  const weights = options.map(option => ({
    itemId: option.harvestItemId,
    weight: world.harvestOptionEffectiveWeight(option, playerLevel),
  }));
  const totalWeight = weights.reduce((total, option) => total + option.weight, 0);
  return new Map(weights.map(option => [option.itemId, option.weight / totalWeight]));
}

describe('fishing spot data', () => {
  test('all requested fish tiers exist as item definitions', () => {
    const itemsById = new Map(loadItems().map(item => [item.id, item]));

    for (const tier of FISH_TIERS) {
      expect(itemsById.get(tier.itemId)).toMatchObject({
        name: tier.name,
        stackable: false,
        equippable: false,
      });
    }

    expect([...itemsById.values()].some(item => item.name.includes('Dogfish'))).toBe(false);
  });

  test('fishingspot definitions group catches into placeable spot types', () => {
    const itemsById = new Map(loadItems().map(item => [item.id, item]));
    const spots = loadObjects().filter(object => object.category === 'fishingspot');
    const spotsByName = new Map(spots.map(spot => [spot.name, spot]));

    expect(optionNames(spotsByName.get('Shallow Fishing Spot')!, itemsById)).toEqual(['Raw Minnow', 'Raw Crayfish', 'Raw Bluegill']);
    expect(optionNames(spotsByName.get('River Fishing Spot')!, itemsById)).toEqual(['Raw Perch', 'Raw Roach', 'Raw Trout', 'Raw Carp', 'Raw Salmon']);
    expect(optionNames(spotsByName.get('Lake Fishing Spot')!, itemsById)).toEqual(['Raw Bluegill', 'Raw Perch', 'Raw Roach', 'Raw Carp', 'Raw Bass']);
    expect(optionNames(spotsByName.get('Coastal Fishing Spot')!, itemsById)).toEqual(['Raw Bass', 'Raw Mackerel', 'Raw Tuna', 'Raw King Crab', 'Raw Catfish', 'Raw Snapper']);
    expect(optionNames(spotsByName.get('Deep Sea Fishing Spot')!, itemsById)).toEqual(['Raw Catfish', 'Raw Snapper', 'Raw Sturgeon', 'Raw Swordfish', 'Raw Reef Shark', 'Raw Halibut']);
    expect(optionNames(spotsByName.get('Shark Fishing Spot')!, itemsById)).toEqual(['Raw Hammerhead Shark', 'Raw Thresher Shark', 'Raw Mako Shark', 'Raw Tiger Shark', 'Raw Great White Shark']);
    expect(optionNames(spotsByName.get('Rare Ocean Fishing Spot')!, itemsById)).toEqual(['Raw Marlin', 'Raw Oarfish', 'Raw Great White Shark']);

    const covered = new Set(spots.flatMap(spot => (spot.harvestOptions ?? []).map(option => option.harvestItemId)));
    expect(FISH_TIERS.every(tier => covered.has(tier.itemId))).toBe(true);
  });

  test('server harvest resolver only rolls unlocked spot options', () => {
    const world = Object.create(World.prototype) as any;
    const objectsByName = new Map(loadObjects().map(object => [object.name, object]));

    const river = objectsByName.get('River Fishing Spot')!;
    expect(world.resolveHarvestYield(river, 14, () => 0)).toBeNull();
    expect(world.resolveHarvestYield(river, 15, () => 0)).toMatchObject({ itemId: 503, xpReward: 60 });
    expect(world.resolveHarvestYield(river, 35, () => 0.999)).toMatchObject({ itemId: 507, xpReward: 130 });

    const deepSea = objectsByName.get('Deep Sea Fishing Spot')!;
    expect(world.resolveHarvestYield(deepSea, 70, () => 0.999)).toMatchObject({ itemId: 514, xpReward: 305 });
  });

  test('higher fishing levels shift spot odds toward higher-tier catches', () => {
    const world = Object.create(World.prototype) as any;
    const objectsByName = new Map(loadObjects().map(object => [object.name, object]));
    const deepSea = objectsByName.get('Deep Sea Fishing Spot')!;

    const level85Odds = harvestOdds(world, deepSea, 85);
    const level100Odds = harvestOdds(world, deepSea, 100);

    expect(level85Odds.size).toBeGreaterThan(1);
    expect(level100Odds.size).toBeGreaterThan(1);
    expect(level100Odds.get(517)!).toBeGreaterThan(level85Odds.get(517)!);
    expect(level100Odds.get(512)!).toBeLessThan(level85Odds.get(512)!);
  });
});
