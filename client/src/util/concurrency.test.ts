import { describe, expect, test } from 'bun:test';
import { mapWithConcurrency } from './concurrency';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  test('returns results in input order regardless of completion order', async () => {
    const out = await mapWithConcurrency([30, 10, 20, 0], 2, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(out).toEqual([30, 10, 20, 0]);
  });

  test('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([...Array(20).keys()], 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await tick(5);
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually ran in parallel
  });

  test('empty input resolves to empty array without calling fn', async () => {
    let called = false;
    const out = await mapWithConcurrency([], 4, async () => { called = true; return 1; });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test('limit larger than item count runs all at once', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 10, async () => {
      active++; peak = Math.max(peak, active); await tick(5); active--;
    });
    expect(peak).toBe(3);
  });

  test('a rejecting item does not prevent others from completing', async () => {
    const settled: number[] = [];
    await expect(mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      await tick(1);
      settled.push(n);
      return n;
    })).rejects.toThrow('boom');
    // 1 and 3 still ran
    expect(settled).toContain(1);
    expect(settled).toContain(3);
  });
});
