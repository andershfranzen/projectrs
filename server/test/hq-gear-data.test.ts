import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { highQualityItemDescription, resolveGearFitSourceItemId, type ItemDef } from '@projectrs/shared';

const HQ_GEAR_TIERS = ['Bronze', 'Iron', 'Steel', 'Black Bronze', 'Mithril', 'Crimson', 'Malachor'];
const HQ_GEAR_FAMILIES = [
  'Dagger',
  'Sword',
  'Mace',
  'Scimitar',
  'Battle Axe',
  '2-handed Sword',
  'Medium Helmet',
  'Full Helmet',
  'Square Shield',
  'Cuirass',
  'Kite Shield',
  'Plate Mail Legs',
  'Plate Mail Body',
];

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
});
