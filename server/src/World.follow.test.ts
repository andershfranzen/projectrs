import { describe, expect, test } from 'bun:test';
import { World } from './World';
import { Player } from './entity/Player';

function makePlayer(name: string, x: number, z: number): Player {
  return new Player(name, x, z, {} as any, 1);
}

function makeFollowHarness() {
  const pathCalls: Array<{ goalX: number; goalZ: number }> = [];
  const world: any = Object.create(World.prototype);
  world.currentTick = 10;
  world.getPlayerMap = () => ({
    isWallBlocked: () => false,
    isWallBlockedOnFloor: () => false,
    findPathForNpc: (_sx: number, _sz: number, goalX: number, goalZ: number) => {
      pathCalls.push({ goalX, goalZ });
      return [{ x: goalX, z: goalZ }];
    },
  });
  world.isPlayerMovementTileBlocked = () => false;
  return { world, pathCalls };
}

describe('player follow scheduling', () => {
  test('does not repath while the follower still has a queued path', () => {
    const { world, pathCalls } = makeFollowHarness();
    const follower = makePlayer('follower', 5.5, 5.5);
    const target = makePlayer('target', 10.5, 10.5);
    target.moveTo(11.5, 10.5);
    follower.setMoveQueue([{ x: 6.5, z: 5.5 }, { x: 7.5, z: 5.5 }]);

    world.updatePlayerFollow(follower, target);

    expect(pathCalls.length).toBe(0);
    expect(follower.getMoveDestination()).toEqual({ x: 7.5, z: 5.5 });
  });

  test('same-tile follow chooses an adjacent tile instead of the live target tile', () => {
    const { world, pathCalls } = makeFollowHarness();
    const follower = makePlayer('follower', 10.5, 10.5);
    const target = makePlayer('target', 10.5, 10.5);
    target.followAnchorX = target.position.x;
    target.followAnchorZ = target.position.y;

    world.updatePlayerFollow(follower, target);

    expect(follower.getMoveDestination()).toEqual({ x: 9.5, z: 10.5 });
  });
});
