import { describe, expect, test } from 'bun:test';
import { validateItemDefs } from './itemValidation';

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    name: 'Test item',
    description: 'A test item',
    stackable: false,
    equippable: false,
    ...overrides,
  };
}

describe('item definition validation', () => {
  test('accepts a valid equipment occupancy definition', () => {
    const result = validateItemDefs([
      item({
        equippable: true,
        equipSlot: 'body',
        occupiesSlots: ['body', 'hands'],
      }),
    ]);

    expect(result.ok).toBe(true);
  });

  test('rejects invalid occupied equipment slots', () => {
    const result = validateItemDefs([
      item({
        equippable: true,
        equipSlot: 'body',
        occupiesSlots: ['body', 'bogus'],
      }),
    ]);

    expect(result).toEqual({ ok: false, error: 'Item 1 has invalid occupiesSlots entry' });
  });

  test('rejects duplicate occupied equipment slots', () => {
    const result = validateItemDefs([
      item({
        equippable: true,
        equipSlot: 'body',
        occupiesSlots: ['body', 'hands', 'hands'],
      }),
    ]);

    expect(result).toEqual({ ok: false, error: 'Item 1 has duplicate occupiesSlots entry' });
  });

  test('requires explicit occupancy to include the primary equip slot', () => {
    const result = validateItemDefs([
      item({
        equippable: true,
        equipSlot: 'body',
        occupiesSlots: ['hands'],
      }),
    ]);

    expect(result).toEqual({ ok: false, error: 'Item 1 occupiesSlots must include equipSlot' });
  });

  test('requires explicit occupancy to define a primary equip slot', () => {
    const result = validateItemDefs([
      item({
        equippable: true,
        occupiesSlots: ['body'],
      }),
    ]);

    expect(result).toEqual({ ok: false, error: 'Item 1 occupiesSlots requires equipSlot' });
  });

  test('uses custom array errors for static data loading', () => {
    expect(validateItemDefs({ items: [] }, { arrayError: 'items.json must be an ItemDef[]' })).toEqual({
      ok: false,
      error: 'items.json must be an ItemDef[]',
    });
  });
});
