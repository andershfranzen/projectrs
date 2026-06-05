import { expect, test } from 'bun:test';
import {
  RELIC_COMBAT_DROP_MAX_CHANCE,
  relicCombatDropForLevel,
  relicCombatDropBandForLevel,
  relicDropChanceForCombatLevel,
  relicDropPoolForCombatLevel,
} from './relics';

function roundedChance(value: number): number {
  return Number(value.toFixed(6));
}

test('combat relic drop bands scale to one-in-25 at each band cap', () => {
  const cases: Array<{ level: number; tier: number | null; chance: number }> = [
    { level: 0, tier: null, chance: 0 },
    { level: 1, tier: 1, chance: RELIC_COMBAT_DROP_MAX_CHANCE / 24 },
    { level: 24, tier: 1, chance: RELIC_COMBAT_DROP_MAX_CHANCE },
    { level: 25, tier: 2, chance: RELIC_COMBAT_DROP_MAX_CHANCE / 25 },
    { level: 49, tier: 2, chance: RELIC_COMBAT_DROP_MAX_CHANCE },
    { level: 50, tier: 3, chance: RELIC_COMBAT_DROP_MAX_CHANCE / 25 },
    { level: 74, tier: 3, chance: RELIC_COMBAT_DROP_MAX_CHANCE },
    { level: 75, tier: 4, chance: RELIC_COMBAT_DROP_MAX_CHANCE / 25 },
    { level: 99, tier: 4, chance: RELIC_COMBAT_DROP_MAX_CHANCE },
    { level: 100, tier: 5, chance: RELIC_COMBAT_DROP_MAX_CHANCE / 50 },
    { level: 149, tier: 5, chance: RELIC_COMBAT_DROP_MAX_CHANCE },
    { level: 150, tier: null, chance: 0 },
  ];

  for (const entry of cases) {
    expect(relicCombatDropBandForLevel(entry.level)?.tier ?? null).toBe(entry.tier);
    expect(roundedChance(relicDropChanceForCombatLevel(entry.level))).toBe(roundedChance(entry.chance));
  }
});

test('combat relic drop pools follow the configured tier bands', () => {
  expect(relicDropPoolForCombatLevel(24)).toEqual([224, 225, 226]);
  expect(relicDropPoolForCombatLevel(25)).toEqual([227, 228, 229, 288]);
  expect(relicDropPoolForCombatLevel(50)).toEqual([289, 290, 291, 292]);
  expect(relicDropPoolForCombatLevel(75)).toEqual([293, 294]);
  expect(relicDropPoolForCombatLevel(100)).toEqual([295]);
  expect(relicDropPoolForCombatLevel(150)).toBeNull();
});

test('combat relic drop recommendation keeps preferred item inside the level tier', () => {
  const tierTwoPreferred = relicCombatDropForLevel(25, 288);
  expect(tierTwoPreferred?.tier).toBe(2);
  expect(tierTwoPreferred?.itemId).toBe(288);
  expect(roundedChance(tierTwoPreferred?.chance ?? 0)).toBe(roundedChance(RELIC_COMBAT_DROP_MAX_CHANCE / 25));

  const mismatchedPreferred = relicCombatDropForLevel(25, 224);
  expect(mismatchedPreferred?.tier).toBe(2);
  expect(mismatchedPreferred?.itemId).toBe(227);

  expect(relicCombatDropForLevel(150, 295)).toBeNull();
});
