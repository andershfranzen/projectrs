import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { npcCombatLevel, type NpcDef } from '@projectrs/shared';

describe('NPC combat levels', () => {
  test('Bandit derives combat level from shared combat stats', () => {
    const npcs = JSON.parse(readFileSync('server/data/npcs.json', 'utf8')) as NpcDef[];
    const bandit = npcs.find(npc => npc.name === 'Bandit');

    expect(bandit).toBeDefined();
    expect(bandit?.combatLevel).toBeUndefined();
    expect(npcCombatLevel(bandit!)).toBe(47);
  });
});
