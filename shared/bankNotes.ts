import type { ItemDef } from './types';

export const BANK_NOTE_TEMPLATE_ITEM_ID = 440;
export const GENERATED_BANK_NOTE_ID_OFFSET = 20000;
export const BANK_NOTE_MODEL = '/assets/models/BankNote.glb';

export function generatedBankNoteId(itemId: number): number {
  return GENERATED_BANK_NOTE_ID_OFFSET + itemId;
}

export function isNotedItem(def: Pick<ItemDef, 'unnotedId'> | null | undefined): def is ItemDef & { unnotedId: number } {
  return typeof def?.unnotedId === 'number' && Number.isInteger(def.unnotedId) && def.unnotedId > 0;
}

export function canonicalBankItemId(itemId: number, itemDefs: Map<number, ItemDef>): number {
  const def = itemDefs.get(itemId);
  return isNotedItem(def) ? def.unnotedId : itemId;
}

export function isNoteableItem(def: ItemDef | null | undefined): def is ItemDef & { noteId: number } {
  return !!def && def.noteable === true && typeof def.noteId === 'number' && Number.isInteger(def.noteId);
}

export function noteIdForItem(itemId: number, itemDefs: Map<number, ItemDef>): number | null {
  const canonicalId = canonicalBankItemId(itemId, itemDefs);
  const def = itemDefs.get(canonicalId);
  return isNoteableItem(def) ? def.noteId : null;
}

function shouldGenerateBankNote(def: ItemDef): boolean {
  if (def.id === BANK_NOTE_TEMPLATE_ITEM_ID) return false;
  if (isNotedItem(def)) return false;
  if (def.stackable) return false;
  return def.noteable !== false;
}

function makeNoteDef(def: ItemDef, noteId: number): ItemDef {
  return {
    id: noteId,
    name: `${def.name} Note`,
    description: `Swap this note at any bank for ${def.name}.`,
    stackable: true,
    noteable: false,
    unnotedId: def.id,
    equippable: false,
    value: def.value,
    model: BANK_NOTE_MODEL,
  };
}

export function withGeneratedBankNotes(defs: readonly ItemDef[]): ItemDef[] {
  const out = defs.map(def => ({ ...def }));
  const usedIds = new Set(out.map(def => def.id));
  for (const def of out) {
    if (isNotedItem(def)) continue;
    if (!shouldGenerateBankNote(def)) continue;
    const noteId = def.noteId ?? generatedBankNoteId(def.id);
    if (noteId <= 0 || noteId > 32767) {
      throw new Error(`Generated bank note id ${noteId} for item ${def.id} is outside int16 protocol range`);
    }
    if (usedIds.has(noteId)) {
      throw new Error(`Bank note id ${noteId} for item ${def.id} collides with an existing item id`);
    }
    def.noteable = true;
    def.noteId = noteId;
    usedIds.add(noteId);
    out.push(makeNoteDef(def, noteId));
  }
  return out;
}
