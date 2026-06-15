import { describe, expect, test } from 'bun:test';
import { GENERIC_SCENERY_OBJECT_DEF_ID } from '@projectrs/shared';
import { GameManager } from './GameManager';

function makeManager(): any {
  return Object.create(GameManager.prototype) as any;
}

const ROCK_DEF = {
  id: 3,
  name: 'Copper Rock',
  category: 'rock',
  width: 0.9,
  height: 0.8,
  actions: ['Mine', 'Examine'],
};

const TREE_DEF = {
  id: 1,
  name: 'Tree',
  category: 'tree',
  width: 2,
  height: 2,
  actions: ['Chop', 'Examine'],
};

const CROP_DEF = {
  id: 30,
  name: 'Wheat Plant',
  category: 'crop',
  width: 0.6,
  height: 0.6,
  actions: ['Pick', 'Examine'],
};

const SCENERY_DEF = {
  id: GENERIC_SCENERY_OBJECT_DEF_ID,
  name: 'Scenery',
  category: 'scenery',
  width: 1,
  height: 1,
  actions: ['Examine'],
};

describe('GameManager world object pick proxies', () => {
  test('fallback bounds use the object visual height instead of a tall generic box', () => {
    const manager = makeManager();

    const bounds = manager.fallbackWorldObjectPickProxyBounds(
      { x: 10.5, z: 20.5, y: 0, rotY: 0 },
      ROCK_DEF,
    );

    expect(bounds.height).toBeCloseTo(0.84);
    expect(bounds.center.y).toBeCloseTo(0.42);
    expect(bounds.height).toBeLessThan(1);
  });

  test('batched placed-object placeholders can provide rendered visual bounds', () => {
    const manager = makeManager();
    let hierarchyBoundsCalled = false;
    const placeholder = {
      metadata: {
        pickProxyBounds: {
          minX: 10,
          minY: 0,
          minZ: 20,
          maxX: 10.9,
          maxY: 0.8,
          maxZ: 20.7,
        },
      },
      computeWorldMatrix: () => {},
      getHierarchyBoundingVectors: () => {
        hierarchyBoundsCalled = true;
        throw new Error('placeholder has no child meshes');
      },
    };

    const bounds = manager.computeWorldObjectPickProxyBounds(
      placeholder,
      { x: 10.5, z: 20.5, y: 0, rotY: 0 },
      ROCK_DEF,
    );

    expect(hierarchyBoundsCalled).toBe(false);
    expect(bounds.center.x).toBeCloseTo(10.45);
    expect(bounds.center.y).toBeCloseTo(0.42);
    expect(bounds.center.z).toBeCloseTo(20.35);
    expect(bounds.height).toBeCloseTo(0.84);
    expect(bounds.height).toBeLessThan(1);
  });

  test('tree proxies use authored footprint instead of oversized canopy bounds', () => {
    const manager = makeManager();
    const treePlaceholder = {
      metadata: {
        pickProxyBounds: {
          minX: 8,
          minY: 0,
          minZ: 18,
          maxX: 13,
          maxY: 4.6,
          maxZ: 23,
        },
      },
      computeWorldMatrix: () => {},
      getHierarchyBoundingVectors: () => {
        throw new Error('placeholder has no child meshes');
      },
    };

    const bounds = manager.computeWorldObjectPickProxyBounds(
      treePlaceholder,
      { x: 10.5, z: 20.5, y: 0, rotY: 0 },
      TREE_DEF,
    );

    expect(bounds.center.x).toBeCloseTo(10.5);
    expect(bounds.center.y).toBeCloseTo(1.02);
    expect(bounds.center.z).toBeCloseTo(20.5);
    expect(bounds.width).toBeCloseTo(2.18);
    expect(bounds.depth).toBeCloseTo(2.18);
    expect(bounds.height).toBeCloseTo(2.04);
  });

  test('crop proxies use authored crop dimensions instead of the old tall default', () => {
    const manager = makeManager();

    const config = manager.cropPickProxyConfig(CROP_DEF);

    expect(config.width).toBeCloseTo(0.64);
    expect(config.depth).toBeCloseTo(0.64);
    expect(config.height).toBeCloseTo(0.64);
    expect(config.y).toBeCloseTo(0.32);
  });

  test('generic batched interactables use visual thin-instance picking instead of box proxies', () => {
    const manager = makeManager();
    const model = { getChildMeshes: () => [] };
    const visualPickCalls: Array<{ model: unknown; objectEntityId: number | null }> = [];
    const pickTargetCalls: Array<{ objectEntityId: number; interactive: boolean; model: unknown }> = [];
    const disposedProxyIds: number[] = [];

    manager.chunkManager = {
      setPlacedObjectVisualPickId: (node: unknown, objectEntityId: number | null) => {
        visualPickCalls.push({ model: node, objectEntityId });
        return true;
      },
    };
    manager.disposeWorldObjectPickProxy = (objectEntityId: number) => disposedProxyIds.push(objectEntityId);
    manager.setWorldObjectPickTarget = (objectEntityId: number, interactive: boolean, root: unknown) => {
      pickTargetCalls.push({ objectEntityId, interactive, model: root });
    };
    manager.createWorldObjectPickProxy = () => {
      throw new Error('should not create a box proxy');
    };
    manager.setWorldObjectPickProxyEnabled = () => {
      throw new Error('should not toggle a box proxy');
    };

    manager.setGenericWorldObjectPickTarget(12345, { x: 10.5, z: 20.5 }, ROCK_DEF, true, model);

    expect(visualPickCalls).toEqual([{ model, objectEntityId: 12345 }]);
    expect(disposedProxyIds).toEqual([12345]);
    expect(pickTargetCalls).toEqual([{ objectEntityId: 12345, interactive: false, model }]);
  });

  test('generic unbatched interactables use their real mesh geometry when available', () => {
    const manager = makeManager();
    const model = {
      getChildMeshes: () => [{ getTotalVertices: () => 12 }],
    };
    const pickTargetCalls: Array<{ objectEntityId: number; interactive: boolean; model: unknown }> = [];
    const disposedProxyIds: number[] = [];

    manager.chunkManager = {
      setPlacedObjectVisualPickId: () => false,
    };
    manager.disposeWorldObjectPickProxy = (objectEntityId: number) => disposedProxyIds.push(objectEntityId);
    manager.setWorldObjectPickTarget = (objectEntityId: number, interactive: boolean, root: unknown) => {
      pickTargetCalls.push({ objectEntityId, interactive, model: root });
    };
    manager.createWorldObjectPickProxy = () => {
      throw new Error('should not create a box proxy');
    };
    manager.setWorldObjectPickProxyEnabled = () => {
      throw new Error('should not toggle a box proxy');
    };

    manager.setGenericWorldObjectPickTarget(23456, { x: 10.5, z: 20.5 }, ROCK_DEF, true, model);

    expect(disposedProxyIds).toEqual([23456]);
    expect(pickTargetCalls).toEqual([{ objectEntityId: 23456, interactive: true, model }]);
  });

  test('carpet scenery defaults to walk here while keeping examine in the menu', () => {
    const manager = makeManager();
    manager.currentFloor = 0;
    manager.worldObjectDefs = new Map([
      [12345, { defId: GENERIC_SCENERY_OBJECT_DEF_ID, x: 10.5, z: 20.5, floor: 0, depleted: false }],
    ]);
    manager.objectDefsCache = new Map([[GENERIC_SCENERY_OBJECT_DEF_ID, SCENERY_DEF]]);
    manager.worldObjectModels = new Map([[12345, { metadata: { assetId: 'Carpet1x4' } }]]);
    manager.worldObjectInteractionActions = () => [];
    manager.interactObject = () => {};
    manager.handleGroundClick = () => {};

    const options = manager.getWorldObjectInteractionOptions(12345, { x: 10.5, z: 20.5 });

    expect(options.map((option: { label: string }) => option.label)).toEqual([
      'Walk here',
      'Examine Carpet',
    ]);
    expect(options[0].primary).not.toBe(false);
    expect(options[1].primary).not.toBe(false);

    const fallbackOptions = manager.getWorldObjectInteractionOptions(12345);
    expect(fallbackOptions[0].label).toBe('Walk here');
    expect(fallbackOptions[0].primary).not.toBe(false);
  });
});
