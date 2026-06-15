import { describe, expect, test } from 'bun:test';
import {
  areTilesCardinallyAdjacent,
  canReachGroundItemTile,
  findPathToReach,
  isTileInsidePathingCollisionBox,
  type TargetPathingCollision,
} from './targetPathing';

function collision(
  blocked: Set<string> = new Set(),
  wallBlocked: Set<string> = new Set(),
): TargetPathingCollision {
  return {
    width: 16,
    height: 16,
    isTileBlocked: (x, z) => blocked.has(`${x},${z}`),
    isWallBlocked: (fx, fz, tx, tz) => wallBlocked.has(`${fx},${fz}->${tx},${tz}`),
  };
}

describe('target pathing', () => {
  test('routes around blockers to a target reach tile', () => {
    const path = findPathToReach({
      startX: 0.5,
      startZ: 1.5,
      collision: collision(new Set(['1,1', '3,1'])),
      reached: (tileX, tileZ) => tileX === 2 && tileZ === 1,
    });

    expect(path.length).toBeGreaterThan(2);
    expect(path.at(-1)).toEqual({ x: 2.5, z: 1.5 });
    expect(path.some(step => Math.floor(step.x) === 1 && Math.floor(step.z) === 1)).toBe(false);
    expect(path.some(step => Math.floor(step.x) === 3 && Math.floor(step.z) === 1)).toBe(false);
  });

  test('can return compressed movement waypoints', () => {
    const path = findPathToReach({
      startX: 0.5,
      startZ: 0.5,
      collision: collision(),
      compress: true,
      reached: (tileX, tileZ) => tileX === 6 && tileZ === 0,
    });

    expect(path).toEqual([
      { x: 1.5, z: 0.5 },
      { x: 6.5, z: 0.5 },
    ]);
  });

  test('surface ground item reach requires a cardinal tile', () => {
    const c = collision();

    expect(areTilesCardinallyAdjacent(5, 5, 6, 5)).toBe(true);
    expect(areTilesCardinallyAdjacent(5, 5, 6, 6)).toBe(false);
    expect(canReachGroundItemTile(c, 5, 5, 6, 5, true)).toBe(true);
    expect(canReachGroundItemTile(c, 5, 5, 6, 6, true)).toBe(false);
    expect(canReachGroundItemTile(c, 4, 5, 6, 5, true)).toBe(false);
  });

  test('collision box detection accepts blocked tiles or cardinal collision edges', () => {
    expect(isTileInsidePathingCollisionBox(collision(new Set(['6,5'])), 6, 5)).toBe(true);
    expect(isTileInsidePathingCollisionBox(collision(new Set(), new Set(['5,5->6,5'])), 6, 5)).toBe(true);
    expect(isTileInsidePathingCollisionBox(collision(), 6, 5)).toBe(false);
  });
});
