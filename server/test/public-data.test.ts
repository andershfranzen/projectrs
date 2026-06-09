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

  test('item public data strips economy and combat stats but keeps render/action fields', () => {
    const sanitized = sanitizePublicData('items.json', [{
      id: 10,
      name: 'Bronze Sword',
      description: 'A sword.',
      stackable: false,
      noteable: true,
      noteId: 110,
      equippable: true,
      equipSlot: 'weapon',
      weaponStyle: 'slash',
      twoHanded: false,
      attackRange: 1,
      healAmount: 4,
      toolType: 'hammer',
      icon: '/sprites/sword.png',
      model: '10.glb',
      stackModels: [{ minQuantity: 10, model: 'coins_10.glb', scale: 0.9 }],
      bodyTypeModels: { 1: 'female.glb' },
      value: 100,
      attackSpeed: 4,
      stabAttack: 1,
      slashAttack: 6,
      meleeStrength: 5,
      rangedAccuracy: 2,
      equipSkill: 'weaponry',
      levelRequired: 5,
      toolLevel: 2,
      toolBonus: 3,
      ammoType: 'arrow',
      isAmmo: true,
    }]) as Array<Record<string, unknown>>;

    expect(sanitized[0].name).toBe('Bronze Sword');
    expect(sanitized[0].noteId).toBe(110);
    expect(sanitized[0].equipSlot).toBe('weapon');
    expect(sanitized[0].weaponStyle).toBe('slash');
    expect(sanitized[0].attackRange).toBe(1);
    expect(sanitized[0].healAmount).toBe(4);
    expect(sanitized[0].toolType).toBe('hammer');
    expect(sanitized[0].model).toBe('10.glb');
    expect(sanitized[0].value).toBeUndefined();
    expect(sanitized[0].attackSpeed).toBeUndefined();
    expect(sanitized[0].stabAttack).toBeUndefined();
    expect(sanitized[0].slashAttack).toBeUndefined();
    expect(sanitized[0].meleeStrength).toBeUndefined();
    expect(sanitized[0].rangedAccuracy).toBeUndefined();
    expect(sanitized[0].equipSkill).toBeUndefined();
    expect(sanitized[0].levelRequired).toBeUndefined();
    expect(sanitized[0].toolLevel).toBeUndefined();
    expect(sanitized[0].toolBonus).toBeUndefined();
    expect(sanitized[0].ammoType).toBeUndefined();
    expect(sanitized[0].isAmmo).toBeUndefined();
  });

  test('NPC public data strips server-only behavior and exact combat stats', () => {
    const sanitized = sanitizePublicData('npcs.json', [{
      id: 4,
      name: 'Wolf',
      examineText: 'A hungry wolf.',
      modelNpcId: 17,
      health: 20,
      attack: 8,
      defence: 6,
      strength: 7,
      attackBonus: -5,
      strengthBonus: -3,
      stabDefence: -2,
      slashDefence: -1,
      crushDefence: 0,
      rangedDefence: 1,
      magicDefence: 2,
      attackStyle: 'stab',
      size: 1,
      lootTable: [{ itemId: 10, quantity: 50, chance: 0.1 }],
      rareDropTables: [{ tableId: 'universal', chance: 0.01 }],
      shop: { name: 'Hidden', items: [{ itemId: 10, price: 1, stock: 1 }] },
      dialogue: { root: 'greet', nodes: {} },
      respawnTime: 30,
      aggressive: true,
    }]) as Array<Record<string, unknown>>;

    expect(sanitized[0].name).toBe('Wolf');
    expect(sanitized[0].examineText).toBe('A hungry wolf.');
    expect(sanitized[0].modelNpcId).toBe(17);
    expect(sanitized[0].combatLevel).toBe(11);
    expect(sanitized[0].health).toBeUndefined();
    expect(sanitized[0].attack).toBeUndefined();
    expect(sanitized[0].defence).toBeUndefined();
    expect(sanitized[0].strength).toBeUndefined();
    expect(sanitized[0].attackBonus).toBeUndefined();
    expect(sanitized[0].strengthBonus).toBeUndefined();
    expect(sanitized[0].stabDefence).toBeUndefined();
    expect(sanitized[0].slashDefence).toBeUndefined();
    expect(sanitized[0].crushDefence).toBeUndefined();
    expect(sanitized[0].rangedDefence).toBeUndefined();
    expect(sanitized[0].magicDefence).toBeUndefined();
    expect(sanitized[0].attackStyle).toBeUndefined();
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
        hqOutputItemId: 30,
        hqChance: 0.01,
        hqXpMultiplier: 3,
      }],
    }]) as Array<Record<string, unknown>>;

    const recipe = (sanitized[0].recipes as Array<Record<string, unknown>>)[0];
    expect(sanitized[0].respawnTime).toBeUndefined();
    expect(sanitized[0].successChances).toBeUndefined();
    expect(recipe.inputItemId).toBe(25);
    expect(recipe.xpReward).toBeUndefined();
    expect(recipe.successChance).toBeUndefined();
    expect(recipe.hqOutputItemId).toBeUndefined();
    expect(recipe.hqChance).toBeUndefined();
    expect(recipe.hqXpMultiplier).toBeUndefined();
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
