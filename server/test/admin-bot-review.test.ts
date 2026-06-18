import { describe, expect, test } from 'bun:test';
import { ClientOpcode } from '@projectrs/shared';
import { BotStats } from '../src/BotStats';
import { GameDatabase } from '../src/Database';

describe('admin bot review data', () => {
  test('saves and reads bot replay traces in event order', () => {
    const db = new GameDatabase(':memory:');
    try {
      const session = db.loginFallbackAccount('replay-target', '11111111-1111-4111-8111-111111111111');
      const loginRowId = db.recordLogin(session.accountId, '203.0.113.30', session.wsSecret);
      const replayId = db.saveBotReplayTrace({
        accountId: session.accountId,
        username: 'replay-target',
        playerId: 42,
        loginRowId,
        triggerReason: 'replayed-action-capability',
        riskScore: 31,
        hardFlags: ['replayed-action-capability'],
        startedAt: 1_700_000_000,
        endedAt: 1_700_000_012,
        mapLevel: 'kcmap',
        floor: 0,
        startX: 12.5,
        startZ: 18.5,
        events: [
          { kind: 'client', t: 1_700_000_000_100, tick: 10, opcode: 40, values: [10001, 0], result: 'accepted', x: 12.5, z: 18.5, mapLevel: 'kcmap', floor: 0, details: { proof: { inputSeq: 7 } } },
          { kind: 'flag', t: 1_700_000_000_700, tick: 11, opcode: 40, values: [10001, 0], result: 'rejected', reason: 'replayed-action-capability', x: 12.5, z: 18.5, mapLevel: 'kcmap', floor: 0, details: { riskScore: 31 } },
        ],
      });

      const summaries = db.listAdminBotReplays(20, session.accountId);
      const detail = db.getAdminBotReplay(replayId);
      const accounts = db.listAdminBotReviewAccounts(20, 'replay-target');

      expect(replayId).toBeGreaterThan(0);
      expect(summaries[0]?.id).toBe(replayId);
      expect(summaries[0]?.username).toBe('replay-target');
      expect(summaries[0]?.hardFlags).toEqual(['replayed-action-capability']);
      expect(summaries[0]?.eventCount).toBe(2);
      expect(detail?.events.map(event => event.kind)).toEqual(['client', 'flag']);
      expect(detail?.events[1]?.reason).toBe('replayed-action-capability');
      expect(detail?.events[0]?.details).toEqual({ proof: { inputSeq: 7 } });
      expect(accounts[0]?.flagCounts).toEqual([{ flag: 'replayed-action-capability', count: 1 }]);
    } finally {
      db.close();
    }
  });

  test('clamps bot replay event payloads for admin reads', () => {
    const db = new GameDatabase(':memory:');
    try {
      const session = db.loginFallbackAccount('replay-clamp', '11111111-1111-4111-8111-111111111111');
      const values = Array.from({ length: 1300 }, (_, index) => index);
      const replayId = db.saveBotReplayTrace({
        accountId: session.accountId,
        username: 'replay-clamp',
        playerId: 43,
        loginRowId: null,
        triggerReason: 'manual-admin-review',
        riskScore: 0,
        hardFlags: ['manual-admin-review'],
        startedAt: 1,
        endedAt: 3,
        mapLevel: 'kcmap',
        floor: 0,
        startX: 1,
        startZ: 2,
        events: [
          { kind: 'server', t: 1000, tick: 1, opcode: 10, values, byteLength: 1, rawBase64: 'AA==', details: { huge: 'x'.repeat(20_000) } },
          { kind: 'client', t: 1001, tick: 1, opcode: ClientOpcode.CURSOR_TRACE, values, result: 'accepted', details: {} },
        ],
      });

      const detail = db.getAdminBotReplay(replayId);

      expect(detail?.events[0]?.values).toHaveLength(128);
      expect(detail?.events[1]?.values).toHaveLength(1200);
      expect(detail?.events[0]?.details.truncated).toBe(true);
    } finally {
      db.close();
    }
  });

  test('playtime timeline splits sessions across real hour buckets', () => {
    const db = new GameDatabase(':memory:');
    try {
      const now = 1_700_006_400;
      const alice = db.loginFallbackAccount('alice-playtime', '11111111-1111-4111-8111-111111111111');
      const bob = db.loginFallbackAccount('bob-playtime', '22222222-2222-4222-8222-222222222222');
      const raw = (db as any).db;
      raw.query(`
        INSERT INTO login_history (account_id, ip_address, login_ts, logout_ts, session_minutes, device_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(alice.accountId, '203.0.113.20', now - 5400, now - 1800, 60, '');
      raw.query(`
        INSERT INTO login_history (account_id, ip_address, login_ts, logout_ts, session_minutes, device_id)
        VALUES (?, ?, ?, NULL, NULL, ?)
      `).run(bob.accountId, '203.0.113.21', now - 1800, '');

      const timeline = db.getAdminPlaytimeTimeline(1, 60, now);
      const previousHour = timeline.buckets.find(bucket => bucket.startTs === now - 7200);
      const currentHour = timeline.buckets.find(bucket => bucket.startTs === now - 3600);

      expect(previousHour?.playMinutes).toBe(30);
      expect(previousHour?.loginCount).toBe(1);
      expect(previousHour?.logoutCount).toBe(0);
      expect(previousHour?.activeAccounts).toBe(1);
      expect(currentHour?.playMinutes).toBe(60);
      expect(currentHour?.loginCount).toBe(1);
      expect(currentHour?.logoutCount).toBe(1);
      expect(currentHour?.activeAccounts).toBe(2);
    } finally {
      db.close();
    }
  });

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
      db.banAccount(alt.accountId, 'linked bot', 'test-admin');

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
      expect(row?.sharedDeviceAlts[0]?.banned).toBe(true);
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

  test('marks shared alts banned when their latest IP is IP-banned', () => {
    const db = new GameDatabase(':memory:');
    try {
      const deviceId = '11111111-1111-4111-8111-111111111111';
      const target = db.loginFallbackAccount('fresh-device-alt', deviceId);
      const deviceAlt = db.loginFallbackAccount('ip-banned-device-alt', deviceId);
      const ipAlt = db.loginFallbackAccount('ip-banned-same-ip-alt', '22222222-2222-4222-8222-222222222222');

      db.recordLogin(target.accountId, '203.0.113.10', deviceId);
      db.recordLogin(deviceAlt.accountId, '203.0.113.11', deviceId);
      db.recordLogin(ipAlt.accountId, '203.0.113.10', ipAlt.wsSecret);
      db.banIp('203.0.113.11', 'bot network', 'test-admin');
      db.banIp('203.0.113.10', 'bot network', 'test-admin');

      const row = db.listAdminBotReviewAccounts(200, 'fresh-device-alt')[0];

      expect(row?.sharedDeviceAlts.find((alt) => alt.username === 'ip-banned-device-alt')?.banned).toBe(true);
      expect(row?.sharedIpAlts.find((alt) => alt.username === 'ip-banned-same-ip-alt')?.banned).toBe(true);
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

  test('finds all non-admin accounts linked by public shared IPs for bulk bans', () => {
    const db = new GameDatabase(':memory:');
    try {
      const target = db.loginFallbackAccount('bulk-target', '11111111-1111-4111-8111-111111111111');
      const first = db.loginFallbackAccount('bulk-alt-one', '22222222-2222-4222-8222-222222222222');
      const second = db.loginFallbackAccount('bulk-alt-two', '33333333-3333-4333-8333-333333333333');
      const admin = db.loginFallbackAccount('bulk-admin', '44444444-4444-4444-8444-444444444444');
      db.setAccountAdminRole(admin.accountId, true);

      db.recordLogin(target.accountId, '198.51.100.10', target.wsSecret);
      db.recordLogin(target.accountId, '198.51.100.11', target.wsSecret);
      db.recordLogin(first.accountId, '198.51.100.10', first.wsSecret);
      db.recordLogin(second.accountId, '198.51.100.11', second.wsSecret);
      db.recordLogin(admin.accountId, '198.51.100.10', admin.wsSecret);

      expect(db.getPublicSharedIpAccountIds(target.accountId)).toEqual([first.accountId, second.accountId]);
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
