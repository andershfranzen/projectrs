import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database as SQLiteDB } from 'bun:sqlite';
import { ClientActivityKind, ClientOpcode } from '@projectrs/shared';
import { BotStats } from '../src/BotStats';
import { GameDatabase } from '../src/Database';
import { Player } from '../src/entity/Player';
import { getOpcodeRateRule, opcodeRequiresBrowserInputTelemetry, rateLimitOverflowIsSuspicious, suspiciousPacketCloseEligible } from '../src/network/GameSocket';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;
const RESET_BOT_METRICS_MIGRATION_ID = 'reset_bot_metrics_2026_05_24_calibration';

describe('anti-bot guardrails', () => {
  test('opcode rate rules bucket high-risk actions separately', () => {
    expect(getOpcodeRateRule(ClientOpcode.PLAYER_MOVE).bucket).toBe('movement');
    expect(getOpcodeRateRule(ClientOpcode.TRADE_OFFER_ITEM).bucket).toBe('inventory-ui');
    expect(getOpcodeRateRule(ClientOpcode.CLIENT_PING).windowMs).toBe(10_000);
    expect(getOpcodeRateRule(ClientOpcode.CURSOR_POSITION).bucket).toBe('cursor');
  });

  test('combat follow-up attack packets do not require fresh browser input', () => {
    const player = new Player('tester', 0, 0, fakeWs, 1);
    player.attackTarget = { id: 7 } as any;

    expect(opcodeRequiresBrowserInputTelemetry(ClientOpcode.PLAYER_ATTACK_NPC, [7], player)).toBe(false);
    expect(opcodeRequiresBrowserInputTelemetry(ClientOpcode.PLAYER_ATTACK_NPC, [8], player)).toBe(true);
    expect(opcodeRequiresBrowserInputTelemetry(ClientOpcode.PLAYER_INTERACT_OBJECT, [10000], player)).toBe(true);
  });

  test('low-risk telemetry overflow is dropped without suspicious strikes', () => {
    expect(rateLimitOverflowIsSuspicious(ClientOpcode.CURSOR_POSITION)).toBe(false);
    expect(rateLimitOverflowIsSuspicious(ClientOpcode.CLIENT_ACTIVITY)).toBe(false);
    expect(rateLimitOverflowIsSuspicious(ClientOpcode.CLIENT_POSITION_Y)).toBe(false);
    expect(rateLimitOverflowIsSuspicious(ClientOpcode.PLAYER_MOVE)).toBe(true);
    expect(rateLimitOverflowIsSuspicious(ClientOpcode.TRADE_OFFER_ITEM)).toBe(true);
  });

  test('state-race packet telemetry does not qualify for disconnects', () => {
    expect(suspiciousPacketCloseEligible('stale-npc-target')).toBe(false);
    expect(suspiciousPacketCloseEligible('unreachable-object-target')).toBe(false);
    expect(suspiciousPacketCloseEligible('dialogue-not-open')).toBe(false);
    expect(suspiciousPacketCloseEligible('appearance-editor-not-open')).toBe(false);
    expect(suspiciousPacketCloseEligible('malformed-frame')).toBe(true);
    expect(suspiciousPacketCloseEligible('bad-move-path-length')).toBe(true);
    expect(suspiciousPacketCloseEligible('missing-bank-deposit-values')).toBe(true);
    expect(suspiciousPacketCloseEligible('rate-limit:inventory-ui')).toBe(true);
  });

  test('per-action rate limits are independent from the global socket limit', () => {
    const player = new Player('tester', 0, 0, fakeWs, 1);

    expect(player.checkActionRateLimit('inventory-ui', 2, 1000, 100)).toBe(true);
    expect(player.checkActionRateLimit('inventory-ui', 2, 1000, 100)).toBe(true);
    expect(player.checkActionRateLimit('inventory-ui', 2, 1000, 100)).toBe(false);
    expect(player.checkActionRateLimit('movement', 2, 1000, 100)).toBe(true);
    expect(player.checkActionRateLimit('inventory-ui', 2, 1000, 1200)).toBe(true);
  });

  test('suspicious packet counts reset on the rolling window', () => {
    const player = new Player('tester', 0, 0, fakeWs, 1);

    expect(player.recordSuspiciousPacket(0)).toBe(1);
    expect(player.recordSuspiciousPacket(10)).toBe(2);
    expect(player.recordSuspiciousPacket(61_000)).toBe(1);
  });

  test('route/action loop signatures flag repeated browser-command loops', () => {
    const stats = BotStats.empty();
    stats.onLogin({});

    for (let i = 0; i < 25; i++) {
      stats.recordMovement(42.5, 17.5);
      stats.recordActionSignature('object', 123, 42.5, 17.5, 'Chop');
    }

    const summary = stats.computeSummary({});
    expect(summary.topActionLoopRepetition).toBe(1);
    expect(summary.flags).toContain('routeActionLoop');
  });

  test('single or sparse repeated actions do not create a route loop flag', () => {
    const stats = BotStats.empty();
    stats.onLogin({});

    for (let i = 0; i < 40; i++) {
      stats.recordMovement(i, 20);
    }
    stats.recordActionSignature('object', 123, 42.5, 17.5, 'Chop');

    const summary = stats.computeSummary({});
    expect(summary.topActionLoopRepetition).toBe(1);
    expect(summary.flags).not.toContain('routeActionLoop');
    expect(summary.riskLevel).toBe('low');
  });

  test('session path repetition is isolated from lifetime destination history', () => {
    const stats = BotStats.empty();
    stats.totalMovements = 5000;
    stats.pathDestinations.set('42,17', 900);
    stats.pathDestinations.set('43,17', 100);
    stats.onLogin({});

    for (let i = 0; i < 60; i++) {
      stats.recordMovement(i, 20);
    }

    const summary = stats.computeSummary({});
    expect(summary.topPathRepetition).toBeLessThan(0.05);
    expect(summary.flags).not.toContain('pathRepetitive');
    expect(summary.flags).toContain('lifetimePathConcentration');
  });

  test('risk profile escalates when multiple calibrated bot signals stack', () => {
    const stats = BotStats.empty();
    stats.onLogin({});
    stats.sessionStartedAt = Date.now() - 20 * 60_000;

    for (let i = 0; i < 100; i++) {
      stats.recordSkillingRoll(1000, 1000);
      stats.recordMovement(42.5, 17.5);
      stats.recordActionSignature('object', 123, 42.5, 17.5, 'Chop');
    }
    for (let i = 0; i < 3; i++) stats.recordSuspiciousPacket('malformed-frame');

    const summary = stats.computeSummary({});
    expect(summary.flags).toContain('tickAligned');
    expect(summary.flags).toContain('routeActionLoop');
    expect(summary.flags).toContain('protocolPackets');
    expect(summary.flags).toContain('noCursorTelemetry');
    expect(['high', 'critical']).toContain(summary.riskLevel);
    expect(summary.riskScore).toBeGreaterThanOrEqual(60);
    expect(summary.riskReasons.length).toBeGreaterThan(0);
  });

  test('server-tick alignment alone is diagnostic, not a high-risk score', () => {
    const stats = BotStats.empty();
    stats.onLogin({});

    for (let i = 0; i < 30; i++) {
      stats.recordSkillingRoll(1000, 1000);
    }

    const summary = stats.computeSummary({});
    expect(summary.flags).toContain('tickAligned');
    expect(summary.riskScore).toBe(0);
    expect(summary.riskLevel).toBe('low');
  });

  test('stale gameplay packets are tracked but do not fuzz-score like protocol abuse', () => {
    const stats = BotStats.empty();
    stats.onLogin({});

    for (let i = 0; i < 25; i++) stats.recordSuspiciousPacket('stale-npc-target');

    const summary = stats.computeSummary({});
    expect(summary.sessionSuspiciousPacketClasses.stale).toBe(25);
    expect(summary.flags).not.toContain('protocolPackets');
    expect(summary.flags).not.toContain('rateLimitPackets');
    expect(summary.riskLevel).toBe('low');
  });

  test('lifetime low-social high-activity behavior escalates review score', () => {
    const stats = BotStats.empty();
    stats.onLogin({});
    stats.totalSessionMinutes = 1300;
    stats.totalSkillingActions = 15000;
    stats.totalCombatSwings = 15000;
    stats.totalMovements = 13000;
    stats.totalChatMessages = 10;

    const summary = stats.computeSummary({});
    expect(summary.flags).toContain('lifetimeLowSocialHighActivity');
    expect(summary.flags).toContain('lifetimeExtremeLowSocialHighActivity');
    expect(summary.riskScore).toBeLessThan(30);
    expect(summary.riskLevel).toBe('low');
  });

  test('short-session XP bursts are not treated as reliable velocity evidence', () => {
    const stats = BotStats.empty();
    stats.onLogin({ mining: 0 });
    stats.sessionStartedAt = Date.now() - 60_000;

    const summary = stats.computeSummary({ mining: 10_000 });
    expect(summary.xpPerHour.mining).toBeGreaterThan(80_000);
    expect(summary.flags.some((flag) => flag.startsWith('xpVelocity:'))).toBe(false);
    expect(summary.riskLevel).toBe('low');
  });

  test('XP velocity requires enough active sampled play', () => {
    const stats = BotStats.empty();
    stats.onLogin({ mining: 0 });
    stats.sessionStartedAt = Date.now() - 10 * 60_000;
    for (let i = 0; i < 20; i++) {
      stats.recordSkillingRoll(1000, 1000 + i * 17);
    }

    const summary = stats.computeSummary({ mining: 20_000 });
    expect(summary.flags).toContain('xpVelocity:mining');
    expect(summary.riskScore).toBeGreaterThanOrEqual(26);
  });

  test('heartbeat-coupled activity is flagged as scripted input cadence', () => {
    const stats = BotStats.empty();
    stats.onLogin({});

    for (let i = 0; i < 12; i++) {
      const t = i * 5000;
      stats.recordHeartbeat(i, t);
      stats.recordClientActivity(t + 25);
    }

    const summary = stats.computeSummary({});
    expect(summary.heartbeatActivityCouplingRatio).toBe(1);
    expect(summary.flags).toContain('activityHeartbeatCoupled');
  });

  test('periodic spoofed activity cadence stacks with route loops for review', () => {
    const stats = BotStats.empty();
    stats.onLogin({});
    stats.sessionStartedAt = Date.now() - 20 * 60_000;

    for (let i = 0; i < 30; i++) {
      const t = 10_000 + i * 5000;
      stats.recordClientActivity(ClientActivityKind.Pointer, (i + 1) & 0x7fff, 450, 520, t);
      stats.recordCursorPosition(450 + (i % 4) * 20, 520 + (i % 3) * 20, t + 10);
      stats.recordMovement(42.5, 17.5);
      stats.recordActionSignature('object', 123, 42.5, 17.5, 'Chop');
    }

    const summary = stats.computeSummary({});
    expect(summary.sessionDetailedActivityEvents).toBe(30);
    expect(summary.activityIntervalStdDevMs).toBe(0);
    expect(summary.flags).toContain('activityRegular');
    expect(summary.flags).toContain('routeActionLoop');
    expect(summary.flags).not.toContain('legacyActivityTelemetry');
    expect(summary.riskScore).toBeGreaterThanOrEqual(30);
    expect(summary.riskLevel).toBe('medium');
  });

  test('legacy activity packets are diagnostic but do not convict normal users alone', () => {
    const stats = BotStats.empty();
    stats.onLogin({});
    stats.sessionStartedAt = Date.now() - 20 * 60_000;

    for (let i = 0; i < 50; i++) {
      if (i < 10) stats.recordClientActivity(10_000 + i * 21_000);
      stats.recordMovement(20 + i, 30);
    }

    const summary = stats.computeSummary({});
    expect(summary.sessionActivityEvents).toBe(10);
    expect(summary.sessionDetailedActivityEvents).toBe(0);
    expect(summary.sessionLegacyActivityEvents).toBe(10);
    expect(summary.flags).toContain('legacyActivityTelemetry');
    expect(summary.riskScore).toBeLessThan(30);
    expect(summary.riskLevel).toBe('low');
  });

  test('active sessions without cursor telemetry are flagged for review', () => {
    const stats = BotStats.empty();
    stats.onLogin({});
    stats.sessionStartedAt = Date.now() - 20 * 60_000;

    for (let i = 0; i < 100; i++) {
      stats.recordMovement(40.5 + (i % 3), 20.5);
    }

    const summary = stats.computeSummary({});
    expect(summary.sessionCursorEvents).toBe(0);
    expect(summary.flags).toContain('noCursorTelemetry');
  });

  test('browserless active gameplay escalates current raw websocket bots', () => {
    const stats = BotStats.empty();
    stats.onLogin({});
    stats.sessionStartedAt = Date.now() - 6 * 60_000;

    for (let i = 0; i < 25; i++) {
      stats.recordSkillingRoll(1000, 1000 + i * 17);
    }
    for (let i = 0; i < 6; i++) stats.recordGameplayCommandInputCheck(false);

    const summary = stats.computeSummary({});
    expect(summary.sessionActivityEvents).toBe(0);
    expect(summary.sessionCursorEvents).toBe(0);
    expect(summary.sessionInputlessCommands).toBe(6);
    expect(summary.sessionGameplayCommands).toBe(6);
    expect(summary.sessionCommandsWithoutRecentInput).toBe(6);
    expect(summary.sessionCommandsWithoutRecentActivity).toBe(6);
    expect(summary.flags).toContain('browserlessActiveGameplay');
    expect(summary.flags).toContain('noClientActivityTelemetry');
    expect(summary.flags).toContain('noCursorTelemetry');
    expect(summary.flags).toContain('inputlessCommandBurst');
    expect(summary.flags).toContain('commandsWithoutRecentInput');
    expect(summary.flags).toContain('commandsWithoutRecentActivity');
    expect(summary.riskScore).toBeGreaterThanOrEqual(60);
    expect(['high', 'critical']).toContain(summary.riskLevel);
  });

  test('normal browser telemetry prevents browserless gameplay flags', () => {
    const stats = BotStats.empty();
    stats.onLogin({});
    stats.sessionStartedAt = Date.now() - 6 * 60_000;
    stats.recordClientActivity(ClientActivityKind.Pointer, 1, 450, 520, 1000);
    stats.recordCursorPosition(450, 520);

    for (let i = 0; i < 25; i++) {
      stats.recordSkillingRoll(1000, 1000 + i * 17);
    }
    for (let i = 0; i < 4; i++) stats.recordGameplayCommandInputCheck(true);

    const summary = stats.computeSummary({});
    expect(summary.flags).not.toContain('browserlessActiveGameplay');
    expect(summary.flags).not.toContain('noClientActivityTelemetry');
    expect(summary.flags).not.toContain('noCursorTelemetry');
    expect(summary.flags).not.toContain('inputlessCommandBurst');
    expect(summary.flags).not.toContain('commandsWithoutRecentInput');
    expect(summary.flags).not.toContain('commandsWithoutRecentActivity');
    expect(summary.riskLevel).toBe('low');
  });

  test('cursor spoofing without client activity still escalates raw websocket bots', () => {
    const stats = BotStats.empty();
    stats.onLogin({});
    stats.sessionStartedAt = Date.now() - 6 * 60_000;

    for (let i = 0; i < 25; i++) {
      stats.recordCursorPosition(300 + (i % 6) * 80, 350 + (i % 5) * 60, 10_000 + i * 1000);
      stats.recordGameplayCommandInputCheck(true, false);
      stats.recordSkillingRoll(1000, 10_000 + i * 1000 + 20);
    }

    const summary = stats.computeSummary({});
    expect(summary.sessionCursorEvents).toBe(25);
    expect(summary.sessionActivityEvents).toBe(0);
    expect(summary.sessionInputlessCommands).toBe(0);
    expect(summary.sessionCommandsWithoutRecentInput).toBe(0);
    expect(summary.sessionCommandsWithoutRecentActivity).toBe(25);
    expect(summary.flags).not.toContain('browserlessActiveGameplay');
    expect(summary.flags).not.toContain('noCursorTelemetry');
    expect(summary.flags).toContain('noClientActivityTelemetry');
    expect(summary.flags).toContain('commandsWithoutRecentActivity');
    expect(summary.flags).toContain('activitylessCommandRatio');
    expect(summary.riskScore).toBeGreaterThanOrEqual(60);
    expect(['high', 'critical']).toContain(summary.riskLevel);
  });

  test('cursorless but active repetitive skilling remains low risk by itself', () => {
    const stats = BotStats.empty();
    stats.onLogin({});
    stats.sessionStartedAt = Date.now() - 20 * 60_000;
    stats.recordClientActivity(ClientActivityKind.Keyboard, 1, -1, -1, 1000);

    for (let i = 0; i < 40; i++) {
      stats.recordSkillingRoll(1000, 1000);
      stats.recordMovement(42.5, 17.5);
      stats.recordActionSignature('object', 123, 42.5, 17.5, 'Chop');
    }

    const summary = stats.computeSummary({});
    expect(summary.flags).toContain('tickAligned');
    expect(summary.flags).toContain('routeActionLoop');
    expect(summary.flags).toContain('noCursorTelemetry');
    expect(summary.flags).not.toContain('browserlessActiveGameplay');
    expect(summary.riskScore).toBeLessThan(30);
    expect(summary.riskLevel).toBe('low');
  });

  test('normal silent grinders with browser telemetry stay low risk despite diagnostic flags', () => {
    const stats = BotStats.empty();
    stats.onLogin({});
    stats.sessionStartedAt = Date.now() - 3 * 60 * 60_000;

    for (let i = 0; i < 180; i++) {
      const t = 10_000 + i * 30_000 + (i % 7) * 137;
      stats.recordClientActivity(
        ClientActivityKind.Pointer,
        (i + 1) & 0x7fff,
        120 + (i % 8) * 95,
        180 + (i % 5) * 120,
        t,
      );
      stats.recordCursorPosition(120 + (i % 8) * 95, 180 + (i % 5) * 120, t + 50);
      stats.recordSkillingRoll(1000, 1000);
      stats.recordMovement(42.5, 17.5);
      stats.recordActionSignature('object', 123, 42.5, 17.5, 'Chop');
    }

    const summary = stats.computeSummary({});
    expect(summary.flags).toContain('tickAligned');
    expect(summary.flags).toContain('pathRepetitive');
    expect(summary.flags).toContain('routeActionLoop');
    expect(summary.flags).toContain('noChat');
    expect(summary.flags).not.toContain('browserlessActiveGameplay');
    expect(summary.flags).not.toContain('noClientActivityTelemetry');
    expect(summary.flags).not.toContain('noCursorTelemetry');
    expect(summary.flags).not.toContain('commandsWithoutRecentActivity');
    expect(summary.flags).not.toContain('activityRegular');
    expect(summary.flags).not.toContain('legacyActivityTelemetry');
    expect(summary.riskScore).toBeLessThan(30);
    expect(summary.riskLevel).toBe('low');
  });

  test('recent browser input is required for gameplay command telemetry', () => {
    const stats = BotStats.empty();
    stats.onLogin({});
    stats.sessionStartedAt = Date.now() - 3 * 60_000;

    expect(stats.hasRecentBrowserInput(10_000, 15_000)).toBe(false);
    stats.recordClientActivity(ClientActivityKind.Pointer, 1, 450, 520, 10_000);
    expect(stats.hasRecentBrowserInput(11_000, 15_000)).toBe(true);
    expect(stats.hasRecentClientActivity(11_000, 15_000)).toBe(true);
    expect(stats.hasRecentBrowserInput(30_500, 15_000)).toBe(false);
    expect(stats.hasRecentClientActivity(30_500, 15_000)).toBe(false);

    stats.recordGameplayCommandInputCheck(false);
    stats.recordGameplayCommandInputCheck(false);
    stats.recordGameplayCommandInputCheck(false);

    const summary = stats.computeSummary({});
    expect(summary.sessionGameplayCommands).toBe(3);
    expect(summary.sessionCommandsWithoutRecentInput).toBe(3);
    expect(summary.sessionCommandsWithoutRecentActivity).toBe(3);
    expect(summary.inputlessCommandRatio).toBe(1);
    expect(summary.flags).toContain('commandsWithoutRecentInput');
    expect(summary.riskScore).toBeGreaterThanOrEqual(30);
  });

  test('static cursor telemetry is flagged separately from missing telemetry', () => {
    const stats = BotStats.empty();
    stats.onLogin({});

    for (let i = 0; i < 20; i++) {
      stats.recordCursorPosition(500, 500);
    }

    const summary = stats.computeSummary({});
    expect(summary.topCursorCellRepetition).toBe(1);
    expect(summary.flags).toContain('cursorStatic');
    expect(summary.flags).not.toContain('noCursorTelemetry');
  });

  test('risk profile persists in bot_stats rows', () => {
    const db = new GameDatabase(':memory:');
    try {
      const session = db.loginFallbackAccount('risk-tester', '11111111-1111-4111-8111-111111111111');
      const stats = BotStats.empty();
      stats.onLogin({});
      for (let i = 0; i < 5; i++) stats.recordSuspiciousPacket('malformed-frame');
      const summary = stats.finalize(db, session.accountId, {}, 1);
      const row = db.loadBotStats(session.accountId);

      expect(row?.risk_score).toBe(summary.riskScore);
      expect(row?.risk_level).toBe(summary.riskLevel);
      expect(JSON.parse(row?.risk_reasons ?? '[]')).toEqual(summary.riskReasons);
      expect(row?.total_suspicious_packets).toBe(5);
      expect(JSON.parse(row?.suspicious_packet_reasons ?? '{}')['malformed-frame']).toBe(5);
    } finally {
      db.close();
    }
  });

  test('checkpoint persists active-session risk before logout', () => {
    const db = new GameDatabase(':memory:');
    try {
      const session = db.loginFallbackAccount('active-risk', '11111111-1111-4111-8111-111111111111');
      const stats = BotStats.empty();
      stats.onLogin({});
      stats.sessionStartedAt = Date.now() - 6 * 60_000;
      for (let i = 0; i < 3; i++) stats.recordGameplayCommandInputCheck(false);

      stats.checkpoint(db, session.accountId, {});
      const row = db.loadBotStats(session.accountId);
      const summary = JSON.parse(row?.last_session_summary ?? '{}') as { flags?: string[] };

      expect(row?.risk_score).toBeGreaterThanOrEqual(30);
      expect(row?.risk_level).toBe('medium');
      expect(summary.flags).toContain('commandsWithoutRecentInput');
    } finally {
      db.close();
    }
  });

  test('bot metrics reset migration clears polluted persisted bot stats', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evilquest-bot-metrics-'));
    const dbPath = join(dir, 'test.db');
    try {
      const first = new GameDatabase(dbPath);
      const session = first.loginFallbackAccount('polluted-metrics', '11111111-1111-4111-8111-111111111111');
      const stats = BotStats.empty();
      stats.onLogin({});
      for (let i = 0; i < 5; i++) stats.recordSuspiciousPacket('malformed-frame');
      stats.finalize(first, session.accountId, {}, 1);
      first.close();

      const raw = new SQLiteDB(dbPath);
      raw.query('DELETE FROM server_migrations WHERE id = ?').run(RESET_BOT_METRICS_MIGRATION_ID);
      raw.close();

      const second = new GameDatabase(dbPath);
      expect(second.loadBotStats(session.accountId)).toBeNull();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('short sessions do not overwrite the last meaningful bot summary', () => {
    const db = new GameDatabase(':memory:');
    try {
      const session = db.loginFallbackAccount('summary-tester', '11111111-1111-4111-8111-111111111111');
      const stats = BotStats.empty();
      stats.onLogin({});
      stats.sessionStartedAt = Date.now() - 10 * 60_000;
      for (let i = 0; i < 10; i++) stats.recordMovement(10 + i, 20);
      const meaningful = stats.finalize(db, session.accountId, {}, 1);

      stats.onLogin({});
      const short = stats.finalize(db, session.accountId, {}, 2);
      const row = db.loadBotStats(session.accountId);
      const last = JSON.parse(row?.last_session_summary ?? '{}') as { sessionMinutes?: number };
      const history = JSON.parse(row?.session_history ?? '[]') as unknown[];

      expect(meaningful.sessionMinutes).toBeGreaterThanOrEqual(9);
      expect(short.sessionMinutes).toBe(0);
      expect(last.sessionMinutes).toBe(meaningful.sessionMinutes);
      expect(history).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
