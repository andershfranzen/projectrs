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
  world.npcs = new Map();
  world.playerCombatTargets = new Map();
  world.npcTargetedBy = new Map();
  world.maps = new Map([[player.currentMapLevel, map]]);
  world.blockedObjectTiles = new Set();
  world.currentTick = 0;
  world.getPlayerMap = () => map;
  world.clearCombatTarget = () => {};
  world.clearCombatReferencesTo = () => {};
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
  return player;
}

describe('placed stair descent', () => {
  test('kcmap registers placed stair ramp tiles from object chunks', () => {
    const map = new GameMap('kcmap');

    expect(map.getStair(219, 156)).not.toBeNull();
    expect(map.getStair(220, 156)).not.toBeNull();
    expect(map.getStair(221, 156)).not.toBeNull();
  });

  test('castle exterior stair rises toward the authored upper floor plane', () => {
    const map = new GameMap('kcmap');

    const lower = map.getEffectiveHeightOnFloor(219.5, 156.5, 0, 0);
    const middle = map.getEffectiveHeightOnFloor(220.5, 156.5, 0, lower);
    const upper = map.getEffectiveHeightOnFloor(221.5, 156.5, 0, middle);

    expect(lower).toBeLessThan(middle);
    expect(middle).toBeLessThan(upper);
    expect(map.getWalkableFloorTargetsAt(222.5, 156.5).some(target => target.floor === 1)).toBe(true);
  });

  test('height inference waits until the player steps off a placed stair ramp', () => {
    const map = new GameMap('kcmap');
    const player = makePlayer(221.5, 156.5, 0, 2.5);
    const { world, floorChanges } = makeHarness(map, player);

    world.tickTransitions();
    expect(player.currentFloor).toBe(0);
    expect(floorChanges).toEqual([]);

    player.position.x = 222.5;
    player.position.y = 156.5;
    player.effectiveY = map.getEffectiveHeightOnFloor(player.position.x, player.position.y, 0, 2.5);

    world.tickTransitions();
    expect(player.currentFloor).toBe(1);
    expect(floorChanges).toEqual([{ floor: 1, y: 27 }]);
  });

  test('upper-floor move to a ground target near a placed stair demotes before path validation', () => {
    const map = new GameMap('kcmap');
    const player = makePlayer(221.5, 156.5, 1, 2.5);
    const { world, floorChanges } = makeHarness(map, player);

    world.handlePlayerMove(player.id, [{ x: 224.5, z: 156.5 }]);

    expect(player.currentFloor).toBe(0);
    expect(floorChanges).toEqual([{ floor: 0, y: 25 }]);
    expect(player.hasMoveQueue()).toBe(true);
  });

  test('upper-floor move to a valid upstairs tile near a placed stair stays upstairs', () => {
    const map = new GameMap('kcmap');
    const player = makePlayer(221.5, 156.5, 1, 2.5);
    const { world, floorChanges } = makeHarness(map, player);

    world.handlePlayerMove(player.id, [{ x: 222.5, z: 156.5 }]);

    expect(player.currentFloor).toBe(1);
    expect(floorChanges).toEqual([]);
    expect(player.hasMoveQueue()).toBe(true);
  });
});
