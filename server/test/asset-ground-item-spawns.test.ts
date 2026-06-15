import { expect, test } from 'bun:test';
import { KNIFE_ITEM_ID } from '@projectrs/shared';
import { ASSET_TO_GROUND_ITEM_SPAWN } from '../src/data/AssetGroundItemSpawns';

test('placed knife assets spawn pickupable knives', () => {
  for (const assetId of ['Knife', 'knife', 'Knife.glb', '/assets/models/Knife.glb']) {
    expect(ASSET_TO_GROUND_ITEM_SPAWN[assetId]).toMatchObject({
      itemId: KNIFE_ITEM_ID,
      quantity: 1,
    });
  }
});
