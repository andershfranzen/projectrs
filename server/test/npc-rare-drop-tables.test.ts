import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NpcDef, RareDropTableDef } from '@projectrs/shared';

const NPCS_PATH = join(import.meta.dir, '..', 'data', 'npcs.json');
const RARE_DROP_TABLES_PATH = join(import.meta.dir, '..', 'data', 'rare-drop-tables.json');

const EXPECTED_ACCESS = new Map<number, number>([
  [5, 1 / 384],
  [7, 3 / 128],
  [9, 4 / 128],
  [17, 1 / 128],
  [22, 2 / 128],
  [25, 4 / 128],
  [26, 5 / 128],
  [27, 1 / 512],
  [100, 3 / 128],
  [101, 4 / 128],
]);

const EXPECTED_MEGA_RARE_ITEM_IDS = [10, 311, 329, 330, 386, 393, 412];

function loadNpcDefs(): NpcDef[] {
  return JSON.parse(readFileSync(NPCS_PATH, 'utf8')) as NpcDef[];
}

function loadRareDropTables(): RareDropTableDef[] {
  return JSON.parse(readFileSync(RARE_DROP_TABLES_PATH, 'utf8')) as RareDropTableDef[];
}

function roundedChance(value: number): number {
  return Number(value.toFixed(12));
}

describe('NPC rare drop table access', () => {
  test('rare drop tables use 128-weight denominators', () => {
    for (const table of loadRareDropTables()) {
      const totalWeight = table.entries.reduce((total, entry) => total + entry.weight, 0);
      expect(totalWeight, `${table.id} total weight`).toBe(128);
    }
  });

  test('gem table is disabled and mega-rare contains the authored item set', () => {
    const tables = loadRareDropTables();
    expect(tables.some(table => table.id === 'gem')).toBe(false);

    const universal = tables.find(table => table.id === 'universal');
    expect(universal?.entries.some(entry => entry.type === 'table' && entry.tableId === 'gem')).toBe(false);
    expect(universal?.entries.some(entry => entry.type === 'table' && entry.tableId === 'mega_rare')).toBe(true);

    const megaRare = tables.find(table => table.id === 'mega_rare');
    const itemIds = megaRare?.entries
      .filter(entry => entry.type === 'item')
      .map(entry => entry.itemId)
      .sort((a, b) => a - b);
    expect(itemIds).toEqual(EXPECTED_MEGA_RARE_ITEM_IDS);
  });

  test('mega-rare weights keep malachor gear rarer than mithril gear and knight cape rarest', () => {
    const megaRare = loadRareDropTables().find(table => table.id === 'mega_rare');
    expect(megaRare).toBeDefined();
    const weights = new Map(
      megaRare?.entries
        .filter(entry => entry.type === 'item')
        .map(entry => [entry.itemId, entry.weight]) ?? [],
    );

    expect(weights.get(386), 'Mithril 2-handed Sword (HQ)').toBeGreaterThan(weights.get(329) ?? 0);
    expect(weights.get(393), 'Mithril Plate Mail Body (HQ)').toBeGreaterThan(weights.get(329) ?? 0);
    expect(weights.get(386), 'Mithril 2-handed Sword (HQ)').toBeGreaterThan(weights.get(330) ?? 0);
    expect(weights.get(393), 'Mithril Plate Mail Body (HQ)').toBeGreaterThan(weights.get(330) ?? 0);

    const knightCapeWeight = weights.get(412) ?? 0;
    for (const [itemId, weight] of weights) {
      if (itemId === 412) continue;
      expect(weight, `item ${itemId} should be more common than Knight's Cape`).toBeGreaterThan(knightCapeWeight);
    }
  });

  test('only selected NPCs access the universal rare drop table', () => {
    const rareTableIds = new Set(loadRareDropTables().map(table => table.id));
    expect(rareTableIds.has('universal')).toBe(true);

    const actual = new Map<number, number>();
    for (const npc of loadNpcDefs()) {
      if (!npc.rareDropTables) continue;
      expect(npc.rareDropTables, `${npc.name} rare drop table count`).toHaveLength(1);
      const [access] = npc.rareDropTables;
      expect(rareTableIds.has(access.tableId), `${npc.name} rare table id`).toBe(true);
      expect(access.tableId, `${npc.name} rare table id`).toBe('universal');
      actual.set(npc.id, access.chance);
    }

    expect([...actual.keys()].sort((a, b) => a - b)).toEqual([...EXPECTED_ACCESS.keys()].sort((a, b) => a - b));
    for (const [npcId, chance] of EXPECTED_ACCESS) {
      expect(roundedChance(actual.get(npcId) ?? 0), `npc ${npcId} rare table chance`).toBe(roundedChance(chance));
    }
  });
});
