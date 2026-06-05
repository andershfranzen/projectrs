import type { RareDropTableDef, RareDropTableEntry, RareDropItemEntry } from '@projectrs/shared';

export interface RolledLootDrop {
  itemId: number;
  quantity: number;
  rare?: true;
  source?: 'rare_drop_table';
  rareTableId?: string;
  rareAccessTableId?: string;
}

const MAX_RARE_DROP_TABLE_DEPTH = 8;

function clampRng(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1 - Number.EPSILON;
  return value;
}

function entryWeight(entry: RareDropTableEntry): number {
  return Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 0;
}

function rollQuantity(entry: RareDropItemEntry, rng: () => number): number {
  if (Number.isFinite(entry.quantity) && entry.quantity !== undefined) {
    return Math.max(1, Math.floor(entry.quantity));
  }

  const min = Number.isFinite(entry.minQuantity) ? Math.floor(entry.minQuantity ?? 1) : 1;
  const max = Number.isFinite(entry.maxQuantity) ? Math.floor(entry.maxQuantity ?? min) : min;
  const low = Math.max(1, min);
  const high = Math.max(low, max);
  if (high === low) return low;
  return low + Math.floor(clampRng(rng()) * (high - low + 1));
}

export function rollRareDropTable(
  tableId: string,
  tables: ReadonlyMap<string, RareDropTableDef>,
  rng: () => number = Math.random,
  depth: number = 0,
): RolledLootDrop | null {
  if (depth > MAX_RARE_DROP_TABLE_DEPTH) return null;

  const table = tables.get(tableId);
  if (!table || !Array.isArray(table.entries) || table.entries.length === 0) return null;

  const totalWeight = table.entries.reduce((total, entry) => total + entryWeight(entry), 0);
  if (totalWeight <= 0) return null;

  let roll = clampRng(rng()) * totalWeight;
  let selected: RareDropTableEntry | null = null;
  for (const entry of table.entries) {
    const weight = entryWeight(entry);
    if (weight <= 0) continue;
    if (roll < weight) {
      selected = entry;
      break;
    }
    roll -= weight;
  }
  selected ??= table.entries[table.entries.length - 1] ?? null;
  if (!selected) return null;

  switch (selected.type) {
    case 'item':
      return {
        itemId: selected.itemId,
        quantity: rollQuantity(selected, rng),
        rare: true,
        source: 'rare_drop_table',
        rareTableId: tableId,
      };
    case 'table':
      return rollRareDropTable(selected.tableId, tables, rng, depth + 1);
    case 'nothing':
      return null;
  }
}
