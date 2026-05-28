import { describe, expect, test } from 'bun:test';
import { deriveElevatedFloorTiles, deriveUpperFloorTilesFromPlanes } from './floorDerivation';

const flatPlane = (x: number, z: number, y: number) => ({
  position: { x, y, z },
  rotation: { x: -Math.PI / 2, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
  width: 1,
  height: 1,
});

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

describe('deriveUpperFloorTilesFromPlanes floor bands', () => {
  test('keeps significant low first-floor buildings in the same floor number as taller first floors', () => {
    const planes = [
      flatPlane(0.5, 0.5, -0.4),
      ...Array.from({ length: 9 }, (_, i) => flatPlane(1.5 + i, 0.5, 2.12)),
      ...Array.from({ length: 20 }, (_, i) => flatPlane(1.5 + i, 2.5, 2.68)),
      flatPlane(15.5, 0.5, 2.34),
      ...Array.from({ length: 8 }, (_, i) => flatPlane(1.5 + i, 4.5, 5.5)),
    ];

    const floors = deriveUpperFloorTilesFromPlanes(planes, 32, 8);
    expect(floors.get(1)?.get(1)).toBe(2.12);
    expect(floors.get(1)?.get(2 * 32 + 1)).toBe(2.68);
    expect(floors.get(1)?.has(15)).toBe(false);
    expect(floors.get(2)?.get(4 * 32 + 1)).toBe(5.5);
  });
});
