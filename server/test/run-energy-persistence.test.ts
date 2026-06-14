import { describe, expect, test } from 'bun:test';
import { RUN_ENERGY_MAX } from '@projectrs/shared';
import { GameDatabase } from '../src/Database';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

describe('run energy persistence', () => {
  test('defaults new accounts to full run energy', () => {
    const db = new GameDatabase(':memory:');
    try {
      const session = db.loginFallbackAccount('fresh-runner');
      expect(db.loadPlayerState(session.accountId)?.runEnergy).toBe(RUN_ENERGY_MAX);
    } finally {
      db.close();
    }
  });

  test('saves and loads run energy through full and movement checkpoint saves', () => {
    const db = new GameDatabase(':memory:');
    try {
      const session = db.loginFallbackAccount('tired-runner');
      const player = new Player('tired-runner', 1.5, 1.5, fakeWs, session.accountId);

      player.setRunEnergy(4321);
      db.savePlayerState(session.accountId, player, 0);
      expect(db.loadPlayerState(session.accountId)?.runEnergy).toBe(4321);

      player.setRunEnergy(1234);
      db.savePlayerPosition(session.accountId, player, 0);
      expect(db.loadPlayerState(session.accountId)?.runEnergy).toBe(1234);
    } finally {
      db.close();
    }
  });
});
