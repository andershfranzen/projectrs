import type { ObjectRecipe, ItemDef } from '@projectrs/shared';
import { createModalPanel } from './ModalPanel';
import { closeActiveContextMenu } from './popupStyle';
import { renderItemSlot } from '../rendering/ItemIcon';

export type SmithCallback = (recipeIndex: number) => void;

/**
 * Popup panel showing available smithing recipes when interacting with an anvil.
 * Only shows recipes for bar types the player currently holds. When the player
 * holds multiple bar types, first presents a picker to choose which bar to smith.
 */
export class SmithingPanel {
  private container: HTMLDivElement;
  private titleEl: HTMLSpanElement;
  private gridEl: HTMLDivElement;
  private visible: boolean = false;
  private onSmith: SmithCallback | null = null;
  private onCloseCallback: (() => void) | null = null;

  // Cached state for swapping between picker and recipe view
  private allRecipes: ObjectRecipe[] = [];
  private allInventory: ({ itemId: number; quantity: number } | null)[] = [];
  private cachedSmithingLevel: number = 0;
  private cachedHasHammer: boolean = false;
  private cachedItemDefs: Map<number, ItemDef> = new Map();
  // Station-specific labels. Default = "Anvil" / "bars" / requires a hammer
  // (the original anvil-only flow). Furnace passes "Furnace" / "ore" / no
  // hammer warning so the copy reads correctly. Single source of truth so
  // each render path doesn't need to special-case the station type.
  private stationLabel: string = 'Anvil';
  private inputNoun: string = 'bars';
  private requiresTool: boolean = true;

  constructor() {
    const modal = createModalPanel({
      id: 'smithing-panel',
      title: 'Smithing',
      geometry: { kind: 'canvas', widthFrac: 0.3 },
      chrome: 'stone',
      onClose: () => this.hide(),
    });
    this.container = modal.root;
    this.titleEl = modal.title;

    // Recipe grid — flex:1 so it fills available vertical space;
    // overflow-y:auto is a last-resort scroll only if content can't fit on very small clients
    this.gridEl = document.createElement('div');
    this.gridEl.style.cssText = 'padding: 10px; overflow-y: auto; flex: 1 1 auto; min-height: 0;';
    this.container.appendChild(this.gridEl);

    document.body.appendChild(this.container);
  }

  show(
    recipes: ObjectRecipe[],
    inventory: ({ itemId: number; quantity: number } | null)[],
    smithingLevel: number,
    hasHammer: boolean,
    itemDefs: Map<number, ItemDef>,
    onSmith: SmithCallback,
    opts?: { stationLabel?: string; inputNoun?: string; requiresTool?: boolean },
  ): void {
    closeActiveContextMenu();
    this.onSmith = onSmith;
    this.allRecipes = recipes;
    this.allInventory = inventory;
    this.cachedSmithingLevel = smithingLevel;
    this.cachedHasHammer = hasHammer;
    this.cachedItemDefs = itemDefs;
    this.stationLabel = opts?.stationLabel ?? 'Anvil';
    this.inputNoun = opts?.inputNoun ?? 'bars';
    this.requiresTool = opts?.requiresTool ?? true;

    // Which bar types does the player actually hold?
    const itemCounts = this.countInventory(inventory);
    const availableBarIds = new Set<number>();
    for (const r of recipes) {
      if ((itemCounts.get(r.inputItemId) ?? 0) > 0) availableBarIds.add(r.inputItemId);
    }

    this.container.style.display = 'flex';
    this.visible = true;

    if (availableBarIds.size === 0) {
      // Player has no bars at all — show empty state
      this.renderEmptyState(hasHammer);
    } else if (availableBarIds.size === 1) {
      // Single bar type — skip picker, show recipes directly
      const [barId] = availableBarIds;
      this.renderRecipesForBar(barId);
    } else {
      // Multiple bar types — show picker first
      this.renderBarPicker(availableBarIds);
    }
  }

  private countInventory(inventory: ({ itemId: number; quantity: number } | null)[]): Map<number, number> {
    const counts = new Map<number, number>();
    for (const slot of inventory) {
      if (slot) counts.set(slot.itemId, (counts.get(slot.itemId) ?? 0) + slot.quantity);
    }
    return counts;
  }

