export const EQUIPMENT_SLOT_NAMES = [
  'weapon',
  'shield',
  'head',
  'body',
  'legs',
  'neck',
  'ring',
  'hands',
  'feet',
  'cape',
  'ammo',
] as const;

export type EquipSlot = typeof EQUIPMENT_SLOT_NAMES[number];

export const EQUIPMENT_SLOT_COUNT = EQUIPMENT_SLOT_NAMES.length;

export const EQUIPMENT_SLOT_LABELS = {
  weapon: 'Weapon',
  shield: 'Shield',
  head: 'Head',
  body: 'Body',
  legs: 'Legs',
  neck: 'Neck',
  ring: 'Ring',
  hands: 'Hands',
  feet: 'Feet',
  cape: 'Cape',
  ammo: 'Ammo',
} as const satisfies Record<EquipSlot, string>;

export const EQUIPMENT_SLOT_INDICES = Object.freeze(
  Object.fromEntries(EQUIPMENT_SLOT_NAMES.map((slot, index) => [slot, index])),
) as Readonly<Record<EquipSlot, number>>;

const EQUIPMENT_SLOT_SET: ReadonlySet<string> = new Set(EQUIPMENT_SLOT_NAMES);

export function isEquipSlot(value: unknown): value is EquipSlot {
  return typeof value === 'string' && EQUIPMENT_SLOT_SET.has(value);
}

export function equipmentSlotAt(index: number): EquipSlot | undefined {
  return Number.isInteger(index) ? EQUIPMENT_SLOT_NAMES[index] : undefined;
}

export function equipmentSlotIndex(slot: EquipSlot): number {
  return EQUIPMENT_SLOT_INDICES[slot];
}

export interface EquipmentSlotOccupancyDef {
  equipSlot?: unknown;
  occupiesSlots?: readonly unknown[];
  twoHanded?: boolean;
}

export function occupiedEquipmentSlotsForDef(def: EquipmentSlotOccupancyDef | null | undefined): EquipSlot[] {
  if (!def) return [];
  const slots = new Set<EquipSlot>();
  if (isEquipSlot(def.equipSlot)) slots.add(def.equipSlot);
  if (Array.isArray(def.occupiesSlots)) {
    for (const slot of def.occupiesSlots) {
      if (isEquipSlot(slot)) slots.add(slot);
    }
  }
  if (def.twoHanded === true && def.equipSlot === 'weapon') slots.add('shield');
  return [...slots];
}

export function equipmentSlotSetsConflict(a: readonly EquipSlot[], b: readonly EquipSlot[]): boolean {
  for (const slot of a) {
    if (b.includes(slot)) return true;
  }
  return false;
}
