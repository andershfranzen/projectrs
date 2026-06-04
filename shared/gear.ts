import type { ItemDef } from './types.js';

const GEAR_FIT_TIERS: readonly string[] = ['Bronze', 'Iron', 'Steel', 'Mithril', 'Black Bronze', 'Crimson', 'Malachor'];

export function gearFitTierForName(name?: string | null): string {
  if (!name) return '';
  return GEAR_FIT_TIERS.find(tier => name === tier || name.startsWith(`${tier} `)) ?? '';
}

export function gearFitFamilyForName(name?: string | null): string {
  if (!name) return '';
  const tier = gearFitTierForName(name);
  return tier ? name.slice(tier.length).trim() : '';
}

export function resolveEquipmentModelPath(
  def: Pick<ItemDef, 'equipSlot' | 'model' | 'bodyTypeModels'> | null | undefined,
  bodyType = 0,
  slotOverride?: string,
): string | null {
  if (!def) return null;
  const model = bodyType > 0
    ? def.bodyTypeModels?.[String(bodyType)] || def.model
    : def.model;
  if (!model) return null;
  if (model.startsWith('/')) return model;
  const slot = slotOverride ?? def.equipSlot;
  return slot ? `/assets/equipment/${slot}/${model}` : null;
}
