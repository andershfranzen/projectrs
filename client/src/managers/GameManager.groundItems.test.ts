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

  test('table footprint ground items appear before table actions when the table hitbox is picked', () => {
    const manager = Object.create(GameManager.prototype) as GameManager;
    const stack: GroundItemData[] = [
      { id: 3, itemId: 102, quantity: 1, x: 5.5, z: 7.5, floor: 0, y: 1 },
    ];
    (manager as any).currentFloor = 0;
    (manager as any).itemDefsCache = new Map([[102, { name: 'Knife' }]]);
    (manager as any).worldObjectDefs = new Map([[77, { defId: 900, x: 5.5, z: 7.5, floor: 0, rotY: 0 }]]);
    (manager as any).objectDefsCache = new Map([[900, { id: 900, name: 'Table', width: 1, depth: 1 }]]);
    (manager as any).entities = {
      groundItemSprites: new Map(),
      getGroundItemStackForTileKey: () => [],
      getGroundItemStackForItem: () => [],
      getGroundItemStackAtTile: (x: number, z: number) =>
        Math.floor(x) === 5 && Math.floor(z) === 7 ? stack : [],
    };
    (manager as any).scene = {
      pick: () => ({ hit: true, pickedMesh: { name: 'table', metadata: null, parent: null }, thinInstanceIndex: -1 }),
    };
    (manager as any).inputManager = {
      pickGround: () => null,
    };
    (manager as any).canvasPointFromClient = () => ({ x: 100, y: 120 });
    (manager as any).pickPlayerAtPoint = () => null;
    (manager as any).pickNpcAtPoint = () => ({ entityId: null, groundItem: null, closestMesh: null });
    (manager as any).findWorldObjectIdFromPick = () => 77;
    (manager as any).isWorldObjectOnCurrentInteractionFloor = () => true;
    (manager as any).getWorldObjectInteractionOptions = () => [{ label: 'Examine Table', action: () => {} }];

    const options = (manager as any).getWorldInteractionOptionsAt(10, 20) as { label: string }[];

    expect(options.map(option => option.label)).toEqual(['Pick up Knife', 'Examine Table']);
  });

  test('clicked ground tile items appear before picked object actions', () => {
    const manager = Object.create(GameManager.prototype) as GameManager;
    const stack: GroundItemData[] = [
      { id: 3, itemId: 102, quantity: 1, x: 5.5, z: 7.5, floor: 0, y: 1 },
    ];
    (manager as any).currentFloor = 0;
    (manager as any).itemDefsCache = new Map([[102, { name: 'Knife' }]]);
    (manager as any).worldObjectDefs = new Map([[77, { defId: 900, x: 4.5, z: 7.5, floor: 0, rotY: 0 }]]);
    (manager as any).objectDefsCache = new Map([[900, { id: 900, name: 'Table', width: 1, depth: 1 }]]);
    (manager as any).entities = {
      groundItemSprites: new Map(),
      getGroundItemStackForTileKey: () => [],
      getGroundItemStackForItem: () => [],
      getGroundItemStackAtTile: (x: number, z: number) =>
        Math.floor(x) === 5 && Math.floor(z) === 7 ? stack : [],
    };
    (manager as any).scene = {
      pick: () => ({ hit: true, pickedMesh: { name: 'table', metadata: null, parent: null }, thinInstanceIndex: -1 }),
    };
    (manager as any).inputManager = {
      pickGround: () => ({ x: 5.5, z: 7.5 }),
    };
    (manager as any).canvasPointFromClient = () => ({ x: 100, y: 120 });
    (manager as any).pickPlayerAtPoint = () => null;
    (manager as any).pickNpcAtPoint = () => ({ entityId: null, groundItem: null, closestMesh: null });
    (manager as any).findWorldObjectIdFromPick = () => 77;
    (manager as any).isWorldObjectOnCurrentInteractionFloor = () => true;
    (manager as any).getWorldObjectInteractionOptions = () => [{ label: 'Examine Table', action: () => {} }];

    const options = (manager as any).getWorldInteractionOptionsAt(10, 20) as { label: string }[];

    expect(options.map(option => option.label)).toEqual(['Pick up Knife', 'Examine Table']);
  });

  test('decorative placed object surface picks up ground items on its hit tile', () => {
    const manager = Object.create(GameManager.prototype) as GameManager;
    const stack: GroundItemData[] = [
      { id: 3, itemId: 102, quantity: 1, x: 5.5, z: 7.5, floor: 0, y: 1 },
    ];
    const root = { name: 'placed_table', metadata: { assetId: 'table', placedX: 4.5, placedY: 0, placedZ: 7.5 }, parent: null };
    const child = { name: 'table_top', metadata: null, parent: root };
    (manager as any).currentFloor = 0;
    (manager as any).itemDefsCache = new Map([[102, { name: 'Knife' }]]);
    (manager as any).entities = {
      groundItemSprites: new Map(),
      getGroundItemStackForTileKey: () => [],
      getGroundItemStackForItem: () => [],
      getGroundItemStackAtTile: (x: number, z: number) =>
        Math.floor(x) === 5 && Math.floor(z) === 7 ? stack : [],
    };
    (manager as any).scene = {
      pick: () => ({
        hit: true,
        pickedMesh: child,
        pickedPoint: { x: 5.8, z: 7.2 },
        thinInstanceIndex: -1,
      }),
    };
    (manager as any).chunkManager = {
      isPlacedObjectNode: (node: unknown) => node === root,
      getPlacedObjectAuthoredPosition: () => ({ x: 4.5, y: 0, z: 7.5 }),
    };
    (manager as any).inputManager = {
      pickGround: () => null,
    };
    (manager as any).canvasPointFromClient = () => ({ x: 100, y: 120 });
    (manager as any).pickPlayerAtPoint = () => null;
    (manager as any).pickNpcAtPoint = () => ({ entityId: null, groundItem: null, closestMesh: null });
    (manager as any).findWorldObjectIdFromPick = () => null;

    const options = (manager as any).getWorldInteractionOptionsAt(10, 20) as { label: string }[];

    expect(options.map(option => option.label)).toEqual(['Pick up Knife']);
  });

  test('ground item reach allows table-top items but still respects wall edges', () => {
    const manager = Object.create(GameManager.prototype) as GameManager;
    (manager as any).isTileBlocked = (x: number, z: number) => x === 6 && z === 5;
    (manager as any).isWallBlockedForPath = () => false;

    expect((manager as any).canReachGroundItemTileFrom(5, 5, 6, 5)).toBe(true);

    (manager as any).isWallBlockedForPath = (fx: number, fz: number, tx: number, tz: number) =>
      fx === 5 && fz === 5 && tx === 6 && tz === 5;

    expect((manager as any).canReachGroundItemTileFrom(5, 5, 6, 5)).toBe(false);
  });
});
