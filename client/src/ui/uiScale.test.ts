import { describe, expect, test } from 'bun:test';
import { UI_SCALE_OPTIONS } from './uiScale';

describe('UI scale options', () => {
  test('includes compact 75 percent scale before standard sizes', () => {
    expect(UI_SCALE_OPTIONS.map(option => [option.label, option.value])).toEqual([
      ['75%', 0.75],
      ['100%', 1],
      ['125%', 1.25],
      ['150%', 1.5],
    ]);
  });
});
