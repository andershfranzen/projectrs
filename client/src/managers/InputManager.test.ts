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
