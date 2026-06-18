import { expect, test } from 'bun:test';
import {
  BROTHER_MONK_CHEST_OBJECT_DEF_ID,
  GENERIC_SCENERY_OBJECT_DEF_ID,
  STAIRS_OBJECT_DEF_ID,
  TRAPDOOR_OBJECT_DEF_ID,
  WELL_OBJECT_DEF_ID,
  isCropPlacedAssetId,
  isGroundItemSpawnAssetId,
  isPlacedObjectStorageSurfaceAssetId,
  isWalkHerePrimarySceneryAssetId,
  objectDefIdForPlacedAsset,
  sceneryExamineMetaForAsset,
  storageSurfaceProfileForPlacedAsset,
} from './index';

test('filler scenery has clean display names and authored examine text', () => {
  expect(objectDefIdForPlacedAsset('bookcase2')).toBe(GENERIC_SCENERY_OBJECT_DEF_ID);
  expect(sceneryExamineMetaForAsset('bookcase2')).toEqual({
    name: 'Bookcase',
    examineText: 'Someone alphabetised this by confidence.',
  });

  expect(objectDefIdForPlacedAsset('OnePersonBed1')).toBe(GENERIC_SCENERY_OBJECT_DEF_ID);
  expect(sceneryExamineMetaForAsset('OnePersonBed1')?.name).toBe('Bed');
  expect(sceneryExamineMetaForAsset('OnePersonBed1')?.examineText).toBe("A bed with the exact shape of a bad night's sleep.");

  expect(objectDefIdForPlacedAsset('bush1')).toBe(GENERIC_SCENERY_OBJECT_DEF_ID);
  expect(sceneryExamineMetaForAsset('bush1')).toEqual({
    name: 'Bush',
    examineText: 'A thick bush with tangled branches and dark leaves. Something could easily hide in it.',
  });
  expect(sceneryExamineMetaForAsset('bush2')?.examineText).toBe('A scruffy roadside bush, dusty at the roots and stubbornly alive.');
  expect(sceneryExamineMetaForAsset('bush3')?.examineText).toBe('George W.');

  expect(sceneryExamineMetaForAsset('Fountain_2')?.name).toBe('Broken fountain');
});

test('reported desert and palace props resolve to examineable scenery', () => {
  const expectedNames: Record<string, string> = {
    PalmTree: 'Palm tree',
    PalmTreeLowSwept: 'Palm tree',
    PalmTreeWindHook: 'Palm tree',
    chair: 'Chair',
    Theodosian_Chair_1: 'Chair',
    table1: 'Table',
    Table_1: 'Table',
    'open tier 1 chest': 'Open chest',
    'open tier 2 chest': 'Open chest',
    Minecart: 'Mine cart',
    MinecartTrackStraight: 'Mine cart track',
    MinecartTrackStop: 'Mine cart buffer',
    'Tanning Rack': 'Tanning rack',
    'ranged shop sign': 'Ranged shop sign',
    depleted_rock: 'Depleted rock',
    bush1: 'Bush',
    bush2: 'Bush',
    bush3: 'Bush',
  };

  for (const [assetId, name] of Object.entries(expectedNames)) {
    expect(objectDefIdForPlacedAsset(assetId)).toBe(GENERIC_SCENERY_OBJECT_DEF_ID);
    expect(sceneryExamineMetaForAsset(assetId)?.name).toBe(name);
    expect(sceneryExamineMetaForAsset(assetId)?.examineText).toBeTruthy();
  }
});

test('reported graveyard and spawn castle props have asset-specific examine text', () => {
  expect(objectDefIdForPlacedAsset('WIPStair1')).toBe(STAIRS_OBJECT_DEF_ID);
  expect(sceneryExamineMetaForAsset('WIPStair1')).toEqual({
    name: 'Wooden spiral staircase',
    examineText: 'A wooden spiral staircase leading between levels.',
  });
  expect(sceneryExamineMetaForAsset('Byzantine_WIPStair1')?.name).toBe('Wooden spiral staircase');
  expect(sceneryExamineMetaForAsset('Theodosian_WIPStair1')?.examineText).not.toContain('Stone steps');

  expect(sceneryExamineMetaForAsset('Fountain_2')).toEqual({
    name: 'Broken fountain',
    examineText: 'A dry, broken fountain. Whatever water once flowed here is long gone.',
  });
  expect(sceneryExamineMetaForAsset('Bench_1')).toEqual({
    name: 'Stone bench',
    examineText: 'A cold stone bench worn smooth by mourners and weather.',
  });
  expect(sceneryExamineMetaForAsset('Chains_1003')).toEqual({
    name: 'Chained stone coffin',
    examineText: 'A stone coffin bound shut with heavy chains.',
  });
});

