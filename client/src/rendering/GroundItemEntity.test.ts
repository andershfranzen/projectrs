import { describe, expect, test } from 'bun:test';
import type { ItemDef } from '@projectrs/shared';
import {
  groundItemHiddenStackPipCount,
  groundItemHiddenStackPipOffset,
  groundItemTargetModelSizeForItem,
  groundItemVisibleStackOffsetForIndex,
  groundItemVisualScaleFromOptions,
} from './GroundItemEntity';

function item(overrides: Partial<ItemDef> = {}): ItemDef {
  return {
    id: 238,
    name: 'Potato',
    description: 'A freshly picked potato.',
    stackable: false,
    equippable: false,
    value: 3,
    model: '/assets/models/Potato.glb',
    ...overrides,
  } as ItemDef;
}

describe('ground item sizing', () => {
  test('applies per-item icon scale to modeled ground drops', () => {
    const potato = item();
    const visualScale = groundItemVisualScaleFromOptions({ iconScale: 0.55 });

    expect(groundItemTargetModelSizeForItem(potato, 1, visualScale)).toBeCloseTo(0.34 * 0.55, 5);
  });

  test('keeps equip-slot base sizes before visual scaling', () => {
    const ring = item({ id: 999, name: 'Tiny Ring', equipSlot: 'ring' });

    expect(groundItemTargetModelSizeForItem(ring, 1, 0.5)).toBeCloseTo(0.14 * 0.5, 5);
  });

  test('keeps stack model scale in the final target size', () => {
    const coins = item({
      id: 1,
      name: 'Coins',
      stackable: true,
      stackModels: [
        { minQuantity: 1, model: '/assets/models/coins_1.glb', scale: 0.62 },
        { minQuantity: 5, model: '/assets/models/coins_5.glb', scale: 0.86 },
      ],
    });

    expect(groundItemTargetModelSizeForItem(coins, 5, 0.5)).toBeCloseTo(0.34 * 0.86 * 0.5, 5);
  });

  test('clamps raw icon scale like the thumbnail renderer', () => {
    expect(groundItemVisualScaleFromOptions({})).toBe(1);
    expect(groundItemVisualScaleFromOptions({ iconScale: Number.NaN })).toBe(1);
    expect(groundItemVisualScaleFromOptions({ iconScale: 0 })).toBe(0.05);
    expect(groundItemVisualScaleFromOptions({ iconScale: 99 })).toBe(2);
  });

  test('shows hidden-stack pips only after the visible model budget is exceeded', () => {
    expect(groundItemHiddenStackPipCount(3)).toBe(0);
    expect(groundItemHiddenStackPipCount(4)).toBe(1);
    expect(groundItemHiddenStackPipCount(5)).toBe(2);
    expect(groundItemHiddenStackPipCount(6)).toBe(3);
    expect(groundItemHiddenStackPipCount(30)).toBe(3);
    expect(groundItemHiddenStackPipCount(Number.NaN)).toBe(0);
  });

  test('places visible same-tile drops as a compact pile instead of a line', () => {
    const offsets = [0, 1, 2].map(groundItemVisibleStackOffsetForIndex);

    for (const offset of offsets) {
      expect(Math.hypot(offset.x, offset.z)).toBeLessThanOrEqual(0.06);
    }

    const area = Math.abs(
      offsets[0].x * (offsets[1].z - offsets[2].z)
      + offsets[1].x * (offsets[2].z - offsets[0].z)
      + offsets[2].x * (offsets[0].z - offsets[1].z)
    ) / 2;
    expect(area).toBeGreaterThan(0.0008);
    expect(offsets.map(offset => offset.y)).toEqual([...offsets.map(offset => offset.y)].sort((a, b) => b - a));
  });

  test('clusters hidden-stack pips instead of drawing a row of coins', () => {
    const offsets = [0, 1, 2].map(index => groundItemHiddenStackPipOffset(index, 3));
    const uniqueX = new Set(offsets.map(offset => offset.x.toFixed(3)));
    const uniqueZ = new Set(offsets.map(offset => offset.z.toFixed(3)));

    expect(uniqueX.size).toBeGreaterThan(1);
    expect(uniqueZ.size).toBeGreaterThan(1);
    for (const offset of offsets) {
      expect(Math.hypot(offset.x - 0.16, offset.z - 0.17)).toBeLessThanOrEqual(0.04);
    }
  });
});
