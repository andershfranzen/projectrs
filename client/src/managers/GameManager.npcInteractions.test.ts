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

  test('server idle combat target clears local NPC combat state', () => {
    const manager = makeManager(0);
    let clearedFaceLock = false;
    manager.localPlayer = {
      clearFaceLock(force: boolean) {
        clearedFaceLock = force;
      },
    };
    manager.combatTargetId = 1;
    manager.magicTargetId = 2;
    manager.pendingSingleCastSpell = -1;
    manager.localCombatWalkUntilMs = 100;
    manager.lastLocalCombatIntentSentAt = 200;
    manager.lastLocalCombatServerConfirmAt = 300;
    manager.pendingFaceTargetEntityId = 1;
    manager._combatPathTimer = 0.5;

    manager.adoptLocalNpcCombatTargetFromServer(0);

    expect(manager.combatTargetId).toBe(-1);
    expect(manager.magicTargetId).toBe(-1);
    expect(manager.pendingSingleCastSpell).toBe(-1);
    expect(manager.localCombatWalkUntilMs).toBe(0);
    expect(manager.lastLocalCombatIntentSentAt).toBe(0);
    expect(manager.lastLocalCombatServerConfirmAt).toBe(0);
    expect(manager.pendingFaceTargetEntityId).toBe(-1);
    expect(manager._combatPathTimer).toBe(0);
    expect(clearedFaceLock).toBe(true);
  });

  test('server idle target preserves a pending one-off spell cast through pre-cast combat clear', () => {
    const manager = makeManager(0);
    manager.localPlayer = { clearFaceLock() {} };
    manager.combatTargetId = 1;
    manager.magicTargetId = 1;
    manager.pendingSingleCastSpell = 4;
    manager.autoCastSpellIndex = -1;
    manager._combatPathTimer = 0.5;

    manager.adoptLocalNpcCombatTargetFromServer(0);

    expect(manager.combatTargetId).toBe(-1);
    expect(manager.magicTargetId).toBe(-1);
    expect(manager.pendingSingleCastSpell).toBe(4);
    expect(manager._combatPathTimer).toBe(0);
  });

  test('autocast follow does not resend attack intent when no LOS path is available', () => {
    const manager = makeManager(0);
    const sent: unknown[] = [];
    const pathArgs: unknown[][] = [];
    let facedTarget = -1;
    manager.entities.npcTargets.set(1, { x: 10.5, z: 10.5, y: 0, floor: 0 });
    manager.localPlayer = {};
    manager.network = { sendRaw: (packet: unknown) => sent.push(packet) };
    manager.playerX = 1.5;
    manager.playerZ = 1.5;
    manager.path = [];
    manager.pathIndex = 0;
    manager.autoCastSpellIndex = 0;
    manager.magicTargetId = 1;
    manager.combatTargetId = -1;
    manager._combatPathTimer = 0;
    manager.castingUntil = 0;
    manager.isNonCombatNpc = () => false;
    manager.isPointInNpcInteractionRange = () => false;
    manager.findPathToNpcInteraction = (...args: unknown[]) => {
      pathArgs.push(args);
      return { path: [], preserveCurrentStep: false };
    };
    manager.faceLocalPlayerTowardNpc = (targetId: number) => {
      facedTarget = targetId;
    };

    manager.updateCombatFollow(0.7);

    expect(pathArgs).toHaveLength(1);
    expect(pathArgs[0][4]).toBe(true);
    expect(sent).toHaveLength(0);
    expect(manager.magicTargetId).toBe(-1);
    expect(manager.combatTargetId).toBe(-1);
    expect(facedTarget).toBe(1);
  });

  test('melee follow does not resend attack intent when no path is available', () => {
    const manager = makeManager(0);
    const sent: unknown[] = [];
    let facedTarget = -1;
    manager.entities.npcTargets.set(1, { x: 10.5, z: 10.5, y: 0, floor: 0 });
    manager.localPlayer = {};
    manager.network = { sendRaw: (packet: unknown) => sent.push(packet) };
    manager.playerX = 1.5;
    manager.playerZ = 1.5;
    manager.path = [];
    manager.pathIndex = 0;
    manager.autoCastSpellIndex = -1;
    manager.magicTargetId = -1;
    manager.combatTargetId = 1;
    manager._combatPathTimer = 0;
    manager.castingUntil = 0;
    manager.isNonCombatNpc = () => false;
    manager.isPointInNpcInteractionRange = () => false;
    manager.getLocalNpcAttackRange = () => 1.5;
    manager.getLocalNpcAttackRangeMode = () => 'melee';
    manager.isLocalRangedWeapon = () => false;
    manager.findPathToNpcInteraction = () => ({ path: [], preserveCurrentStep: false });
    manager.faceLocalPlayerTowardNpc = (targetId: number) => {
      facedTarget = targetId;
    };

    manager.updateCombatFollow(0.7);

    expect(sent).toHaveLength(0);
    expect(manager.magicTargetId).toBe(-1);
    expect(manager.combatTargetId).toBe(-1);
    expect(facedTarget).toBe(1);
  });
});
