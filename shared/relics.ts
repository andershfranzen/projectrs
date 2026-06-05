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

export interface RelicCombatDropBand {
  tier: number;
  minLevel: number;
  maxLevel: number;
}

export const RELIC_COMBAT_DROP_MAX_CHANCE = 1 / 25;
export const RELIC_COMBAT_DROP_BANDS: readonly RelicCombatDropBand[] = [
  { tier: 1, minLevel: 1, maxLevel: 24 },
  { tier: 2, minLevel: 25, maxLevel: 49 },
  { tier: 3, minLevel: 50, maxLevel: 74 },
  { tier: 4, minLevel: 75, maxLevel: 99 },
  { tier: 5, minLevel: 100, maxLevel: 149 },
];

export function relicTierDef(tier: number): RelicTierDef | undefined {
  return RELIC_TIERS.find(def => def.tier === tier);
}

export function relicCombatDropBandForLevel(level: number): RelicCombatDropBand | null {
  if (!Number.isFinite(level)) return null;
  const combatLevel = Math.floor(level);
  return RELIC_COMBAT_DROP_BANDS.find(band => combatLevel >= band.minLevel && combatLevel <= band.maxLevel) ?? null;
}

export function relicDropChanceForCombatLevel(level: number): number {
  const band = relicCombatDropBandForLevel(level);
  if (!band) return 0;

  const combatLevel = Math.floor(level);
  const bandSize = band.maxLevel - band.minLevel + 1;
  const bandProgress = combatLevel - band.minLevel + 1;
  return (bandProgress / bandSize) * RELIC_COMBAT_DROP_MAX_CHANCE;
}

export function relicDropPoolForCombatLevel(level: number): readonly number[] | null {
  const band = relicCombatDropBandForLevel(level);
  return band ? relicTierDef(band.tier)?.itemIds ?? null : null;
}

export interface RelicCombatDropRecommendation {
  tier: number;
  itemId: number;
  quantity: 1;
  chance: number;
  itemIds: readonly number[];
}

export function relicCombatDropForLevel(level: number, preferredItemId?: number): RelicCombatDropRecommendation | null {
  const band = relicCombatDropBandForLevel(level);
  if (!band) return null;
  const itemIds = relicTierDef(band.tier)?.itemIds;
  if (!itemIds || itemIds.length === 0) return null;
  const itemId = preferredItemId != null && itemIds.includes(preferredItemId)
    ? preferredItemId
    : itemIds[0];
  return {
    tier: band.tier,
    itemId,
    quantity: 1,
    chance: relicDropChanceForCombatLevel(level),
    itemIds,
  };
}
