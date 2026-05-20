import { describe, expect, test } from 'bun:test';
import { ClientOpcode } from '@projectrs/shared';
import { BotStats } from '../src/BotStats';
import { GameDatabase } from '../src/Database';
import { Player } from '../src/entity/Player';
import { getOpcodeRateRule } from '../src/network/GameSocket';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

describe('anti-bot guardrails', () => {
  test('opcode rate rules bucket high-risk actions separately', () => {
    expect(getOpcodeRateRule(ClientOpcode.PLAYER_MOVE).bucket).toBe('movement');
    expect(getOpcodeRateRule(ClientOpcode.TRADE_OFFER_ITEM).bucket).toBe('inventory-ui');
    expect(getOpcodeRateRule(ClientOpcode.CLIENT_PING).windowMs).toBe(10_000);
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

  test('risk profile escalates when multiple bot signals stack', () => {
    const stats = BotStats.empty();
    stats.onLogin({});

    for (let i = 0; i < 30; i++) {
      stats.recordSkillingRoll(1000, 1000);
      stats.recordMovement(42.5, 17.5);
      stats.recordActionSignature('object', 123, 42.5, 17.5, 'Chop');
    }
    for (let i = 0; i < 5; i++) stats.recordSuspiciousPacket();

    const summary = stats.computeSummary({});
    expect(summary.flags).toContain('tickAligned');
    expect(summary.flags).toContain('routeActionLoop');
    expect(summary.flags).toContain('suspiciousPackets');
    expect(summary.riskLevel).toBe('high');
    expect(summary.riskScore).toBeGreaterThanOrEqual(60);
    expect(summary.riskReasons.length).toBeGreaterThan(0);
  });

  test('risk profile persists in bot_stats rows', () => {
    const db = new GameDatabase(':memory:');
    try {
      const session = db.loginFallbackAccount('risk-tester', '11111111-1111-4111-8111-111111111111');
      const stats = BotStats.empty();
      stats.onLogin({});
      for (let i = 0; i < 5; i++) stats.recordSuspiciousPacket();
      const summary = stats.finalize(db, session.accountId, {}, 1);
      const row = db.loadBotStats(session.accountId);

      expect(row?.risk_score).toBe(summary.riskScore);
      expect(row?.risk_level).toBe(summary.riskLevel);
      expect(JSON.parse(row?.risk_reasons ?? '[]')).toEqual(summary.riskReasons);
      expect(row?.total_suspicious_packets).toBe(5);
    } finally {
      db.close();
    }
  });
});
