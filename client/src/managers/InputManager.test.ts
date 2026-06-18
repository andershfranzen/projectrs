import { describe, expect, test } from 'bun:test';
import { InputManager } from './InputManager';

function makeInputManagerForObjectPick(
  pickedMesh: any,
  thinInstanceIndex: number,
  predicateAssertions: (predicate: (mesh: any, thinInstanceIndex: number) => boolean) => void,
): { manager: InputManager; clickedIds: number[] } {
  const clickedIds: number[] = [];
  const scene = {
    activeCamera: {},
    onPointerObservable: { add: () => {} },
    pick: (_x: number, _y: number, predicate: (mesh: any, thinInstanceIndex: number) => boolean) => {
      predicateAssertions(predicate);
      return { hit: true, pickedMesh, thinInstanceIndex };
    },
  };
  const manager = new InputManager(scene as any, {} as any);
  manager.setEnabled(true);
  manager.setObjectClickHandler((objectEntityId) => clickedIds.push(objectEntityId));
  return { manager, clickedIds };
}

describe('InputManager object picking', () => {
  test('manual client-coordinate clicks stay in canvas CSS coordinates after render scaling', () => {
    const scene = {
      activeCamera: {},
      onPointerObservable: { add: () => {} },
      getEngine: () => ({
        getRenderingCanvas: () => ({
          getBoundingClientRect: () => ({ left: 10, top: 20, width: 1000, height: 800 }),
        }),
        getRenderWidth: () => 500,
        getRenderHeight: () => 400,
      }),
    };
    const manager = new InputManager(scene as any, {} as any);
    const calls: Array<{ x: number; y: number; shiftKey: boolean }> = [];
    (manager as any).handlePrimaryAction = (x: number, y: number, shiftKey: boolean) => {
      calls.push({ x, y, shiftKey });
      return true;
    };

    expect(manager.handlePrimaryActionAt(210, 420, true)).toBe(true);

    expect(calls).toEqual([{ x: 200, y: 400, shiftKey: true }]);
  });

  test('sky-band ground picks clamp down only when requested by menu picking', () => {
    const pickedRayYs: number[] = [];
    const scene = {
      activeCamera: {},
      onPointerObservable: { add: () => {} },
      getEngine: () => ({
        getRenderingCanvas: () => ({
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        }),
      }),
      createPickingRay: (_x: number, y: number) => {
        pickedRayYs.push(y);
        return {
          origin: { x: 10, y: 5, z: 20 },
          direction: { x: 0.1, y: y < 100 ? 0.05 : -0.5, z: -0.1 },
        };
      },
      multiPick: () => [],
      pick: () => ({ hit: false, pickedMesh: null }),
    };
    const chunkManager = {
      pickAuthoredFlatTexturePlane: () => null,
      getCurrentFloor: () => 0,
      getEffectiveHeight: () => 0,
      getWalkableHeightsAt: () => [0],
      getMapWidth: () => 1000,
      getMapHeight: () => 1000,
    };
    const manager = new InputManager(scene as any, chunkManager as any);

    expect(manager.pickGround(300, 20)).toBeNull();
    expect(manager.pickGround(300, 20, { allowSkyClamp: true })).toEqual({ x: 11.5, z: 19.5 });
    expect(pickedRayYs.some(y => y > 100)).toBe(true);
  });

  test('ray-plane fallback only accepts tiles with a walkable height on the player plane', () => {
    const makeScene = () => ({
      activeCamera: {},
      onPointerObservable: { add: () => {} },
      createPickingRay: () => ({
        origin: { x: 10, y: 5, z: 20 },
        direction: { x: 0.2, y: -1, z: 0.1 },
      }),
      multiPick: () => [],
      pick: () => ({ hit: false, pickedMesh: null }),
    });
    const makeChunkManager = (walkableHeights: number[]) => ({
      pickAuthoredFlatTexturePlane: () => null,
      getCurrentFloor: () => 0,
      getEffectiveHeight: () => 0,
      getWalkableHeightsAt: () => walkableHeights,
      getMapWidth: () => 1000,
      getMapHeight: () => 1000,
    });

    const unloadedManager = new InputManager(makeScene() as any, makeChunkManager([]) as any);
    const loadedManager = new InputManager(makeScene() as any, makeChunkManager([0]) as any);

    expect(unloadedManager.pickGround(300, 200)).toBeNull();
    expect(loadedManager.pickGround(300, 200)).toEqual({ x: 11.5, z: 20.5 });
  });

  test('routes batched crop proxy thin-instance picks to object clicks', () => {
    const batchMesh = {
      metadata: {
        kind: 'cropPickProxyBatch',
        objectEntityIdsByThinInstance: [null, 12345],
        activeObjectPickInstanceCount: 1,
      },
      parent: null,
    };
    const { manager, clickedIds } = makeInputManagerForObjectPick(batchMesh, 1, (predicate) => {
      expect(predicate(batchMesh, -1)).toBe(true);
      expect(predicate(batchMesh, 0)).toBe(false);
      expect(predicate(batchMesh, 1)).toBe(true);
    });

    expect((manager as any).handlePrimaryAction(10, 20, false)).toBe(true);
    expect(clickedIds).toEqual([12345]);
  });

  test('routes batched world-object proxy thin-instance picks to object clicks', () => {
    const batchMesh = {
      metadata: {
        kind: 'worldObjectPickProxyBatch',
        objectEntityIdsByThinInstance: [23456],
        activeObjectPickInstanceCount: 1,
      },
      parent: null,
    };
    const { manager, clickedIds } = makeInputManagerForObjectPick(batchMesh, 0, (predicate) => {
      expect(predicate(batchMesh, -1)).toBe(true);
      expect(predicate(batchMesh, 0)).toBe(true);
    });

    expect((manager as any).handlePrimaryAction(10, 20, false)).toBe(true);
    expect(clickedIds).toEqual([23456]);
  });

  test('routes batched world-object visual thin-instance picks to object clicks', () => {
    const batchMesh = {
      metadata: {
        kind: 'worldObjectVisualBatch',
        objectEntityIdsByThinInstance: [null, 34567],
        activeObjectPickInstanceCount: 1,
      },
      parent: null,
    };
    const { manager, clickedIds } = makeInputManagerForObjectPick(batchMesh, 1, (predicate) => {
      expect(predicate(batchMesh, -1)).toBe(true);
      expect(predicate(batchMesh, 0)).toBe(false);
      expect(predicate(batchMesh, 1)).toBe(true);
    });

    expect((manager as any).handlePrimaryAction(10, 20, false)).toBe(true);
    expect(clickedIds).toEqual([34567]);
  });
});
