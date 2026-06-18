import { describe, expect, test } from 'bun:test';
import { GameManager } from './GameManager';

function makeNode() {
  let enabled = true;
  return {
    isDisposed: () => false,
    isEnabled: () => enabled,
    setEnabled: (next: boolean) => {
      enabled = next;
    },
    get enabled() {
      return enabled;
    },
  };
}

function makeRoofManager() {
  const visualToggles: boolean[] = [];
  const manager = Object.create(GameManager.prototype) as any;
  manager.hiddenRoofNodes = [];
  manager.hiddenRoofNodeSet = new Set();
  manager.hoverHiddenRoofNodes = [];
  manager.hoverHiddenRoofNodeSet = new Set();
  manager.worldObjectIdByNode = new Map();
  manager.worldObjectDefs = new Map();
  manager.objectDefsCache = new Map();
  manager.currentFloor = 0;
  manager.playerX = 10.5;
  manager.playerZ = 12.5;
  manager.localPlayer = { position: { y: 0 } };
  manager.chunkManager = {
    setPlacedObjectVisualEnabled: (_node: unknown, enabled: boolean) => {
      visualToggles.push(enabled);
      return true;
    },
    roofNodeDefaultEnabled: () => true,
    getCeilingHeight: () => Infinity,
    getRoofNodesNear: () => [],
    getNodesAboveHeight: () => [],
  };
  return { manager, visualToggles };
}

describe('GameManager roof hiding', () => {
  test('hover reveal hides and restores batched roof visuals', () => {
    const { manager, visualToggles } = makeRoofManager();
    const roofNode = makeNode();

    manager.applyHoverHiddenRoofSet(new Set([roofNode]));

    expect(visualToggles).toEqual([false]);
    expect(roofNode.enabled).toBe(false);

    manager.applyHoverHiddenRoofSet(new Set());

    expect(visualToggles).toEqual([false, true]);
    expect(roofNode.enabled).toBe(true);
  });

  test('indoor roof recompute hides batched roof visuals', () => {
    const { manager, visualToggles } = makeRoofManager();
    const roofNode = makeNode();
    manager.chunkManager.getRoofNodesNear = () => [roofNode];

    manager.recomputeHiddenRoofs();

    expect(visualToggles).toEqual([false]);
    expect(roofNode.enabled).toBe(false);
  });

  test('chunk visibility reapply keeps batched hidden roofs hidden', () => {
    const { manager, visualToggles } = makeRoofManager();
    const roofNode = makeNode();
    manager.hiddenRoofNodes = [roofNode];
    manager.hiddenRoofNodeSet = new Set([roofNode]);

    manager.reapplyHiddenRoofStates();

    expect(visualToggles).toEqual([false]);
    expect(roofNode.enabled).toBe(false);
  });
});
