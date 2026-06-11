import { afterEach, describe, expect, test } from 'bun:test';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { ChunkManager, assertOptionalMapResourceResponse, isInteractiveDoorPlacedAsset, isObjectShadowReceiverGround, isRoofLikePlacedAsset, placedObjectThinGroupKey } from './ChunkManager';
import type { GroundType } from '@projectrs/shared';

const originalFetch = globalThis.fetch;
const originalConsoleWarn = console.warn;
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalConsoleWarn;
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

function installNoTokenFetch(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = fetchImpl as typeof fetch;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => '' },
  });
}

type ObjectChunkManagerHarness = {
  mapId: string;
  objectLoadGeneration: number;
  scene: { isDisposed: boolean };
  loadingObjectChunks: Set<string>;
  chunkPlacedNodes: Map<string, TransformNode[]>;
  chunksKnownEmpty: Set<string>;
  placedObjectsByChunk: Map<string, unknown[]>;
  objectLoadChunks: Set<string>;
  desiredObjectChunks: Set<string>;
  touchObjectChunk: () => void;
  loadChunkPlacedObjects: (chunkKey: string, generation: number) => Promise<void>;
};

function makeObjectChunkManager(): ObjectChunkManagerHarness {
  return Object.assign(Object.create(ChunkManager.prototype), {
    mapId: 'kcmap',
    objectLoadGeneration: 1,
    scene: { isDisposed: false },
    loadingObjectChunks: new Set<string>(['1,2']),
    chunkPlacedNodes: new Map<string, TransformNode[]>(),
    chunksKnownEmpty: new Set<string>(),
    placedObjectsByChunk: new Map<string, unknown[]>(),
    objectLoadChunks: new Set<string>(),
    desiredObjectChunks: new Set<string>(),
    touchObjectChunk: () => {},
  });
}

describe('placed object roof classification', () => {
  test('does not treat structural slabs as removable roofs', () => {
    expect(isRoofLikePlacedAsset('stone slab')).toBe(false);
    expect(isRoofLikePlacedAsset('stone slab2')).toBe(false);
    expect(isRoofLikePlacedAsset('stone slabs')).toBe(false);
  });

  test('still treats actual roof assets as removable roofs', () => {
    expect(isRoofLikePlacedAsset('roof')).toBe(true);
    expect(isRoofLikePlacedAsset('flat roof')).toBe(true);
    expect(isRoofLikePlacedAsset('roof corner')).toBe(true);
    expect(isRoofLikePlacedAsset('tile roofing')).toBe(true);
    expect(isRoofLikePlacedAsset('wood roofing')).toBe(true);
    expect(isRoofLikePlacedAsset('spire')).toBe(true);
  });
});

describe('placed object door classification', () => {
  test('only standalone door assets are treated as interactive door panels', () => {
    expect(isInteractiveDoorPlacedAsset('castleTruedoor')).toBe(true);
    expect(isInteractiveDoorPlacedAsset('basicTruedoor')).toBe(true);
    expect(isInteractiveDoorPlacedAsset('IronDoor1')).toBe(true);
    expect(isInteractiveDoorPlacedAsset('stone door1')).toBe(false);
    expect(isInteractiveDoorPlacedAsset('dark stone door2')).toBe(false);
    expect(isInteractiveDoorPlacedAsset('wood door3')).toBe(false);
    expect(isInteractiveDoorPlacedAsset('white doorway')).toBe(false);
  });
});

