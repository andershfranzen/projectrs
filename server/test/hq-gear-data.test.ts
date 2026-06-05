import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { highQualityItemDescription, resolveGearFitSourceItemId, type ItemDef } from '@projectrs/shared';

const ATTACK_STATS = ['stabAttack', 'slashAttack', 'crushAttack'] as const;
const DEFENCE_STATS = ['stabDefence', 'slashDefence', 'crushDefence', 'magicDefence', 'rangedDefence'] as const;
const STAT_FIELDS = [
  ...ATTACK_STATS,
  ...DEFENCE_STATS,
  'meleeStrength',
  'rangedAccuracy',
  'rangedStrength',
  'magicAccuracy',
] as const satisfies readonly (keyof ItemDef)[];
const HQ_IDENTITY_FIELDS = ['id', 'name', 'description'] as const satisfies readonly (keyof ItemDef)[];

type StatField = typeof STAT_FIELDS[number];

const GEAR_TIER_CONFIGS = [
  { name: 'Bronze', multiplier: 1, equipLevel: 1, barValue: 15 },
  { name: 'Iron', multiplier: 1.5, equipLevel: 6, barValue: 30 },
  { name: 'Steel', multiplier: 2, equipLevel: 15, barValue: 60 },
  { name: 'Black Bronze', multiplier: 3, equipLevel: 25, barValue: 120 },
  { name: 'Mithril', multiplier: 4, equipLevel: 35, barValue: 240 },
  { name: 'Crimson', multiplier: 5, equipLevel: 45, barValue: 480 },
  { name: 'Malachor', multiplier: 6, equipLevel: 55, barValue: 960 },
] as const;

const GEAR_FAMILY_CONFIGS = {
  Dagger: { bars: 1, stats: { stabAttack: 5, slashAttack: 2, meleeStrength: 3 } },
  Sword: { bars: 1, stats: { stabAttack: 2, slashAttack: 7, meleeStrength: 5 } },
  Mace: { bars: 1, stats: { crushAttack: 6, meleeStrength: 5 } },
  Scimitar: { bars: 2, stats: { slashAttack: 9, meleeStrength: 7 } },
  'Battle Axe': { bars: 3, stats: { slashAttack: 6, crushAttack: 12, meleeStrength: 14 } },
  '2-handed Sword': { bars: 3, stats: { slashAttack: 14, meleeStrength: 24 } },
  'Medium Helmet': { bars: 1, stats: { stabDefence: 3, slashDefence: 4, crushDefence: 2 } },
  'Full Helmet': { bars: 2, stats: { stabDefence: 5, slashDefence: 6, crushDefence: 4 } },
  'Square Shield': {
    bars: 2,
    stats: { stabDefence: 4, slashDefence: 5, crushDefence: 4, rangedDefence: 3 },
  },
  Cuirass: {
    bars: 3,
    stats: { stabDefence: 8, slashDefence: 10, crushDefence: 6, rangedDefence: 8 },
  },
  'Kite Shield': {
    bars: 3,
    stats: { stabDefence: 7, slashDefence: 8, crushDefence: 7, rangedDefence: 5 },
  },
  'Plate Mail Legs': {
    bars: 3,
    stats: { stabDefence: 6, slashDefence: 7, crushDefence: 5, rangedDefence: 5 },
  },
  'Plate Mail Body': {
    bars: 5,
    stats: { stabDefence: 14, slashDefence: 16, crushDefence: 12, rangedDefence: 14 },
  },
} as const satisfies Record<string, { bars: number; stats: Partial<Record<StatField, number>> }>;

const HQ_GEAR_TIERS = GEAR_TIER_CONFIGS.map((tier) => tier.name);
const HQ_GEAR_FAMILIES = Object.keys(GEAR_FAMILY_CONFIGS) as Array<keyof typeof GEAR_FAMILY_CONFIGS>;
const HQ_BOW_NAMES = [
  'Shortbow',
  'Oak Shortbow',
  'Willow Shortbow',
  'Maple Shortbow',
  'Yew Shortbow',
  'Mystic Shortbow',
] as const;

