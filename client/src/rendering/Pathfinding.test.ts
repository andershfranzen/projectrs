import { describe, expect, test } from 'bun:test';
import { findPath } from './Pathfinding';

describe('client pathfinding', () => {
  test('honors the max step search limit', () => {
    const path = findPath(
      0.5,
      0.5,
      5.5,
      0.5,
      () => false,
      16,
      16,
      3,
    );

    expect(path.at(-1)).toEqual({ x: 3.5, z: 0.5 });
  });

  test('walks toward goals beyond the local search window instead of returning empty', () => {
    const path = findPath(
      0.5,
      0.5,
      100.5,
      0.5,
      () => false,
      256,
      16,
      200,
    );

    expect(path.length).toBeGreaterThan(0);
    expect(path.at(-1)).toEqual({ x: 63.5, z: 0.5 });
  });

  test('caps compressed waypoints instead of returning an empty path', () => {
    const key = (x: number, z: number) => `${x},${z}`;
    const passable = new Set<string>([key(0, 0)]);
    let corridorX = 0;
    let corridorZ = 0;

    for (let i = 0; i < 30; i++) {
      corridorX++;
      passable.add(key(corridorX, corridorZ));
      corridorX++;
      passable.add(key(corridorX, corridorZ));
      passable.add(key(corridorX, 1));
      corridorZ = corridorZ === 0 ? 2 : 0;
      passable.add(key(corridorX, corridorZ));
    }

    const path = findPath(
      0.5,
      0.5,
      corridorX + 0.5,
      corridorZ + 0.5,
      (x, z) => !passable.has(key(x, z)),
      128,
      8,
      500,
    );

    expect(path).toHaveLength(50);
    expect(path.at(-1)).toEqual({ x: 50.5, z: 0.5 });
  });
});
