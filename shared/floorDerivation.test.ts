import { describe, expect, test } from 'bun:test';
import { deriveElevatedFloorTiles } from './floorDerivation';

describe('deriveElevatedFloorTiles bridge flag', () => {
  test('explicit bridge planes snap even when terrain is not blocking water', () => {
    const tileIdx = 0;
    const basePlane = {
      position: { x: 0.5, y: 1.25, z: 0.5 },
      rotation: { x: -Math.PI / 2, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      width: 1,
      height: 1,
    };

    const withoutFlag = deriveElevatedFloorTiles(
      [basePlane],
      1,
      1,
      () => 0,
      () => false,
    ).get(tileIdx);
    expect(withoutFlag?.isBridge).toBe(false);

    const withFlag = deriveElevatedFloorTiles(
      [{ ...basePlane, bridge: true }],
      1,
      1,
      () => 0,
      () => false,
    ).get(tileIdx);
    expect(withFlag?.isBridge).toBe(true);
    expect(withFlag?.wasBlocking).toBe(false);
  });

  test('explicit bridge planes can be modest ramps', () => {
    const entry = deriveElevatedFloorTiles(
      [{
        position: { x: 0.5, y: 0.5, z: 0.5 },
        rotation: { x: -1.31, y: 0, z: Math.PI / 2 },
        scale: { x: 1, y: 1, z: 1 },
        width: 1,
        height: 1,
        bridge: true,
      }],
      1,
      1,
      () => -1,
      () => false,
    ).get(0);

    expect(entry?.isBridge).toBe(true);
    expect(entry?.y).toBe(0.5);
  });
});
