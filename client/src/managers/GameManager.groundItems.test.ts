import { describe, expect, test } from 'bun:test';
import { GameManager } from './GameManager';
import type { GroundItemData } from './EntityManager';

describe('GameManager ground item picking', () => {
  test('resolves live tile stack when picked ground item id is stale', () => {
    const manager = Object.create(GameManager.prototype) as GameManager;
    const stack: GroundItemData[] = [
      { id: 2, itemId: 101, quantity: 4, x: 5.5, z: 7.5, floor: 0, y: 0 },
    ];
    const idLookups: number[] = [];
    (manager as any).entities = {
      getGroundItemStackForTileKey: (tileKey: string) => tileKey === '0,5,7' ? stack : [],
      getGroundItemStackForItem: (groundItemId: number) => {
        idLookups.push(groundItemId);
        return [];
      },
    };

    const result = (manager as any).groundItemStackForPick({ groundItemId: 1, tileKey: '0,5,7' }) as GroundItemData[];

    expect(result.map(item => item.id)).toEqual([2]);
    expect(idLookups).toEqual([]);
  });

  test('falls back to item id for legacy ground item metadata', () => {
    const manager = Object.create(GameManager.prototype) as GameManager;
    const stack: GroundItemData[] = [
      { id: 1, itemId: 100, quantity: 1, x: 5.5, z: 7.5, floor: 0, y: 0 },
    ];
    (manager as any).entities = {
      getGroundItemStackForTileKey: () => [],
      getGroundItemStackForItem: (groundItemId: number) => groundItemId === 1 ? stack : [],
    };

    const result = (manager as any).groundItemStackForPick({ groundItemId: 1, tileKey: null }) as GroundItemData[];

    expect(result.map(item => item.id)).toEqual([1]);
  });

  test('reads ground item tile metadata from a picked parent node', () => {
    const manager = Object.create(GameManager.prototype) as GameManager;
    (manager as any).entities = { groundItemSprites: new Map() };
    const parent = {
      metadata: { kind: 'groundItem', groundItemId: 1, groundItemTileKey: '0,5,7' },
      parent: null,
    };
    const child = { metadata: null, parent };

    const pick = (manager as any).findGroundItemFromPick(child, 'childMesh');

    expect(pick).toEqual({ groundItemId: 1, tileKey: '0,5,7' });
  });

  test('world context options include a multi-picked ground item behind scenery', () => {
    const manager = Object.create(GameManager.prototype) as GameManager;
    const stack: GroundItemData[] = [
      { id: 2, itemId: 101, quantity: 4, x: 5.5, z: 7.5, floor: 0, y: 0 },
    ];
    (manager as any).currentFloor = 0;
    (manager as any).itemDefsCache = new Map([[101, { name: 'Bronze dagger' }]]);
    (manager as any).entities = {
      groundItemSprites: new Map(),
      getGroundItemStackForTileKey: (tileKey: string) => tileKey === '0,5,7' ? stack : [],
      getGroundItemStackForItem: () => [],
      getGroundItemStackAtTile: () => [],
    };
    (manager as any).scene = {
      pick: () => ({ hit: true, pickedMesh: { name: 'scenery', metadata: null, parent: null } }),
    };
    (manager as any).inputManager = {
      pickGround: () => ({ x: 5.5, z: 7.5 }),
    };
    (manager as any).canvasPointFromClient = () => ({ x: 100, y: 120 });
    (manager as any).pickPlayerAtPoint = () => null;
    (manager as any).pickNpcAtPoint = () => ({
      entityId: null,
      groundItem: { groundItemId: 1, tileKey: '0,5,7' },
      closestMesh: null,
    });
    (manager as any).findWorldObjectIdFromPick = () => null;

    const options = (manager as any).getWorldInteractionOptionsAt(10, 20) as { label: string }[];

    expect(options.map(option => option.label)).toEqual(['Pick up Bronze dagger (4)']);
  });
});
