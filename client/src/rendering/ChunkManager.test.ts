import { describe, expect, test } from 'bun:test';
import { isInteractiveDoorPlacedAsset, isRoofLikePlacedAsset, placedObjectThinGroupKey } from './ChunkManager';

describe('placed object roof classification', () => {
  test('does not treat structural slabs as removable roofs', () => {
    expect(isRoofLikePlacedAsset('stone slab')).toBe(false);
    expect(isRoofLikePlacedAsset('stone slab2')).toBe(false);
    expect(isRoofLikePlacedAsset('stone slabs')).toBe(false);
  });

  test('still treats actual roof assets as removable roofs', () => {
    expect(isRoofLikePlacedAsset('roof')).toBe(true);
    expect(isRoofLikePlacedAsset('flat roof')).toBe(true);
    expect(isRoofLikePlacedAsset('roof corner')).toBe(true);
    expect(isRoofLikePlacedAsset('tile roofing')).toBe(true);
    expect(isRoofLikePlacedAsset('wood roofing')).toBe(true);
    expect(isRoofLikePlacedAsset('spire')).toBe(true);
  });
});

describe('placed object door classification', () => {
  test('only Truedoor assets are treated as interactive door panels', () => {
    expect(isInteractiveDoorPlacedAsset('castleTruedoor')).toBe(true);
    expect(isInteractiveDoorPlacedAsset('basicTruedoor')).toBe(true);
    expect(isInteractiveDoorPlacedAsset('stone door1')).toBe(false);
    expect(isInteractiveDoorPlacedAsset('dark stone door2')).toBe(false);
    expect(isInteractiveDoorPlacedAsset('wood door3')).toBe(false);
    expect(isInteractiveDoorPlacedAsset('white doorway')).toBe(false);
  });
});

describe('placed object thin-instance grouping', () => {
  test('separates elevated scenery by storey height for indoor culling', () => {
    const firstFloorWall = placedObjectThinGroupKey('stone wall', 'elevated', 2.73);
    const upperWall = placedObjectThinGroupKey('stone wall', 'elevated', 5.49);

    expect(firstFloorWall).not.toBe(upperWall);
  });

  test('keeps small same-storey placement jitter in one elevated batch', () => {
    expect(placedObjectThinGroupKey('stone wall', 'elevated', 2.73))
      .toBe(placedObjectThinGroupKey('stone wall', 'elevated', 2.75));
  });

  test('does not split ground or roof batches by height', () => {
    expect(placedObjectThinGroupKey('stone wall', 'ground', 0))
      .toBe(placedObjectThinGroupKey('stone wall', 'ground', 2.73));
    expect(placedObjectThinGroupKey('tile roofing', 'roof', 2.73))
      .toBe(placedObjectThinGroupKey('tile roofing', 'roof', 5.49));
  });
});
