import { describe, expect, test } from 'bun:test';
import {
  NPC_INTERACTION_DIRECT_ATTACK,
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
  manager.localCombatLevel = () => 7;
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

  test('combat-start dialogue NPCs without direct attack stay talk-first protected', () => {
    const manager = makeManager(NPC_INTERACTION_HAS_DIALOGUE | NPC_INTERACTION_STARTS_COMBAT);

    expect(manager.isNonCombatNpc(1, npcDef.id)).toBe(true);
    expect(manager.getNpcInteractionOptions(1).map((option: any) => option.label)).toEqual([
      'Talk-to Mortrek',
      'Examine Mortrek',
    ]);
  });

  test('direct-attack dialogue NPCs expose Attack as a secondary option', () => {
    const manager = makeManager(NPC_INTERACTION_HAS_DIALOGUE | NPC_INTERACTION_STARTS_COMBAT | NPC_INTERACTION_DIRECT_ATTACK);

    expect(manager.isNonCombatNpc(1, npcDef.id)).toBe(false);
    const options = manager.getNpcInteractionOptions(1);
    expect(options.map((option: any) => option.label)).toEqual([
      'Talk-to Mortrek',
      'Attack Mortrek (level-7)',
      'Examine Mortrek',
    ]);
    expect(options[0].primary).toBeUndefined();
    expect(options[1].primary).toBe(false);
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

  test('NPC attack level uses RuneScape combat difference colors', () => {
    const manager = makeManager(NPC_INTERACTION_HAS_DIALOGUE | NPC_INTERACTION_STARTS_COMBAT);
    manager.entities.npcCombatTargets.set(1, manager.localPlayerId);
    manager.localCombatLevel = () => 7;

    const option = manager.getNpcInteractionOptions(1)[0];

    expect(option.labelParts).toEqual([
      { text: 'Attack ' },
      { text: 'Mortrek' },
      { text: ' (level-7)', color: '#ffff00' },
    ]);
  });

  test('combat level difference color matches classic RuneScape thresholds', () => {
    const manager = makeManager(0);

    expect(manager.combatLevelDifferenceColor(50, 61)).toBe('#ff0000');
    expect(manager.combatLevelDifferenceColor(50, 59)).toBe('#ff3000');
    expect(manager.combatLevelDifferenceColor(50, 56)).toBe('#ff7000');
    expect(manager.combatLevelDifferenceColor(50, 53)).toBe('#ffb000');
    expect(manager.combatLevelDifferenceColor(50, 50)).toBe('#ffff00');
    expect(manager.combatLevelDifferenceColor(50, 47)).toBe('#c0ff00');
    expect(manager.combatLevelDifferenceColor(50, 44)).toBe('#80ff00');
    expect(manager.combatLevelDifferenceColor(50, 41)).toBe('#40ff00');
    expect(manager.combatLevelDifferenceColor(50, 39)).toBe('#00ff00');
  });

  test('shop interaction still wins over combat-start dialogue', () => {
    const manager = makeManager(NPC_INTERACTION_HAS_DIALOGUE | NPC_INTERACTION_HAS_SHOP | NPC_INTERACTION_STARTS_COMBAT);

    expect(manager.isNonCombatNpc(1, npcDef.id)).toBe(true);
  });

  test('hover action label uses the same primary option as left-click', () => {
    const manager = makeManager(NPC_INTERACTION_HAS_DIALOGUE | NPC_INTERACTION_STARTS_COMBAT);

    const option = manager.defaultHoverActionOption(manager.getNpcInteractionOptions(1));

    expect(option?.label).toBe('Talk-to Mortrek');
  });

  test('hover action readout includes total option count', () => {
    const manager = makeManager(NPC_INTERACTION_HAS_DIALOGUE | NPC_INTERACTION_STARTS_COMBAT);
    manager.entities.npcCombatTargets.set(1, manager.localPlayerId);

    const readout = manager.defaultHoverActionReadout(manager.getNpcInteractionOptions(1));

    expect(readout?.option.label).toBe('Attack Mortrek (level-7)');
    expect(readout?.totalOptions).toBe(3);
  });

  test('hover action label falls back to walk-here when the primary path is handled elsewhere', () => {
    const manager = Object.create(GameManager.prototype) as any;
    const option = manager.defaultHoverActionOption([
      { label: 'Walk here', primary: false, action: () => {} },
    ]);

    expect(option?.label).toBe('Walk here');
  });
});
