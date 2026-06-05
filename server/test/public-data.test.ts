import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invalidatePublicDataCache, isPublicDataFile, readPublicDataContent, sanitizePublicData } from '../src/data/PublicData';

describe('public data hardening', () => {
  test('production data allow-list excludes raw shop data', () => {
    expect(isPublicDataFile('items.json')).toBe(true);
    expect(isPublicDataFile('npcs.json')).toBe(true);
    expect(isPublicDataFile('shops.json')).toBe(false);
  });

  test('NPC public data strips server-only behavior but keeps client render/combat fields', () => {
    const sanitized = sanitizePublicData('npcs.json', [{
      id: 4,
      name: 'Wolf',
      health: 20,
      attack: 8,
      defence: 6,
      strength: 7,
      size: 1,
      lootTable: [{ itemId: 10, quantity: 50, chance: 0.1 }],
      rareDropTables: [{ tableId: 'universal', chance: 0.01 }],
      shop: { name: 'Hidden', items: [{ itemId: 10, price: 1, stock: 1 }] },
      dialogue: { root: 'greet', nodes: {} },
      respawnTime: 30,
      aggressive: true,
    }]) as Array<Record<string, unknown>>;

    expect(sanitized[0].name).toBe('Wolf');
    expect(sanitized[0].health).toBe(20);
    expect(sanitized[0].lootTable).toBeUndefined();
    expect(sanitized[0].rareDropTables).toBeUndefined();
    expect(sanitized[0].shop).toBeUndefined();
    expect(sanitized[0].dialogue).toBeUndefined();
    expect(sanitized[0].respawnTime).toBeUndefined();
    expect(sanitized[0].aggressive).toBeUndefined();
  });

  test('object public data strips server-side rewards/chances from recipes', () => {
    const sanitized = sanitizePublicData('objects.json', [{
      id: 6,
      name: 'Furnace',
      category: 'furnace',
      actions: ['Use', 'Examine'],
      blocking: true,
      width: 1,
      height: 1,
      color: [1, 2, 3],
      respawnTime: 30,
      successChances: { 31: [64, 200] },
      recipes: [{
        inputItemId: 25,
        inputQuantity: 1,
        outputItemId: 29,
        outputQuantity: 1,
        skill: 'smithing',
        levelRequired: 1,
        xpReward: 6,
        successChance: 0.5,
      }],
    }]) as Array<Record<string, unknown>>;

    const recipe = (sanitized[0].recipes as Array<Record<string, unknown>>)[0];
    expect(sanitized[0].respawnTime).toBeUndefined();
    expect(sanitized[0].successChances).toBeUndefined();
    expect(recipe.inputItemId).toBe(25);
    expect(recipe.xpReward).toBeUndefined();
    expect(recipe.successChance).toBeUndefined();
  });

  test('quest public data strips trigger internals but keeps journal progress thresholds', () => {
    const sanitized = sanitizePublicData('quests.json', [{
      id: 'q',
      name: 'Quest',
      blurb: 'Start text',
      startTrigger: { type: 'npcKill', npcDefId: 10, chance: 0.05 },
      rewards: { items: [{ itemId: 10, quantity: 1 }] },
      stages: [{
        id: 0,
        description: 'Kill some things.',
        trigger: { type: 'npcKill', npcDefId: 10, count: 3, chance: 0.25 },
      }],
    }]) as Array<Record<string, unknown>>;

    const stage = (sanitized[0].stages as Array<Record<string, unknown>>)[0];
    const trigger = stage.trigger as Record<string, unknown>;
    expect(sanitized[0].startTrigger).toBeUndefined();
    expect(sanitized[0].rewards).toBeUndefined();
    expect(trigger.type).toBe('npcKill');
    expect(trigger.count).toBe(3);
    expect(trigger.npcDefId).toBeUndefined();
    expect(trigger.chance).toBeUndefined();
  });

  test('sanitized public data cache is explicitly invalidatable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eq-public-data-'));
    const file = join(dir, 'npcs.json');
    try {
      writeFileSync(file, JSON.stringify([{ id: 1, name: 'Rat', health: 1, lootTable: [{ itemId: 1 }] }]));
      const first = readPublicDataContent('npcs.json', file, true);
      writeFileSync(file, JSON.stringify([{ id: 1, name: 'Wolf', health: 2, lootTable: [{ itemId: 2 }] }]));
      invalidatePublicDataCache('npcs.json');
      const second = readPublicDataContent('npcs.json', file, true);

      expect(first).toContain('"Rat"');
      expect(second).toContain('"Wolf"');
      expect(second).not.toContain('lootTable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      invalidatePublicDataCache();
    }
  });
});
