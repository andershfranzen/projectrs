import { expect, test } from 'bun:test';
import { highQualityBaseItemName, highQualityItemDescription, resolveGearFitSourceItemId } from './gear';
import type { ItemDef } from './types';

function item(id: number, name: string, equipSlot: string): ItemDef {
  return { id, name, equipSlot, value: 1 } as ItemDef;
}

test('highQualityBaseItemName strips the HQ suffix only', () => {
  expect(highQualityBaseItemName('Mithril Sword (HQ)')).toBe('Mithril Sword');
  expect(highQualityBaseItemName('Mithril Sword')).toBeNull();
});

test('highQualityItemDescription formats HQ examine text from the base item name', () => {
  expect(highQualityItemDescription('Mithril Sword (HQ)')).toBe('A high quality Mithril Sword.');
  expect(highQualityItemDescription('Mithril Sword')).toBeNull();
});

test('resolveGearFitSourceItemId maps HQ gear to the normal item fit source', () => {
  const defs = [
    item(144, 'Mithril Sword', 'weapon'),
    item(382, 'Mithril Sword (HQ)', 'weapon'),
    item(500, 'Mithril Sword', 'shield'),
  ];

  expect(resolveGearFitSourceItemId(382, defs)).toBe(144);
  expect(resolveGearFitSourceItemId(144, defs)).toBe(144);
});
