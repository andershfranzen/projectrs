import { describe, expect, test } from 'bun:test';
import {
  getActiveMovementStep,
  normalizeMovementRouteForActiveStep,
  remainingMovementQueueMatches,
  sameMovementTile,
  trimMovementQueueToNextStep,
} from './movementQueue';

describe('movement queue helpers', () => {
  test('sameMovementTile compares tile coordinates only', () => {
    expect(sameMovementTile({ x: 1.1, z: 2.9 }, { x: 1.8, z: 2.1 })).toBe(true);
    expect(sameMovementTile({ x: 1.1, z: 2.9 }, { x: 2.1, z: 2.1 })).toBe(false);
  });

  test('getActiveMovementStep resolves the active unit step inside a compressed diagonal segment', () => {
    expect(getActiveMovementStep({
      anchor: { x: 0.5, z: 0.5 },
      path: [{ x: 4.5, z: 4.5 }],
      tileProgress: 0.625,
    })).toEqual({
      from: { x: 2.5, z: 2.5 },
      target: { x: 3.5, z: 3.5 },
      progress: 0.5,
    });
  });

  test('normalizeMovementRouteForActiveStep prepends the active unit tile before a turn', () => {
    expect(normalizeMovementRouteForActiveStep(
      [{ x: 0.5, z: 8.5 }],
      {
        anchor: { x: 0.5, z: 0.5 },
        path: [{ x: 10.5, z: 10.5 }],
        tileProgress: 0.05,
      },
    )).toEqual({
      path: [
        { x: 1.5, z: 1.5 },
        { x: 0.5, z: 8.5 },
      ],
      preserveCurrentStep: true,
    });
  });

  test('normalizeMovementRouteForActiveStep does not duplicate the active target', () => {
    expect(normalizeMovementRouteForActiveStep(
      [
        { x: 1.5, z: 1.5 },
        { x: 0.5, z: 8.5 },
      ],
      {
        anchor: { x: 0.5, z: 0.5 },
        path: [{ x: 10.5, z: 10.5 }],
        tileProgress: 0.05,
      },
    )).toEqual({
      path: [
        { x: 1.5, z: 1.5 },
        { x: 0.5, z: 8.5 },
      ],
      preserveCurrentStep: true,
    });
  });

  test('remainingMovementQueueMatches starts from the queue cursor', () => {
    const queue = [
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
    ];

    expect(remainingMovementQueueMatches(queue, 1, [{ x: 2.5, z: 0.5 }])).toBe(true);
    expect(remainingMovementQueueMatches(queue, 1, queue)).toBe(false);
  });

  test('trimMovementQueueToNextStep keeps only the active destination tile', () => {
    expect(trimMovementQueueToNextStep([
      { x: 1.5, z: 1.5 },
      { x: 2.5, z: 2.5 },
    ], 0)).toEqual([{ x: 1.5, z: 1.5 }]);
    expect(trimMovementQueueToNextStep([], 0)).toBeNull();
  });
});
