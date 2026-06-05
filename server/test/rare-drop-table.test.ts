import { describe, expect, test } from 'bun:test';
import type { RareDropTableDef } from '@projectrs/shared';
import { rollRareDropTable } from '../src/combat/RareDropTable';

function sequenceRng(values: number[]): () => number {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (value === undefined) throw new Error('RNG sequence exhausted');
    return value;
  };
}

describe('rare drop tables', () => {
  test('empty and missing tables drop nothing', () => {
    const tables = new Map<string, RareDropTableDef>([
      ['empty', { id: 'empty', entries: [] }],
    ]);

    expect(rollRareDropTable('empty', tables, () => 0)).toBeNull();
    expect(rollRareDropTable('missing', tables, () => 0)).toBeNull();
  });

  test('weighted entries can resolve nested subtables', () => {
    const tables = new Map<string, RareDropTableDef>([
      ['universal', {
        id: 'universal',
        entries: [
          { type: 'nothing', weight: 1 },
          { type: 'item', itemId: 10, quantity: 50, weight: 1 },
          { type: 'table', tableId: 'gems', weight: 2 },
        ],
      }],
      ['gems', {
        id: 'gems',
        entries: [
          { type: 'item', itemId: 14, quantity: 1, weight: 1 },
        ],
      }],
    ]);

    expect(rollRareDropTable('universal', tables, sequenceRng([0.75, 0]))).toEqual({ itemId: 14, quantity: 1 });
  });

  test('item quantity ranges are inclusive', () => {
    const tables = new Map<string, RareDropTableDef>([
      ['universal', {
        id: 'universal',
        entries: [
          { type: 'item', itemId: 10, minQuantity: 10, maxQuantity: 12, weight: 1 },
        ],
      }],
    ]);

    expect(rollRareDropTable('universal', tables, sequenceRng([0, 0.999]))).toEqual({ itemId: 10, quantity: 12 });
  });
});
