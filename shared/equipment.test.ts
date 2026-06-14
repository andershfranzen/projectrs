import { describe, expect, test } from 'bun:test';
import { equipmentSlotSetsConflict, occupiedEquipmentSlotsForDef } from './equipment';

describe('equipment slot occupancy', () => {
  test('defaults to the primary equip slot', () => {
    expect(occupiedEquipmentSlotsForDef({ equipSlot: 'head' })).toEqual(['head']);
  });

  test('keeps legacy two-handed weapons occupying the shield slot', () => {
    expect(occupiedEquipmentSlotsForDef({ equipSlot: 'weapon', twoHanded: true })).toEqual(['weapon', 'shield']);
  });

  test('deduplicates explicit occupied slots and detects overlap', () => {
    const body = occupiedEquipmentSlotsForDef({ equipSlot: 'body', occupiesSlots: ['body', 'hands', 'hands'] });
    expect(body).toEqual(['body', 'hands']);
    expect(equipmentSlotSetsConflict(body, ['hands'])).toBe(true);
    expect(equipmentSlotSetsConflict(body, ['feet'])).toBe(false);
  });

  test('ignores invalid runtime slot data', () => {
    expect(occupiedEquipmentSlotsForDef({ equipSlot: 'body', occupiesSlots: ['hands', 'bogus'] })).toEqual(['body', 'hands']);
    expect(occupiedEquipmentSlotsForDef({ equipSlot: 'bogus', occupiesSlots: ['also-bad'] })).toEqual([]);
    expect(occupiedEquipmentSlotsForDef({ equipSlot: 'body', occupiesSlots: { slot: 'hands' } as any })).toEqual(['body']);
  });
});