describe('terrain object shadow receivers', () => {
  test('dry terrain receives baked object shadows across grass/sand boundaries', () => {
    expect(isObjectShadowReceiverGround('grass')).toBe(true);
    expect(isObjectShadowReceiverGround('sand')).toBe(true);
    expect(isObjectShadowReceiverGround('drysand')).toBe(true);
    expect(isObjectShadowReceiverGround('water')).toBe(false);
    expect(isObjectShadowReceiverGround('void')).toBe(false);
  });

  test('shared grass/sand corners use the same shadow factor', () => {
    const width = 2;
    const height = 1;
    const shadowInf = new Float32Array((width + 1) * (height + 1));
    shadowInf.fill(1);
    shadowInf[1] = 0.42;
    const manager = Object.assign(Object.create(ChunkManager.prototype), {
      mapWidth: width,
      mapHeight: height,
      defaultGround: 'grass' as GroundType,
      shadowInf,
      mapData: {
        tiles: [[
          { ground: 'grass', groundB: null },
          { ground: 'sand', groundB: null },
        ]],
      },
    }) as any;

    expect(manager.getCornerObjectShadowFactor(1, 0)).toBeCloseTo(0.42);
  });
});

describe('procedural grass batching', () => {
  test('coalesces grass thin-instance rebuilds across chunk changes', () => {
    const callbacks: FrameRequestCallback[] = [];
    let rebuilds = 0;
    const manager = Object.assign(Object.create(ChunkManager.prototype), {
      grassBladeChunks: new Map<string, { matrices: Float32Array; enabled: boolean }>(),
      grassBladeBatchDirty: false,
      grassBladeBatchRebuildScheduled: false,
      loadMapToken: 1,
      scheduleNextFrame: (callback: FrameRequestCallback) => {
        callbacks.push(callback);
      },
      rebuildGrassBladeBatchNow: () => {
        rebuilds++;
      },
    }) as any;

    manager.registerGrassBladeChunk('0,0', new Float32Array(16), true);
    manager.registerGrassBladeChunk('0,1', new Float32Array(32), false);
    manager.setGrassBladeChunkEnabled('0,1', true);

    expect(callbacks).toHaveLength(1);
    expect(rebuilds).toBe(0);

    callbacks[0](performance.now());

    expect(rebuilds).toBe(1);
    expect(manager.grassBladeBatchDirty).toBe(false);
    expect(manager.grassBladeBatchRebuildScheduled).toBe(false);
  });
});

