import { expect, test } from 'bun:test';
import { Npc } from '../src/entity/Npc';
import type { NpcDef, PlayerAppearance } from '@projectrs/shared';

const femaleAppearance: PlayerAppearance = {
  bodyType: 1,
  shirtColor: 0,
  pantsColor: 0,
  shoesColor: 0,
  hairColor: 0,
  beltColor: 1,
  skinColor: 0,
  hairStyle: 10,
};

const baseDef: NpcDef = {
  id: 102,
  name: 'Custom Humanoid',
  health: 10,
  attack: 1,
  defence: 1,
  strength: 1,
  attackSpeed: 4,
  respawnTime: 10,
  aggressive: false,
  wanderRange: 0,
  lootTable: [],
};

test('female default humanoid spawn name is displayed as woman', () => {
  const npc = new Npc(baseDef, 10.5, 10.5, {
    appearance: femaleAppearance,
    nameOverride: 'man',
  });

  expect(npc.displayName).toBe('woman');
  expect(npc.nameOverride).toBe('woman');
});

test('female default humanoid definition name synthesizes a woman override', () => {
  const npc = new Npc({ ...baseDef, name: 'Man' }, 10.5, 10.5, {
    appearance: femaleAppearance,
  });

  expect(npc.displayName).toBe('Woman');
  expect(npc.nameOverride).toBe('Woman');
});

test('authored female NPC names remain authored', () => {
  const npc = new Npc(baseDef, 10.5, 10.5, {
    appearance: femaleAppearance,
    nameOverride: 'Sela',
  });

  expect(npc.displayName).toBe('Sela');
  expect(npc.nameOverride).toBe('Sela');
});
