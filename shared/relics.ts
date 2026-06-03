export interface RelicTierDef {
  tier: number;
  itemIds: readonly number[];
  goodMagicXp: number;
}

export const RELIC_TIERS: readonly RelicTierDef[] = [
  { tier: 1, itemIds: [224, 225, 226], goodMagicXp: 10 },
  { tier: 2, itemIds: [227, 228, 229, 288], goodMagicXp: 35 },
  { tier: 3, itemIds: [289, 290, 291, 292], goodMagicXp: 100 },
  { tier: 4, itemIds: [293, 294], goodMagicXp: 250 },
  { tier: 5, itemIds: [295], goodMagicXp: 600 },
];

export const RELIC_ITEM_IDS: ReadonlySet<number> = new Set(RELIC_TIERS.flatMap(tier => tier.itemIds));

export function relicTierDef(tier: number): RelicTierDef | undefined {
  return RELIC_TIERS.find(def => def.tier === tier);
}

export function relicDropPoolForCombatLevel(level: number): readonly number[] | null {
  if (level < 30) return RELIC_TIERS[0].itemIds;
  if (level <= 60) return RELIC_TIERS[1].itemIds;
  if (level <= 100) return relicTierDef(3)?.itemIds ?? null;
  if (level <= 150) return relicTierDef(4)?.itemIds ?? null;
  return relicTierDef(5)?.itemIds ?? null;
}
