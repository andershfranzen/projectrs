import { expect, test } from 'bun:test';
import { expandAndValidateWaypointPath } from './movementValidation';

test('expands compressed waypoints into centered unit tile steps', () => {
  const validated = expandAndValidateWaypointPath({
    startX: 0.5,
    startZ: 0.5,
    waypoints: [
      { x: 2.5, z: 0.5 },
      { x: 4.5, z: 2.5 },
    ],
    initialState: 0,
    canStep: () => true,
    afterStep: ({ state }) => state + 1,
  });

  expect(validated).toEqual({
    path: [
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
      { x: 3.5, z: 1.5 },
      { x: 4.5, z: 2.5 },
    ],
    state: 4,
    requestedTileCount: 4,
    truncated: false,
  });
});

test('rejects diagonal corner cutting through blocked side tiles', () => {
  const blocked = new Set(['1,0']);
  const validated = expandAndValidateWaypointPath({
    startX: 0.5,
    startZ: 0.5,
    waypoints: [{ x: 1.5, z: 1.5 }],
    initialState: null,
    canStep: step => !blocked.has(`${step.toTileX},${step.toTileZ}`),
  });

  expect(validated.path).toEqual([]);
  expect(validated.requestedTileCount).toBe(1);
  expect(validated.truncated).toBe(true);
});

test('rejects compressed segments that are not cardinal or 45-degree diagonal', () => {
  const validated = expandAndValidateWaypointPath({
    startX: 0.5,
    startZ: 0.5,
    waypoints: [{ x: 2.5, z: 1.5 }],
    initialState: null,
    canStep: () => true,
  });

  expect(validated.path).toEqual([]);
  expect(validated.requestedTileCount).toBe(2);
  expect(validated.truncated).toBe(true);
});

test('reports attempted distance when segment and route caps are exceeded', () => {
  const longSegment = expandAndValidateWaypointPath({
    startX: 0.5,
    startZ: 0.5,
    waypoints: [{ x: 100.5, z: 0.5 }],
    initialState: null,
    maxSegmentTiles: 64,
    canStep: () => true,
  });

  expect(longSegment.path).toEqual([]);
  expect(longSegment.requestedTileCount).toBe(100);
  expect(longSegment.truncated).toBe(true);

  const longRoute = expandAndValidateWaypointPath({
    startX: 0.5,
    startZ: 0.5,
    waypoints: [
      { x: 2.5, z: 0.5 },
      { x: 4.5, z: 0.5 },
      { x: 6.5, z: 0.5 },
    ],
    initialState: null,
    maxRequestedTiles: 5,
    canStep: () => true,
  });

  expect(longRoute.path).toEqual([
    { x: 1.5, z: 0.5 },
    { x: 2.5, z: 0.5 },
    { x: 3.5, z: 0.5 },
    { x: 4.5, z: 0.5 },
  ]);
  expect(longRoute.requestedTileCount).toBe(6);
  expect(longRoute.truncated).toBe(true);
});
