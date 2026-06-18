import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

  test('createAccount rejects active IP bans when a signup IP is supplied', async () => {
    const db = new GameDatabase(':memory:');
    try {
      db.banIp('::ffff:203.0.113.45', 'bot network', 'test-admin');

      const blocked = await db.createAccount('BlockedUser', 'password123', DEVICE_ID, '203.0.113.45');
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error).toBe('Banned');
      expect(db.getAccountIdByUsername('BlockedUser')).toBeNull();

      const allowed = await db.createAccount('AllowedUser', 'password123', DEVICE_ID, '203.0.113.46');
      expect(allowed.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  test('active IP bans stay IP-only until shared-IP account bans are explicit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evilquest-ipban-'));
    const path = join(dir, 'test.db');
    let db: GameDatabase | null = new GameDatabase(path);
    try {
      const target = db.loginFallbackAccount('IpTarget', DEVICE_ID);
      const alt = db.loginFallbackAccount('IpAlt', '22222222-2222-4222-8222-222222222222');
      const admin = db.loginFallbackAccount('IpAdmin', '33333333-3333-4333-8333-333333333333');
      db.setAccountAdminRole(admin.accountId, true);
      (db as any).db.query('INSERT INTO login_history (account_id, ip_address, login_ts, device_id) VALUES (?, ?, unixepoch(), ?)')
        .run(target.accountId, '::ffff:198.51.100.9', DEVICE_ID);
      db.recordLogin(alt.accountId, '198.51.100.9', '22222222-2222-4222-8222-222222222222');
      db.recordLogin(admin.accountId, '198.51.100.9', '33333333-3333-4333-8333-333333333333');
      (db as any).db.query('INSERT INTO ip_bans (ip_address, reason, banned_by) VALUES (?, ?, ?)')
        .run('::ffff:198.51.100.9', 'bot network', 'test-admin');

      expect(db.isAccountBanned(target.accountId)).toBeNull();
      expect(db.isAccountBanned(alt.accountId)).toBeNull();
      expect(db.isAccountBanned(admin.accountId)).toBeNull();
      expect(db.isIpBanned('::ffff:198.51.100.9')).not.toBeNull();

      db.close();
      db = null;
      db = new GameDatabase(path);
      expect(db.isAccountBanned(target.accountId)).toBeNull();
      expect(db.isAccountBanned(alt.accountId)).toBeNull();
      expect(db.isAccountBanned(admin.accountId)).toBeNull();
      expect(db.banAccountsForIp('198.51.100.9', 'bot network', 'test-admin')).toEqual([target.accountId, alt.accountId]);
      expect(db.isAccountBanned(target.accountId)).not.toBeNull();
      expect(db.isAccountBanned(alt.accountId)).not.toBeNull();
      expect(db.isAccountBanned(admin.accountId)).toBeNull();
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
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
