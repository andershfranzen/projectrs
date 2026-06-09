import { describe, expect, test } from 'bun:test';
import {
  createObjectShadowCaster,
  createWallEdgeShadowCaster,
  isLinearCasterCoveredByWallRuns,
  objectShadowFactorAt,
  wallShadowRunsFromEntries,
} from './objectShadows';

describe('object shadow profiles', () => {
  test('wall shadows cast from one side instead of a centered blob', () => {
    const caster = createObjectShadowCaster({
      assetId: 'stone wall',
      x: 10,
      z: 10,
      rotationY: 0,
      width: 4,
      depth: 0.2,
    });

    expect(caster?.type).toBe('linear');
    const castSide = objectShadowFactorAt(caster!, 10, 9.2);
    const oppositeSide = objectShadowFactorAt(caster!, 10, 11.2);
    expect(castSide).toBeLessThan(oppositeSide);
    expect(castSide).toBeLessThan(0.75);
    expect(objectShadowFactorAt(caster!, 10, 11.2)).toBeGreaterThan(0.85);
  });

  test('wall shadows remain visible on integer terrain vertices around half-tile placements', () => {
    const caster = createObjectShadowCaster({
      assetId: 'white wall',
      x: 10.5,
      z: 10.5,
      rotationY: 0,
      width: 1,
      depth: 0.2,
    });

    expect(caster?.type).toBe('linear');
    expect(objectShadowFactorAt(caster!, 10, 10)).toBeLessThan(0.55);
    expect(objectShadowFactorAt(caster!, 10, 11)).toBeLessThan(0.9);
    expect(objectShadowFactorAt(caster!, 10, 9)).toBeLessThan(0.9);
    expect(objectShadowFactorAt(caster!, 10, 9)).toBeLessThan(objectShadowFactorAt(caster!, 10, 11));
  });

  test('wall shadow contact reaches endpoints to avoid bright connection gaps', () => {
    const caster = createObjectShadowCaster({
      assetId: 'stone wall',
      x: 10.5,
      z: 10.5,
      rotationY: 0,
      width: 1,
      depth: 0.2,
    });

    expect(caster?.type).toBe('linear');
    expect(objectShadowFactorAt(caster!, 10, 10.5)).toBeLessThan(0.85);
    expect(objectShadowFactorAt(caster!, 9.5, 10.5)).toBeLessThan(0.82);
    expect(objectShadowFactorAt(caster!, 11.5, 10.5)).toBeLessThan(0.82);
  });

  test('collision wall runs merge mirrored adjacent edges', () => {
    const runs = wallShadowRunsFromEntries([
      [0, 1, 1], // N edge at z=1
      [1, 1, 1],
      [0, 0, 4], // mirrored S edge duplicates the first segment
    ]);

    expect(runs).toContainEqual({ x0: 0, z0: 1, x1: 2, z1: 1 });
  });

  test('collision wall shadows cast from the merged wall line', () => {
    const caster = createWallEdgeShadowCaster(8, 10, 12, 10);

    expect(caster?.type).toBe('linear');
    const castSide = objectShadowFactorAt(caster!, 10, 9);
    const oppositeSide = objectShadowFactorAt(caster!, 10, 11);
    expect(castSide).toBeLessThan(oppositeSide);
    expect(castSide).toBeLessThan(0.72);
  });

  test('visual wall fallback is skipped only when collision wall runs cover it', () => {
    const caster = createObjectShadowCaster({
      assetId: 'stone wall',
      x: 10,
      z: 10.25,
      rotationY: 0,
      width: 4,
      depth: 0.2,
    });

    expect(caster?.type).toBe('linear');
    expect(isLinearCasterCoveredByWallRuns(caster!, [{ x0: 8, z0: 10, x1: 12, z1: 10 }])).toBe(true);
    expect(isLinearCasterCoveredByWallRuns(caster!, [{ x0: 8, z0: 14, x1: 12, z1: 14 }])).toBe(false);
  });

  test('non-wall assets keep a round shadow profile', () => {
    const caster = createObjectShadowCaster({
      assetId: 'oak tree',
      x: 5,
      z: 5,
      width: 1,
      depth: 1,
    });

    expect(caster?.type).toBe('round');
    expect(objectShadowFactorAt(caster!, 5, 5)).toBeLessThan(objectShadowFactorAt(caster!, 5, 8));
  });
});
