import { describe, expect, test } from 'bun:test';
import { isPublicDataFile, sanitizePublicData } from '../src/data/PublicData';

describe('public data hardening', () => {
  test('production data allow-list excludes raw shop data', () => {
    expect(isPublicDataFile('items.json')).toBe(true);
    expect(isPublicDataFile('npcs.json')).toBe(true);
    expect(isPublicDataFile('shops.json')).toBe(false);
  });

  test('NPC public data strips loot tables but keeps client render/combat fields', () => {
    const sanitized = sanitizePublicData('npcs.json', [{
      id: 4,
      name: 'Wolf',
      health: 20,
      attack: 8,
      defence: 6,
      strength: 7,
      size: 1,
      lootTable: [{ itemId: 10, quantity: 50, chance: 0.1 }],
    }]) as Array<Record<string, unknown>>;

    expect(sanitized[0].name).toBe('Wolf');
    expect(sanitized[0].health).toBe(20);
    expect(sanitized[0].lootTable).toBeUndefined();
  });
});