describe('placed object thin-instance grouping', () => {
  test('batches static world-object visuals but keeps doors unique', () => {
    const manager = Object.assign(Object.create(ChunkManager.prototype), {
      modelAnimationGroups: new Map(),
      assetRegistry: new Map(),
    }) as any;
    const basePlacement = {
      position: { x: 1, y: 0, z: 2 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };

    expect(manager.canBatchPlacedObjectVisual({ ...basePlacement, assetId: 'sTree 1' })).toBe(true);
    expect(manager.canBatchPlacedObjectVisual({ ...basePlacement, assetId: 'wheat2' })).toBe(true);
    expect(manager.canBatchPlacedObjectVisual({ ...basePlacement, assetId: 'castleTruedoor' })).toBe(false);
  });

  test('separates elevated scenery by storey height for indoor culling', () => {
    const firstFloorWall = placedObjectThinGroupKey('stone wall', 'elevated', 2.73);
    const upperWall = placedObjectThinGroupKey('stone wall', 'elevated', 5.49);

    expect(firstFloorWall).not.toBe(upperWall);
  });

  test('keeps small same-storey placement jitter in one elevated batch', () => {
    expect(placedObjectThinGroupKey('stone wall', 'elevated', 2.73))
      .toBe(placedObjectThinGroupKey('stone wall', 'elevated', 2.75));
  });

  test('does not split ground or roof batches by height', () => {
    expect(placedObjectThinGroupKey('stone wall', 'ground', 0))
      .toBe(placedObjectThinGroupKey('stone wall', 'ground', 2.73));
    expect(placedObjectThinGroupKey('tile roofing', 'roof', 2.73))
      .toBe(placedObjectThinGroupKey('tile roofing', 'roof', 5.49));
  });

  test('toggles a batched placed visual through its thin-instance matrix', () => {
    const manager = Object.create(ChunkManager.prototype) as any;
    const node = {} as TransformNode;
    const visibleMatrix = Matrix.Translation(1, 2, 3);
    const hiddenMatrix = Matrix.Translation(4, 5, 6);
    const matrixCalls: Array<{ index: number; matrix: Matrix; refresh: boolean }> = [];
    const bufferUpdates: string[] = [];
    const mesh = {
      thinInstanceSetMatrixAt: (index: number, matrix: Matrix, refresh: boolean) => {
        matrixCalls.push({ index, matrix, refresh });
      },
      thinInstanceBufferUpdated: (kind: string) => {
        bufferUpdates.push(kind);
      },
    } as unknown as Mesh;

    manager.placedObjectVisualRefs = new WeakMap([[node, [{
      mesh,
      index: 7,
      visibleMatrix,
      hiddenMatrix,
    }]]]);

    expect(manager.setPlacedObjectVisualEnabled(node, false)).toBe(true);
    expect(manager.setPlacedObjectVisualEnabled(node, true)).toBe(true);
    expect(manager.setPlacedObjectVisualEnabled({} as TransformNode, true)).toBe(false);

    expect(matrixCalls).toEqual([
      { index: 7, matrix: hiddenMatrix, refresh: false },
      { index: 7, matrix: visibleMatrix, refresh: false },
    ]);
    expect(bufferUpdates).toEqual(['matrix', 'matrix']);
  });
});

describe('secured map resource loading', () => {
  test('treats missing optional map resources differently from protected failures', () => {
    expect(() => {
      assertOptionalMapResourceResponse(new Response('', { status: 404 }), 'kcmap/walls.json');
    }).not.toThrow();

    expect(() => {
      assertOptionalMapResourceResponse(new Response('Forbidden', { status: 403 }), 'kcmap/walls.json');
    }).toThrow('HTTP 403 while loading kcmap/walls.json');
  });

  test('does not cache protected object chunk failures as empty chunks', async () => {
    installNoTokenFetch(async () => new Response('Forbidden', { status: 403 }));
    console.warn = () => {};
    const manager = makeObjectChunkManager();

    await manager.loadChunkPlacedObjects('1,2', 1);

    expect(manager.chunkPlacedNodes.has('1,2')).toBe(false);
    expect(manager.chunksKnownEmpty.has('1,2')).toBe(false);
    expect(manager.loadingObjectChunks.has('1,2')).toBe(false);
  });

  test('still caches genuinely missing object chunks as empty', async () => {
    installNoTokenFetch(async () => new Response('Not Found', { status: 404 }));
    const manager = makeObjectChunkManager();

    await manager.loadChunkPlacedObjects('1,2', 1);

    expect(manager.chunkPlacedNodes.get('1,2')).toEqual([]);
    expect(manager.chunksKnownEmpty.has('1,2')).toBe(true);
    expect(manager.loadingObjectChunks.has('1,2')).toBe(false);
  });
});

describe('roof hover reveal indexing', () => {
  type RoofGridInternals = {
    mapWidth: number;
    mapHeight: number;
    floorLayerData: Map<number, unknown>;
    roofObjectGrid: Map<string, unknown[]>;
    roofObjectGridKeysByChunk: Map<string, Set<string>>;
    placedObjectsByChunk: Map<string, Array<{ assetId: string; position: { x: number; y: number; z: number }; noRoof?: boolean }>>;
    chunkPlacedNodes: Map<string, TransformNode[]>;
    texturePlaneRevealEntriesByChunk: Map<string, Array<{
      mesh: TransformNode;
      minY: number;
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
    }>>;
    chunkElevatedThinInstSources: Map<string, Array<{
      mesh: TransformNode;
      minX: number;
      maxX: number;
      maxOriginY: number;
      minZ: number;
      maxZ: number;
      tileKeys?: Set<string>;
    }>>;
    chunkStructuralThinInstSources: Map<string, Array<{
      mesh: TransformNode;
      minX: number;
      maxX: number;
      maxOriginY: number;
      minZ: number;
      maxZ: number;
      tileKeys?: Set<string>;
    }>>;
    stampRoofObjectFootprint: (
      chunkKey: string,
      obj: { position: { x: number; y: number; z: number } },
      bMin: Vector3,
      bMax: Vector3,
    ) => void;
  };

  function makeChunkManagerForRoofGrid(): { manager: ChunkManager; internals: RoofGridInternals } {
    const internals = Object.create(ChunkManager.prototype) as RoofGridInternals;
    internals.mapWidth = 128;
    internals.mapHeight = 128;
    internals.floorLayerData = new Map();
    internals.roofObjectGrid = new Map();
    internals.roofObjectGridKeysByChunk = new Map();
    internals.placedObjectsByChunk = new Map();
    internals.chunkPlacedNodes = new Map();
    internals.texturePlaneRevealEntriesByChunk = new Map();
    internals.chunkElevatedThinInstSources = new Map();
    internals.chunkStructuralThinInstSources = new Map();
    return { manager: internals as unknown as ChunkManager, internals };
  }

  test('finds elevated roof tile under the cursor ray before the ground projection', () => {
    const { manager, internals } = makeChunkManagerForRoofGrid();
    internals.roofObjectGrid.set('90,34', [{ y: 3, floor: 0 }]);

    const hit = manager.findRoofHoverPointFromRay(
      new Vector3(90.5, 10, 27.5),
      new Vector3(0, -1, 1),
      0.5,
      90.5,
      37.5,
      4,
    );

    expect(hit).toEqual({ x: 90.5, z: 34.5, y: 3 });
  });

  test('resolves outside wall hover from a wall-height ray sample', () => {
    const { manager, internals } = makeChunkManagerForRoofGrid();
    internals.roofObjectGrid.set('90,34', [{ y: 2.98, floor: 0 }]);
    internals.placedObjectsByChunk.set('2,1', [
      { assetId: 'stone wall', position: { x: 90, y: 0, z: 34 } },
    ]);

    const hit = manager.findRoofRevealPointFromRay(
      new Vector3(94.5, 3, 34.5),
      new Vector3(-2.6666666667, -1, 0),
      0.5,
      86.5,
      34.5,
      3,
      3,
      [1.5],
    );

    expect(hit?.x).toBeCloseTo(90.5);
    expect(hit?.z).toBeCloseTo(34.5);
    expect(hit?.y).toBe(1.5);
  });

  test('does not reveal a roof from a distant structural hover sample', () => {
    const { manager, internals } = makeChunkManagerForRoofGrid();
    internals.roofObjectGrid.set('90,34', [{ y: 2.98, floor: 0 }]);
    internals.placedObjectsByChunk.set('2,1', [
      { assetId: 'stone wall', position: { x: 90, y: 0, z: 34 } },
    ]);

    const hit = manager.findRoofRevealPointFromRay(
      new Vector3(92.1, 3, 34.5),
      new Vector3(0, -1, 0),
      0.5,
      92.1,
      34.5,
      1,
      1,
      [1.5],
    );

    expect(hit).toBeNull();
  });

  test('stamps the authored roof tile when transformed bounds contain no tile center', () => {
    const { manager, internals } = makeChunkManagerForRoofGrid();
    const stampRoofObjectFootprint = internals.stampRoofObjectFootprint.bind(manager);

    stampRoofObjectFootprint(
      '2,1',
      { position: { x: 90.5, y: 2.98, z: 34.5 } },
      new Vector3(90.01, 2.9, 34.01),
      new Vector3(90.49, 3.1, 34.49),
    );

    expect(internals.roofObjectGrid.has('90,34')).toBe(true);
    expect(internals.roofObjectGridKeysByChunk.get('2,1')?.has('90,34')).toBe(true);
  });

  test('includes nearby flat cap and slab pieces in the same outside-wall reveal', () => {
    const { manager, internals } = makeChunkManagerForRoofGrid();
    const lowerRoof = {} as TransformNode;
    const flatCap = {} as TransformNode;
    const flatCapNode = {
      metadata: { assetId: 'roof tile 3' },
      getAbsolutePosition: () => new Vector3(90.5, 2.72, 34.5),
    } as unknown as TransformNode;
    internals.roofObjectGrid.set('90,32', [{ node: lowerRoof, y: 1.94, floor: 0 }]);
    internals.roofObjectGrid.set('90,34', [{ node: flatCap, y: 2.98, floor: 0 }]);
    internals.chunkPlacedNodes.set('2,1', [flatCapNode]);

    const nodes = manager.getConnectedRoofRevealNodesAt(90.5, 32.5, 0.5, 1.2, 3);

    expect(nodes).toContain(lowerRoof);
    expect(nodes).toContain(flatCap);
    expect(nodes).toContain(flatCapNode);
  });

  test('reveals castle upper storeys while keeping wall torches visible', () => {
    const { manager, internals } = makeChunkManagerForRoofGrid();
    const lowerRoof = {} as TransformNode;
    const topRoof = {} as TransformNode;
    const slabCap = {
      metadata: { assetId: 'stone slab2' },
      getAbsolutePosition: () => new Vector3(70.5, 5.0, 15.5),
    } as unknown as TransformNode;
    const upperWall = {
      metadata: { assetId: 'stone wall' },
      getAbsolutePosition: () => new Vector3(70.5, 2.74, 15.5),
    } as unknown as TransformNode;
    const angledWall = {
      metadata: { assetId: 'stone 30' },
      getAbsolutePosition: () => new Vector3(70.5, 5.49, 15.5),
    } as unknown as TransformNode;
    const thinUpperWallBatch = {} as TransformNode;
    const unrelatedThinWallBatch = {} as TransformNode;
    const thinUpperFurnitureBatch = {} as TransformNode;
    const unrelatedThinFurnitureBatch = {} as TransformNode;
    const topTexturePlane = {
      metadata: { isTexPlane: true, isFlat: true, isNoRoof: false, minY: 5.49 },
    } as unknown as TransformNode;
    const unrelatedTexturePlane = {
      metadata: { isTexPlane: true, isFlat: true, isNoRoof: false, minY: 5.49 },
    } as unknown as TransformNode;
    const noRoofTexturePlane = {
      metadata: { isTexPlane: true, isFlat: true, isNoRoof: true, minY: 5.49 },
    } as unknown as TransformNode;
    const pitchedTexturePlane = {
      metadata: { isTexPlane: true, isFlat: false, isNoRoof: false, minY: 3.35 },
    } as unknown as TransformNode;
    const resizedTexturePlane = {
      metadata: { isTexPlane: true, isFlat: true, isNoRoof: false, minY: 5.49 },
    } as unknown as TransformNode;
    const wallTorch = {
      metadata: { assetId: 'Walltorch' },
      getAbsolutePosition: () => new Vector3(70.5, 1.24, 15.5),
    } as unknown as TransformNode;
    const chest = {
      metadata: { assetId: 'tier 1 chest' },
      getAbsolutePosition: () => new Vector3(70.5, 3.0, 15.5),
    } as unknown as TransformNode;
    internals.roofObjectGrid.set('70,15', [
      { node: lowerRoof, y: 2.72, floor: 0 },
      { node: topRoof, y: 5.31, floor: 0 },
    ]);
    internals.chunkPlacedNodes.set('2,0', [slabCap, upperWall, angledWall, wallTorch, chest]);
    internals.chunkStructuralThinInstSources.set('2,0', [
      { mesh: thinUpperWallBatch, minX: 69, maxX: 72, maxOriginY: 5.49, minZ: 14, maxZ: 16, tileKeys: new Set(['70,15']) },
      { mesh: unrelatedThinWallBatch, minX: 80, maxX: 82, maxOriginY: 5.49, minZ: 20, maxZ: 22, tileKeys: new Set(['81,21']) },
    ]);
    internals.chunkElevatedThinInstSources.set('2,0', [
      { mesh: thinUpperFurnitureBatch, minX: 69, maxX: 72, maxOriginY: 2.68, minZ: 14, maxZ: 16, tileKeys: new Set(['70,15']) },
      { mesh: unrelatedThinFurnitureBatch, minX: 80, maxX: 82, maxOriginY: 2.68, minZ: 20, maxZ: 22, tileKeys: new Set(['81,21']) },
    ]);
    internals.texturePlaneRevealEntriesByChunk.set('2,0', [
      { mesh: topTexturePlane, minY: 5.49, minX: 70, maxX: 71, minZ: 15, maxZ: 16 },
      { mesh: unrelatedTexturePlane, minY: 5.49, minX: 90, maxX: 91, minZ: 21, maxZ: 22 },
      { mesh: noRoofTexturePlane, minY: 5.49, minX: 70, maxX: 71, minZ: 15, maxZ: 16 },
      { mesh: pitchedTexturePlane, minY: 3.35, minX: 70, maxX: 71, minZ: 15, maxZ: 16 },
    ]);
    internals.texturePlaneRevealEntriesByChunk.set('1,0', [
      { mesh: resizedTexturePlane, minY: 5.49, minX: 59, maxX: 61, minZ: 15, maxZ: 16 },
    ]);

    const nodes = manager.getConnectedRoofRevealNodesAt(70.5, 15.5, 0.5, 1.2, 3);

    expect(nodes).toContain(lowerRoof);
    expect(nodes).toContain(topRoof);
    expect(nodes).toContain(slabCap);
    expect(nodes).toContain(upperWall);
    expect(nodes).toContain(angledWall);
    expect(nodes).toContain(thinUpperWallBatch);
    expect(nodes).toContain(thinUpperFurnitureBatch);
    expect(nodes).toContain(topTexturePlane);
    expect(nodes).toContain(noRoofTexturePlane);
    expect(nodes).toContain(pitchedTexturePlane);
    expect(nodes).toContain(resizedTexturePlane);
    expect(nodes).not.toContain(unrelatedThinWallBatch);
    expect(nodes).not.toContain(unrelatedThinFurnitureBatch);
    expect(nodes).not.toContain(unrelatedTexturePlane);
    expect(nodes).not.toContain(wallTorch);
    expect(nodes).toContain(chest);

    const floor2Nodes = manager.getConnectedRoofRevealNodesAt(70.5, 15.5, 3.23, 3.93, 3);
    expect(floor2Nodes).toContain(topRoof);
    expect(floor2Nodes).toContain(topTexturePlane);
    expect(floor2Nodes).toContain(noRoofTexturePlane);
    expect(floor2Nodes).toContain(pitchedTexturePlane);
    expect(floor2Nodes).toContain(resizedTexturePlane);
    expect(floor2Nodes).not.toContain(unrelatedTexturePlane);
  });

  test('keeps the authored roof tile even when model bounds stamp a shifted tile', () => {
    const { manager, internals } = makeChunkManagerForRoofGrid();
    const stampRoofObjectFootprint = internals.stampRoofObjectFootprint.bind(manager);

    stampRoofObjectFootprint(
      '2,1',
      { position: { x: 90.5, y: 2.98, z: 34.5 } },
      new Vector3(91.01, 2.9, 34.01),
      new Vector3(91.99, 3.1, 34.99),
    );

    expect(internals.roofObjectGrid.has('91,34')).toBe(true);
    expect(internals.roofObjectGrid.has('90,34')).toBe(true);
    expect(internals.roofObjectGridKeysByChunk.get('2,1')?.has('90,34')).toBe(true);
  });
});
