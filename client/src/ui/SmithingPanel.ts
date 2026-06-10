import type { ObjectRecipe, ItemDef } from '@projectrs/shared';
import { createModalPanel } from './ModalPanel';
import { closeActiveContextMenu } from './popupStyle';
import { renderItemSlot } from '../rendering/ItemIcon';

export type RecipeQuantityButton = { label: string; value: number | 'all' };
export type SmithCallback = (recipeIndex: number, quantity?: number) => void;
export type FlatRecipeEntry<TRecipe extends Pick<ObjectRecipe, 'inputItemId'> = ObjectRecipe> = {
  recipe: TRecipe;
  index: number;
  maxQuantity: number;
};

export interface SmithingPanelOptions {
  stationLabel?: string;
  inputNoun?: string;
  requiresTool?: boolean;
  layout?: 'grouped' | 'flat';
  actionButtons?: RecipeQuantityButton[];
  actionVerb?: string;
  primaryRecipePerInput?: boolean;
}

export function primaryRecipeEntriesPerInput<TEntry extends FlatRecipeEntry<Pick<ObjectRecipe, 'inputItemId'>>>(
  entries: readonly TEntry[],
): TEntry[] {
  const seenInputIds = new Set<number>();
  return entries.filter(({ recipe }) => {
    if (seenInputIds.has(recipe.inputItemId)) return false;
    seenInputIds.add(recipe.inputItemId);
    return true;
  });
}

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
  private layout: 'grouped' | 'flat' = 'grouped';
  private actionButtons: RecipeQuantityButton[] = [];
  private actionVerb: string = 'Make';
  private primaryRecipePerInput: boolean = false;

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
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.visible) return;
      event.preventDefault();
      event.stopPropagation();
      this.hide();
    });
  }

  show(
    recipes: ObjectRecipe[],
    inventory: ({ itemId: number; quantity: number } | null)[],
    smithingLevel: number,
    hasHammer: boolean,
    itemDefs: Map<number, ItemDef>,
    onSmith: SmithCallback,
    opts?: SmithingPanelOptions,
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
    this.layout = opts?.layout ?? 'grouped';
    this.actionButtons = [...(opts?.actionButtons ?? [])];
    this.actionVerb = opts?.actionVerb ?? 'Make';
    this.primaryRecipePerInput = opts?.primaryRecipePerInput ?? false;

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
    } else if (this.layout === 'flat') {
      this.renderFlatRecipeList();
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

  private maxQuantityForRecipe(recipe: ObjectRecipe, itemCounts: Map<number, number>): number {
    const primary = Math.floor((itemCounts.get(recipe.inputItemId) ?? 0) / Math.max(1, recipe.inputQuantity));
    if (recipe.secondInputItemId === undefined) return primary;
    const secondary = Math.floor(
      (itemCounts.get(recipe.secondInputItemId) ?? 0) / Math.max(1, recipe.secondInputQuantity ?? 1),
    );
    return Math.min(primary, secondary);
  }

  private itemRequirementLabel(itemId: number, quantity: number): string {
    const itemName = this.cachedItemDefs.get(itemId)?.name ?? `Item ${itemId}`;
    return quantity > 1 ? `${itemName} x${quantity}` : itemName;
  }

  private recipeRequirementLabel(recipe: ObjectRecipe): string {
    const parts = [
      this.itemRequirementLabel(recipe.inputItemId, Math.max(1, recipe.inputQuantity)),
    ];
    if (recipe.secondInputItemId !== undefined) {
      parts.push(this.itemRequirementLabel(recipe.secondInputItemId, Math.max(1, recipe.secondInputQuantity ?? 1)));
    }
    return parts.join(' + ');
  }

  private renderFlatRecipeList(): void {
    this.titleEl.textContent = this.stationLabel;
    this.gridEl.innerHTML = '';
    const itemCounts = this.countInventory(this.allInventory);
    const toolOk = !this.requiresTool || this.cachedHasHammer;
    let visibleRecipes = this.allRecipes
      .map((recipe, index) => ({
        recipe,
        index,
        maxQuantity: this.maxQuantityForRecipe(recipe, itemCounts),
      }))
      .filter(({ maxQuantity }) => maxQuantity > 0);

    if (this.primaryRecipePerInput) {
      visibleRecipes = primaryRecipeEntriesPerInput(visibleRecipes);
    }

    if (visibleRecipes.length === 0) {
      this.renderEmptyState(this.cachedHasHammer);
      return;
    }

    const grid = document.createElement('div');
    grid.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
      gap: 8px;
      align-items: stretch;
    `;

    visibleRecipes.forEach(({ recipe, index, maxQuantity }) => {
      const inputDef = this.cachedItemDefs.get(recipe.inputItemId);
      const outputDef = this.cachedItemDefs.get(recipe.outputItemId);
      const inputName = inputDef?.name ?? `Item ${recipe.inputItemId}`;
      const outputName = outputDef?.name ?? `Item ${recipe.outputItemId}`;
      const outputLabel = recipe.outputQuantity > 1 ? `${outputName} x${recipe.outputQuantity}` : outputName;
      const requirementLabel = this.recipeRequirementLabel(recipe);
      const hasLevel = this.cachedSmithingLevel >= recipe.levelRequired;
      const hasSecondInput = recipe.secondInputItemId === undefined
        || (itemCounts.get(recipe.secondInputItemId) ?? 0) >= (recipe.secondInputQuantity ?? 1);
      const canMake = hasLevel && maxQuantity > 0 && hasSecondInput && toolOk;

      const card = document.createElement('div');
      card.style.cssText = `
        position: relative;
        min-height: 172px;
        display: flex;
        flex-direction: column;
        gap: 7px;
        padding: 9px;
        box-sizing: border-box;
        border-radius: 4px;
        background:
          linear-gradient(180deg, rgba(42, 34, 28, 0.92), rgba(22, 17, 14, 0.96)),
          url('/ui/stone-dark.png') repeat;
        border: 1px solid ${canMake ? '#6f604b' : '#3d342b'};
        box-shadow: inset 0 1px 0 rgba(235, 205, 160, 0.08), 0 1px 0 rgba(0,0,0,0.55);
        opacity: ${canMake ? '1' : '0.62'};
      `;
      card.title = `${outputLabel} — ${requirementLabel}, Lv ${recipe.levelRequired}`;

      const media = document.createElement('div');
      media.style.cssText = 'display: grid; grid-template-columns: 42px 1fr 42px; align-items: center; gap: 7px; min-height: 44px;';

      const inputIcon = document.createElement('div');
      inputIcon.style.cssText = 'width: 42px; height: 42px;';
      if (inputDef) renderItemSlot(inputIcon, inputDef, this.cachedItemDefs, { size: 42 });
      media.appendChild(inputIcon);

      const arrow = document.createElement('div');
      arrow.style.cssText = 'height: 1px; background: #6f604b; position: relative;';
      const arrowHead = document.createElement('div');
      arrowHead.style.cssText = `
        position: absolute; right: -1px; top: -4px;
        width: 0; height: 0;
        border-top: 4px solid transparent;
        border-bottom: 4px solid transparent;
        border-left: 7px solid #6f604b;
      `;
      arrow.appendChild(arrowHead);
      media.appendChild(arrow);

      const outputIcon = document.createElement('div');
      outputIcon.style.cssText = 'width: 42px; height: 42px;';
      if (outputDef) renderItemSlot(outputIcon, outputDef, this.cachedItemDefs, { size: 42 });
      media.appendChild(outputIcon);
      card.appendChild(media);

      const title = document.createElement('div');
      title.style.cssText = `
        min-height: 30px;
        color: ${canMake ? '#f0ddd0' : '#9c8c81'};
        font-size: 12px;
        font-weight: bold;
        line-height: 1.25;
        text-align: center;
        overflow: hidden;
      `;
      title.textContent = outputLabel;
      card.appendChild(title);

      const detail = document.createElement('div');
      detail.style.cssText = `
        min-height: 28px;
        color: ${canMake ? '#c7b9a6' : '#81746a'};
        font-size: 11px;
        line-height: 1.25;
        text-align: center;
      `;
      const held = itemCounts.get(recipe.inputItemId) ?? 0;
      detail.textContent = `${inputName}: ${held} held`;
      card.appendChild(detail);

      const levelBadge = document.createElement('div');
      levelBadge.style.cssText = `
        position: absolute;
        top: 5px;
        right: 7px;
        color: ${hasLevel ? '#b8c792' : '#d68a7d'};
        font-size: 10px;
        font-weight: bold;
        text-shadow: 1px 1px 0 #000;
      `;
      levelBadge.textContent = `Lv ${recipe.levelRequired}`;
      card.appendChild(levelBadge);

      if (!canMake) {
        const reason = document.createElement('div');
        reason.style.cssText = 'min-height: 18px; color: #c38377; font-size: 11px; text-align: center; font-weight: bold;';
        if (!hasLevel) reason.textContent = `Need level ${recipe.levelRequired}`;
        else if (!toolOk) reason.textContent = 'Missing tool';
        else reason.textContent = `No ${inputName}`;
        card.appendChild(reason);
      }

      const buttonRow = document.createElement('div');
      const buttonColumnCount = Math.max(1, this.actionButtons.length);
      buttonRow.style.cssText = `display: grid; grid-template-columns: repeat(${buttonColumnCount}, minmax(0, 1fr)); gap: 4px; margin-top: auto;`;

      for (const amount of this.actionButtons) {
        const requested = amount.value === 'all' ? maxQuantity : Math.min(Math.floor(amount.value), maxQuantity);
        const enabled = canMake && requested > 0 && (amount.value === 'all' || maxQuantity >= amount.value);
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = amount.label;
        button.title = enabled ? `${this.actionVerb} ${requested}` : '';
        button.disabled = !enabled;
        button.style.cssText = `
          height: 25px;
          min-width: 0;
          padding: 2px 3px;
          box-sizing: border-box;
          border-radius: 3px;
          border: 1px solid ${enabled ? '#8a6f47' : '#3b332b'};
          background: ${enabled ? 'linear-gradient(180deg, #553821 0%, #2d1d14 100%)' : 'rgba(20, 17, 15, 0.85)'};
          color: ${enabled ? '#f2d6b8' : '#6e6258'};
          cursor: ${enabled ? 'pointer' : 'default'};
          font-family: Arial, Helvetica, sans-serif;
          font-size: 11px;
          font-weight: bold;
          text-shadow: 1px 1px 0 #000;
          overflow: hidden;
        `;
        if (enabled) {
          button.addEventListener('mouseenter', () => { button.style.background = 'linear-gradient(180deg, #704726 0%, #3a2518 100%)'; });
          button.addEventListener('mouseleave', () => { button.style.background = 'linear-gradient(180deg, #553821 0%, #2d1d14 100%)'; });
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.onSmith?.(index, amount.value === 'all' ? -1 : requested);
            this.hide();
          });
        }
        buttonRow.appendChild(button);
      }

      if (this.actionButtons.length > 0) card.appendChild(buttonRow);
      grid.appendChild(card);
    });

    this.gridEl.appendChild(grid);
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
      const outputLabel = recipe.outputQuantity > 1 ? `${recipe.outputQuantity} ${outputName}` : outputName;
      const requirementLabel = this.recipeRequirementLabel(recipe);
      const hasLevel = this.cachedSmithingLevel >= recipe.levelRequired;
      const hasBars = barCount >= recipe.inputQuantity;
      // Furnace recipes also have a secondInputItemId (coal, etc.). Without
      // it the auto-pick path would fall to a downstream recipe (e.g. coal-less
      // iron at 50%) — surface that in the picker by greying steel/black bronze
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
      tile.title = `${outputLabel} — ${requirementLabel}, Lv ${recipe.levelRequired}`;

      // Icon — 48px, readable at normal zoom
      if (outputDef) {
        const iconBox = document.createElement('div');
        iconBox.style.cssText = 'width: 48px; height: 48px; margin-bottom: 3px;';
        renderItemSlot(iconBox, outputDef, this.cachedItemDefs, { size: 48 });
        tile.appendChild(iconBox);
      }

      // Short name — strip the bar-type prefix (e.g. "Bronze Dagger" → "Dagger")
      const shortName = outputName.replace(
        /^(Bronze|Iron|Steel|Black Bronze|Mithril|Crimson|Malachor|Silver)\s+/i,
        '',
      );
      const nameEl = document.createElement('div');
      nameEl.style.cssText = `
        font-size: 11px; line-height: 1.2; text-align: center;
        color: ${canSmith ? '#ddd' : '#777'};
        max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      `;
      nameEl.textContent = recipe.outputQuantity > 1 ? `${shortName} x${recipe.outputQuantity}` : shortName;
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
