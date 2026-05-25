import { describe, expect, test } from 'bun:test';
import {
  BANKER_NPC_ID,
  bankAccessSpawnViolation,
  isAllowedBankAccessSpawn,
  validateBankAccessSpawns,
} from './npcSafety';

const bankerDef = { id: BANKER_NPC_ID, name: 'Banker', bankAccess: true };
const ratDef = { id: 18, name: 'Rat', bankAccess: false };

describe('bank-access NPC safety', () => {
  test('allows only explicit banker spawn coordinates', () => {
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
    })).toBe(false);
  });

  test('reports bank-enabled spawns outside the allowlist', () => {
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
      { id: 100, npcId: BANKER_NPC_ID, x: 345.5, z: 168.5 },
    ], id => id === BANKER_NPC_ID ? bankerDef : undefined);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('spawn 100');
  });
});
