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
  private static readonly ITEMS_PER_PAGE = 12;
  private container: HTMLDivElement;
  private network: NetworkManager;
  private itemDefs: Map<number, ItemDef>;
  private items: ShopItem[] = [];
  private visible: boolean = false;
  private gridEl: HTMLDivElement | null = null;
  private titleEl: HTMLSpanElement | null = null;
  private onCloseCallback: (() => void) | null = null;
  private npcEntityId: number = -1;
  private pageIndex: number = 0;

  constructor(network: NetworkManager, itemDefs: Map<number, ItemDef>) {
    this.network = network;
    this.itemDefs = itemDefs;

    const modal = createGameDialogModal({
      id: 'shop-panel',
      title: 'Shop',
      closeLabel: 'X',
      width: 'min(560px, calc(100% - var(--right-rail-width, 300px) - 24px))',
      onClose: () => this.hide(),
    });
    this.container = modal.root;
    this.titleEl = modal.title;

    // Items grid
    this.gridEl = document.createElement('div');
    this.gridEl.style.cssText = `
      margin-top: 4px;
      padding: 6px;
      overflow: hidden;
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
      gap: 5px;
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

  show(npcEntityId: number, items: ShopItem[], shopTitle?: string): void {
    closeActiveContextMenu();
    if (this.npcEntityId !== npcEntityId) this.pageIndex = 0;
    this.npcEntityId = npcEntityId;
    this.items = items;
    this.clampPageIndex();
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
    this.clampPageIndex();

    if (this.items.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'This shop is empty.';
      empty.style.cssText = `padding: 12px; color: #f4ded5; opacity: 0.78; font-size: 12px; text-shadow: ${DIALOGUE_TEXT_SHADOW};`;
      this.gridEl.appendChild(empty);
      return;
    }

    const start = this.pageIndex * ShopPanel.ITEMS_PER_PAGE;
    const pageItems = this.items.slice(start, start + ShopPanel.ITEMS_PER_PAGE);
    for (const item of pageItems) {
      const def = this.itemDefs.get(item.itemId);
      const name = def?.name ?? `Item #${item.itemId}`;

      const row = document.createElement('div');
      row.style.cssText = `
        display: flex;
        align-items: center;
        gap: 5px;
        min-height: 34px;
        padding: 4px 5px;
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
      iconEl.style.cssText = 'width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;';
      if (def) {
        renderItemSlot(iconEl, def, this.itemDefs, {
          size: 26,
          extraStyle: 'max-width:26px;max-height:26px;',
        });
      }

      const infoEl = document.createElement('span');
      infoEl.style.cssText = 'display:flex;flex-direction:column;gap:1px;flex:1;min-width:0;';

      const nameEl = document.createElement('span');
      nameEl.textContent = name;
      nameEl.style.cssText = `color: #f4ded5; font-size: 12px; line-height:14px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: ${DIALOGUE_TEXT_SHADOW};`;

      const priceEl = document.createElement('span');
      priceEl.textContent = `${item.price} gp - Stock ${item.stock}`;
      priceEl.style.cssText = `color: ${item.stock > 0 ? '#d6b16a' : '#d98d7f'}; font-size: 11px; line-height:13px; white-space: nowrap; overflow:hidden; text-overflow:ellipsis; text-shadow: ${DIALOGUE_TEXT_SHADOW};`;

      infoEl.append(nameEl, priceEl);

      const actionsEl = document.createElement('span');
      actionsEl.style.cssText = 'display:flex;gap:3px;align-items:center;flex-shrink:0;';

      const buyBtn = document.createElement('button');
      buyBtn.textContent = 'Buy';
      buyBtn.style.cssText = this.actionButtonCss('34px');
      buyBtn.disabled = item.stock <= 0;
      if (buyBtn.disabled) buyBtn.style.opacity = '0.45';
      this.installButtonHover(buyBtn);
      buyBtn.onclick = () => {
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_BUY_ITEM, item.itemId, 1));
      };

      const buyBatchQuantity = Math.min(5, item.stock);
      const buy5Btn = document.createElement('button');
      buy5Btn.textContent = item.stock > 0 ? `Buy ${buyBatchQuantity}` : 'Buy 5';
      buy5Btn.style.cssText = this.actionButtonCss('44px');
      buy5Btn.disabled = item.stock <= 0;
      if (buy5Btn.disabled) buy5Btn.style.opacity = '0.45';
      this.installButtonHover(buy5Btn);
      buy5Btn.onclick = () => {
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_BUY_ITEM, item.itemId, buyBatchQuantity));
      };

      row.appendChild(iconEl);
      row.appendChild(infoEl);
      actionsEl.append(buyBtn, buy5Btn);
      row.appendChild(actionsEl);
      this.gridEl.appendChild(row);
    }

    this.renderPager();
  }

  private clampPageIndex(): void {
    const pageCount = Math.max(1, Math.ceil(this.items.length / ShopPanel.ITEMS_PER_PAGE));
    this.pageIndex = Math.max(0, Math.min(this.pageIndex, pageCount - 1));
  }

  private renderPager(): void {
    if (!this.gridEl || this.items.length <= ShopPanel.ITEMS_PER_PAGE) return;
    const pageCount = Math.max(1, Math.ceil(this.items.length / ShopPanel.ITEMS_PER_PAGE));
    const pager = document.createElement('div');
    pager.style.cssText = `
      display:flex;
      align-items:center;
      justify-content:center;
      gap:8px;
      padding:3px 0 0;
      grid-column:1/-1;
    `;

    const prev = document.createElement('button');
    prev.textContent = '<';
    prev.title = 'Previous page';
    prev.style.cssText = this.actionButtonCss('32px');
    prev.disabled = this.pageIndex <= 0;
    this.installButtonHover(prev);
    prev.onclick = () => {
      this.pageIndex--;
      this.render();
    };

    const label = document.createElement('span');
    label.textContent = `${this.pageIndex + 1}/${pageCount}`;
    label.style.cssText = `min-width:42px;text-align:center;color:#f4ded5;font-size:12px;text-shadow:${DIALOGUE_TEXT_SHADOW};`;

    const next = document.createElement('button');
    next.textContent = '>';
    next.title = 'Next page';
    next.style.cssText = this.actionButtonCss('32px');
    next.disabled = this.pageIndex >= pageCount - 1;
    this.installButtonHover(next);
    next.onclick = () => {
      this.pageIndex++;
      this.render();
    };

    pager.append(prev, label, next);
    this.gridEl.appendChild(pager);
  }

  private actionButtonCss(minWidth: string = '48px'): string {
    return `
      background: ${SHOP_BUTTON_BG};
      border: 1px solid ${DIALOGUE_ACCENT_BRIGHT};
      color: #f4ded5;
      padding: 3px 5px;
      min-width: ${minWidth};
      border-radius: 2px;
      cursor: pointer;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 11px;
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
