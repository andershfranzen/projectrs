import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RELIC_ITEM_IDS,
  npcCombatLevel,
  relicDropChanceForCombatLevel,
  relicDropPoolForCombatLevel,
  type NpcDef,
} from '@projectrs/shared';

const NPCS_PATH = join(import.meta.dir, '..', 'data', 'npcs.json');

function loadNpcDefs(): NpcDef[] {
  return JSON.parse(readFileSync(NPCS_PATH, 'utf8')) as NpcDef[];
}

function roundedChance(value: number): number {
  return Number(value.toFixed(6));
}

describe('NPC relic loot tables', () => {
  test('loot-bearing NPCs have exactly one combat-level-appropriate relic drop', () => {
    for (const npc of loadNpcDefs()) {
      const lootTable = Array.isArray(npc.lootTable) ? npc.lootTable : [];
      const relicDrops = lootTable.filter(drop => RELIC_ITEM_IDS.has(drop.itemId));
      const nonRelicDrops = lootTable.filter(drop => !RELIC_ITEM_IDS.has(drop.itemId));
      const combatLevel = npcCombatLevel(npc);
      const pool = relicDropPoolForCombatLevel(combatLevel);

      if (nonRelicDrops.length === 0 || !pool) {
        expect(relicDrops, `${npc.name} should not have relic drops`).toHaveLength(0);
        continue;
      }

      expect(relicDrops, `${npc.name} should have one relic drop`).toHaveLength(1);
      const [drop] = relicDrops;
      expect(pool, `${npc.name} relic tier should match combat level ${combatLevel}`).toContain(drop.itemId);
      expect(drop.quantity, `${npc.name} relic quantity`).toBe(1);
      expect(roundedChance(drop.chance), `${npc.name} relic chance`).toBe(roundedChance(relicDropChanceForCombatLevel(combatLevel)));
    }
  });
});
