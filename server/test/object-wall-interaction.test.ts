import { describe, expect, test } from 'bun:test';
import { COOKING_RANGE_OBJECT_DEF_ID, KILN_OBJECT_DEF_ID, POTTERY_WHEEL_OBJECT_DEF_ID } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

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
});
