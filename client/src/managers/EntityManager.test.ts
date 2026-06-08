import { describe, expect, test } from 'bun:test';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { ItemDef } from '@projectrs/shared';
import { EntityManager } from './EntityManager';

function makeFakeNpcSprite(x: number, z: number): any {
  return {
    position: new Vector3(x, 0, z),
    walking: false,
    isWalking() { return this.walking; },
    startWalking() { this.walking = true; },
    stopWalking() { this.walking = false; },
    updateMovementDirection() {},
    setPositionXYZ(nx: number, ny: number, nz: number) {
      this.position.set(nx, ny, nz);
    },
  };
}

describe('EntityManager NPC interpolation', () => {
  test('fresh final NPC steps use normal one-tile-per-tick speed', () => {
    const manager = Object.create(EntityManager.prototype) as EntityManager;
    const sprite = makeFakeNpcSprite(10.5, 10.5);
    (manager as any).getHeight = () => 0;
    (manager as any).npcSprites = new Map([[1, sprite]]);
    (manager as any).npcTargets = new Map([[
      1,
      {
        x: 11.5,
        z: 10.5,
        floor: 0,
        y: 0,
        prevX: 10.5,
        prevZ: 10.5,
        t: performance.now(),
        continueWalking: false,
      },
    ]]);
    (manager as any).npcCombatTargets = new Map();
    (manager as any).remotePlayers = new Map();

    manager.interpolateNpcs(0.3, null, -1, null);

    expect(sprite.position.x).toBeCloseTo(11.0, 5);
    expect(sprite.position.z).toBe(10.5);
    expect(sprite.isWalking()).toBe(true);
  });
});

describe('EntityManager ground item stacks', () => {
  test('can resolve every ground item on a tile in display order', () => {
    const manager = Object.create(EntityManager.prototype) as EntityManager;
    (manager as any).groundItems = new Map([
      [1, { id: 1, itemId: 100, quantity: 1, x: 5.5, z: 7.5, floor: 0 }],
      [2, { id: 2, itemId: 101, quantity: 4, x: 5.5, z: 7.5, floor: 0 }],
      [3, { id: 3, itemId: 102, quantity: 1, x: 6.5, z: 7.5, floor: 0 }],
    ]);
    (manager as any).groundItemIdsByTile = new Map([
      ['0,5,7', new Set([1, 2])],
      ['0,6,7', new Set([3])],
    ]);
    (manager as any).itemDefsCache = new Map<number, ItemDef>([
      [100, { id: 100, name: 'Bones', description: '', value: 1, stackable: false, equippable: false }],
      [101, { id: 101, name: 'Coins', description: '', value: 5, stackable: true, equippable: false }],
      [102, { id: 102, name: 'Feather', description: '', value: 1, stackable: false, equippable: false }],
    ]);

    expect(manager.getGroundItemStackAtTile(5.5, 7.5, 0).map(item => item.id)).toEqual([2, 1]);
    expect(manager.getGroundItemStackForTileKey('0,5,7').map(item => item.id)).toEqual([2, 1]);
  });

  test('can resolve a tile stack after the picked top item was removed', () => {
    const manager = Object.create(EntityManager.prototype) as EntityManager;
    (manager as any).groundItems = new Map([
      [2, { id: 2, itemId: 101, quantity: 4, x: 5.5, z: 7.5, floor: 0 }],
    ]);
    (manager as any).groundItemIdsByTile = new Map([
      ['0,5,7', new Set([2])],
    ]);
    (manager as any).itemDefsCache = new Map<number, ItemDef>([
      [101, { id: 101, name: 'Coins', description: '', value: 5, stackable: true, equippable: false }],
    ]);

    expect(manager.getGroundItemStackForItem(1)).toEqual([]);
    expect(manager.getGroundItemStackForTileKey('0,5,7').map(item => item.id)).toEqual([2]);
  });
});
