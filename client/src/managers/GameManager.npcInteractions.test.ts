import { describe, expect, test } from 'bun:test';
import {
  NPC_INTERACTION_HAS_DIALOGUE,
  NPC_INTERACTION_HAS_SHOP,
  NPC_INTERACTION_STARTS_COMBAT,
  type NpcDef,
} from '@projectrs/shared';
import { GameManager } from './GameManager';

const npcDef: NpcDef = {
  id: 101,
  name: 'Mortrek',
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

function makeManager(flags: number): any {
  const manager = Object.create(GameManager.prototype) as any;
  manager.currentFloor = 0;
  manager.localPlayerId = 99;
  manager.combatTargetId = -1;
  manager.magicTargetId = -1;
  manager.entities = {
    npcTargets: new Map([[1, { floor: 0 }]]),
    npcDefs: new Map([[1, npcDef.id]]),
    npcInteractions: new Map([[1, flags]]),
    npcOverrideNames: new Map(),
    npcCombatTargets: new Map(),
  };
  manager.npcDefsCache = new Map([[npcDef.id, npcDef]]);
  manager.npcDisplayName = () => npcDef.name;
  manager.npcLevelFor = () => 7;
  manager.attackNpc = () => {};
  manager.talkToNpc = () => {};
  manager.examineNpc = () => {};
  return manager;
}

describe('GameManager NPC interaction classification', () => {
  test('plain dialogue NPCs remain non-combat', () => {
    const manager = makeManager(NPC_INTERACTION_HAS_DIALOGUE);

    expect(manager.isNonCombatNpc(1, npcDef.id)).toBe(true);
  });

  test('combat-start dialogue NPCs are not cleared as non-combat targets', () => {
    const manager = makeManager(NPC_INTERACTION_HAS_DIALOGUE | NPC_INTERACTION_STARTS_COMBAT);

    expect(manager.isNonCombatNpc(1, npcDef.id)).toBe(false);
    expect(manager.getNpcInteractionOptions(1).map((option: any) => option.label)).toEqual([
      'Talk-to Mortrek',
      'Examine Mortrek',
    ]);
  });

  test('active dialogue-started combat makes attack the primary option', () => {
    const manager = makeManager(NPC_INTERACTION_HAS_DIALOGUE | NPC_INTERACTION_STARTS_COMBAT);
    manager.entities.npcCombatTargets.set(1, manager.localPlayerId);

    const options = manager.getNpcInteractionOptions(1);

    expect(options.map((option: any) => option.label)).toEqual([
      'Attack Mortrek (level-7)',
      'Talk-to Mortrek',
      'Examine Mortrek',
    ]);
    expect(options[0].primary).toBeUndefined();
    expect(options[1].primary).toBe(false);
  });

  test('shop interaction still wins over combat-start dialogue', () => {
    const manager = makeManager(NPC_INTERACTION_HAS_DIALOGUE | NPC_INTERACTION_HAS_SHOP | NPC_INTERACTION_STARTS_COMBAT);

    expect(manager.isNonCombatNpc(1, npcDef.id)).toBe(true);
  });

  test('hover action label uses the same primary option as left-click', () => {
    const manager = makeManager(NPC_INTERACTION_HAS_DIALOGUE | NPC_INTERACTION_STARTS_COMBAT);
    manager.entities.npcCombatTargets.set(1, manager.localPlayerId);

    const option = manager.defaultHoverActionOption(manager.getNpcInteractionOptions(1));

    expect(option?.label).toBe('Attack Mortrek (level-7)');
  });

  test('hover action label falls back to walk-here when the primary path is handled elsewhere', () => {
    const manager = Object.create(GameManager.prototype) as any;
    const option = manager.defaultHoverActionOption([
      { label: 'Walk here', primary: false, action: () => {} },
    ]);

    expect(option?.label).toBe('Walk here');
  });
});
