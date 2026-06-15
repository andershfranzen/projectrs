import { describe, expect, test } from 'bun:test';
import {
  BANKER_NPC_ID,
  bankAccessSpawnViolation,
  formatNpcAuthoringIssues,
  isAllowedBankAccessSpawn,
  validateNpcDefsForAuthoring,
  validateBankAccessSpawns,
  validateNpcSpawnsForAuthoring,
} from './npcSafety';

const bankerDef = { id: BANKER_NPC_ID, name: 'Banker', bankAccess: true };
const ratDef = { id: 18, name: 'Rat', bankAccess: false };

describe('bank-access NPC safety', () => {
  test('allows explicitly named banker spawns at any coordinate', () => {
    expect(isAllowedBankAccessSpawn('kcmap', {
      npcId: BANKER_NPC_ID,
      name: 'Banker',
      x: 71.5,
      z: 25.5,
    })).toBe(true);

    expect(isAllowedBankAccessSpawn('kcmap', {
      npcId: BANKER_NPC_ID,
      name: 'Banker',
      x: 345.5,
      z: 168.5,
    })).toBe(true);

    expect(isAllowedBankAccessSpawn('kcmap', {
      npcId: BANKER_NPC_ID,
      x: 345.5,
      z: 168.5,
    })).toBe(false);
  });

  test('reports unnamed bank-enabled spawns', () => {
    expect(bankAccessSpawnViolation('kcmap', {
      id: 100,
      npcId: BANKER_NPC_ID,
      x: 345.5,
      z: 168.5,
    }, bankerDef)).toContain('bank-access NPC Banker (16)');

    expect(bankAccessSpawnViolation('kcmap', {
      id: 95,
      npcId: 18,
      x: 222.5,
      z: 158.5,
    }, ratDef)).toBeNull();
  });

  test('validates a full spawn list', () => {
    const errors = validateBankAccessSpawns('kcmap', [
      { id: 67, npcId: BANKER_NPC_ID, name: 'Banker', x: 71.5, z: 25.5 },
      { id: 68, npcId: BANKER_NPC_ID, name: 'Banker', x: 345.5, z: 168.5 },
      { id: 100, npcId: BANKER_NPC_ID, x: 345.5, z: 168.5 },
    ], id => id === BANKER_NPC_ID ? bankerDef : undefined);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('spawn 100');
  });
});

describe('NPC authoring validation', () => {
  test('reports spawn structure problems before they hit runtime', () => {
    const issues = validateNpcSpawnsForAuthoring({
      mapId: 'kcmap',
      width: 100,
      height: 100,
      spawns: [
        { id: 10, npcId: 18, x: 5.5, z: 6.5, wanderRange: 3 },
        { id: 10, npcId: 999, x: 101.5, z: 6, wanderRange: -1, floor: 1.5, equipment: [1, 2] },
        { id: 11, npcId: 18, x: 9.5, z: 6, wanderRange: 1 },
        { npcId: BANKER_NPC_ID, x: 7.5, z: 8.5, wanderRange: 0 },
      ],
      resolveNpcDef: (id) => {
        if (id === 18) return ratDef;
        if (id === BANKER_NPC_ID) return bankerDef;
        return undefined;
      },
    });

    expect(issues.some(issue => issue.code === 'spawn.duplicateId')).toBe(true);
    expect(issues.some(issue => issue.code === 'spawn.unknownNpcId')).toBe(true);
    expect(issues.some(issue => issue.code === 'spawn.outOfBounds')).toBe(true);
    expect(issues.some(issue => issue.code === 'spawn.offCenter' && issue.severity === 'warning')).toBe(true);
    expect(issues.some(issue => issue.code === 'spawn.invalidNumber' && issue.field === 'wanderRange')).toBe(true);
    expect(issues.some(issue => issue.code === 'spawn.invalidFloor')).toBe(true);
    expect(issues.some(issue => issue.code === 'npc.invalidEquipment')).toBe(true);
    expect(issues.some(issue => issue.code === 'spawn.bankAccessName')).toBe(true);
  });

  test('accepts clean centered spawns', () => {
    const issues = validateNpcSpawnsForAuthoring({
      mapId: 'kcmap',
      width: 100,
      height: 100,
      spawns: [
        { id: 1, npcId: 18, x: 5.5, z: 6.5, wanderRange: 3, aggressive: false },
        { id: 2, npcId: BANKER_NPC_ID, name: 'Banker', x: 7.5, z: 8.5, wanderRange: 0 },
      ],
      resolveNpcDef: (id) => id === BANKER_NPC_ID ? bankerDef : ratDef,
    });

    expect(issues).toHaveLength(0);
  });

  test('allows intentionally offset stationary NPCs while warning on wandering offsets', () => {
    const issues = validateNpcSpawnsForAuthoring({
      mapId: 'kcmap',
      width: 100,
      height: 100,
      spawns: [
        { id: 1, npcId: 20, x: 5.75, z: 6.5, wanderRange: 0 },
        { id: 2, npcId: 18, x: 9.75, z: 6.5, wanderRange: 3 },
      ],
      resolveNpcDef: (id) => {
        if (id === 20) return { id: 20, name: 'Merchant', stationary: true, wanderRange: 0 };
        return ratDef;
      },
    });

    expect(issues.filter(issue => issue.code === 'spawn.offCenter')).toHaveLength(1);
    expect(issues.find(issue => issue.code === 'spawn.offCenter')?.spawnId).toBe(2);
  });

  test('reports invalid NPC definitions and model aliases', () => {
    const issues = validateNpcDefsForAuthoring([
      {
        id: 1,
        name: 'Rat',
        health: 2,
        attack: 1,
        defence: 1,
        strength: 1,
        attackSpeed: 4,
        respawnTime: 20,
        aggressive: false,
        wanderRange: 3,
        lootTable: [],
      },
      {
        id: 1,
        name: '',
        health: 0,
        attack: 1,
        defence: 1,
        strength: 1,
        attackSpeed: -1,
        respawnTime: 20,
        aggressive: 'no',
        wanderRange: 3,
        lootTable: {},
        modelNpcId: 999,
      },
    ]);

    expect(issues.some(issue => issue.code === 'npcDef.duplicateId')).toBe(true);
    expect(issues.some(issue => issue.code === 'npcDef.missingName')).toBe(true);
    expect(issues.some(issue => issue.code === 'npcDef.invalidHealth')).toBe(true);
    expect(issues.some(issue => issue.code === 'npcDef.invalidNumber' && issue.field === 'attackSpeed')).toBe(true);
    expect(issues.some(issue => issue.code === 'npcDef.invalidAggressive')).toBe(true);
    expect(issues.some(issue => issue.code === 'npcDef.invalidLootTable')).toBe(true);
    expect(issues.some(issue => issue.code === 'npcDef.unknownModelNpcId')).toBe(true);
    expect(formatNpcAuthoringIssues(issues)).toContain('error');
  });
});
