import { describe, expect, test } from 'bun:test';
import { primaryRecipeEntriesPerInput, type FlatRecipeEntry } from './SmithingPanel';

describe('SmithingPanel recipe filtering', () => {
  test('keeps the first visible recipe for each input item', () => {
    const entries: FlatRecipeEntry[] = [
      {
        index: 2,
        maxQuantity: 3,
        recipe: {
          inputItemId: 263,
          inputQuantity: 1,
          outputItemId: 16,
          outputQuantity: 1,
          skill: 'cooking',
          levelRequired: 1,
          xpReward: 30,
        },
      },
      {
        index: 3,
        maxQuantity: 3,
        recipe: {
          inputItemId: 263,
          inputQuantity: 1,
          outputItemId: 269,
          outputQuantity: 1,
          skill: 'cooking',
          levelRequired: 1,
          xpReward: 5,
        },
      },
      {
        index: 4,
        maxQuantity: 1,
        recipe: {
          inputItemId: 27,
          inputQuantity: 1,
          outputItemId: 28,
          outputQuantity: 1,
          skill: 'cooking',
          levelRequired: 1,
          xpReward: 20,
        },
      },
    ];

    expect(primaryRecipeEntriesPerInput(entries).map((entry) => entry.index)).toEqual([2, 4]);
  });
});
