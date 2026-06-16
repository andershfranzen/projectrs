import { describe, expect, test } from 'bun:test';
import { WallEdge } from '@projectrs/shared';
import { GameMap } from '../src/GameMap';

function makeMap(): GameMap {
  const map = Object.create(GameMap.prototype) as any;
  map.width = 12;
  map.height = 12;
  map.walls = new Uint8Array(map.width * map.height);
  map.wallHeights = new Map<number, number>();
  map.shootOverProjectileWallEdges = new Uint8Array(map.width * map.height);
  map.floorHeights = new Map<number, number>();
  map.elevatedFloorHeights = new Map<number, number>();
  map.openDoorEdges = new Map<string, number>();
  map.floorLayers = new Map();
  map.getInterpolatedHeight = () => 0;
  return map as GameMap;
}

describe('projectile line of sight', () => {
  test('default-height wall edges block arrows', () => {
    const map = makeMap();
    map.setWall(5, 4, WallEdge.E);

    expect(map.hasProjectileLineOfSight(4.5, 4.5, 7.5, 4.5, 0, 1.35, 1.0)).toBe(false);
  });

  test('low fence-height wall edges can be shot over', () => {
    const map = makeMap();
    map.setWall(5, 4, WallEdge.E);
    (map as any).wallHeights.set(4 * 12 + 5, 1.1);

    expect(map.hasProjectileLineOfSight(4.5, 4.5, 7.5, 4.5, 0, 1.35, 1.0)).toBe(true);
  });

  test('diagonal shots check the destination entry edges exactly', () => {
    const map = makeMap();
    map.setWall(5, 5, WallEdge.W);

    expect(map.hasProjectileLineOfSight(4.5, 4.5, 7.5, 7.5, 0, 1.35, 1.0)).toBe(false);
  });

  test('kcmap cow pen fence can be shot over', () => {
    const map = new GameMap('kcmap');

    expect(map.hasProjectileLineOfSight(172.5, 170.5, 181.5, 171.5, 0, 1.35, 1.0)).toBe(true);
    expect(map.hasProjectileLineOfSight(202.5, 172.5, 188.5, 172.5, 0, 1.35, 1.0)).toBe(true);
    expect(map.hasProjectileLineOfSight(188.5, 187.5, 188.5, 179.5, 0, 1.35, 1.0)).toBe(true);
  });

  test('kcmap full-height building walls near the south-west building block arrows', () => {
    const map = new GameMap('kcmap');

    expect(map.hasProjectileLineOfSight(87.5, 35.5, 90.5, 35.5, 0, 1.35, 1.0)).toBe(false);
    expect(map.hasProjectileLineOfSight(90.5, 35.5, 87.5, 35.5, 0, 1.35, 1.0)).toBe(false);
  });

  test('kcmap fence assets do not make nearby full-height building walls shoot-over', () => {
    const map = new GameMap('kcmap');

    expect(map.hasProjectileLineOfSight(86.5, 20.5, 87.5, 24.5, 0, 1.35, 1.0)).toBe(false);
  });

  test('kcmap fence asset edges remain shoot-over', () => {
    const map = new GameMap('kcmap');

    expect(map.hasProjectileLineOfSight(86.5, 23.5, 86.5, 24.5, 0, 1.35, 1.0)).toBe(true);
  });
});
