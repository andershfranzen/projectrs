import { describe, expect, test } from 'bun:test';
import { BROTHER_MONK_CHEST_OBJECT_DEF_ID, GENERIC_SCENERY_OBJECT_DEF_ID, STAIRS_OBJECT_DEF_ID, TRAPDOOR_OBJECT_DEF_ID } from '@projectrs/shared';
import { GameManager } from './GameManager';

function makeManager(): any {
  const manager = Object.create(GameManager.prototype) as any;
  manager.currentFloor = 0;
  manager.localAuthoritativeTileHeights = new Map();
  manager.getHeightAtFloor = (x: number, z: number) =>
    typeof manager.getHeight === 'function' ? manager.getHeight(x, z) : 0;
  return manager;
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

const FISHING_SPOT_DEF = {
  id: 61,
  name: 'Net Fishing Test Spot',
  category: 'fishingspot',
  width: 0.6,
  height: 0.6,
  actions: ['Fish', 'Examine'],
};

const BROTHER_MONK_CHEST_DEF = {
  id: BROTHER_MONK_CHEST_OBJECT_DEF_ID,
  name: 'Brother Monk Chest',
  category: 'chest',
  width: 1,
  height: 1,
  actions: ['Unlock', 'Examine'],
};

const SCENERY_DEF = {
  id: GENERIC_SCENERY_OBJECT_DEF_ID,
  name: 'Scenery',
  category: 'scenery',
  width: 1,
  height: 1,
  actions: ['Examine'],
};

const ENTER_SCENERY_WITHOUT_TRANSITION_DEF = {
  id: 999,
  name: 'Enterable Scenery',
  category: 'scenery',
  width: 1,
  height: 1,
  actions: ['Enter', 'Examine'],
};

const STAIRS_DEF = {
  id: STAIRS_OBJECT_DEF_ID,
  name: 'Stairs',
  category: 'ladder',
  width: 1,
  height: 1,
  actions: ['Climb-up', 'Climb-down', 'Examine'],
};

const TRAPDOOR_DEF = {
  id: TRAPDOOR_OBJECT_DEF_ID,
  name: 'Trapdoor',
  category: 'scenery',
  width: 1,
  height: 0.2,
  actions: ['Enter', 'Examine'],
  transition: {
    targetMap: 'underground',
    targetX: 130.5,
    targetZ: 130.5,
  },
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

  test('fishing spot proxies use an oversized click hitbox', () => {
    const manager = makeManager();

    const bounds = manager.computeWorldObjectPickProxyBounds(
      { metadata: {}, computeWorldMatrix: () => {}, getHierarchyBoundingVectors: () => {
        throw new Error('fishing spots should ignore tiny visual bounds');
      } },
      { x: 10.5, z: 20.5, y: 0, rotY: 0 },
      FISHING_SPOT_DEF,
    );

    expect(bounds.center.x).toBeCloseTo(10.5);
    expect(bounds.center.y).toBeCloseTo(0.9);
    expect(bounds.center.z).toBeCloseTo(20.5);
    expect(bounds.width).toBeCloseTo(1.6);
    expect(bounds.depth).toBeCloseTo(1.6);
    expect(bounds.height).toBeCloseTo(1.8);
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

  test('fishing spots use box proxies even when the visual is batched', () => {
    const manager = makeManager();
    const model = { getChildMeshes: () => [] };
    const visualPickCalls: Array<{ model: unknown; objectEntityId: number | null }> = [];
    const pickTargetCalls: Array<{ objectEntityId: number; interactive: boolean; model: unknown }> = [];
    const createdProxyIds: number[] = [];
    const toggledProxyIds: Array<{ objectEntityId: number; enabled: boolean }> = [];

    manager.worldObjectPickProxyRefs = new Map();
    manager.chunkManager = {
      setPlacedObjectVisualPickId: (node: unknown, objectEntityId: number | null) => {
        visualPickCalls.push({ model: node, objectEntityId });
        return true;
      },
    };
    manager.setWorldObjectPickTarget = (objectEntityId: number, interactive: boolean, root: unknown) => {
      pickTargetCalls.push({ objectEntityId, interactive, model: root });
    };
    manager.createWorldObjectPickProxy = (objectEntityId: number) => createdProxyIds.push(objectEntityId);
    manager.setWorldObjectPickProxyEnabled = (objectEntityId: number, enabled: boolean) => {
      toggledProxyIds.push({ objectEntityId, enabled });
    };
    manager.disposeWorldObjectPickProxy = () => {
      throw new Error('should keep the box proxy for fishing spots');
    };

    manager.setGenericWorldObjectPickTarget(34567, { x: 10.5, z: 20.5 }, FISHING_SPOT_DEF, true, model);

    expect(visualPickCalls).toEqual([{ model, objectEntityId: null }]);
    expect(pickTargetCalls).toEqual([{ objectEntityId: 34567, interactive: false, model }]);
    expect(createdProxyIds).toEqual([34567]);
    expect(toggledProxyIds).toEqual([{ objectEntityId: 34567, enabled: true }]);
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
    manager.lastClickX = 321;
    manager.lastClickY = 654;
    const clickEffects: Array<{ x: number; y: number; color?: string }> = [];
    const groundClicks: Array<{ x: number; z: number }> = [];
    manager.spawnCursorClickEffect = (x: number, y: number, color?: string) => {
      clickEffects.push({ x, y, color });
    };
    manager.handleGroundClick = (x: number, z: number) => {
      groundClicks.push({ x, z });
    };

    const options = manager.getWorldObjectInteractionOptions(12345, { x: 10.5, z: 20.5 });

    expect(options.map((option: { label: string }) => option.label)).toEqual([
      'Walk here',
      'Examine Carpet',
    ]);
    expect(options[0].primary).not.toBe(false);
    expect(options[1].primary).not.toBe(false);
    options[0].action();
    expect(clickEffects).toEqual([{ x: 321, y: 654, color: '#ffe040' }]);
    expect(groundClicks).toEqual([{ x: 10.5, z: 20.5 }]);

    const fallbackOptions = manager.getWorldObjectInteractionOptions(12345);
    expect(fallbackOptions[0].label).toBe('Walk here');
    expect(fallbackOptions[0].primary).not.toBe(false);
  });

  test('mapped stair assets use asset-specific display names in interaction labels', () => {
    const manager = makeManager();
    manager.currentFloor = 1;
    manager.worldObjectDefs = new Map([
      [12346, {
        defId: STAIRS_OBJECT_DEF_ID,
        x: 220.5,
        z: 158.5,
        floor: 0,
        depleted: false,
        ladderActionMask: 1,
      }],
    ]);
    manager.objectDefsCache = new Map([[STAIRS_OBJECT_DEF_ID, STAIRS_DEF]]);
    manager.worldObjectModels = new Map([[12346, { metadata: { assetId: 'WIPStair1' } }]]);
    manager.interactObject = () => {};

    const options = manager.getWorldObjectInteractionOptions(12346);

    expect(options.map((option: { label: string }) => option.label)).toEqual([
      'Climb-down Wooden spiral staircase',
      'Examine Wooden spiral staircase',
    ]);
    expect(options[1].primary).toBe(false);
  });

  test('depleted chests keep examine in the menu', () => {
    const manager = makeManager();
    const interactions: Array<{ objectEntityId: number; actionIndex: number }> = [];
    manager.worldObjectDefs = new Map([
      [45678, { defId: BROTHER_MONK_CHEST_OBJECT_DEF_ID, x: 107.5, z: 94.5, floor: 0, depleted: true }],
    ]);
    manager.objectDefsCache = new Map([[BROTHER_MONK_CHEST_OBJECT_DEF_ID, BROTHER_MONK_CHEST_DEF]]);
    manager.worldObjectModels = new Map();
    manager.isWorldObjectOnCurrentInteractionFloor = () => true;
    manager.worldObjectInteractionActions = () => [];
    manager.interactObject = (objectEntityId: number, actionIndex: number) => {
      interactions.push({ objectEntityId, actionIndex });
    };

    const options = manager.getWorldObjectInteractionOptions(45678);

    expect(options.map((option: { label: string }) => option.label)).toEqual(['Examine Brother Monk Chest']);
    options[0].action();
    expect(interactions).toEqual([{ objectEntityId: 45678, actionIndex: 0 }]);
  });

  test('left-clicking the brother monk chest uses primary object interaction', () => {
    const manager = makeManager();
    const interactions: Array<{ objectEntityId: number; actionIndex: number }> = [];
    const clickEffects: Array<{ x: number; y: number; color?: string }> = [];

    manager.castingUntil = 0;
    manager.skillCancelTime = -1000;
    manager.lastClickX = 12;
    manager.lastClickY = 34;
    manager.worldObjectDefs = new Map([
      [45678, { defId: BROTHER_MONK_CHEST_OBJECT_DEF_ID, x: 107.5, z: 94.5, y: 0, floor: 0, depleted: false }],
    ]);
    manager.objectDefsCache = new Map([[BROTHER_MONK_CHEST_OBJECT_DEF_ID, BROTHER_MONK_CHEST_DEF]]);
    manager.isWorldObjectOnCurrentInteractionFloor = () => true;
    manager.isWorldObjectInteractable = () => true;
    manager.tryUseInventoryItemOn = () => false;
    manager.spawnCursorClickEffect = (x: number, y: number, color?: string) => {
      clickEffects.push({ x, y, color });
    };
    manager.interactMarker = null;
    manager.destMarker = null;
    manager.interactObject = (objectEntityId: number, actionIndex: number) => {
      interactions.push({ objectEntityId, actionIndex });
    };

    manager.handleObjectClick(45678);

    expect(clickEffects).toEqual([{ x: 12, y: 34, color: '#ff3030' }]);
    expect(interactions).toEqual([{ objectEntityId: 45678, actionIndex: 0 }]);
  });

  test('left-clicking a trapdoor uses the enter interaction', () => {
    const manager = makeManager();
    const interactions: Array<{ objectEntityId: number; actionIndex: number }> = [];
    const clickEffects: Array<{ x: number; y: number; color?: string }> = [];

    manager.castingUntil = 0;
    manager.skillCancelTime = -1000;
    manager.lastClickX = 56;
    manager.lastClickY = 78;
    manager.worldObjectDefs = new Map([
      [56789, { defId: TRAPDOOR_OBJECT_DEF_ID, x: 42.5, z: 76.5, y: 0, floor: 0, depleted: false }],
    ]);
    manager.objectDefsCache = new Map([[TRAPDOOR_OBJECT_DEF_ID, TRAPDOOR_DEF]]);
    manager.isWorldObjectOnCurrentInteractionFloor = () => true;
    manager.isWorldObjectInteractable = () => true;
    manager.tryUseInventoryItemOn = () => false;
    manager.spawnCursorClickEffect = (x: number, y: number, color?: string) => {
      clickEffects.push({ x, y, color });
    };
    manager.interactMarker = null;
    manager.destMarker = null;
    manager.interactObject = (objectEntityId: number, actionIndex: number) => {
      interactions.push({ objectEntityId, actionIndex });
    };

    manager.handleObjectClick(56789);

    expect(clickEffects).toEqual([{ x: 56, y: 78, color: '#ff3030' }]);
    expect(interactions).toEqual([{ objectEntityId: 56789, actionIndex: 0 }]);
  });

  test('left-clicking enterable scenery without a transition does not auto-interact', () => {
    const manager = makeManager();
    const interactions: Array<{ objectEntityId: number; actionIndex: number }> = [];

    manager.castingUntil = 0;
    manager.skillCancelTime = -1000;
    manager.lastClickX = 56;
    manager.lastClickY = 78;
    manager.worldObjectDefs = new Map([
      [67890, { defId: ENTER_SCENERY_WITHOUT_TRANSITION_DEF.id, x: 12.5, z: 34.5, y: 0, floor: 0, depleted: false }],
    ]);
    manager.objectDefsCache = new Map([[ENTER_SCENERY_WITHOUT_TRANSITION_DEF.id, ENTER_SCENERY_WITHOUT_TRANSITION_DEF]]);
    manager.isWorldObjectOnCurrentInteractionFloor = () => true;
    manager.isWorldObjectInteractable = () => true;
    manager.tryUseInventoryItemOn = () => false;
    manager.spawnCursorClickEffect = () => {};
    manager.interactMarker = null;
    manager.destMarker = null;
    manager.interactObject = (objectEntityId: number, actionIndex: number) => {
      interactions.push({ objectEntityId, actionIndex });
    };

    manager.handleObjectClick(67890);

    expect(interactions).toEqual([]);
  });

  test('skilling start queues until a matching predicted object-arrival path drains', () => {
    const manager = makeManager();
    let clearedPath = 0;
    let stoppedWalking = 0;
    let facedToward: { x: number; z: number } = { x: Number.NaN, z: Number.NaN };
    let tileFrom: { x: number; z: number } = { x: Number.NaN, z: Number.NaN };

    manager.path = [{ x: 107.5, z: 95.5 }];
    manager.pathIndex = 0;
    manager.playerX = 106.5;
    manager.playerZ = 95.5;
    manager.worldObjectDefs = new Map([
      [
        45678,
        {
          defId: BROTHER_MONK_CHEST_OBJECT_DEF_ID,
          x: 107.5,
          z: 94.5,
          y: 0,
          floor: 0,
          depleted: false,
          interactionTiles: [{ x: 107, z: 95 }],
        },
      ],
    ]);
    manager.objectDefsCache = new Map([[BROTHER_MONK_CHEST_OBJECT_DEF_ID, BROTHER_MONK_CHEST_DEF]]);
    manager.isOnObjectInteractionTile = () => true;
    manager.getHeight = () => 0.25;
    manager.clearPredictedPath = () => { clearedPath += 1; };
    manager.setTileFrom = (x: number, z: number) => { tileFrom = { x, z }; };
    manager.localPlayer = {
      stopWalking: () => { stoppedWalking += 1; },
      faceToward: (target: { x: number; z: number }) => { facedToward = { x: target.x, z: target.z }; },
    };
    manager.isSkilling = true;
    manager.skillingObjectId = 45678;

    manager.queueOrStartLocalSkillingVisual(45678, undefined, true);

    expect(manager.playerX).toBe(106.5);
    expect(manager.playerZ).toBe(95.5);
    expect(manager.pathIndex).toBe(0);
    expect(clearedPath).toBe(0);
    expect(stoppedWalking).toBe(0);
    expect(manager.pendingLocalSkillingVisual).toEqual({ objectId: 45678, variant: undefined, stationary: true });

    manager.pathIndex = 1;
    manager.playerX = 107.5;
    manager.flushPendingLocalSkillingVisual();

    expect(manager.pendingLocalSkillingVisual).toBe(null);
    expect(clearedPath).toBe(1);
    expect(tileFrom).toEqual({ x: 107.5, z: 95.5 });
    expect(stoppedWalking).toBe(1);
    expect(facedToward).toEqual({ x: 107.5, z: 94.5 });
  });

  test('skilling start does not snap to an unrelated predicted path destination', () => {
    const manager = makeManager();
    let rendered = 0;
    let finishedArrival = 0;
    let clearedPath = 0;

    manager.path = [{ x: 88.5, z: 88.5 }];
    manager.pathIndex = 0;
    manager.playerX = 106.5;
    manager.playerZ = 95.5;
    manager.worldObjectDefs = new Map([
      [45678, { defId: BROTHER_MONK_CHEST_OBJECT_DEF_ID, x: 107.5, z: 94.5, y: 0, floor: 0, depleted: false }],
    ]);
    manager.objectDefsCache = new Map([[BROTHER_MONK_CHEST_OBJECT_DEF_ID, BROTHER_MONK_CHEST_DEF]]);
    manager.isOnObjectInteractionTile = () => false;
    manager.renderLocalPlayerAtLogicalPosition = () => { rendered += 1; };
    manager.finishPredictedPathArrival = () => { finishedArrival += 1; };
    manager.clearPredictedPath = () => { clearedPath += 1; };
    manager.setTileFrom = () => {};
    manager.localPlayer = {
      stopWalking: () => {},
      faceToward: () => {},
    };

    manager.prepareSkillingAtObject(45678);

    expect(manager.playerX).toBe(106.5);
    expect(manager.playerZ).toBe(95.5);
    expect(rendered).toBe(0);
    expect(finishedArrival).toBe(0);
    expect(clearedPath).toBe(0);
  });

  test('object walking falls back when an authored chest use tile is blocked', () => {
    const manager = makeManager();
    let startedPath: Array<{ x: number; z: number }> = [];
    const data = {
      defId: BROTHER_MONK_CHEST_OBJECT_DEF_ID,
      x: 107.5,
      z: 94.5,
      y: 0,
      floor: 0,
      depleted: false,
      interactionTiles: [{ x: 107, z: 95 }],
    };

    manager.playerX = 106.5;
    manager.playerZ = 92.5;
    manager.path = [];
    manager.pathIndex = 0;
    manager.tileProgress = 0;
    manager.getActiveUnitStep = () => null;
    manager.isTileBlocked = (x: number, z: number) => x === 107 && z === 95;
    manager.isWallBlockedForPath = () => false;
    manager.findPathFromMovementAnchor = (goalX: number, goalZ: number) => ({
      path: [{ x: goalX, z: goalZ }],
      preserveCurrentStep: false,
    });
    manager.startPredictedPath = (path: Array<{ x: number; z: number }>) => {
      startedPath = path;
    };

    expect(manager.walkToAdjacentTileOf(data, BROTHER_MONK_CHEST_DEF)).toBe(true);
    expect(startedPath).toEqual([{ x: 107.5, z: 93.5 }]);
  });

  test('fallback object tile counts as usable when authored chest tile is unreachable', () => {
    const manager = makeManager();
    const data = {
      defId: BROTHER_MONK_CHEST_OBJECT_DEF_ID,
      x: 107.5,
      z: 94.5,
      y: 0,
      floor: 0,
      depleted: false,
      interactionTiles: [{ x: 107, z: 95 }],
    };

    manager.playerX = 108.5;
    manager.playerZ = 94.5;
    manager.isTileBlocked = () => false;
    manager.isWallBlockedForPath = () => false;
    manager.findPathFromMovementAnchor = () => ({ path: [], preserveCurrentStep: false });

    expect(manager.isOnObjectInteractionTile(108, 94, data, BROTHER_MONK_CHEST_DEF)).toBe(true);
  });
});
