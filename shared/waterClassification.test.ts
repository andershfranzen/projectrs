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

  test('shoreline slopes with one submerged corner remain walkable land', () => {
    const tile = defaultKCTile('sand');
    const shoreCorners = { tl: -0.2, tr: 0.3, bl: 0.4, br: 0.2 };

    expect(classifyTileType(tile, shoreCorners, 0)).toBe(TileType.SAND);
  });

  test('shoreline slopes with two submerged corners remain walkable land', () => {
    const tile = defaultKCTile('sand');
    const shoreCorners = { tl: -0.2, tr: -0.1, bl: 0.35, br: 0.25 };

    expect(classifyTileType(tile, shoreCorners, 0)).toBe(TileType.SAND);
  });

  test('mostly submerged terrain is blocking water', () => {
    const tile = defaultKCTile('sand');
    const riverCorners = { tl: -0.2, tr: -0.1, bl: -0.3, br: 0.25 };

    expect(classifyTileType(tile, riverCorners, 0)).toBe(TileType.WATER);
  });

  test('dungeon rock paint is visual-only for collision', () => {
    for (const ground of ['dungeon-rock', 'dungeon-grey-rock', 'dungeon-dark-rock'] as const) {
      const tile = defaultKCTile(ground);

      expect(classifyTileType(tile, flatCorners, -1)).toBe(TileType.STONE);
    }
  });
});
