import { ClientOpcode, encodePacket, type ItemDef } from '@projectrs/shared';
import { renderItemSlot } from '../rendering/ItemIcon';
import type { NetworkManager } from '../managers/NetworkManager';
import {
  DIALOGUE_ACCENT,
  DIALOGUE_ACCENT_BRIGHT,
  DIALOGUE_PARCHMENT_BG,
  DIALOGUE_TEXT_SHADOW,
  createGameDialogModal,
  mountModalInGameFrame,
} from './ModalPanel';
import { closeActiveContextMenu } from './popupStyle';

export interface ShopItem {
  itemId: number;
  price: number;
  stock: number;
}

const SHOP_BUTTON_BG = 'rgba(43, 10, 8, 0.9)';
const SHOP_BUTTON_HOVER_BG = 'rgba(78, 18, 14, 0.95)';

export class ShopPanel {
  private container: HTMLDivElement;
  private network: NetworkManager;
  private itemDefs: Map<number, ItemDef>;
  private items: ShopItem[] = [];
  private visible: boolean = false;
  private gridEl: HTMLDivElement | null = null;
  private titleEl: HTMLSpanElement | null = null;
  private onCloseCallback: (() => void) | null = null;

  constructor(network: NetworkManager, itemDefs: Map<number, ItemDef>) {
    this.network = network;
    this.itemDefs = itemDefs;

    const modal = createGameDialogModal({
      id: 'shop-panel',
      title: 'Shop',
      closeLabel: 'X',
      onClose: () => this.hide(),
    });
    this.container = modal.root;
    this.titleEl = modal.title;

    // Items grid
    this.gridEl = document.createElement('div');
    this.gridEl.style.cssText = `
      margin-top: 4px;
      padding: 8px 9px 6px;
      overflow-y: auto;
      flex: 1 1 auto;
      min-height: 0;
      border: 1px solid ${DIALOGUE_ACCENT};
      background: ${DIALOGUE_PARCHMENT_BG};
      box-shadow:
        inset 0 1px 0 rgba(255,220,170,0.06),
        inset 0 0 18px rgba(0,0,0,0.34);
    `;
    this.container.appendChild(this.gridEl);

    // Sell instruction
    const sellHint = document.createElement('div');
    sellHint.style.cssText = `
      padding: 6px 10px 8px;
      font-size: 11px;
      color: #f4ded5;
      opacity: 0.82;
      border-top: 1px solid rgba(143, 47, 40, 0.62);
      text-align: center;
      text-shadow: ${DIALOGUE_TEXT_SHADOW};
    `;
    sellHint.textContent = 'Right-click inventory items to sell';
    this.container.appendChild(sellHint);

    mountModalInGameFrame(this.container);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.visible) this.hide();
    });
  }

  show(_npcEntityId: number, items: ShopItem[], shopTitle?: string): void {
    closeActiveContextMenu();
    this.items = items;
    this.visible = true;
    this.container.style.display = 'flex';
    if (this.titleEl) this.titleEl.textContent = shopTitle ?? 'Shop';
    this.render();
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = 'none';
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

    if (this.items.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'This shop is empty.';
      empty.style.cssText = `padding: 12px; color: #f4ded5; opacity: 0.78; font-size: 12px; text-shadow: ${DIALOGUE_TEXT_SHADOW};`;
      this.gridEl.appendChild(empty);
      return;
    }

    for (const item of this.items) {
      const def = this.itemDefs.get(item.itemId);
      const name = def?.name ?? `Item #${item.itemId}`;

      const row = document.createElement('div');
      row.style.cssText = `
        display: flex;
        align-items: center;
        gap: 7px;
        min-height: 42px;
        padding: 5px 7px;
        margin: 0 0 6px;
        background:
          linear-gradient(rgba(65, 40, 30, 0.34), rgba(25, 17, 14, 0.58)),
          url('/ui/parchment.png') repeat;
        border: 1px solid rgba(143, 47, 40, 0.58);
        border-radius: 2px;
        box-shadow:
          inset 0 1px 0 rgba(235,210,168,0.08),
          inset 0 -1px 0 rgba(0,0,0,0.42);
      `;
      row.onmouseenter = () => {
        row.style.background = 'linear-gradient(rgba(78, 41, 32, 0.46), rgba(35, 19, 16, 0.68)), url("/ui/parchment.png") repeat';
        row.style.borderColor = DIALOGUE_ACCENT_BRIGHT;
      };
      row.onmouseleave = () => {
        row.style.background = 'linear-gradient(rgba(65, 40, 30, 0.34), rgba(25, 17, 14, 0.58)), url("/ui/parchment.png") repeat';
        row.style.borderColor = 'rgba(154, 51, 43, 0.55)';
      };

      const iconEl = document.createElement('span');
      iconEl.style.cssText = 'width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;';
      if (def) {
        renderItemSlot(iconEl, def, this.itemDefs, {
          size: 32,
          extraStyle: 'max-width:32px;max-height:32px;',
        });
      }

      const nameEl = document.createElement('span');
      nameEl.textContent = name;
      nameEl.style.cssText = `color: #f4ded5; font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: ${DIALOGUE_TEXT_SHADOW};`;

      const priceEl = document.createElement('span');
      priceEl.textContent = `${item.price} gp`;
      priceEl.style.cssText = `color: #d6b16a; font-size: 12px; white-space: nowrap; text-shadow: ${DIALOGUE_TEXT_SHADOW};`;

      const buyBtn = document.createElement('button');
      buyBtn.textContent = 'Buy';
      buyBtn.style.cssText = this.actionButtonCss();
      this.installButtonHover(buyBtn);
      buyBtn.onclick = () => {
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_BUY_ITEM, item.itemId, 1));
      };

      const buy5Btn = document.createElement('button');
      buy5Btn.textContent = 'Buy 5';
      buy5Btn.style.cssText = this.actionButtonCss('56px');
      this.installButtonHover(buy5Btn);
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

  private actionButtonCss(minWidth: string = '48px'): string {
    return `
      background: ${SHOP_BUTTON_BG};
      border: 1px solid ${DIALOGUE_ACCENT_BRIGHT};
      color: #f4ded5;
      padding: 4px 8px;
      min-width: ${minWidth};
      border-radius: 2px;
      cursor: pointer;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12px;
      text-shadow: ${DIALOGUE_TEXT_SHADOW};
    `;
  }

  private installButtonHover(button: HTMLButtonElement): void {
    button.addEventListener('mouseenter', () => { if (!button.disabled) button.style.background = SHOP_BUTTON_HOVER_BG; });
    button.addEventListener('mouseleave', () => { button.style.background = SHOP_BUTTON_BG; });
  }

  dispose(): void {
    this.container.remove();
  }
}
