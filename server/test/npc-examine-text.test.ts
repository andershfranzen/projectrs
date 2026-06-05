import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import type { NpcDef } from '@projectrs/shared';

test('all NPC definitions have authored examine text', () => {
  const npcs = JSON.parse(readFileSync('server/data/npcs.json', 'utf8')) as NpcDef[];

  const missing = npcs
    .filter(npc => !npc.examineText?.trim())
    .map(npc => `${npc.id}:${npc.name}`);

  const fallbackLike = npcs
    .filter(npc => {
      const text = npc.examineText?.trim() ?? '';
      return text === `It's ${npc.name}.` || text === `It's ${npc.name}`;
    })
    .map(npc => `${npc.id}:${npc.name}`);

  expect(missing).toEqual([]);
  expect(fallbackLike).toEqual([]);
  expect(npcs.find(npc => npc.name === 'Goblin')?.examineText).toBe('A goblin with more nerve than plan.');
  expect(npcs.find(npc => npc.name === 'Bill the Stylist')?.examineText).toBe('A man who can see your split ends from three tiles away.');
});
