import { describe, expect, test } from 'bun:test';
import { GameDatabase } from '../src/Database';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

describe('magic combat state persistence', () => {
  test('saves and loads autocast spell and magic stance', () => {
    const db = new GameDatabase(':memory:');
    try {
      const session = db.loginFallbackAccount('Mage');
      const player = new Player('Mage', 1.5, 1.5, fakeWs, session.accountId);
      player.autocastSpellIndex = 7;
      player.magicStance = 'defensive';

      db.savePlayerState(session.accountId, player, 0);
      let saved = db.loadPlayerState(session.accountId);

      expect(saved?.autocastSpellIndex).toBe(7);
      expect(saved?.magicStance).toBe('defensive');

      db.saveMagicCombatState(session.accountId, 3, 'controlled');
      saved = db.loadPlayerState(session.accountId);

      expect(saved?.autocastSpellIndex).toBe(3);
      expect(saved?.magicStance).toBe('controlled');
    } finally {
      db.close();
    }
  });
});
