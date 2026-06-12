import { describe, expect, test } from 'bun:test';
import {
  BotStats,
  behavioralEvidenceFlagCount,
  BEHAVIORAL_EVIDENCE_THRESHOLD,
  analyzeMechanicalJitter,
  isLikelyMobileSession,
} from './BotStats';

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

    // Structured signal carries the label, measured value, threshold, points
    // and tier the admin panel renders.
    const signal = summary.riskSignals.find(s => s.flag === 'sameCommandCadenceRegular');
    expect(signal).toBeDefined();
    expect(signal!.points).toBe(32);
    expect(signal!.tier).toBe('hard');
    expect(signal!.label.length).toBeGreaterThan(0);
    expect(signal!.threshold).toContain('stddev');
    expect(signal!.measured).toContain('0ms stddev');
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
    expect(summary.riskSignals.some(s => s.flag === 'gameplayCommandIntervalPattern' && s.tier === 'hard')).toBe(true);
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

describe('behavioral-evidence cluster (uncaps careful bots)', () => {
  test('counts only distinct automation-mechanism signals', () => {
    expect(behavioralEvidenceFlagCount([
      'activityHeartbeatCoupled', 'routeActionLoop', 'noMoveRedirects', 'maxPathCommandRatio',
    ])).toBe(4);
  });

  test('ignores lifestyle/grinder signals a dedicated human also trips', () => {
    expect(behavioralEvidenceFlagCount([
      'noChat', 'marathonSession', 'noIdleBreaks', 'pathRepetitive', 'lifetimeLowSocialHighActivity',
    ])).toBe(0);
  });

  test('excludes pingRegular (stable-network false positive)', () => {
    expect(behavioralEvidenceFlagCount(['pingRegular'])).toBe(0);
  });

  test('de-duplicates and normalizes suffixed flags', () => {
    expect(behavioralEvidenceFlagCount([
      'routeActionLoop', 'routeActionLoop', 'xpVelocity:mining',
    ])).toBe(1);
  });

  test('threshold is a conservative count of independent tells', () => {
    expect(BEHAVIORAL_EVIDENCE_THRESHOLD).toBeGreaterThanOrEqual(4);
    expect(behavioralEvidenceFlagCount(['activityRegular', 'routeActionLoop', 'noMoveRedirects']))
      .toBeLessThan(BEHAVIORAL_EVIDENCE_THRESHOLD);
  });
});

describe('mechanical-jitter detection (computer-generated randomization)', () => {
  test('flags tight, tail-less jitter that slips past the cadence gate', () => {
    // ~1000ms ± uniform 80ms: nonzero variance, low CV, no heavy tail.
    const intervals = Array.from({ length: 50 }, (_, i) => 1000 + ((i * 137) % 160) - 80);
    const m = analyzeMechanicalJitter(intervals);
    expect(m.isMechanical).toBe(true);
    expect(m.coefficientOfVariation!).toBeLessThan(0.15);
    expect(m.tailRatio!).toBeLessThan(1.5);
  });

  test('does NOT flag human timing with occasional long pauses (heavy tail)', () => {
    const steady = Array.from({ length: 40 }, (_, i) => 750 + (i % 5) * 40);
    const pauses = [2800, 3500, 2600, 4000, 3100, 2700, 3300, 2900, 3600, 2500];
    const m = analyzeMechanicalJitter([...steady, ...pauses]);
    expect(m.isMechanical).toBe(false);
    expect(m.tailRatio!).toBeGreaterThan(1.5);
  });

  test('does NOT flag a perfect metronome (0 variance — caught by cadence instead)', () => {
    expect(analyzeMechanicalJitter(Array(50).fill(1000)).isMechanical).toBe(false);
  });

  test('needs enough samples', () => {
    expect(analyzeMechanicalJitter([1000, 1010, 990, 1005]).isMechanical).toBe(false);
  });
});

describe('mobile detection (avoid false-flagging phone players)', () => {
  test('touch-dominant session reads as mobile', () => {
    expect(isLikelyMobileSession(120, 4, 0)).toBe(true);
  });

  test('desktop pointer/keyboard session is not mobile', () => {
    expect(isLikelyMobileSession(0, 200, 30)).toBe(false);
  });

  test('a few stray taps on desktop do not read as mobile', () => {
    expect(isLikelyMobileSession(6, 300, 10)).toBe(false);
  });

  test('a bot emitting a handful of fake touch packets does not read as mobile', () => {
    // Below the touch-event floor and outnumbered → no mobile exemption.
    expect(isLikelyMobileSession(10, 0, 0)).toBe(false);
  });
});

describe('cursor-absence signals are mobile-safe', () => {
  test('mobile player with no cursor telemetry is NOT flagged noCursorTelemetry/cursorStatic', () => {
    const stats = BotStats.empty();
    for (let i = 0; i < 60; i++) stats.recordSkillingRoll(i * 600, i * 600, i * 1000); // 60 skilling actions
    for (let i = 0; i < 40; i++) stats.recordClientActivity(3 /* Touch */, i, null, null, i * 1000); // touch activity, no cursor
    // Backdate session start so sessionMinutes clears the ≥5-minute gate.
    (stats as unknown as { sessionStartedAt: number }).sessionStartedAt = Date.now() - 10 * 60_000;

    const summary = stats.computeSummary({});
    expect(summary.isLikelyMobile).toBe(true);
    // noCursorTelemetry / cursorStatic are diagnostic-tier flags.
    expect(summary.diagnosticFlags).not.toContain('noCursorTelemetry');
    expect(summary.diagnosticFlags).not.toContain('cursorStatic');
  });

  test('desktop player with no cursor telemetry IS flagged noCursorTelemetry', () => {
    const stats = BotStats.empty();
    for (let i = 0; i < 60; i++) stats.recordSkillingRoll(i * 600, i * 600, i * 1000);
    // No touch, no cursor → not mobile, cursor-absence should fire.
    (stats as unknown as { sessionStartedAt: number }).sessionStartedAt = Date.now() - 10 * 60_000;

    const summary = stats.computeSummary({});
    expect(summary.isLikelyMobile).toBe(false);
    expect(summary.diagnosticFlags).toContain('noCursorTelemetry');
  });
});
