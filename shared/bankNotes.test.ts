import { describe, expect, test } from 'bun:test';
import {
  canonicalBankItemId,
  generatedBankNoteId,
  noteIdForItem,
  withGeneratedBankNotes,
  type ItemDef,
} from './index';

function item(id: number, name: string, stackable = false): ItemDef {
  return {
    id,
    name,
    description: name,
    stackable,
    equippable: false,
    value: id,
  };
}

describe('bank note definitions', () => {
  test('generates stackable noted variants for unstackable items', () => {
    const defs = withGeneratedBankNotes([
      item(10, 'Coins', true),
      item(411, 'Green Cape'),
    ]);
    const map = new Map(defs.map(def => [def.id, def]));
    const noteId = generatedBankNoteId(411);

    expect(map.get(411)?.noteable).toBe(true);
    expect(map.get(411)?.noteId).toBe(noteId);
    expect(map.get(noteId)).toMatchObject({
      id: noteId,
      name: 'Green Cape Note',
      stackable: true,
      equippable: false,
      unnotedId: 411,
      value: 411,
      model: '/assets/models/BankNote.glb',
    });
    expect(noteIdForItem(411, map)).toBe(noteId);
    expect(canonicalBankItemId(noteId, map)).toBe(411);
    expect(noteIdForItem(10, map)).toBeNull();
  });
});
