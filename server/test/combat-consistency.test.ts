import { describe, expect, test } from 'bun:test';
import { Player } from '../src/entity/Player';
import { Npc } from '../src/entity/Npc';
import {
  grantMagicCombatXp,
  grantMeleeCombatXp,
  grantRangedCombatXp,
  isPointInNpcMagicAttackRange,
  shouldConsumeAmmoOnShot,
} from '../src/combat/Combat';
import type { NpcDef } from '@projectrs/shared';

const fakeWs = { sendBinary() {}, send() {} } as any;

const npcDef: NpcDef = {
  id: 1,
  name: 'Target',
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

function combatXpTotal(player: Player): number {
  return player.skills.weaponry.xp
    + player.skills.strength.xp
    + player.skills.defence.xp
    + player.skills.archery.xp
    + player.skills.goodmagic.xp
    + player.skills.evilmagic.xp;
}

describe('combat style consistency', () => {
  test('melee ranged and magic all award 4 primary combat XP per capped damage', () => {
    const melee = new Player('melee', 0.5, 0.5, fakeWs, 1);
    melee.stance = 'controlled';
    const meleeBefore = combatXpTotal(melee);
    const meleeXp = grantMeleeCombatXp(melee, 1);
    expect(combatXpTotal(melee) - meleeBefore).toBe(4);
    expect(meleeXp.xpDrops.filter(drop => drop.skill !== 'hitpoints').reduce((sum, drop) => sum + drop.amount, 0)).toBe(4);

    const ranged = new Player('ranged', 0.5, 0.5, fakeWs, 2);
    const rangedBefore = combatXpTotal(ranged);
    const rangedXp = grantRangedCombatXp(ranged, 1);
    expect(combatXpTotal(ranged) - rangedBefore).toBe(4);
    expect(rangedXp.xpDrops).toContainEqual({ skill: 'archery', amount: 4 });

    const magic = new Player('magic', 0.5, 0.5, fakeWs, 3);
    magic.magicStance = 'controlled';
    const magicBefore = combatXpTotal(magic);
    const magicXp = grantMagicCombatXp(magic, 'evilmagic', 1, magic.magicStance);
    expect(combatXpTotal(magic) - magicBefore).toBe(4);
    expect(magicXp.xpDrops).toContainEqual({ skill: 'evilmagic', amount: 2 });
    expect(magicXp.xpDrops).toContainEqual({ skill: 'defence', amount: 2 });
  });

  test('magic range uses the same tile footprint metric as ranged combat', () => {
    const npc = new Npc(npcDef, 10.5, 10.5);

    expect(isPointInNpcMagicAttackRange(npc, 20.5, 20.5)).toBe(true);
    expect(isPointInNpcMagicAttackRange(npc, 21.5, 20.5)).toBe(false);
  });

  test('ammo break rolls are owned by combat rules', () => {
    expect(shouldConsumeAmmoOnShot({ itemDef: { ammoType: 'arrow' } }, () => 0.199)).toBe(true);
    expect(shouldConsumeAmmoOnShot({ itemDef: { ammoType: 'arrow' } }, () => 0.2)).toBe(false);
    expect(shouldConsumeAmmoOnShot({ itemDef: { ammoType: 'bolt' } }, () => 0.99)).toBe(true);
  });
});
