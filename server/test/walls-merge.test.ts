import { describe, expect, test } from 'bun:test';
import type { WallsFile } from '@projectrs/shared';
import { preserveExistingFloorLayerTiles } from '../src/data/WallsMerge';

describe('preserveExistingFloorLayerTiles', () => {
  test('keeps existing upper-floor tiles when editor payload omits them', () => {
    const existing: WallsFile = {
      walls: {},
      floorLayers: {
        1: { walls: { '5,5': 1 }, tiles: { '5,5': 2.1 } },
      },
    };
    const incoming: WallsFile = {
      walls: {},
      floorLayers: {
        1: { walls: { '5,5': 2 } },
      },
    };

    expect(preserveExistingFloorLayerTiles(incoming, existing).floorLayers?.[1].tiles)
      .toEqual({ '5,5': 2.1 });
  });

  test('treats empty editor tile records as missing by default', () => {
    const existing: WallsFile = {
      walls: {},
      floorLayers: {
        1: { walls: {}, tiles: { '5,5': 2.1 } },
      },
    };
    const incoming: WallsFile = {
      walls: {},
      floorLayers: {
        1: { walls: {}, tiles: {} },
      },
    };

    expect(preserveExistingFloorLayerTiles(incoming, existing).floorLayers?.[1].tiles)
      .toEqual({ '5,5': 2.1 });
  });

  test('can honor an explicit empty tile record when requested', () => {
    const existing: WallsFile = {
      walls: {},
      floorLayers: {
        1: { walls: {}, tiles: { '5,5': 2.1 } },
      },
    };
    const incoming: WallsFile = {
      walls: {},
      floorLayers: {
        1: { walls: {}, tiles: {} },
      },
    };

    expect(preserveExistingFloorLayerTiles(incoming, existing, { preserveEmptyTileRecords: false }).floorLayers?.[1].tiles)
      .toEqual({});
  });
});
