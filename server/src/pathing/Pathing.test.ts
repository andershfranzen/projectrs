import { describe, expect, test } from 'bun:test';
import {
  canTravel,
  findPathToAnyTile,
  findPathToRectInteraction,
  isRectInteractionTileReachable,
  stepTowardNaiveInteraction,
  type PathingCollision,
} from './Pathing';

function openCollision(blocked: Set<string> = new Set(), wallBlocked?: PathingCollision['isWallBlocked']): PathingCollision {
  return {
    width: 32,
    height: 32,
    isTileBlocked: (x, z) => blocked.has(`${x},${z}`),
    isWallBlocked: wallBlocked,
  };
}

describe('server pathing', () => {
  test('paths to an entity interaction surface instead of the occupied tile', () => {
    const path = findPathToRectInteraction({
      startX: 0.5,
      startZ: 1.5,
      targetX: 3.5,
      targetZ: 1.5,
      targetSize: 1,
      collision: openCollision(),
    });

    expect(path.at(-1)).toEqual({ x: 2.5, z: 1.5 });
    expect(path.some(step => Math.floor(step.x) === 3 && Math.floor(step.z) === 1)).toBe(false);
  });

  test('entity reach requires a clear wall edge to the footprint', () => {
    const blocked = new Set(['3,0', '3,2', '4,1']);
    const collision = openCollision(blocked, (fx, fz, tx, tz) =>
      fx === 2 && fz === 1 && tx === 3 && tz === 1);

    const path = findPathToRectInteraction({
      startX: 0.5,
      startZ: 1.5,
      targetX: 3.5,
      targetZ: 1.5,
      targetSize: 1,
      collision,
    });

    expect(path).toEqual([]);
    expect(isRectInteractionTileReachable(collision, 2, 1, 3.5, 1.5, 1)).toBe(false);
  });

  test('BFS routes exact tile paths around blockers without corner cutting', () => {
    const path = findPathToAnyTile({
      startX: 0.5,
      startZ: 0.5,
      goals: [{ x: 2, z: 0 }],
      collision: openCollision(new Set(['1,0'])),
    });

    expect(path.length).toBeGreaterThan(2);
    expect(path.at(-1)).toEqual({ x: 2.5, z: 0.5 });
    expect(path.some(step => Math.floor(step.x) === 1 && Math.floor(step.z) === 0)).toBe(false);
  });

  test('naive chase steps toward the target interaction surface', () => {
    const collision = openCollision();
    const step = stepTowardNaiveInteraction(collision, 10.5, 10.5, 1, 9.5, 9.5, 1);

    expect(step).not.toBeNull();
    expect(isRectInteractionTileReachable(collision, Math.floor(step!.x), Math.floor(step!.z), 9.5, 9.5, 1)).toBe(true);
  });

  test('large naive chase steps use the common validator without diagonal jumps', () => {
    const step = stepTowardNaiveInteraction(openCollision(), 10.5, 10.5, 2, 8.5, 8.5, 1);

    expect(step).not.toBeNull();
    expect(Math.abs(Math.floor(step!.x) - 10) + Math.abs(Math.floor(step!.z) - 10)).toBe(1);
  });

  test('sized movement validates the whole destination footprint', () => {
    const collision = openCollision(new Set(['11,9']));

    expect(canTravel(collision, 10, 10, 1, 0, 2)).toBe(false);
  });
});
