import { describe, expect, test } from 'bun:test';
import { GameDatabase } from '../src/Database';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

describe('account usernames', () => {
  test('createAccount preserves username casing while login and uniqueness stay case-insensitive', async () => {
    const db = new GameDatabase(':memory:');
    try {
      const created = await db.createAccount('CamelCase_1', 'password123', DEVICE_ID);
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      expect(db.getUsernameByAccountId(created.accountId)).toBe('CamelCase_1');

      const login = await db.login('camelcase_1', 'password123', DEVICE_ID);
      expect(login.ok).toBe(true);
      if (login.ok) expect(login.username).toBe('CamelCase_1');

      const duplicate = await db.createAccount('camelcase_1', 'password123', DEVICE_ID);
      expect(duplicate.ok).toBe(false);
      if (!duplicate.ok) expect(duplicate.error).toBe('Username already taken');
    } finally {
      db.close();
    }
  });

  test('renameAccount validates names and preserves new casing', async () => {
    const db = new GameDatabase(':memory:');
    try {
      const first = await db.createAccount('FirstName', 'password123', DEVICE_ID);
      const second = await db.createAccount('SecondName', 'password123', DEVICE_ID);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      const duplicate = db.renameAccount(first.accountId, 'secondname');
      expect(duplicate.ok).toBe(false);
      if (!duplicate.ok) expect(duplicate.error).toBe('Username already taken');

      const renamed = db.renameAccount(first.accountId, 'NewDisplay');
      expect(renamed.ok).toBe(true);
      if (!renamed.ok) return;
      expect(renamed.oldUsername).toBe('FirstName');
      expect(renamed.username).toBe('NewDisplay');
      expect(db.getUsernameByAccountId(first.accountId)).toBe('NewDisplay');
      expect(db.getAccountIdByUsername('newdisplay')).toBe(first.accountId);

      const invalid = db.renameAccount(first.accountId, 'bad__name');
      expect(invalid.ok).toBe(false);
    } finally {
      db.close();
    }
  });
});
