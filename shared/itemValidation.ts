import { isEquipSlot } from './equipment';
import { ALL_SKILLS } from './skills';
import { HEAD_RENDER_MODES, type ItemDef } from './types';

export type ItemDefValidationResult =
  | { ok: true; items: ItemDef[] }
  | { ok: false; error: string };

export interface ItemDefValidationOptions {
  arrayError?: string;
}

const EQUIP_SKILLS = new Set<string>(ALL_SKILLS);
const WEAPON_STYLES = new Set(['stab', 'slash', 'crush', 'bow', 'crossbow']);
const TOOL_TYPES = new Set(['axe', 'pickaxe', 'hammer', 'fishing_net', 'fishing_rod', 'harpoon', 'fishing_pot']);
const HEAD_RENDER_MODE_SET: ReadonlySet<string> = new Set(HEAD_RENDER_MODES);
const FINITE_NUMBER_FIELDS = [
  'value', 'attackSpeed', 'attackRange', 'stabAttack', 'slashAttack', 'crushAttack',
  'stabDefence', 'slashDefence', 'crushDefence', 'rangedDefence',
  'magicDefence', 'magicAccuracy', 'meleeStrength', 'rangedAccuracy',
  'rangedStrength', 'healAmount', 'toolLevel', 'toolBonus', 'levelRequired',
] as const;

export function validateItemDefs(items: unknown, options: ItemDefValidationOptions = {}): ItemDefValidationResult {
  if (!Array.isArray(items)) {
    return { ok: false, error: options.arrayError ?? 'Body must be { items: ItemDef[] }' };
  }
  const seen = new Set<number>();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Every item must be an object' };
    const item = raw as Record<string, unknown>;
    if (!Number.isInteger(item.id) || (item.id as number) <= 0) return { ok: false, error: `Invalid item id: ${String(item.id)}` };
    if (seen.has(item.id as number)) return { ok: false, error: `Duplicate item id: ${item.id}` };
    seen.add(item.id as number);
    if (typeof item.name !== 'string' || item.name.trim().length === 0) return { ok: false, error: `Item ${item.id} is missing a name` };
    if (typeof item.description !== 'string') return { ok: false, error: `Item ${item.id} is missing a description` };
    if (item.questItem !== undefined && typeof item.questItem !== 'boolean') return { ok: false, error: `Item ${item.id} has invalid questItem` };
    if (typeof item.stackable !== 'boolean') return { ok: false, error: `Item ${item.id} has invalid stackable` };
    if (typeof item.equippable !== 'boolean') return { ok: false, error: `Item ${item.id} has invalid equippable` };
    if (item.equipSlot !== undefined && !isEquipSlot(item.equipSlot)) return { ok: false, error: `Item ${item.id} has invalid equipSlot` };
    if (item.occupiesSlots !== undefined) {
      if (!Array.isArray(item.occupiesSlots) || item.occupiesSlots.length === 0) {
        return { ok: false, error: `Item ${item.id} has invalid occupiesSlots` };
      }
      if (item.equipSlot === undefined) {
        return { ok: false, error: `Item ${item.id} occupiesSlots requires equipSlot` };
      }
      const seenSlots = new Set<string>();
      for (const slot of item.occupiesSlots) {
        if (!isEquipSlot(slot)) return { ok: false, error: `Item ${item.id} has invalid occupiesSlots entry` };
        if (seenSlots.has(slot)) return { ok: false, error: `Item ${item.id} has duplicate occupiesSlots entry` };
        seenSlots.add(slot);
      }
      if (item.equipSlot !== undefined && !seenSlots.has(String(item.equipSlot))) {
        return { ok: false, error: `Item ${item.id} occupiesSlots must include equipSlot` };
      }
    }
    if (item.equipSkill !== undefined && !EQUIP_SKILLS.has(String(item.equipSkill))) return { ok: false, error: `Item ${item.id} has invalid equipSkill` };
    if (item.weaponStyle !== undefined && !WEAPON_STYLES.has(String(item.weaponStyle))) return { ok: false, error: `Item ${item.id} has invalid weaponStyle` };
    if (item.toolType !== undefined && !TOOL_TYPES.has(String(item.toolType))) return { ok: false, error: `Item ${item.id} has invalid toolType` };
    if (item.headRenderMode !== undefined && !HEAD_RENDER_MODE_SET.has(String(item.headRenderMode))) return { ok: false, error: `Item ${item.id} has invalid headRenderMode` };
    if (item.thumbnailModel !== undefined && (typeof item.thumbnailModel !== 'string' || item.thumbnailModel.trim().length === 0)) {
      return { ok: false, error: `Item ${item.id} has invalid thumbnailModel` };
    }
    if (item.bodyTypeModels !== undefined) {
      if (!item.bodyTypeModels || typeof item.bodyTypeModels !== 'object' || Array.isArray(item.bodyTypeModels)) {
        return { ok: false, error: `Item ${item.id} has invalid bodyTypeModels` };
      }
      for (const [bodyType, model] of Object.entries(item.bodyTypeModels as Record<string, unknown>)) {
        if (!/^\d+$/.test(bodyType) || typeof model !== 'string' || model.trim().length === 0) {
          return { ok: false, error: `Item ${item.id} has invalid bodyTypeModels.${bodyType}` };
        }
      }
    }
    if (item.stackModels !== undefined) {
      if (!Array.isArray(item.stackModels)) return { ok: false, error: `Item ${item.id} has invalid stackModels` };
      for (const [index, variant] of item.stackModels.entries()) {
        if (!variant || typeof variant !== 'object') return { ok: false, error: `Item ${item.id} has invalid stackModels.${index}` };
        const stackVariant = variant as Record<string, unknown>;
        if (!Number.isInteger(stackVariant.minQuantity) || (stackVariant.minQuantity as number) <= 0) {
          return { ok: false, error: `Item ${item.id} has invalid stackModels.${index}.minQuantity` };
        }
        if (typeof stackVariant.model !== 'string' || stackVariant.model.trim().length === 0) {
          return { ok: false, error: `Item ${item.id} has invalid stackModels.${index}.model` };
        }
        if (stackVariant.scale !== undefined && (typeof stackVariant.scale !== 'number' || !Number.isFinite(stackVariant.scale) || stackVariant.scale <= 0)) {
          return { ok: false, error: `Item ${item.id} has invalid stackModels.${index}.scale` };
        }
      }
    }
    for (const field of FINITE_NUMBER_FIELDS) {
      const value = item[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        return { ok: false, error: `Item ${item.id} has invalid ${field}` };
      }
    }
    if (item.attackRange !== undefined && (item.attackRange as number) <= 0) {
      return { ok: false, error: `Item ${item.id} has invalid attackRange` };
    }
  }
  return { ok: true, items: items as ItemDef[] };
}
