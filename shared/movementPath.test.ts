import { expect, test } from 'bun:test';
import {
  collectCompressedRouteTileKeys,
  compressedPathTileSteps,
  compressedPathTileStepsFromIndex,
  compressedRouteProgressSteps,
  compressedRouteSegmentIndexForTile,
  compressedRouteStepIndexForTile,
  samePathTile,
  tileOnCompressedPathSegment,
} from './movementPath';

test('compressedPathTileSteps counts unit tiles across compressed segments', () => {
  expect(compressedPathTileSteps(
    { x: 10.5, z: 7.5 },
    [
      { x: 30.5, z: 7.5 },
      { x: 30.5, z: 9.5 },
      { x: 10.5, z: 9.5 },
    ],
  )).toBe(42);
});

test('compressedPathTileStepsFromIndex counts without slicing the path', () => {
  const path = [
    { x: 11.5, z: 7.5 },
    { x: 30.5, z: 7.5 },
    { x: 30.5, z: 9.5 },
  ];

  expect(compressedPathTileStepsFromIndex({ x: 11.5, z: 7.5 }, path, 1)).toBe(21);
});

test('tileOnCompressedPathSegment detects tiles on straight and diagonal segments', () => {
  expect(tileOnCompressedPathSegment({ x: 0.5, z: 0.5 }, { x: 4.5, z: 4.5 }, 3, 3)).toBe(true);
  expect(tileOnCompressedPathSegment({ x: 0.5, z: 0.5 }, { x: 4.5, z: 4.5 }, 3, 2)).toBe(false);
  expect(tileOnCompressedPathSegment({ x: 2.5, z: 1.5 }, { x: 2.5, z: 6.5 }, 2, 5)).toBe(true);
});

test('compressed route helpers find segment and step indices', () => {
  const path = [
    { x: 5.5, z: 0.5 },
    { x: 5.5, z: 4.5 },
    { x: 8.5, z: 7.5 },
  ];

  expect(compressedRouteSegmentIndexForTile({ x: 0.5, z: 0.5 }, path, 5, 3)).toBe(1);
  expect(compressedRouteSegmentIndexForTile({ x: 5.5, z: 2.5 }, path, 5, 3, 1)).toBe(1);
  expect(compressedRouteStepIndexForTile({ x: 0.5, z: 0.5 }, path, 5.5, 3.5)).toBe(8);
  expect(compressedRouteStepIndexForTile({ x: 0.5, z: 0.5 }, path, 7.5, 6.5)).toBe(11);
  expect(compressedRouteStepIndexForTile({ x: 0.5, z: 0.5 }, path, 7.5, 5.5)).toBe(-1);
});

test('compressedRouteProgressSteps accounts for completed segments and active progress', () => {
  const path = [
    { x: 5.5, z: 0.5 },
    { x: 5.5, z: 4.5 },
  ];

  expect(compressedRouteProgressSteps({ x: 0.5, z: 0.5 }, path, 0, 0.5)).toBe(2.5);
  expect(compressedRouteProgressSteps({ x: 0.5, z: 0.5 }, path, 1, 0.25)).toBe(6);
});

test('collectCompressedRouteTileKeys emits every unit tile on a compressed route', () => {
  const tiles = collectCompressedRouteTileKeys(
    { x: 0.5, z: 0.5 },
    [
      { x: 2.5, z: 0.5 },
      { x: 4.5, z: 2.5 },
    ],
  );

  expect([...tiles]).toEqual(['0,0', '1,0', '2,0', '3,1', '4,2']);
});

test('samePathTile compares by tile, not fractional offset', () => {
  expect(samePathTile({ x: 1.1, z: 2.9 }, { x: 1.8, z: 2.1 })).toBe(true);
  expect(samePathTile({ x: 1.1, z: 2.9 }, { x: 2.1, z: 2.1 })).toBe(false);
});
