import { ClientOpcode, encodePacket, type ItemDef } from '@projectrs/shared';
import { renderItemSlot } from '../rendering/ItemIcon';
import type { NetworkManager } from '../managers/NetworkManager';
import { createModalPanel } from './ModalPanel';
import { closeActiveContextMenu } from './popupStyle';

export interface ShopItem {
  itemId: number;
  price: number;
  stock: number;
}

export class ShopPanel {
  private container: HTMLDivElement;
  private network: NetworkManager;
  private itemDefs: Map<number, ItemDef>;
  private items: ShopItem[] = [];
  private visible: boolean = false;
  private shopNpcId: number = -1;
  private gridEl: HTMLDivElement | null = null;
  private titleEl: HTMLSpanElement | null = null;
  private onCloseCallback: (() => void) | null = null;

  constructor(network: NetworkManager, itemDefs: Map<number, ItemDef>) {
    this.network = network;
    this.itemDefs = itemDefs;

    const modal = createModalPanel({
      id: 'shop-panel',
      title: 'Shop',
      geometry: { kind: 'canvas', widthFrac: 0.32 },
      chrome: 'dark',
      onClose: () => this.hide(),
    });
    this.container = modal.root;
    this.titleEl = modal.title;

    // Items grid
    this.gridEl = document.createElement('div');
    this.gridEl.style.cssText = 'padding: 8px; overflow-y: auto; flex: 1 1 auto; min-height: 0;';
    this.container.appendChild(this.gridEl);

    // Sell instruction
    const sellHint = document.createElement('div');
    sellHint.style.cssText = 'padding: 6px 12px; font-size: 11px; color: #888; border-top: 1px solid #333; text-align: center;';
    sellHint.textContent = 'Right-click inventory items to sell';
    this.container.appendChild(sellHint);

    document.body.appendChild(this.container);
  }

  show(npcEntityId: number, items: ShopItem[], shopTitle?: string): void {
    closeActiveContextMenu();
    this.shopNpcId = npcEntityId;
    this.items = items;
    this.visible = true;
    this.container.style.display = 'flex';
    if (this.titleEl) this.titleEl.textContent = shopTitle ?? 'Shop';
    this.render();
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = 'none';
    this.shopNpcId = -1;
    if (this.onCloseCallback) this.onCloseCallback();
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Set a callback for when shop is closed */
  setOnClose(cb: () => void): void {
    this.onCloseCallback = cb;
  }

  private render(): void {
    if (!this.gridEl) return;
    this.gridEl.innerHTML = '';

    for (const item of this.items) {
      const def = this.itemDefs.get(item.itemId);
      const name = def?.name ?? `Item #${item.itemId}`;

      const row = document.createElement('div');
      row.style.cssText = `
        display: flex; justify-content: space-between; align-items: center;
        padding: 6px 8px; margin: 2px 0; background: #222; border-radius: 3px;
        border: 1px solid #333; cursor: pointer;
      `;
      row.onmouseenter = () => { row.style.borderColor = '#aa8844'; };
      row.onmouseleave = () => { row.style.borderColor = '#333'; };

      const iconEl = document.createElement('span');
      iconEl.style.cssText = 'width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; margin-right: 6px; flex-shrink: 0;';
      if (def) {
        renderItemSlot(iconEl, def, this.itemDefs, {
          size: 32,
          extraStyle: 'max-width:32px;max-height:32px;',
        });
      }

      const nameEl = document.createElement('span');
      nameEl.textContent = name;
      nameEl.style.cssText = 'color: #eee; font-size: 13px; flex: 1; min-width: 0;';

      const priceEl = document.createElement('span');
      priceEl.textContent = `${item.price} gp`;
      priceEl.style.cssText = 'color: #d8372b; font-size: 13px; white-space: nowrap; margin-left: 8px;';

      const buyBtn = document.createElement('button');
      buyBtn.textContent = 'Buy';
      buyBtn.style.cssText = `
        background: #3a6633; border: 1px solid #5a8855; color: #ddd;
        padding: 3px 10px; border-radius: 3px; cursor: pointer;
        font-family: Arial, Helvetica, sans-serif; font-size: 12px; margin-left: 8px;
      `;
      buyBtn.onclick = () => {
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_BUY_ITEM, item.itemId, 1));
      };

      const buy5Btn = document.createElement('button');
      buy5Btn.textContent = 'x5';
      buy5Btn.style.cssText = `
        background: #335566; border: 1px solid #557788; color: #ddd;
        padding: 3px 6px; border-radius: 3px; cursor: pointer;
        font-family: Arial, Helvetica, sans-serif; font-size: 11px; margin-left: 4px;
      `;
      buy5Btn.onclick = () => {
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_BUY_ITEM, item.itemId, 5));
      };

      row.appendChild(iconEl);
      row.appendChild(nameEl);
      row.appendChild(priceEl);
      row.appendChild(buyBtn);
      row.appendChild(buy5Btn);
      this.gridEl.appendChild(row);
    }
  }

  dispose(): void {
    this.container.remove();
  }
}
