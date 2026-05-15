import { INVENTORY_SIZE, ClientOpcode, encodePacket } from '@projectrs/shared';
import type { ItemDef } from '@projectrs/shared';
import type { NetworkManager } from '../managers/NetworkManager';
import { createContextMenu } from './popupStyle';

export interface InventorySlotData {
  itemId: number;
  quantity: number;
}

export class InventoryPanel {
  private container: HTMLDivElement;
  private slots: (InventorySlotData | null)[] = new Array(INVENTORY_SIZE).fill(null);
  private slotElements: HTMLDivElement[] = [];
  private network: NetworkManager;
  private visible: boolean = true;
  private itemDefs: Map<number, ItemDef> = new Map();

  constructor(network: NetworkManager) {
    this.network = network;
    this.container = this.buildUI();
    document.body.appendChild(this.container);
  }

  setItemDefs(defs: Map<number, ItemDef>): void {
    this.itemDefs = defs;
    // Re-render all slots to apply sprites
    for (let i = 0; i < this.slots.length; i++) this.renderSlot(i);
  }

  private buildUI(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'inventory-panel';
    panel.style.cssText = `
      position: fixed; right: 10px; bottom: 10px;
      width: 204px;
      background:
        repeating-linear-gradient(0deg, rgba(196, 126, 70, 0.035) 0 1px, transparent 1px 4px),
        repeating-linear-gradient(90deg, rgba(0, 0, 0, 0.22) 0 1px, transparent 1px 5px),
        repeating-linear-gradient(45deg, rgba(138, 74, 42, 0.05) 0 2px, transparent 2px 10px),
        linear-gradient(180deg, #2c180f 0%, #1f100a 50%, #120806 100%);
      border-top: 2px solid #6f4227;
      border-left: 2px solid #5c341f;
      border-right: 2px solid #160b06;
      border-bottom: 2px solid #120804;
      border-radius: 2px;
      padding: 3px; z-index: 100;
      font-family: Arial, Helvetica, sans-serif; color: #ddd;
      box-shadow: inset 2px 2px 0 rgba(160, 88, 48, 0.13), inset -2px -2px 0 rgba(0,0,0,0.5), 2px 2px 0 rgba(0,0,0,0.45);
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      text-align: center; padding: 3px; margin-bottom: 3px;
      border-bottom: 1px solid #5a4a35; color: #d8372b;
      font-size: 13px; font-weight: bold;
    `;
    header.textContent = 'Inventory';
    panel.appendChild(header);

    // Grid — 4 columns x 7 rows = 28 slots
    const grid = document.createElement('div');
    grid.style.cssText = `
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 2px;
    `;

    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const slot = document.createElement('div');
      slot.style.cssText = `
        width: 46px; height: 46px;
        background: rgba(0, 0, 0, 0.06);
        border: 1px solid rgba(43, 24, 16, 0.58);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        cursor: pointer; font-size: 10px;
        position: relative;
      `;

      // Right-click to drop/equip
      slot.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.onSlotRightClick(i, e);
      });

      // Left-click to use
      slot.addEventListener('click', () => {
        this.onSlotClick(i);
      });

      grid.appendChild(slot);
      this.slotElements.push(slot);
    }

    panel.appendChild(grid);
    return panel;
  }

  updateSlot(index: number, itemId: number, quantity: number): void {
    if (index < 0 || index >= INVENTORY_SIZE) return;

    if (itemId === 0) {
      this.slots[index] = null;
    } else {
      this.slots[index] = { itemId, quantity };
    }

    this.renderSlot(index);
  }

  private renderSlot(index: number): void {
    const el = this.slotElements[index];
    const slot = this.slots[index];

    if (!slot) {
      el.innerHTML = '';
      el.style.borderColor = '#3a3025';
      return;
    }

    const def = this.itemDefs.get(slot.itemId);
    const name = def?.name || `Item ${slot.itemId}`;
    const sprite = def?.sprite;
    const icon = def?.icon;

    const iconHtml = sprite
      ? `<img src="/sprites/items/${sprite}" style="width:28px;height:28px;image-rendering:pixelated;object-fit:contain;" />`
      : icon
      ? `<img src="/items/${icon}" style="width:28px;height:28px;image-rendering:pixelated;object-fit:contain;" />`
      : `<div style="width:24px;height:24px;background:#aaa;border-radius:3px;"></div>`;

    el.innerHTML = `
      ${iconHtml}
      <div style="font-size: 9px; color: #ccc; text-align: center; line-height: 1;">${name.length > 10 ? name.substring(0, 9) + '..' : name}</div>
      ${slot.quantity > 1 ? `<div style="position: absolute; top: 1px; left: 3px; font-size: 9px; color: #fd0;">${slot.quantity}</div>` : ''}
    `;
    el.style.borderColor = '#5a4a35';
  }

  private onSlotClick(index: number): void {
    const [firstOption] = this.getSlotOptions(index);
    firstOption?.action();
  }

  private onSlotRightClick(index: number, event: MouseEvent): void {
    const options = this.getSlotOptions(index);
    if (options.length === 0) return;

    createContextMenu(options, {
      x: event.clientX,
      y: event.clientY,
      itemPadding: '3px 10px',
    });
  }

  private getSlotOptions(index: number): { label: string; action: () => void }[] {
    const slot = this.slots[index];
    if (!slot) return [];

    const def = this.itemDefs.get(slot.itemId);
    const name = def?.name || 'Item';
    const options: { label: string; action: () => void }[] = [];

    if (def?.equippable) {
      options.push({
        label: `Equip ${name}`,
        action: () => {
          this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EQUIP_ITEM, index, slot.itemId));
        },
      });
    }

    if (def?.healAmount) {
      options.push({
        label: `Eat ${name}`,
        action: () => {
          this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EAT_ITEM, index, slot.itemId));
        },
      });
    }

    options.push({
      label: `Drop ${name}`,
      action: () => {
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_DROP_ITEM, index, slot.itemId));
      },
    });

    return options;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';
  }
}