const NEWER_GATHERING_TIER_CONFIGS = [
  {
    name: 'Crimson',
    oreName: 'Crimsonite Ore',
    barName: 'Crimson Bar',
    barValue: 480,
    equipLevel: 45,
    toolBonus: 5,
    axeValue: 980,
    axeSlashAttack: 24,
    axeStrength: 18,
    pickaxeValue: 960,
    pickaxeCrushAttack: 20,
    pickaxeStrength: 15,
  },
  {
    name: 'Malachor',
    oreName: 'Malachite Ore',
    barName: 'Malachor Bar',
    barValue: 960,
    equipLevel: 55,
    toolBonus: 6,
    axeValue: 1940,
    axeSlashAttack: 28,
    axeStrength: 21,
    pickaxeValue: 1920,
    pickaxeCrushAttack: 24,
    pickaxeStrength: 18,
  },
] as const;

const STAT_FIELD_SET = new Set<keyof ItemDef>(STAT_FIELDS);
const HQ_IDENTITY_FIELD_SET = new Set<keyof ItemDef>(HQ_IDENTITY_FIELDS);

function loadItems(): ItemDef[] {
  const dataDir = join(import.meta.dir, '..', 'data');
  return JSON.parse(readFileSync(join(dataDir, 'items.json'), 'utf8')) as ItemDef[];
}

function itemByName(items: ItemDef[], name: string): ItemDef | undefined {
  return items.find((item) => item.name === name);
}

function expectedHqStatValue(stat: typeof STAT_FIELDS[number], baseValue: number | undefined): number | undefined {
  if (typeof baseValue !== 'number') return baseValue;
  if (ATTACK_STATS.includes(stat as typeof ATTACK_STATS[number])) return baseValue + 3;
  if (DEFENCE_STATS.includes(stat as typeof DEFENCE_STATS[number])) return baseValue + 3;
  if (stat === 'meleeStrength') return baseValue + 2;
  return baseValue;
}

