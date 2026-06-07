import { describe, expect, test } from 'bun:test';
import { normalizeNpcEquipmentFits } from './npcEquipmentFit';

describe('NPC equipment fit overrides', () => {
  test('keeps valid slot transforms and drops empty/default-invalid entries', () => {
    expect(normalizeNpcEquipmentFits({
      head: {
        scale: 1.25,
        localPosition: { x: 0, y: 0.12, z: -0.25 },
        localRotation: { x: 0, y: Math.PI / 4, z: 0 },
      },
      body: {},
      nope: { scale: 2 },
      weapon: { scale: -1 },
      shield: { localPosition: { x: 0, y: Number.NaN, z: 0 } },
    })).toEqual({
      head: {
        scale: 1.25,
        localPosition: { x: 0, y: 0.12, z: -0.25 },
        localRotation: { x: 0, y: Math.PI / 4, z: 0 },
      },
    });
  });

  test('returns null when no usable override remains', () => {
    expect(normalizeNpcEquipmentFits(null)).toBeNull();
    expect(normalizeNpcEquipmentFits({ head: { scale: 0 }, bogus: { scale: 1 } })).toBeNull();
  });
});
