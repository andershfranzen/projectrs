import type { ItemDef, SpellEffectDef } from '@projectrs/shared';
import type { InventoryRemoveResult, Player } from '../entity/Player';

export interface SpellCost {
  itemId: number;
  quantity: number;
  displayName?: string;
}

export interface SpellCostResult {
  ok: boolean;
  message?: string;
  inventoryChanged: boolean;
}

export function getSpellCosts(def: SpellEffectDef): SpellCost[] {
  const byItemId = new Map<number, SpellCost>();
  for (const reagent of def.reagents ?? []) {
    if (reagent.quantity <= 0) continue;
    const existing = byItemId.get(reagent.itemId);
    if (existing) {
      existing.quantity += reagent.quantity;
      existing.displayName ??= reagent.name;
    } else {
      byItemId.set(reagent.itemId, {
        itemId: reagent.itemId,
        quantity: reagent.quantity,
        displayName: reagent.name,
      });
    }
  }
  return [...byItemId.values()];
}

export function consumeSpellCosts(
  player: Player,
  def: SpellEffectDef,
  itemDefs: Map<number, ItemDef>,
): SpellCostResult {
  const costs = getSpellCosts(def);
  if (costs.length === 0) return { ok: true, inventoryChanged: false };

  const missing = findMissingSpellCost(player, costs);
  if (missing) {
    return { ok: false, message: `You need ${formatSpellCost(missing, itemDefs)} to cast this spell.`, inventoryChanged: false };
  }

  const removals: InventoryRemoveResult[] = [];
  for (const cost of costs) {
    const removed = player.removeItemById(cost.itemId, cost.quantity);
    if (removed.completed !== cost.quantity) {
      rollbackSpellCostRemovals(player, removals);
      return { ok: false, message: `You need ${formatSpellCost(cost, itemDefs)} to cast this spell.`, inventoryChanged: false };
    }
    removals.push(removed);
  }

  return { ok: true, inventoryChanged: true };
}

function findMissingSpellCost(
  player: Player,
  costs: SpellCost[],
): SpellCost | null {
  const inventoryCounts = new Map<number, number>();
  for (const slot of player.inventory) {
    if (!slot) continue;
    inventoryCounts.set(slot.itemId, (inventoryCounts.get(slot.itemId) ?? 0) + slot.quantity);
  }

  for (const cost of costs) {
    if ((inventoryCounts.get(cost.itemId) ?? 0) < cost.quantity) return cost;
  }
  return null;
}

function rollbackSpellCostRemovals(player: Player, removals: InventoryRemoveResult[]): void {
  for (let i = removals.length - 1; i >= 0; i--) player.revertRemove(removals[i]);
}

function formatSpellCost(cost: SpellCost, itemDefs: Map<number, ItemDef>): string {
  const name = itemDefs.get(cost.itemId)?.name ?? cost.displayName ?? `item ${cost.itemId}`;
  return `${cost.quantity} ${name}`;
}
