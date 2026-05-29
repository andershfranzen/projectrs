import { describe, expect, test } from 'bun:test';
import { COOKING_RANGE_OBJECT_DEF_ID, KILN_OBJECT_DEF_ID, POTTERY_WHEEL_OBJECT_DEF_ID, type WorldObjectDef } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

const largeBlockingDef: WorldObjectDef = {
  id: 900,
  name: 'Large Chest',
  category: 'chest',
  actions: ['Open', 'Examine'],
  blocking: true,
  width: 2,
  height: 1,
  color: [1, 1, 1],
};

const stationRangeDef: WorldObjectDef = {
  id: COOKING_RANGE_OBJECT_DEF_ID,
  name: 'Cooking Range',
  category: 'cookingrange',
  actions: ['Cook', 'Examine'],
  blocking: true,
  width: 2,
  height: 1,
  color: [1, 1, 1],
};

function makePlayer(): Player {
  return new Player('wall_test', 10.5, 9.5, fakeWs, 1);
}

function makeObject(defId: number, name: string, category: string = 'scenery'): any {
  return {
    id: 10000 + defId,
    defId,
    mapLevel: 'kcmap',
    floor: 0,
    x: 10.5,
    z: 10.5,
    rotationY: 0,
    interactionSides: undefined,
    interactionTiles: undefined,
    def: {
      id: defId,
      name,
      category,
      width: 1,
      height: 1,
    },
  };
}

function canUseWithWallBlocked(defId: number, name: string, wallBlocked: boolean, category?: string): boolean {
  const world = Object.create(World.prototype) as any;
  const player = makePlayer();
  const obj = makeObject(defId, name, category);
  const map = {
    isWallBlocked: () => wallBlocked,
    isWallBlockedOnFloor: () => wallBlocked,
  };
  return world.canUseObjectFromTile(player, obj, 10, 9, map);
}

describe('wall-gated station interaction', () => {
  test('pottery wheels cannot be used through a wall edge', () => {
    expect(canUseWithWallBlocked(POTTERY_WHEEL_OBJECT_DEF_ID, 'Pottery Wheel', true)).toBe(false);
    expect(canUseWithWallBlocked(POTTERY_WHEEL_OBJECT_DEF_ID, 'Pottery Wheel', false)).toBe(true);
  });

  test('kilns cannot be used through a wall edge', () => {
    expect(canUseWithWallBlocked(KILN_OBJECT_DEF_ID, 'Kiln', true)).toBe(false);
    expect(canUseWithWallBlocked(KILN_OBJECT_DEF_ID, 'Kiln', false)).toBe(true);
  });

  test('cooking ranges cannot be used through a wall edge', () => {
    expect(canUseWithWallBlocked(COOKING_RANGE_OBJECT_DEF_ID, 'Cooking Range', true, 'cookingrange')).toBe(false);
    expect(canUseWithWallBlocked(COOKING_RANGE_OBJECT_DEF_ID, 'Cooking Range', false, 'cookingrange')).toBe(true);
  });

  test('authored interaction tiles override loose cooking range adjacency', () => {
    const world = Object.create(World.prototype) as any;
    const player = makePlayer();
    const obj = makeObject(COOKING_RANGE_OBJECT_DEF_ID, 'Cooking Range', 'cookingrange');
    obj.interactionTiles = [{ x: 0, z: -1 }];
    const map = {
      isWallBlocked: () => false,
      isWallBlockedOnFloor: () => false,
    };

    expect(world.canUseObjectFromTile(player, obj, 10, 9, map)).toBe(true);
    expect(world.canUseObjectFromTile(player, obj, 11, 10, map)).toBe(false);
  });

  test('authored interaction tiles can be stood on when terrain is not blocked', () => {
    const world = Object.create(World.prototype) as any;
    world.blockedObjectTiles = new Set();
    const player = makePlayer();
    player.currentMapLevel = 'kcmap';
    player.currentFloor = 0;
    let terrainBlocked = false;
    const map = {
      isBlocked: (x: number, z: number) => terrainBlocked && x === 10 && z === 10,
      isTileBlockedOnFloor: () => false,
    };

    world.setObjectTilesBlocked('kcmap', 10, 10, largeBlockingDef, true, 0, [{ x: 0, z: 0 }], 0);

    expect(world.isTileBlockedForPlayer(player, map, 10, 10)).toBe(false);
    expect(world.isTileBlockedForPlayer(player, map, 9, 10)).toBe(true);

    terrainBlocked = true;
    expect(world.isTileBlockedForPlayer(player, map, 10, 10)).toBe(true);
  });

  test('crafting stations use authored map collision instead of footprint blockers', () => {
    const world = Object.create(World.prototype) as any;
    world.blockedObjectTiles = new Set();
    const player = makePlayer();
    player.currentMapLevel = 'kcmap';
    player.currentFloor = 0;
    let terrainBlocked = false;
    const map = {
      isBlocked: (x: number, z: number) => terrainBlocked && x === 10 && z === 10,
      isTileBlockedOnFloor: () => false,
    };

    world.setObjectTilesBlocked('kcmap', 10, 10, stationRangeDef, true, 0);

    expect(world.isTileBlockedForPlayer(player, map, 10, 10)).toBe(false);
    expect(world.isTileBlockedForPlayer(player, map, 9, 10)).toBe(false);

    terrainBlocked = true;
    expect(world.isTileBlockedForPlayer(player, map, 10, 10)).toBe(true);
  });
});
