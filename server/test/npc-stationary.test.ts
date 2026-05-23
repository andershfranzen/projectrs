import { describe, expect, test } from 'bun:test';
import type { NpcDef } from '@projectrs/shared';
import { Npc } from '../src/entity/Npc';

const baseNpcDef: NpcDef = {
  id: 16,
  name: 'Banker',
  health: 10,
  attack: 1,
  defence: 1,
  strength: 1,
  attackSpeed: 4,
  respawnTime: 10,
  aggressive: false,
  wanderRange: 0,
  lootTable: [],
  bankAccess: true,
  stationary: true,
};

describe('stationary NPCs', () => {
  test('stationary defs force effective wander range to zero', () => {
    const banker = new Npc(baseNpcDef, 10.5, 12.5, 8);

    expect(banker.stationary).toBe(true);
    expect(banker.wanderRange).toBe(0);
  });
});
