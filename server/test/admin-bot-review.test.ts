import { describe, expect, test } from 'bun:test';
import { BotStats } from '../src/BotStats';
import { GameDatabase } from '../src/Database';

describe('admin bot review data', () => {
  test('surfaces persisted bot scores with latest login context', () => {
    const db = new GameDatabase(':memory:');
    try {
      const session = db.loginFallbackAccount('review-target', '11111111-1111-4111-8111-111111111111');
      const loginRowId = db.recordLogin(session.accountId, '203.0.113.7', '11111111-1111-4111-8111-111111111111');
      db.recordLogout(loginRowId, 12);

      const stats = BotStats.empty();
      stats.onLogin({});
      for (let i = 0; i < 5; i++) stats.recordSuspiciousPacket();
      stats.finalize(db, session.accountId, {}, 77);
      db.banAccount(session.accountId, 'review action', 'test-admin', Math.floor(Date.now() / 1000) + 3600);

      const rows = db.listAdminBotReviewAccounts();
      const row = rows.find((entry) => entry.accountId === session.accountId);
      const flags = Array.isArray(row?.lastSessionSummary?.flags)
        ? row.lastSessionSummary.flags
        : [];

      expect(row?.username).toBe('review-target');
      expect(row?.lastIp).toBe('203.0.113.7');
      expect(row?.lastSessionMinutes).toBe(12);
      expect(row?.totalSuspiciousPackets).toBe(5);
      expect(row?.riskScore).toBeGreaterThan(0);
      expect(row?.accountBan?.reason).toBe('review action');
      expect(row?.accountBan?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(flags).toContain('suspiciousPackets');
    } finally {
      db.close();
    }
  });
});
