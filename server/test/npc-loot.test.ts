import { describe, expect, test } from 'bun:test';
import type { RareDropTableDef } from '@projectrs/shared';
import type { Npc } from '../src/entity/Npc';
import { rollLoot } from '../src/combat/Combat';

function npcWithLoot(id: number): Npc {
  return {
    def: {
      id,
      name: id === 18 ? 'Rat' : 'Giant Rat',
      health: 5,
      attack: 1,
      defence: 1,
      strength: 1,
      attackSpeed: 4,
      respawnTime: 12,
      aggressive: false,
      wanderRange: 2,
      lootTable: [{ itemId: 14, quantity: 1, chance: 1 }],
    },
  } as Npc;
}

function sequenceRng(values: number[]): () => number {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (value === undefined) throw new Error('RNG sequence exhausted');
    return value;
  };
}

describe('NPC loot', () => {
  test('small rats never drop loot', () => {
    expect(rollLoot(npcWithLoot(18))).toEqual([]);
  });

  test('giant rats still use their loot table', () => {
    const originalRandom = Math.random;
    Math.random = () => 1;
    try {
      expect(rollLoot(npcWithLoot(2))).toEqual([{ itemId: 14, quantity: 1, dropChance: 1 }]);
    } finally {
      Math.random = originalRandom;
    }
  });

  test('rare drop table rolls after NPC access chance succeeds', () => {
    const npc = npcWithLoot(2);
    npc.def.lootTable = [];
    npc.def.rareDropTables = [{ tableId: 'universal', chance: 1 }];
    const rareDropTables = new Map<string, RareDropTableDef>([
      ['universal', {
        id: 'universal',
        entries: [{ type: 'item', itemId: 10, quantity: 25, weight: 1 }],
      }],
    ]);

    expect(rollLoot(npc, { rareDropTables, rng: sequenceRng([1, 0]) })).toEqual([{
      itemId: 10,
      quantity: 25,
      rare: true,
      source: 'rare_drop_table',
      rareTableId: 'universal',
      rareAccessTableId: 'universal',
    }]);
  });

  test('rare drop table misses leave normal loot behavior unchanged', () => {
    const npc = npcWithLoot(2);
    npc.def.rareDropTables = [{ tableId: 'universal', chance: 0.25 }];
    const rareDropTables = new Map<string, RareDropTableDef>([
      ['universal', {
        id: 'universal',
        entries: [{ type: 'item', itemId: 10, quantity: 25, weight: 1 }],
      }],
    ]);

    expect(rollLoot(npc, { rareDropTables, rng: sequenceRng([0, 0.5]) })).toEqual([{ itemId: 14, quantity: 1, dropChance: 1 }]);
  });
});
