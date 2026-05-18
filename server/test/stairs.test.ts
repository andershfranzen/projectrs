import { describe, expect, test } from 'bun:test';
import { ServerOpcode } from '@projectrs/shared';
import { GameMap } from '../src/GameMap';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function makeHarness(map: GameMap, player: Player): { world: any; floorChanges: Array<{ floor: number; y: number | undefined }> } {
  const floorChanges: Array<{ floor: number; y: number | undefined }> = [];
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.maps = new Map([[player.currentMapLevel, map]]);
  world.blockedObjectTiles = new Set();
  world.currentTick = 0;
  world.getPlayerMap = () => map;
  world.clearCombatTarget = () => {};
  world.cancelSkilling = () => {};
  world.closeOpenInterface = () => {};
  world.sendDialogueClose = () => {};
  world.sendNearbyDoorUpdates = () => {};
  world.refreshPlayerEffectiveY = (p: Player) => {
    p.effectiveY = map.getEffectiveHeightOnFloor(p.position.x, p.position.y, p.currentFloor, p.effectiveY);
  };
  world.sendToPlayer = (_p: Player, opcode: ServerOpcode, ...values: number[]) => {
    if (opcode === ServerOpcode.FLOOR_CHANGE) floorChanges.push({ floor: values[0], y: values[1] });
  };
  return { world, floorChanges };
}

function makePlayer(x: number, z: number, floor: number, y: number): Player {
  const player = new Player('stair_test', x, z, fakeWs, 1);
  player.currentMapLevel = 'kcmap';
  player.currentFloor = floor;
  player.effectiveY = y;
  player.reportedY = y;
  return player;
}

describe('placed stair descent', () => {
  test('kcmap registers placed stair ramp tiles from object chunks', () => {
    const map = new GameMap('kcmap');

    expect(map.getStair(155, 156)).not.toBeNull();
    expect(map.getStair(156, 156)).not.toBeNull();
    expect(map.getStair(157, 156)).not.toBeNull();
  });

  test('upper-floor move to a ground target near a placed stair demotes before path validation', () => {
    const map = new GameMap('kcmap');
    const player = makePlayer(157.5, 156.5, 1, 2.5);
    const { world, floorChanges } = makeHarness(map, player);

    world.handlePlayerMove(player.id, [{ x: 160.5, z: 156.5 }]);

    expect(player.currentFloor).toBe(0);
    expect(floorChanges).toEqual([{ floor: 0, y: 5 }]);
    expect(player.hasMoveQueue()).toBe(true);
  });

  test('upper-floor move to a valid upstairs tile near a placed stair stays upstairs', () => {
    const map = new GameMap('kcmap');
    const player = makePlayer(157.5, 156.5, 1, 2.5);
    const { world, floorChanges } = makeHarness(map, player);

    world.handlePlayerMove(player.id, [{ x: 158.5, z: 156.5 }]);

    expect(player.currentFloor).toBe(1);
    expect(floorChanges).toEqual([]);
    expect(player.hasMoveQueue()).toBe(true);
  });
});
