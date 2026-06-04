import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { highQualityItemDescription, resolveGearFitSourceItemId, type ItemDef } from '@projectrs/shared';

function loadItems(): ItemDef[] {
  const dataDir = join(import.meta.dir, '..', 'data');
  return JSON.parse(readFileSync(join(dataDir, 'items.json'), 'utf8')) as ItemDef[];
}

describe('HQ gear data', () => {
  test('all HQ gear uses high quality examine text and normal gear visuals', () => {
    const items = loadItems();
    const hqGear = items.filter((item) => highQualityItemDescription(item.name) && item.equippable && !item.stackable);

    expect(hqGear.length).toBeGreaterThan(0);
    for (const item of hqGear) {
      const expectedDescription = highQualityItemDescription(item.name);
      if (!expectedDescription) throw new Error(`Expected HQ description for ${item.name}`);
      expect(item.description).toBe(expectedDescription);
      expect(resolveGearFitSourceItemId(item.id, items)).not.toBe(item.id);
    }
  });
});
