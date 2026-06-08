import { describe, expect, test } from 'bun:test';
import { classifyTileType, defaultKCTile, TileType } from './types';

const flatCorners = { tl: 0, tr: 0, bl: 0, br: 0 };

describe('water tile classification', () => {
  test('mud paint stays walkable mud above the water level', () => {
    const tile = { ...defaultKCTile('grass'), waterPainted: true };

    expect(classifyTileType(tile, flatCorners, -1)).toBe(TileType.MUD);
  });

  test('surface-water paint is real blocking water', () => {
    const tile = { ...defaultKCTile('grass'), waterSurface: true };

    expect(classifyTileType(tile, flatCorners, -1)).toBe(TileType.WATER);
  });

  test('second-half surface-water paint is also real blocking water', () => {
    const tile = { ...defaultKCTile('grass'), waterSurfaceB: true };

    expect(classifyTileType(tile, flatCorners, -1)).toBe(TileType.WATER);
  });

  test('submerged terrain remains real water', () => {
    const tile = defaultKCTile('sand');

    expect(classifyTileType(tile, flatCorners, 0)).toBe(TileType.WATER);
  });
});
