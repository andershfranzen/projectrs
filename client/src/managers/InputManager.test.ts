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