  private renderBarPicker(availableBarIds: Set<number>): void {
    this.titleEl.textContent = `${this.stationLabel} — Choose your input`;
    this.gridEl.innerHTML = '';
    const itemCounts = this.countInventory(this.allInventory);

    for (const barId of availableBarIds) {
      const barDef = this.cachedItemDefs.get(barId);
      const barName = barDef?.name ?? `Item ${barId}`;
      const barCount = itemCounts.get(barId) ?? 0;

      const row = document.createElement('div');
      row.style.cssText = `
        display: flex; align-items: center; gap: 10px;
        padding: 8px 10px; margin: 4px 0; border-radius: 3px;
        background: #222; border: 1px solid #444; cursor: pointer;
        transition: background 0.1s;
      `;

      const icon = document.createElement('div');
      icon.style.cssText = 'width: 32px; height: 32px; flex-shrink: 0;';
      if (barDef) {
        renderItemSlot(icon, barDef, this.cachedItemDefs, { size: 32 });
      } else {
        icon.style.background = '#333';
        icon.style.borderRadius = '3px';
      }
      row.appendChild(icon);

      const label = document.createElement('div');
      label.style.cssText = 'flex: 1; font-size: 13px; color: #ddd;';
      label.textContent = `${barName} — ${barCount} in inventory`;
      row.appendChild(label);

      row.addEventListener('mouseenter', () => { row.style.background = '#2a3a2a'; row.style.borderColor = '#5a8855'; });
      row.addEventListener('mouseleave', () => { row.style.background = '#222'; row.style.borderColor = '#444'; });
      row.addEventListener('click', () => this.renderRecipesForBar(barId));

      this.gridEl.appendChild(row);
    }
  }

