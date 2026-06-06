import { describe, expect, test } from 'bun:test';
import type { WorldObjectDef } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { WorldObject } from '../src/entity/WorldObject';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

const caveDef: WorldObjectDef = {
  id: 15,
  name: 'Cave Entrance',
  category: 'scenery',
  actions: ['Enter', 'Examine'],
  blocking: true,
  width: 2,
  height: 2.5,
  color: [1, 1, 1],
  transition: {
    targetMap: 'underground',
    targetX: 130.5,
    targetZ: 130.5,
  },
};

function makeWorld(): any {
  const transitions: Array<{ targetMap: string; targetX: number; targetZ: number; targetFloor?: number; targetY?: number }> = [];
  const world = Object.create(World.prototype) as any;
  world.interruptPlayerAction = () => {};
  world.handleMapTransition = (_player: Player, transition: typeof transitions[number]) => {
    transitions.push(transition);
  };
  world.maps = new Map([
    ['kcmap', { meta: { mapType: 'overworld' } }],
    ['bear_den', { meta: { mapType: 'dungeon', dungeon: true } }],
    ['the_sultans_mine', { meta: { mapType: 'dungeon', dungeon: true } }],
  ]);
  world.transitions = transitions;
  return world;
}

describe('dungeon return teleport routing', () => {
  test('CavernExit1 returns to the entrance tile that sent the player into the dungeon', () => {
    const world = makeWorld();
    const player = new Player('dungeon-test', 289.5, 145.5, fakeWs, 1);
    player.currentMapLevel = 'kcmap';
    player.currentFloor = 2;
    player.effectiveY = 5.25;

    const entrance = new WorldObject(caveDef, 290.5, 145.5, 'kcmap');
    entrance.assetId = 'CavernEntrance1';
    entrance.trigger = {
      type: 'teleport',
      destChunk: 'bear_den',
      entryX: 5.5,
      entryY: 0,
      entryZ: 12.5,
    };

    world.handleTeleportInteraction(player, entrance);

    expect(world.transitions.at(-1)).toEqual({
      targetMap: 'bear_den',
      targetX: 5.5,
      targetZ: 12.5,
      targetY: 0,
    });
    expect(player.dungeonReturnTargets.get('bear_den')).toEqual({
      mapId: 'kcmap',
      x: 289.5,
      z: 145.5,
      y: 5.25,
      floor: 2,
    });

    player.currentMapLevel = 'bear_den';
    player.currentFloor = 0;
    player.position.x = 3.5;
    player.position.y = 12.5;
    player.effectiveY = 0;

    const exit = new WorldObject(caveDef, 3.5, 12.5, 'bear_den');
    exit.assetId = 'CavernExit1';

    world.handleTeleportInteraction(player, exit);

    expect(world.transitions.at(-1)).toEqual({
      targetMap: 'kcmap',
      targetX: 289.5,
      targetZ: 145.5,
      targetY: 5.25,
      targetFloor: 2,
    });
    expect(player.dungeonReturnTargets.has('bear_den')).toBe(false);
  });

  test('CavernExit1 fallback trigger prevents old static cave transition when no return is remembered', () => {
    const world = makeWorld();
    const player = new Player('dungeon-fallback-test', 3.5, 12.5, fakeWs, 1);
    player.currentMapLevel = 'bear_den';

    const exit = new WorldObject(caveDef, 3.5, 12.5, 'bear_den');
    exit.assetId = 'CavernExit1';
    exit.trigger = {
      type: 'teleport',
      destChunk: 'kcmap',
      entryX: 310.5,
      entryY: 0.7801008000969887,
      entryZ: 158.5,
    };

    world.handleTeleportInteraction(player, exit);

    expect(world.transitions.at(-1)).toEqual({
      targetMap: 'kcmap',
      targetX: 310.5,
      targetZ: 158.5,
      targetY: 0.7801008000969887,
    });
    expect(player.dungeonReturnTargets.has('kcmap')).toBe(false);
  });

  test('authored dungeon exits use explicit trigger coordinates over remembered return targets', () => {
    const world = makeWorld();
    const player = new Player('sultans-return-test', 267.5, 211.5, fakeWs, 1);
    player.currentMapLevel = 'kcmap';
    player.effectiveY = 0.12262444826774299;

    const entrance = new WorldObject(caveDef, 267, 210.82673029107593, 'kcmap');
    entrance.assetId = 'cavedoor';
    entrance.trigger = {
      type: 'teleport',
      destChunk: 'the_sultans_mine',
      entryX: 114.5,
      entryY: 0.6719981878995895,
      entryZ: 163.5,
    };

    world.handleTeleportInteraction(player, entrance);

    expect(world.transitions.at(-1)).toEqual({
      targetMap: 'the_sultans_mine',
      targetX: 114.5,
      targetZ: 163.5,
      targetY: 0.6719981878995895,
    });
    expect(player.dungeonReturnTargets.get('the_sultans_mine')).toEqual({
      mapId: 'kcmap',
      x: 267.5,
      z: 211.5,
      y: 0.12262444826774299,
      floor: 0,
    });

    player.currentMapLevel = 'the_sultans_mine';
    player.position.x = 114.5;
    player.position.y = 163.5;
    player.effectiveY = 0.6719981878995895;

    const exit = new WorldObject(caveDef, 115.05611916989199, 165.48676895114792, 'the_sultans_mine');
    exit.assetId = 'CavernExit1';
    exit.trigger = {
      type: 'teleport',
      destChunk: 'kcmap',
      entryX: 266.5,
      entryY: 0.10420007794164121,
      entryZ: 211.5,
    };

    world.handleTeleportInteraction(player, exit);

    expect(world.transitions.at(-1)).toEqual({
      targetMap: 'kcmap',
      targetX: 266.5,
      targetZ: 211.5,
      targetY: 0.10420007794164121,
    });
    expect(player.dungeonReturnTargets.has('the_sultans_mine')).toBe(false);
  });
});
