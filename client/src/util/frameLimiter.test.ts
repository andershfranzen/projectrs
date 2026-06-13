import { describe, expect, test } from 'bun:test';
import { createFrameLimiter, DEFAULT_RENDER_FRAME_MS, FRAME_LIMIT_EPSILON_MS } from './frameLimiter';

describe('createFrameLimiter', () => {
  test('runs the first frame immediately and skips high-refresh intermediate frames', () => {
    const limiter = createFrameLimiter(60, 1000);

    expect(limiter.shouldRun(1000)).toBe(true);
    expect(limiter.shouldRun(1008)).toBe(false);
    expect(limiter.shouldRun(1000 + DEFAULT_RENDER_FRAME_MS)).toBe(true);
  });

  test('keeps roughly 60 rendered frames on a 75 Hz requestAnimationFrame cadence', () => {
    const limiter = createFrameLimiter(60, 0);
    let renderedFrames = 0;

    for (let frame = 0; frame < 75; frame++) {
      if (limiter.shouldRun(frame * (1000 / 75))) renderedFrames++;
    }

    expect(renderedFrames).toBeGreaterThanOrEqual(59);
    expect(renderedFrames).toBeLessThanOrEqual(61);
  });

  test('allows normal 60 Hz jitter within the epsilon window', () => {
    const limiter = createFrameLimiter(60, 0);

    expect(limiter.shouldRun(0)).toBe(true);
    expect(limiter.shouldRun(DEFAULT_RENDER_FRAME_MS - FRAME_LIMIT_EPSILON_MS / 2)).toBe(true);
  });

  test('resets the deadline after a long pause instead of catching up', () => {
    const limiter = createFrameLimiter(60, 0);

    expect(limiter.shouldRun(0)).toBe(true);
    expect(limiter.shouldRun(5000)).toBe(true);
    expect(limiter.shouldRun(5008)).toBe(false);
    expect(limiter.shouldRun(5000 + DEFAULT_RENDER_FRAME_MS)).toBe(true);
  });
});
