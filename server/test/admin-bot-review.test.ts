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
      db.muteAccount(session.accountId, 'chat spam', 'test-admin', Math.floor(Date.now() / 1000) + 1800);

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
      expect(row?.accountMute?.reason).toBe('chat spam');
      expect(row?.accountMute?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
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
      const ipAlt = db.loginFallbackAccount('same-ip-target', '33333333-3333-4333-8333-333333333333');
      const residential = db.loginFallbackAccount('residential-target', '44444444-4444-4444-8444-444444444444');
      const targetLoginId = db.recordLogin(target.accountId, '203.0.113.7', deviceId);
      db.setLoginReverseDns(targetLoginId, 'se-sto-wg-001.relays.mullvad.net');
      db.recordLogin(alt.accountId, '203.0.113.8', deviceId);
      db.recordLogin(ipAlt.accountId, '203.0.113.7', '33333333-3333-4333-8333-333333333333');
      const residentialLoginId = db.recordLogin(residential.accountId, '203.0.113.9', '44444444-4444-4444-8444-444444444444');
      db.setLoginReverseDns(residentialLoginId, 'customer-203-0-113-9.toronto.isp.example');

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
      expect(row?.sharedIpAlts[0]?.username).toBe('same-ip-target');
      expect(row?.sharedIpAlts[0]?.lastIp).toBe('203.0.113.7');
      expect(row?.vpnLikeIp?.reason).toBe('Mullvad PTR');
      expect(row?.vpnLikeIp?.ip).toBe('203.0.113.7');
      const residentialRow = db.listAdminBotReviewAccounts().find((entry) => entry.accountId === residential.accountId);
      expect(residentialRow?.vpnLikeIp).toBeNull();
    } finally {
      db.close();
    }
  });

  test('ignores legacy local and private IPs when finding shared IP alts', () => {
    const db = new GameDatabase(':memory:');
    try {
      const target = db.loginFallbackAccount('review-target', '11111111-1111-4111-8111-111111111111');
      const localOnly = db.loginFallbackAccount('local-only-alt', '22222222-2222-4222-8222-222222222222');
      const realIpAlt = db.loginFallbackAccount('same-ip-target', '33333333-3333-4333-8333-333333333333');

      db.recordLogin(target.accountId, '::1', target.wsSecret);
      db.recordLogin(localOnly.accountId, '::1', localOnly.wsSecret);
      db.recordLogin(target.accountId, '::ffff:127.0.0.1', target.wsSecret);
      db.recordLogin(localOnly.accountId, '::ffff:127.0.0.1', localOnly.wsSecret);
      db.recordLogin(target.accountId, '172.18.0.1', target.wsSecret);
      db.recordLogin(localOnly.accountId, '172.18.0.1', localOnly.wsSecret);
      db.recordLogin(target.accountId, '203.0.113.7', target.wsSecret);
      db.recordLogin(realIpAlt.accountId, '203.0.113.7', realIpAlt.wsSecret);

      const row = db.listAdminBotReviewAccounts(200, 'review-target')[0];

      expect(row?.sharedIpAlts.map((alt) => alt.username)).toEqual(['same-ip-target']);
    } finally {
      db.close();
    }
  });

  test('filters bot review accounts by username', () => {
    const db = new GameDatabase(':memory:');
    try {
      const needle = db.loginFallbackAccount('needle-target', '11111111-1111-4111-8111-111111111111');
      db.loginFallbackAccount('haystack-target', '22222222-2222-4222-8222-222222222222');
      db.recordLogin(needle.accountId, '203.0.113.7', '11111111-1111-4111-8111-111111111111');

      const rows = db.listAdminBotReviewAccounts(200, 'needle');

      expect(rows.map(row => row.username)).toEqual(['needle-target']);
    } finally {
      db.close();
    }
  });

  test('clears bot risk telemetry while keeping account review rows', () => {
    const db = new GameDatabase(':memory:');
    try {
      const session = db.loginFallbackAccount('reset-target', '11111111-1111-4111-8111-111111111111');
      const loginRowId = db.recordLogin(session.accountId, '203.0.113.7', '11111111-1111-4111-8111-111111111111');
      db.recordLogout(loginRowId, 8);

      const stats = BotStats.empty();
      stats.onLogin({});
      for (let i = 0; i < 5; i++) stats.recordSuspiciousPacket('malformed-frame');
      stats.finalize(db, session.accountId, {}, 77);

      expect(db.loadBotStats(session.accountId)?.risk_score).toBeGreaterThan(0);
      expect(db.clearBotStats()).toBe(1);
      expect(db.loadBotStats(session.accountId)).toBeNull();

      const row = db.listAdminBotReviewAccounts(200, 'reset-target')[0];
      expect(row?.username).toBe('reset-target');
      expect(row?.riskScore).toBe(0);
      expect(row?.riskLevel).toBe('low');
      expect(row?.riskReasons).toEqual([]);
      expect(row?.totalSuspiciousPackets).toBe(0);
      expect(row?.lastIp).toBe('203.0.113.7');
      expect(row?.lastSessionMinutes).toBe(8);
    } finally {
      db.close();
    }
  });

  test('clears bot risk telemetry for one account only', () => {
    const db = new GameDatabase(':memory:');
    try {
      const target = db.loginFallbackAccount('reset-one', '11111111-1111-4111-8111-111111111111');
      const other = db.loginFallbackAccount('keep-one', '22222222-2222-4222-8222-222222222222');
      const targetStats = BotStats.empty();
      const otherStats = BotStats.empty();
      targetStats.riskScore = 80;
      otherStats.riskScore = 70;
      db.saveBotStats(target.accountId, targetStats.toRow());
      db.saveBotStats(other.accountId, otherStats.toRow());

      expect(db.clearBotStatsForAccount(target.accountId)).toBe(1);
      expect(db.loadBotStats(target.accountId)).toBeNull();
      expect(db.loadBotStats(other.accountId)?.risk_score).toBe(70);
    } finally {
      db.close();
    }
  });

  test('granting admin is reflected in moderation info and bot review rows', () => {
    const db = new GameDatabase(':memory:');
    try {
      const target = db.loginFallbackAccount('future-admin', '11111111-1111-4111-8111-111111111111');

      const updated = db.setAccountAdminRole(target.accountId, true);
      const row = db.listAdminBotReviewAccounts(200, 'future-admin')[0];

      expect(updated?.isAdmin).toBe(true);
      expect(db.getAccountModerationInfo(target.accountId)?.isAdmin).toBe(true);
      expect(row?.isAdmin).toBe(true);
    } finally {
      db.close();
    }
  });
});
