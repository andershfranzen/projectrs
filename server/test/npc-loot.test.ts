import { describe, expect, test } from 'bun:test';
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

describe('NPC loot', () => {
  test('small rats never drop loot', () => {
    expect(rollLoot(npcWithLoot(18))).toEqual([]);
  });

  test('giant rats still use their loot table', () => {
    const originalRandom = Math.random;
    Math.random = () => 1;
    try {
      expect(rollLoot(npcWithLoot(2))).toEqual([{ itemId: 14, quantity: 1 }]);
    } finally {
      Math.random = originalRandom;
    }
  });
});
