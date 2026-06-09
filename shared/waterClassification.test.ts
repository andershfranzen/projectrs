import { describe, expect, test } from 'bun:test';
import { classifyTileType, defaultKCTile, TileType } from './types';

const flatCorners = { tl: 0, tr: 0, bl: 0, br: 0 };

describe('water tile classification', () => {
  test('mud paint stays walkable mud above the water level', () => {
    const tile = { ...defaultKCTile('grass'), waterPainted: true };

    expect(classifyTileType(tile, flatCorners, -1)).toBe(TileType.MUD);
  });

  test('surface-water paint stays walkable on flat terrain', () => {
    const tile = { ...defaultKCTile('grass'), waterSurface: true };

    expect(classifyTileType(tile, flatCorners, -1)).toBe(TileType.GRASS);
  });

  test('second-half surface-water paint also stays walkable on flat terrain', () => {
    const tile = { ...defaultKCTile('grass'), waterSurfaceB: true };

    expect(classifyTileType(tile, flatCorners, -1)).toBe(TileType.GRASS);
  });

  test('surface-water over mud paint stays walkable mud', () => {
    const tile = { ...defaultKCTile('grass'), waterPainted: true, waterSurface: true, waterSurfaceB: true };

    expect(classifyTileType(tile, flatCorners, -1)).toBe(TileType.MUD);
  });

  test('submerged terrain remains real water', () => {
    const tile = defaultKCTile('sand');

    expect(classifyTileType(tile, flatCorners, 0)).toBe(TileType.WATER);
  });
});
