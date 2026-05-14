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
      width: 204px; background: rgba(30, 25, 18, 0.92);
      border: 2px solid #5a4a35; border-radius: 4px;
      padding: 6px; z-index: 100;
      font-family: Arial, Helvetica, sans-serif; color: #ddd;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      text-align: center; padding: 4px; margin-bottom: 4px;
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
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid #3a3025;
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
    const slot = this.slots[index];
    if (!slot) return;
    // TODO: Use item (eat food, etc.)
  }

  private onSlotRightClick(index: number, event: MouseEvent): void {
    const slot = this.slots[index];
    if (!slot) return;

    const def = this.itemDefs.get(slot.itemId);
    const name = def?.name || 'Item';

    const options: { label: string; action: () => void }[] = [
      {
        label: `Drop ${name}`,
        action: () => {
          this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_DROP_ITEM, index, slot.itemId));
        },
      },
    ];

    if (def?.equippable) {
      options.unshift({
        label: `Equip ${name}`,
        action: () => {
          this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EQUIP_ITEM, index, slot.itemId));
        },
      });
    }

    if (def?.healAmount) {
      options.unshift({
        label: `Eat ${name}`,
        action: () => {
          this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EAT_ITEM, index, slot.itemId));
        },
      });
    }

    createContextMenu(options, {
      x: event.clientX,
      y: event.clientY,
      itemPadding: '3px 10px',
    });
  }

  toggle(): void {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';
  }
}