test('carpet scenery keeps examine metadata but defaults to walk here', () => {
  expect(objectDefIdForPlacedAsset('Carpet1x4')).toBe(GENERIC_SCENERY_OBJECT_DEF_ID);
  expect(sceneryExamineMetaForAsset('Carpet1x4')?.name).toBe('Carpet');
  expect(objectDefIdForPlacedAsset('Carpet2x4')).toBe(GENERIC_SCENERY_OBJECT_DEF_ID);
  expect(isWalkHerePrimarySceneryAssetId('Carpet1x4')).toBe(true);
  expect(isWalkHerePrimarySceneryAssetId('Carpet2x3')).toBe(true);
  expect(isWalkHerePrimarySceneryAssetId('bookcase2')).toBe(false);
});

test('placed knife assets are ground item spawns, not scenery', () => {
  expect(isGroundItemSpawnAssetId('Knife')).toBe(true);
  expect(isGroundItemSpawnAssetId('/assets/models/Knife.glb')).toBe(true);
  expect(objectDefIdForPlacedAsset('Knife')).toBeUndefined();
});

test('table scenery can act as storage surfaces', () => {
  expect(objectDefIdForPlacedAsset('table1')).toBe(GENERIC_SCENERY_OBJECT_DEF_ID);
  expect(isPlacedObjectStorageSurfaceAssetId('table1')).toBe(true);
  expect(storageSurfaceProfileForPlacedAsset('table1')?.surfaceHeight).toBeGreaterThan(1);
  expect(objectDefIdForPlacedAsset('Theodosian_Table_1')).toBe(GENERIC_SCENERY_OBJECT_DEF_ID);
  expect(isPlacedObjectStorageSurfaceAssetId('Theodosian_Table_1')).toBe(true);
});

test('tree assets resolve to the right harvestable object definitions', () => {
  expect(objectDefIdForPlacedAsset('sTree 1')).toBe(1);
  expect(objectDefIdForPlacedAsset('dying tree')).toBe(10);
});

test('stall assets resolve to roguery stall object definitions', () => {
  expect(objectDefIdForPlacedAsset('food stall')).toBe(52);
  expect(objectDefIdForPlacedAsset('crafting stall')).toBe(53);
  expect(objectDefIdForPlacedAsset('hides stall')).toBe(54);
  expect(objectDefIdForPlacedAsset('Ranging stall')).toBe(55);
  expect(objectDefIdForPlacedAsset('low level smithing stall')).toBe(56);
  expect(objectDefIdForPlacedAsset('high level smithing stall')).toBe(57);
  expect(objectDefIdForPlacedAsset('relic stall')).toBe(58);
  expect(objectDefIdForPlacedAsset('Gem stall')).toBe(59);
  expect(objectDefIdForPlacedAsset('depleted stall')).toBeUndefined();
});

test('fishing bubble assets resolve to fishing spot object definitions', () => {
  expect(objectDefIdForPlacedAsset('FishingSpotBubbles')).toBe(5);
  expect(objectDefIdForPlacedAsset('FishingSpotBubblesNet')).toBe(5);
  expect(objectDefIdForPlacedAsset('FishingSpotBubblesRod')).toBe(46);
  expect(objectDefIdForPlacedAsset('FishingSpotBubblesHarpoon')).toBe(48);
});

test('trapdoor assets resolve to the teleport object definition', () => {
  expect(objectDefIdForPlacedAsset('TrapdoorClosed')).toBe(TRAPDOOR_OBJECT_DEF_ID);
  expect(objectDefIdForPlacedAsset('TrapdoorOpenFinal')).toBe(TRAPDOOR_OBJECT_DEF_ID);
});

test('quest chest asset resolves to the dedicated Brother Monk chest definition', () => {
  expect(objectDefIdForPlacedAsset('brother monk chest')).toBe(BROTHER_MONK_CHEST_OBJECT_DEF_ID);
});

test('crop assets are identified for batched crop rendering', () => {
  expect(isCropPlacedAssetId('rice')).toBe(true);
  expect(isCropPlacedAssetId('PotatoPlant')).toBe(true);
  expect(isCropPlacedAssetId('CauliflowerPlant')).toBe(true);
  expect(isCropPlacedAssetId('wheat2rotated3')).toBe(true);
  expect(isCropPlacedAssetId('sTree 1')).toBe(false);
  expect(isCropPlacedAssetId('bookcase2')).toBe(false);
});

test('water source assets resolve to the well object definition', () => {
  expect(objectDefIdForPlacedAsset('well')).toBe(WELL_OBJECT_DEF_ID);
  expect(objectDefIdForPlacedAsset('desert well')).toBe(WELL_OBJECT_DEF_ID);
  expect(objectDefIdForPlacedAsset('desert fountain')).toBe(WELL_OBJECT_DEF_ID);
});

test('structural map pieces do not become generic examine objects', () => {
  expect(objectDefIdForPlacedAsset('roof')).toBeUndefined();
  expect(objectDefIdForPlacedAsset('Fence2')).toBeUndefined();
  expect(objectDefIdForPlacedAsset('stone slab2')).toBeUndefined();
  expect(objectDefIdForPlacedAsset('wood pole')).toBeUndefined();
});
