import { expect, test } from 'bun:test';
import { compressedPathTileSteps } from './movementPath';

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
