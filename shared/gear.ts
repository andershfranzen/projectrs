import type { ItemDef } from './types.js';

const GEAR_FIT_TIERS: readonly string[] = ['Bronze', 'Iron', 'Steel', 'Black Bronze', 'Mithril', 'Crimson', 'Malachor'];
const HIGH_QUALITY_SUFFIX = ' (HQ)';

export function gearFitTierForName(name?: string | null): string {
  if (!name) return '';
  return GEAR_FIT_TIERS.find(tier => name === tier || name.startsWith(`${tier} `)) ?? '';
}

export function gearFitFamilyForName(name?: string | null): string {
  if (!name) return '';
  const tier = gearFitTierForName(name);
  return tier ? name.slice(tier.length).trim() : '';
}

export function highQualityBaseItemName(name?: string | null): string | null {
  if (!name?.endsWith(HIGH_QUALITY_SUFFIX)) return null;
  const baseName = name.slice(0, -HIGH_QUALITY_SUFFIX.length).trim();
  return baseName.length > 0 ? baseName : null;
}

export function highQualityItemDescription(name?: string | null): string | null {
  const baseName = highQualityBaseItemName(name);
  return baseName ? `A high quality ${baseName}.` : null;
}

export function resolveGearFitSourceItemId(
  itemId: number,
  itemDefs: Iterable<Pick<ItemDef, 'id' | 'name' | 'equipSlot'>>,
): number {
  let item: Pick<ItemDef, 'id' | 'name' | 'equipSlot'> | null = null;
  const defs = Array.from(itemDefs);
  for (const def of defs) {
    if (def.id === itemId) {
      item = def;
      break;
    }
  }
  const baseName = highQualityBaseItemName(item?.name);
  if (!item || !baseName) return itemId;
  const source = defs.find(def => def.name === baseName && def.equipSlot === item.equipSlot);
  return source?.id ?? itemId;
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
