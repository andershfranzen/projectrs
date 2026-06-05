import { expect, test } from 'bun:test';
import {
  GENERIC_SCENERY_OBJECT_DEF_ID,
  objectDefIdForPlacedAsset,
  sceneryExamineMetaForAsset,
} from './index';

test('filler scenery has clean display names and authored examine text', () => {
  expect(objectDefIdForPlacedAsset('bookcase2')).toBe(GENERIC_SCENERY_OBJECT_DEF_ID);
  expect(sceneryExamineMetaForAsset('bookcase2')).toEqual({
    name: 'Bookcase',
    examineText: 'Shelves packed with dusty old books.',
  });

  expect(objectDefIdForPlacedAsset('OnePersonBed1')).toBe(GENERIC_SCENERY_OBJECT_DEF_ID);
  expect(sceneryExamineMetaForAsset('OnePersonBed1')?.name).toBe('Bed');
  expect(sceneryExamineMetaForAsset('OnePersonBed1')?.examineText).toBe('A narrow bed. It looks more useful than comfortable.');

  expect(objectDefIdForPlacedAsset('bush1')).toBe(GENERIC_SCENERY_OBJECT_DEF_ID);
  expect(sceneryExamineMetaForAsset('bush1')).toEqual({
    name: 'Bush',
    examineText: 'A thick bush with tangled branches and dark leaves. Something could easily hide in it.',
  });
  expect(sceneryExamineMetaForAsset('bush2')?.examineText).toBe('A scruffy roadside bush, dusty at the roots and stubbornly alive.');
  expect(sceneryExamineMetaForAsset('bush3')?.examineText).toBe('George W.');
});

test('tree assets resolve to the right harvestable object definitions', () => {
  expect(objectDefIdForPlacedAsset('sTree 1')).toBe(1);
  expect(objectDefIdForPlacedAsset('dying tree')).toBe(10);
});

test('structural map pieces do not become generic examine objects', () => {
  expect(objectDefIdForPlacedAsset('roof')).toBeUndefined();
  expect(objectDefIdForPlacedAsset('Fence2')).toBeUndefined();
  expect(objectDefIdForPlacedAsset('stone slab2')).toBeUndefined();
  expect(objectDefIdForPlacedAsset('wood pole')).toBeUndefined();
});
