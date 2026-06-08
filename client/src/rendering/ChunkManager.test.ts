import { describe, expect, test } from 'bun:test';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { ChunkManager, isInteractiveDoorPlacedAsset, isRoofLikePlacedAsset, placedObjectThinGroupKey } from './ChunkManager';

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
  test('only Truedoor assets are treated as interactive door panels', () => {
    expect(isInteractiveDoorPlacedAsset('castleTruedoor')).toBe(true);
    expect(isInteractiveDoorPlacedAsset('basicTruedoor')).toBe(true);
    expect(isInteractiveDoorPlacedAsset('stone door1')).toBe(false);
    expect(isInteractiveDoorPlacedAsset('dark stone door2')).toBe(false);
    expect(isInteractiveDoorPlacedAsset('wood door3')).toBe(false);
    expect(isInteractiveDoorPlacedAsset('white doorway')).toBe(false);
  });
});

describe('placed object thin-instance grouping', () => {
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
