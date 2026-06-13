import { describe, expect, test } from 'bun:test';
import {
  BRIGHTNESS_OPTIONS,
  brightnessMultiplierForLevel,
  normalizeBrightnessLevel,
} from './brightness';

describe('brightness settings', () => {
  test('keeps level 3 as the current unmodified brightness', () => {
    expect(BRIGHTNESS_OPTIONS.map(option => option.value)).toEqual([1, 2, 3, 4]);
    expect(brightnessMultiplierForLevel(3)).toBe(1);
  });

  test('normalizes stored brightness to the closest supported levels', () => {
    expect(normalizeBrightnessLevel('1')).toBe(1);
    expect(normalizeBrightnessLevel(2)).toBe(2);
    expect(normalizeBrightnessLevel('4')).toBe(4);
    expect(normalizeBrightnessLevel('not-a-level')).toBe(3);
  });
});
