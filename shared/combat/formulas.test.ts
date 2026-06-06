import { expect, test } from 'bun:test';
import { npcCanAggroPlayerByCombatLevel } from './formulas';

test('npc proactive aggression stops when player combat is at least twice the npc combat level', () => {
  expect(npcCanAggroPlayerByCombatLevel(10, 19)).toBe(true);
  expect(npcCanAggroPlayerByCombatLevel(10, 20)).toBe(false);
  expect(npcCanAggroPlayerByCombatLevel(10, 21)).toBe(false);
});

test('npc proactive aggression threshold uses normalized integer combat levels', () => {
  expect(npcCanAggroPlayerByCombatLevel(10.9, 19.9)).toBe(true);
  expect(npcCanAggroPlayerByCombatLevel(10.9, 20.1)).toBe(false);
});
