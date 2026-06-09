import { describe, expect, test } from 'bun:test';
import { BotStats } from './BotStats';

function recordCommand(stats: BotStats, signature: string, nowMs: number): void {
  stats.recordGameplayCommandInputCheck(true, true);
  stats.recordGameplayCommandTiming(signature, nowMs);
}

describe('BotStats command cadence detection', () => {
  test('flags metronomic repeated gameplay commands', () => {
    const stats = BotStats.empty();

    for (let i = 0; i < 13; i++) {
      recordCommand(stats, 'object:10042:0:-1', i * 1200);
    }

    const summary = stats.computeSummary({});

    expect(summary.sameCommandIntervalSamples).toBe(12);
    expect(summary.sameCommandIntervalStdDevMs).toBe(0);
    expect(summary.flags).toContain('sameCommandCadenceRegular');
    expect(summary.riskReasons.some(reason => reason.includes('repeated command cadence'))).toBe(true);
  });

  test('does not flag varied repeated gameplay command timing', () => {
    const stats = BotStats.empty();
    const intervals = [900, 1410, 760, 1180, 1530, 820, 1275, 1015, 1670, 690, 1335, 1090];
    let now = 0;
    recordCommand(stats, 'object:10042:0:-1', now);
    for (const interval of intervals) {
      now += interval;
      recordCommand(stats, 'object:10042:0:-1', now);
    }

    const summary = stats.computeSummary({});

    expect(summary.sameCommandIntervalSamples).toBe(12);
    expect(summary.sameCommandIntervalStdDevMs).toBeGreaterThan(75);
    expect(summary.flags).not.toContain('sameCommandCadenceRegular');
  });

  test('flags repeated random-looking interval patterns', () => {
    const stats = BotStats.empty();
    const intervals = [930, 1470, 760, 1280, 1110];
    let now = 0;
    recordCommand(stats, 'object:10042:0:-1', now);

    for (let i = 0; i < 30; i++) {
      now += intervals[i % intervals.length];
      recordCommand(stats, 'object:10042:0:-1', now);
    }

    const summary = stats.computeSummary({});

    expect(summary.sameCommandIntervalStdDevMs).toBeGreaterThan(75);
    expect(summary.flags).not.toContain('sameCommandCadenceRegular');
    expect(summary.gameplayCommandIntervalPatternRatio).toBe(1);
    expect(summary.flags).toContain('gameplayCommandIntervalPattern');
    expect(summary.riskReasons.some(reason => reason.includes('interval pattern'))).toBe(true);
  });

  test('flags repeated command order even when intervals vary', () => {
    const stats = BotStats.empty();
    const signatures = ['object:10042:0:-1', 'pickup:201', 'object:10043:0:-1', 'pickup:202'];
    let now = 0;

    for (let i = 0; i < 40; i++) {
      now += 650 + ((i * 137) % 1000);
      recordCommand(stats, signatures[i % signatures.length], now);
    }

    const summary = stats.computeSummary({});

    expect(summary.gameplayCommandSequencePatternRatio).toBe(1);
    expect(summary.contextFlags).toContain('gameplayCommandSequencePattern');
    expect(summary.flags).not.toContain('gameplayCommandSequencePattern');
  });
});
