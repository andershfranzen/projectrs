import { expect, test } from 'bun:test';
import {
  BROTHER_MONK_CHEST_OBJECT_DEF_ID,
  GENERIC_SCENERY_OBJECT_DEF_ID,
  WELL_OBJECT_DEF_ID,
  isCropPlacedAssetId,
  isWalkHerePrimarySceneryAssetId,
  objectDefIdForPlacedAsset,
  sceneryExamineMetaForAsset,
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

  expect(sceneryExamineMetaForAsset('Fountain_2')).toEqual({
    name: 'Fountain',
    examineText: 'The water reflects someone who should probably get back to work.',
  });
});

test('carpet scenery keeps examine metadata but defaults to walk here', () => {
  expect(objectDefIdForPlacedAsset('Carpet1x4')).toBe(GENERIC_SCENERY_OBJECT_DEF_ID);
  expect(sceneryExamineMetaForAsset('Carpet1x4')?.name).toBe('Carpet');
  expect(isWalkHerePrimarySceneryAssetId('Carpet1x4')).toBe(true);
  expect(isWalkHerePrimarySceneryAssetId('Carpet2x3')).toBe(true);
  expect(isWalkHerePrimarySceneryAssetId('bookcase2')).toBe(false);
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
  expect(objectDefIdForPlacedAsset('FishingSpotBubblesNet')).toBe(61);
  expect(objectDefIdForPlacedAsset('FishingSpotBubblesRod')).toBe(62);
  expect(objectDefIdForPlacedAsset('FishingSpotBubblesHarpoon')).toBe(63);
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