  private renderRecipesForBar(barId: number): void {
    const barDef = this.cachedItemDefs.get(barId);
    const barName = barDef?.name ?? `Item ${barId}`;
    const itemCounts = this.countInventory(this.allInventory);
    const barCount = itemCounts.get(barId) ?? 0;

    this.titleEl.textContent = `${this.stationLabel} — ${barName}`;
    this.gridEl.innerHTML = '';

    // Back button if we came from the picker (i.e. player has multiple bar types)
    const availableBarCount = new Set(
      this.allRecipes
        .map((r) => r.inputItemId)
        .filter((id) => (itemCounts.get(id) ?? 0) > 0),
    ).size;
    if (availableBarCount > 1) {
      const backBtn = document.createElement('button');
      // Generic copy avoids a brittle pluralization rule for `inputNoun` and
      // reads naturally for both anvil ("bars" → "← Back to bars") and
      // furnace ("ore" → "← Back to ore"). Naming the station in the button
      // also helps when the panel was opened via right-click from somewhere
      // the player isn't physically next to the station.
      backBtn.textContent = `← Back to ${this.inputNoun}`;
      backBtn.style.cssText = `
        background: linear-gradient(180deg, #3a2518 0%, #2a1810 100%);
        border: 1px solid #5a4a35; color: #d8372b; cursor: pointer;
        padding: 4px 10px; margin-bottom: 6px; border-radius: 3px;
        font-family: Arial, Helvetica, sans-serif; font-size: 11px;
      `;
      backBtn.onclick = () => {
        const available = new Set<number>();
        for (const r of this.allRecipes) {
          if ((itemCounts.get(r.inputItemId) ?? 0) > 0) available.add(r.inputItemId);
        }
        this.renderBarPicker(available);
      };
      this.gridEl.appendChild(backBtn);
    }

    const sectionHeader = document.createElement('div');
    sectionHeader.style.cssText = `
      padding: 4px 8px; margin-bottom: 8px; font-size: 12px; font-weight: bold;
      color: #d8372b; border-bottom: 1px solid #333;
    `;
    sectionHeader.textContent = `${barName} (${barCount} in inventory)`;
    this.gridEl.appendChild(sectionHeader);

    // Grid: auto-fill tiles that reflow to viewport
    const grid = document.createElement('div');
    grid.style.cssText = `
      display: grid; gap: 5px;
      grid-template-columns: repeat(auto-fill, minmax(82px, 1fr));
    `;

    // Tool check is constant across every recipe in this view — lift it out
    // of the per-tile loop. Furnaces (requiresTool === false) short-circuit
    // to true; anvils require the hammer to be in inventory.
    const toolOk = !this.requiresTool || this.cachedHasHammer;

    this.allRecipes.forEach((recipe, index) => {
      if (recipe.inputItemId !== barId) return;

      const outputDef = this.cachedItemDefs.get(recipe.outputItemId);
      const outputName = outputDef?.name ?? `Item ${recipe.outputItemId}`;
      const hasLevel = this.cachedSmithingLevel >= recipe.levelRequired;
      const hasBars = barCount >= recipe.inputQuantity;
      // Furnace recipes also have a secondInputItemId (coal, etc.). Without
      // it the auto-pick path would fall to a downstream recipe (e.g. coal-less
      // iron at 50%) — surface that in the picker by greying steel/mithril
      // tiles when coal isn't present, so the player understands why a
      // tile they "could" click might not produce what they expect.
      const hasSecondInput = recipe.secondInputItemId === undefined
        || (itemCounts.get(recipe.secondInputItemId) ?? 0) >= (recipe.secondInputQuantity ?? 1);
      const canSmith = hasLevel && hasBars && hasSecondInput && toolOk;

      const tile = document.createElement('div');
      tile.style.cssText = `
        position: relative;
        display: flex; flex-direction: column; align-items: center;
        padding: 6px 4px 5px; border-radius: 3px;
        background: ${canSmith ? '#222' : '#1a1a1a'};
        border: 1px solid ${canSmith ? '#444' : '#2a2a2a'};
        opacity: ${canSmith ? '1' : '0.5'};
        cursor: ${canSmith ? 'pointer' : 'default'};
        transition: background 0.1s, border-color 0.1s;
      `;
      tile.title = `${outputName} — ${recipe.inputQuantity} ${barName}${recipe.inputQuantity > 1 ? 's' : ''}, Lv ${recipe.levelRequired}`;

      // Icon — 48px, readable at normal zoom
      if (outputDef) {
        const iconBox = document.createElement('div');
        iconBox.style.cssText = 'width: 48px; height: 48px; margin-bottom: 3px;';
        renderItemSlot(iconBox, outputDef, this.cachedItemDefs, { size: 48 });
        tile.appendChild(iconBox);
      }

      // Short name — strip the bar-type prefix (e.g. "Bronze Dagger" → "Dagger")
      const shortName = outputName.replace(
        /^(Bronze|Iron|Steel|Mithril|Black Bronze|Silver)\s+/i,
        '',
      );
      const nameEl = document.createElement('div');
      nameEl.style.cssText = `
        font-size: 11px; line-height: 1.2; text-align: center;
        color: ${canSmith ? '#ddd' : '#777'};
        max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      `;
      nameEl.textContent = shortName;
      tile.appendChild(nameEl);

      // Level badge corner
      const lvlBadge = document.createElement('div');
      lvlBadge.style.cssText = `
        position: absolute; top: 2px; right: 4px;
        font-size: 10px; line-height: 1; font-weight: bold;
        color: ${hasLevel ? '#88a' : '#c66'};
        text-shadow: 1px 1px 0 #000;
      `;
      lvlBadge.textContent = `${recipe.levelRequired}`;
      tile.appendChild(lvlBadge);

      if (canSmith) {
        tile.addEventListener('mouseenter', () => { tile.style.background = '#2a3a2a'; tile.style.borderColor = '#5a8855'; });
        tile.addEventListener('mouseleave', () => { tile.style.background = '#222'; tile.style.borderColor = '#444'; });
        tile.addEventListener('click', () => {
          this.onSmith?.(index);
          this.hide();
        });
      }

      grid.appendChild(tile);
    });

    this.gridEl.appendChild(grid);

    if (this.requiresTool && !this.cachedHasHammer) {
      const warn = document.createElement('div');
      warn.style.cssText = 'padding: 8px 12px; font-size: 12px; color: #c44; text-align: center; margin-top: 8px;';
      warn.textContent = 'You need a hammer in your inventory to smith.';
      this.gridEl.appendChild(warn);
    }
  }

  private renderEmptyState(hasHammer: boolean): void {
    this.titleEl.textContent = this.stationLabel;
    this.gridEl.innerHTML = '';
    const msg = document.createElement('div');
    msg.style.cssText = 'padding: 24px 12px; font-size: 13px; color: #aaa; text-align: center;';
    msg.textContent = `You have no ${this.inputNoun} to use here.`;
    this.gridEl.appendChild(msg);
    if (this.requiresTool && !hasHammer) {
      const warn = document.createElement('div');
      warn.style.cssText = 'padding: 8px 12px; font-size: 12px; color: #c44; text-align: center;';
      warn.textContent = 'You also need a hammer to smith.';
      this.gridEl.appendChild(warn);
    }
  }

  hide(): void {
    this.container.style.display = 'none';
    this.visible = false;
    this.onSmith = null;
    this.onCloseCallback?.();
  }

  isVisible(): boolean {
    return this.visible;
  }

  setOnClose(cb: (() => void) | null): void {
    this.onCloseCallback = cb;
  }
}
