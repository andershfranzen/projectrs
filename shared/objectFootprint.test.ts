import { expect, test } from 'bun:test';
import {
  getObjectFootprintBounds,
  getObjectFootprintCenter,
  getObjectFootprintCenterCoord,
  getObjectFootprintContinuousCenterCoord,
  getObjectFootprintTiles,
  getObjectInteractionTiles,
  isTileInsideObjectFootprint,
  isTileAdjacentToObject,
} from './objectFootprint';

test('footprint center matches tile-center average for odd and even widths', () => {
  for (const width of [1, 2, 3, 4, 5]) {
    const x = 10.5;
    const z = 20.5;
    const tiles = getObjectFootprintTiles(x, z, { width });
    const avgX = tiles.reduce((sum, tile) => sum + tile.x + 0.5, 0) / tiles.length;
    const avgZ = tiles.reduce((sum, tile) => sum + tile.z + 0.5, 0) / tiles.length;
    const center = getObjectFootprintCenter(x, z, { width });

    expect(center.x).toBe(avgX);
    expect(center.z).toBe(avgZ);
    expect(getObjectFootprintCenterCoord(x, width)).toBe(avgX);
    expect(getObjectFootprintCenterCoord(z, width)).toBe(avgZ);
  }
});

test('continuous footprint center preserves sub-tile render movement', () => {
  expect(getObjectFootprintContinuousCenterCoord(10.5, 2)).toBe(10);
  expect(getObjectFootprintContinuousCenterCoord(10.75, 2)).toBe(10.25);
  expect(getObjectFootprintContinuousCenterCoord(10.5, 3)).toBe(10.5);
  expect(getObjectFootprintContinuousCenterCoord(10.75, 3)).toBe(10.75);
});

test('size two footprint uses shared center and perimeter convention', () => {
  expect(getObjectFootprintBounds(10.5, 20.5, 2)).toEqual({
    minX: 9,
    maxX: 10,
    minZ: 19,
    maxZ: 20,
    width: 2,
    depth: 2,
  });
  expect(getObjectFootprintCenter(10.5, 20.5, { width: 2 })).toEqual({ x: 10, z: 20 });
  expect(getObjectFootprintTiles(10.5, 20.5, { width: 2 })).toEqual([
    { x: 9, z: 19 },
    { x: 9, z: 20 },
    { x: 10, z: 19 },
    { x: 10, z: 20 },
  ]);
  expect(getObjectInteractionTiles(10.5, 20.5, { width: 2 })).toEqual([
    { x: 9, z: 21 },
    { x: 10, z: 21 },
    { x: 11, z: 20 },
    { x: 11, z: 19 },
    { x: 10, z: 18 },
    { x: 9, z: 18 },
    { x: 8, z: 19 },
    { x: 8, z: 20 },
  ]);
});

test('rectangular footprints use depth and rotate in quarter turns', () => {
  const def = { width: 2, depth: 1 };
  expect(getObjectFootprintBounds(10.5, 20.5, def)).toEqual({
    minX: 9,
    maxX: 10,
    minZ: 20,
    maxZ: 20,
    width: 2,
    depth: 1,
  });
  expect(getObjectFootprintTiles(10.5, 20.5, def)).toEqual([
    { x: 9, z: 20 },
    { x: 10, z: 20 },
  ]);
  expect(getObjectInteractionTiles(10.5, 20.5, def)).toEqual([
    { x: 9, z: 21 },
    { x: 10, z: 21 },
    { x: 11, z: 20 },
    { x: 10, z: 19 },
    { x: 9, z: 19 },
    { x: 8, z: 20 },
  ]);
  expect(getObjectFootprintTiles(10.5, 20.5, def, Math.PI / 2)).toEqual([
    { x: 10, z: 19 },
    { x: 10, z: 20 },
  ]);
  expect(isTileInsideObjectFootprint(9, 20, 10.5, 20.5, def)).toBe(true);
  expect(isTileInsideObjectFootprint(9, 19, 10.5, 20.5, def)).toBe(false);
  expect(isTileAdjacentToObject(11, 20, 10.5, 20.5, def)).toBe(true);
});

test('interaction tiles are cardinal-only around larger footprints', () => {
  for (const width of [1, 2, 3, 4, 5]) {
    const x = 10.5;
    const z = 20.5;
    const footprintKeys = new Set(
      getObjectFootprintTiles(x, z, { width }).map(tile => `${tile.x},${tile.z}`),
    );
    for (const tile of getObjectInteractionTiles(x, z, { width })) {
      expect(footprintKeys.has(`${tile.x},${tile.z}`)).toBe(false);
      expect(isTileAdjacentToObject(tile.x, tile.z, x, z, { width })).toBe(true);
    }
    const { minX, minZ } = getObjectFootprintBounds(x, z, width);
    expect(isTileAdjacentToObject(minX - 1, minZ - 1, x, z, { width })).toBe(false);
  }
});

test('inside-footprint checks distinguish overlap from interaction perimeter', () => {
  expect(isTileInsideObjectFootprint(10, 20, 10.5, 20.5, { width: 2 })).toBe(true);
  expect(isTileInsideObjectFootprint(9, 19, 10.5, 20.5, { width: 2 })).toBe(true);
  expect(isTileInsideObjectFootprint(11, 20, 10.5, 20.5, { width: 2 })).toBe(false);
  expect(isTileAdjacentToObject(11, 20, 10.5, 20.5, { width: 2 })).toBe(true);
});