describe('HQ gear data', () => {
  test('metal weapon and armor stats scale through all tiers', () => {
    const items = loadItems();

    for (const tier of GEAR_TIER_CONFIGS) {
      for (const family of HQ_GEAR_FAMILIES) {
        const item = itemByName(items, `${tier.name} ${family}`);
        const familyConfig = GEAR_FAMILY_CONFIGS[family];

        expect(item, `Missing item: ${tier.name} ${family}`).toBeDefined();
        if (!item) continue;

        expect(item.levelRequired, `${item.name} equip level`).toBe(tier.equipLevel);
        expect(item.value, `${item.name} value`).toBe(Math.round(tier.barValue * familyConfig.bars * 1.5));

        const familyStats: Partial<Record<StatField, number>> = familyConfig.stats;
        for (const stat of STAT_FIELDS) {
          const baseValue = familyStats[stat];
          const expected = typeof baseValue === 'number' ? Math.round(baseValue * tier.multiplier) : undefined;
          expect(item[stat], `${item.name} ${String(stat)}`).toBe(expected);
        }
      }
    }
  });

  test('newer tier materials and gathering tools scale past Mithril', () => {
    const items = loadItems();

    for (const tier of NEWER_GATHERING_TIER_CONFIGS) {
      const ore = itemByName(items, tier.oreName);
      const bar = itemByName(items, tier.barName);
      const axe = itemByName(items, `${tier.name} Axe`);
      const pickaxe = itemByName(items, `${tier.name} Pickaxe`);

      expect(ore?.value, `${tier.oreName} value`).toBe(Math.round(tier.barValue * 0.4));
      expect(bar?.value, `${tier.barName} value`).toBe(tier.barValue);

      expect(axe?.toolType, `${tier.name} Axe tool type`).toBe('axe');
      expect(axe?.toolLevel, `${tier.name} Axe tool level`).toBe(tier.equipLevel);
      expect(axe?.toolBonus, `${tier.name} Axe tool bonus`).toBe(tier.toolBonus);
      expect(axe?.value, `${tier.name} Axe value`).toBe(tier.axeValue);
      expect(axe?.slashAttack, `${tier.name} Axe slash attack`).toBe(tier.axeSlashAttack);
      expect(axe?.meleeStrength, `${tier.name} Axe strength`).toBe(tier.axeStrength);

      expect(pickaxe?.toolType, `${tier.name} Pickaxe tool type`).toBe('pickaxe');
      expect(pickaxe?.toolLevel, `${tier.name} Pickaxe tool level`).toBe(tier.equipLevel);
      expect(pickaxe?.toolBonus, `${tier.name} Pickaxe tool bonus`).toBe(tier.toolBonus);
      expect(pickaxe?.value, `${tier.name} Pickaxe value`).toBe(tier.pickaxeValue);
      expect(pickaxe?.crushAttack, `${tier.name} Pickaxe crush attack`).toBe(tier.pickaxeCrushAttack);
      expect(pickaxe?.meleeStrength, `${tier.name} Pickaxe strength`).toBe(tier.pickaxeStrength);
    }
  });

  test('all HQ gear uses high quality examine text and normal gear visuals', () => {
    const items = loadItems();
    const hqGear = items.filter((item) => highQualityItemDescription(item.name) && item.equippable && !item.stackable);

    expect(hqGear.length).toBeGreaterThan(0);
    for (const item of hqGear) {
      const expectedDescription = highQualityItemDescription(item.name);
      if (!expectedDescription) throw new Error(`Expected HQ description for ${item.name}`);
      expect(item.description).toBe(expectedDescription);
      expect(resolveGearFitSourceItemId(item.id, items)).not.toBe(item.id);
    }
  });

  test('all metal weapon and armor tiers have HQ variants', () => {
    const items = loadItems();

    for (const tier of HQ_GEAR_TIERS) {
      for (const family of HQ_GEAR_FAMILIES) {
        const baseName = `${tier} ${family}`;
        const hqName = `${baseName} (HQ)`;
        const base = itemByName(items, baseName);
        const hq = itemByName(items, hqName);

        expect(base, `Missing base item: ${baseName}`).toBeDefined();
        expect(hq, `Missing HQ item: ${hqName}`).toBeDefined();
        expect(hq?.equipSlot).toBe(base?.equipSlot);
      }
    }
  });

  test('HQ weapon and armor variants are base copies except identity text and stats', () => {
    const items = loadItems();

    for (const tier of HQ_GEAR_TIERS) {
      for (const family of HQ_GEAR_FAMILIES) {
        const base = itemByName(items, `${tier} ${family}`);
        const hq = itemByName(items, `${tier} ${family} (HQ)`);
        if (!base || !hq) throw new Error(`Missing HQ pair for ${tier} ${family}`);

        const fields = new Set<keyof ItemDef>([
          ...Object.keys(base) as Array<keyof ItemDef>,
          ...Object.keys(hq) as Array<keyof ItemDef>,
        ]);

        for (const field of fields) {
          if (HQ_IDENTITY_FIELD_SET.has(field) || STAT_FIELD_SET.has(field)) continue;
          expect(hq[field], `${hq.name} should copy ${String(field)} from ${base.name}`).toEqual(base[field]);
        }

        for (const stat of STAT_FIELDS) {
          expect(hq[stat], `${hq.name} should have expected ${String(stat)}`).toBe(
            expectedHqStatValue(stat, base[stat]),
          );
        }
      }
    }
  });

  test('all strung shortbows have HQ variants copied from base visuals with ranged bonuses', () => {
    const items = loadItems();
    const hqBowStatFields = new Set<keyof ItemDef>(['rangedAccuracy', 'rangedStrength']);

    for (const baseName of HQ_BOW_NAMES) {
      const base = itemByName(items, baseName);
      const hq = itemByName(items, `${baseName} (HQ)`);
      if (!base || !hq) throw new Error(`Missing HQ bow pair for ${baseName}`);
      const expectedDescription = highQualityItemDescription(hq.name);
      if (!expectedDescription) throw new Error(`Expected HQ description for ${hq.name}`);

      expect(hq.description).toBe(expectedDescription);
      expect(resolveGearFitSourceItemId(hq.id, items)).toBe(base.id);
      expect(hq.equipSlot).toBe(base.equipSlot);

      const fields = new Set<keyof ItemDef>([
        ...Object.keys(base) as Array<keyof ItemDef>,
        ...Object.keys(hq) as Array<keyof ItemDef>,
      ]);

      for (const field of fields) {
        if (HQ_IDENTITY_FIELD_SET.has(field) || hqBowStatFields.has(field)) continue;
        expect(hq[field], `${hq.name} should copy ${String(field)} from ${base.name}`).toEqual(base[field]);
      }

      expect(hq.rangedAccuracy, `${hq.name} ranged accuracy`).toBe((base.rangedAccuracy ?? 0) + 1);
      expect(hq.rangedStrength, `${hq.name} ranged strength`).toBe((base.rangedStrength ?? 0) + 2);
    }
  });
});
