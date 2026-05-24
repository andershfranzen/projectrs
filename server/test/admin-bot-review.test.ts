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
      for (let i = 0; i < 5; i++) stats.recordSuspiciousPacket('malformed-frame');
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
      expect(row?.suspiciousPacketReasons[0]).toEqual({ reason: 'malformed-frame', count: 5 });
      expect(row?.riskScore).toBeGreaterThan(0);
      expect(row?.accountBan?.reason).toBe('review action');
      expect(row?.accountBan?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(flags).toContain('protocolPackets');
    } finally {
      db.close();
    }
  });

  test('surfaces shared device alts and calibrated lifetime behavior', () => {
    const db = new GameDatabase(':memory:');
    try {
      const deviceId = '11111111-1111-4111-8111-111111111111';
      const target = db.loginFallbackAccount('review-target', deviceId);
      const alt = db.loginFallbackAccount('alt-target', deviceId);
      db.recordLogin(target.accountId, '203.0.113.7', deviceId);
      db.recordLogin(alt.accountId, '203.0.113.8', deviceId);

      const stats = BotStats.empty();
      stats.onLogin({});
      stats.totalSessionMinutes = 1300;
      stats.totalSkillingActions = 15000;
      stats.totalCombatSwings = 15000;
      stats.totalMovements = 13000;
      stats.totalChatMessages = 10;
      stats.totalFlagEvents = 40;
      stats.riskScore = 96;
      stats.riskLevel = 'critical';
      stats.riskReasons = ['tick-aligned action timing (8ms stddev) (+24)', 'invalid/stale gameplay packets (100 this session) (+14)'];
      db.saveBotStats(target.accountId, stats.toRow());

      const row = db.listAdminBotReviewAccounts().find((entry) => entry.accountId === target.accountId);

      expect(row?.riskScore).toBeLessThan(96);
      expect(row?.riskScore).toBeLessThan(30);
      expect(row?.riskReasons.some((reason) => reason.includes('low-social high-activity'))).toBe(true);
      expect(row?.chatRatePerHour).toBeLessThan(1);
      expect(row?.sharedDeviceAlts[0]?.username).toBe('alt-target');
    } finally {
      db.close();
    }
  });
});
