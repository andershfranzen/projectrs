import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { ASSET_TO_OBJECT_DEF } from '@projectrs/shared';

const MAPS_DIR = resolve(import.meta.dir, '../data/maps');
const OAK_TREE_DEF_ID = 2;

function placedOakAssetIds(): string[] {
  const ids: string[] = [];
  for (const mapEntry of readdirSync(MAPS_DIR, { withFileTypes: true })) {
    if (!mapEntry.isDirectory()) continue;
    const objectsDir = resolve(MAPS_DIR, mapEntry.name, 'objects');
    if (!existsSync(objectsDir)) continue;
    for (const file of readdirSync(objectsDir)) {
      if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
      const placed = JSON.parse(readFileSync(resolve(objectsDir, file), 'utf8')) as Array<{ assetId?: string }>;
      for (const obj of placed) {
        if (typeof obj.assetId === 'string' && /^oaktree\d*$/i.test(obj.assetId)) ids.push(obj.assetId);
      }
    }
  }
  return [...new Set(ids)].sort();
}

describe('oak tree asset mappings', () => {
  test('all oak tree model variants map to the Oak Tree object definition', () => {
    expect(ASSET_TO_OBJECT_DEF.oaktree).toBe(OAK_TREE_DEF_ID);
    expect(ASSET_TO_OBJECT_DEF.oaktree2).toBe(OAK_TREE_DEF_ID);
  });

  test('all placed oak tree assets are interactable oak trees', () => {
    expect(placedOakAssetIds()).toEqual(['oaktree', 'oaktree2']);
    for (const assetId of placedOakAssetIds()) {
      expect(ASSET_TO_OBJECT_DEF[assetId]).toBe(OAK_TREE_DEF_ID);
    }
  });
});
