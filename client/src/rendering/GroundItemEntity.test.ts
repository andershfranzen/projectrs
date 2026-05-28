import { describe, expect, test } from 'bun:test';
import type { ItemDef } from '@projectrs/shared';
import {
  groundItemTargetModelSizeForItem,
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
});
