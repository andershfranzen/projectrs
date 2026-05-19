import { ClientOpcode, encodePacket, INVENTORY_SIZE, TRADE_OFFER_SIZE, type ItemDef } from '@projectrs/shared';
import type { NetworkManager } from '../managers/NetworkManager';
import { createModalPanel } from './ModalPanel';
import { closeActiveContextMenu, createContextMenu } from './popupStyle';
import { renderItemSlot } from '../rendering/ItemIcon';

interface OfferSlotData { itemId: number; quantity: number }

const TRADE_TEXT_SHADOW = '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000';
const TRADE_BUTTON_BG = 'rgba(43, 10, 8, 0.9)';
const TRADE_BUTTON_HOVER_BG = 'rgba(78, 18, 14, 0.95)';
const TRADE_BUTTON_BORDER = '#9a332b';

/** Trade UI — opens as a centered modal split into "My offer" / "Their offer"
 *  on top, "My inventory" on the bottom, with Accept / Decline buttons.
 *
 *  Trigger flow:
 *    1. Either player runs `/trade <name>`     → server sends TRADE_REQUEST_RECEIVED
 *    2. Recipient clicks Accept on the popup   → server sends TRADE_OPEN to both
 *    3. Each side fills their offer            → server broadcasts TRADE_OFFER_UPDATE
 *    4. Each side clicks Accept (stage 1)      → server sends TRADE_ACCEPT_STATE
 *    5. Each side confirms again (stage 2)     → server commits, sends TRADE_CLOSE(0)
 *
 *  All buttons are server-authoritative; UI only reflects state. The
 *  switch-back-to-stage-0-on-mutation behavior is enforced server-side too.
 */
export class TradePanel {
  private container: HTMLDivElement;
  private network: NetworkManager;
  private onClose: (() => void) | null;
  private itemDefs: Map<number, ItemDef> = new Map();
  private visible = false;
  private myOffer: (OfferSlotData | null)[] = new Array(TRADE_OFFER_SIZE).fill(null);
  private theirOffer: (OfferSlotData | null)[] = new Array(TRADE_OFFER_SIZE).fill(null);
  private invSlots: (OfferSlotData | null)[] = new Array(INVENTORY_SIZE).fill(null);
  private myOfferEls: HTMLDivElement[] = [];
  private theirOfferEls: HTMLDivElement[] = [];
  private otherName: string = '';
  private acceptBtn!: HTMLButtonElement;
  private declineBtn!: HTMLButtonElement;
  private statusLabel!: HTMLDivElement;
  private titleEl!: HTMLSpanElement;
  private previewMode = false;
  private previewMyStage = 0;
  private previewTheirStage = 0;

  // Incoming-request popup is a separate small floating element.
  private requestPopup: HTMLDivElement | null = null;

  constructor(network: NetworkManager, hooks: { onClose?: () => void } = {}) {
    this.network = network;
    this.onClose = hooks.onClose ?? null;
    this.container = this.buildUI();
    (document.getElementById('game-frame') ?? document.body).appendChild(this.container);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.visible) this.sendDecline();
    });
  }

  setItemDefs(defs: Map<number, ItemDef>): void {
    this.itemDefs = defs;
    for (let i = 0; i < this.myOffer.length; i++) this.renderOfferSlot('mine', i);
    for (let i = 0; i < this.theirOffer.length; i++) this.renderOfferSlot('theirs', i);
  }

  /** Mirror inventory state so side-panel inventory clicks can offer items. */
  updateInventorySlot(slot: number, itemId: number, quantity: number): void {
    if (slot < 0 || slot >= this.invSlots.length) return;
    this.invSlots[slot] = itemId === 0 ? null : { itemId, quantity };
  }

  showIncomingRequest(requesterId: number, name: string): void {
    // If a popup is already up, replace it.
    this.requestPopup?.remove();
    const pop = document.createElement('div');
    pop.style.cssText = `
      position: absolute; right: calc(var(--right-rail-width, 300px) + 12px);
      bottom: calc(var(--chat-height, 220px) + 12px); z-index: 600;
      background: rgba(43, 10, 8, 0.95); border: 1px solid #9a332b; border-radius: 3px;
      padding: 12px; font-family: Arial, Helvetica, sans-serif; color: #ddd;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      min-width: 220px;
    `;
    const text = document.createElement('div');
    text.innerHTML = `<b style="color:#d8372b;">${escapeHtml(name)}</b> wants to trade.`;
    text.style.cssText = `font-size: 13px; margin-bottom: 10px;`;
    pop.appendChild(text);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = `display: flex; gap: 8px;`;
    const accept = document.createElement('button');
    accept.textContent = 'Accept';
    accept.style.cssText = this.actionButtonCss();
    accept.style.flex = '1';
    this.installButtonHover(accept);
    accept.onclick = () => {
      this.network.sendRaw(encodePacket(ClientOpcode.TRADE_ACCEPT_REQUEST, requesterId));
      pop.remove();
      this.requestPopup = null;
    };
    const decline = document.createElement('button');
    decline.textContent = 'Decline';
    decline.style.cssText = this.actionButtonCss();
    decline.style.flex = '1';
    this.installButtonHover(decline);
    decline.onclick = () => {
      this.network.sendRaw(encodePacket(ClientOpcode.TRADE_DECLINE));
      pop.remove();
      this.requestPopup = null;
    };
    btnRow.appendChild(accept); btnRow.appendChild(decline);
    pop.appendChild(btnRow);

    (document.getElementById('game-frame') ?? document.body).appendChild(pop);
    this.requestPopup = pop;
    // Auto-dismiss after 30s.
    setTimeout(() => { if (this.requestPopup === pop) { pop.remove(); this.requestPopup = null; } }, 30000);
  }

  openSession(otherEntityId: number, otherName: string): void {
    void otherEntityId;
    closeActiveContextMenu();
    this.requestPopup?.remove();
    this.requestPopup = null;
    this.previewMode = false;
    this.previewMyStage = 0;
    this.previewTheirStage = 0;
    this.otherName = otherName;
    this.titleEl.textContent = `Trade with ${otherName}`;
    this.myOffer.fill(null); this.theirOffer.fill(null);
    for (let i = 0; i < this.myOffer.length; i++) this.renderOfferSlot('mine', i);
    for (let i = 0; i < this.theirOffer.length; i++) this.renderOfferSlot('theirs', i);
    this.updateAcceptState(0, 0);
    this.visible = true;
    this.container.style.display = 'flex';
  }

  openPreview(otherName: string = 'no-one'): void {
    closeActiveContextMenu();
    this.requestPopup?.remove();
    this.requestPopup = null;
    this.previewMode = true;
    this.previewMyStage = 0;
    this.previewTheirStage = 0;
    this.otherName = otherName;
    this.titleEl.textContent = `Trade with ${otherName}`;
    this.myOffer.fill(null);
    this.theirOffer.fill(null);
    for (let i = 0; i < this.myOffer.length; i++) this.renderOfferSlot('mine', i);
    for (let i = 0; i < this.theirOffer.length; i++) this.renderOfferSlot('theirs', i);
    this.updateAcceptState(0, 0);
    this.visible = true;
    this.container.style.display = 'flex';
  }

  /** side: 0=mine, 1=theirs */
  updateOffer(side: number, slot: number, itemId: number, quantity: number): void {
    const arr = side === 0 ? this.myOffer : this.theirOffer;
    if (slot < 0 || slot >= arr.length) return;
    arr[slot] = itemId === 0 ? null : { itemId, quantity };
    this.renderOfferSlot(side === 0 ? 'mine' : 'theirs', slot);
  }

  updateAcceptState(myStage: number, theirStage: number): void {
    if (myStage === 0 && theirStage === 0) {
      this.statusLabel.textContent = this.previewMode ? 'Test preview. Use your inventory to add items.' : 'Click inventory items to offer.';
      this.statusLabel.style.color = '#aaa';
      this.acceptBtn.textContent = 'Accept';
      this.acceptBtn.disabled = false;
    } else if (myStage === 0 && theirStage > 0) {
      this.statusLabel.textContent = `${this.otherName} has accepted. Are you sure?`;
      this.statusLabel.style.color = '#d8372b';
      this.acceptBtn.textContent = 'Accept';
      this.acceptBtn.disabled = false;
    } else if (myStage === 1 && theirStage < 1) {
      this.statusLabel.textContent = `Waiting for ${this.otherName}...`;
      this.statusLabel.style.color = '#aaa';
      this.acceptBtn.textContent = 'Waiting...';
      this.acceptBtn.disabled = true;
    } else if (myStage === 1 && theirStage >= 1) {
      this.statusLabel.textContent = 'Confirm trade.';
      this.statusLabel.style.color = '#d8372b';
      this.acceptBtn.textContent = 'Confirm';
      this.acceptBtn.disabled = false;
    } else if (myStage === 2 && theirStage < 2) {
      this.statusLabel.textContent = `Waiting for ${this.otherName} to confirm...`;
      this.statusLabel.style.color = '#aaa';
      this.acceptBtn.textContent = 'Waiting...';
      this.acceptBtn.disabled = true;
    } else if (myStage >= 2 && theirStage >= 2) {
      this.statusLabel.textContent = this.previewMode ? 'Test trade confirmed. Decline closes preview.' : 'Trade confirmed.';
      this.statusLabel.style.color = '#aaa';
      this.acceptBtn.textContent = 'Confirmed';
      this.acceptBtn.disabled = true;
    }
  }

  close(_reason: number): void {
    const wasVisible = this.visible;
    this.previewMode = false;
    this.previewMyStage = 0;
    this.previewTheirStage = 0;
    this.visible = false;
    this.container.style.display = 'none';
    this.myOffer.fill(null); this.theirOffer.fill(null);
    for (let i = 0; i < this.myOffer.length; i++) this.renderOfferSlot('mine', i);
    for (let i = 0; i < this.theirOffer.length; i++) this.renderOfferSlot('theirs', i);
    if (wasVisible) this.onClose?.();
  }

  private buildUI(): HTMLDivElement {
    const modal = createModalPanel({
      id: 'trade-panel',
      title: 'Trade',
      geometry: {
        kind: 'game-canvas',
        width: 'min(438px, calc(100% - var(--right-rail-width, 300px) - 18px))',
        maxHeight: 'calc(100% - var(--chat-height, 220px) - 18px)',
      },
      chrome: 'dialogue',
      closeButton: false,
      onClose: () => this.sendDecline(),
    });
    const root = modal.root;
    this.titleEl = modal.title;

    // Two-pane offers
    const offersRow = document.createElement('div');
    offersRow.style.cssText = `display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 8px 10px 5px;`;

    const myWrap = document.createElement('div');
    const myLabel = document.createElement('div');
    myLabel.textContent = 'My offer';
    myLabel.style.cssText = this.labelCss();
    myWrap.appendChild(myLabel);
    const myGrid = this.makeGrid(5, TRADE_OFFER_SIZE, (slot) => {
      this.removeOfferSlot(slot, 1);
    }, (slot, ev) => {
      const s = this.myOffer[slot];
      if (!s) return;
      this.showQtyMenu(ev, [
        { label: 'Remove 1', n: 1 },
        { label: 'Remove 5', n: 5 },
        { label: 'Remove 10', n: 10 },
        { label: 'Remove All', n: -1 },
      ], (n) => this.removeOfferSlot(slot, n));
    }, this.myOfferEls);
    myWrap.appendChild(myGrid);
    offersRow.appendChild(myWrap);

    const theirWrap = document.createElement('div');
    const theirLabel = document.createElement('div');
    theirLabel.textContent = 'Their offer';
    theirLabel.style.cssText = this.labelCss();
    theirWrap.appendChild(theirLabel);
    // Their offer is read-only; clicks do nothing.
    const theirGrid = this.makeGrid(5, TRADE_OFFER_SIZE, () => {}, () => {}, this.theirOfferEls);
    theirWrap.appendChild(theirGrid);
    offersRow.appendChild(theirWrap);

    root.appendChild(offersRow);

    // Accept/Decline row
    const ctrlRow = document.createElement('div');
    ctrlRow.style.cssText = `display: flex; gap: 6px; padding: 0 10px 6px; align-items: center;`;
    this.statusLabel = document.createElement('div');
    this.statusLabel.style.cssText = `flex: 1; font-size: 12px; color: #f4ded5; min-width: 0; text-shadow: ${TRADE_TEXT_SHADOW};`;
    this.statusLabel.textContent = 'Click inventory items to offer.';
    ctrlRow.appendChild(this.statusLabel);
    this.acceptBtn = document.createElement('button');
    this.acceptBtn.textContent = 'Accept';
    this.acceptBtn.style.cssText = this.actionButtonCss();
    this.installButtonHover(this.acceptBtn);
    this.acceptBtn.onclick = () => this.sendAccept();
    this.declineBtn = document.createElement('button');
    this.declineBtn.textContent = 'Decline';
    this.declineBtn.style.cssText = this.actionButtonCss();
    this.installButtonHover(this.declineBtn);
    this.declineBtn.onclick = () => this.sendDecline();
    ctrlRow.appendChild(this.acceptBtn); ctrlRow.appendChild(this.declineBtn);
    root.appendChild(ctrlRow);

    return root;
  }

  private makeGrid(
    cols: number,
    cells: number,
    onClick: (slot: number) => void,
    onRight: (slot: number, ev: MouseEvent) => void,
    sink: HTMLDivElement[],
  ): HTMLDivElement {
    const grid = document.createElement('div');
    grid.style.cssText = `
      display: grid;
      grid-template-columns: repeat(${cols}, minmax(0, 1fr));
      gap: 0;
      position: relative;
      overflow: hidden;
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
      box-shadow:
        inset 2px 2px 0 rgba(160, 88, 48, 0.13),
        inset -2px -2px 0 rgba(0,0,0,0.5),
        2px 2px 0 rgba(0,0,0,0.45);
    `;
    const stitch = document.createElement('div');
    stitch.style.cssText = `
      position: absolute; inset: 3px;
      border: 1px dotted rgba(150, 82, 46, 0.38);
      border-radius: 1px;
      box-shadow: 0 0 0 1px rgba(35, 16, 9, 0.7);
      pointer-events: none; z-index: 1;
    `;
    grid.appendChild(stitch);
    for (let i = 0; i < cells; i++) {
      const cell = document.createElement('div');
      cell.style.cssText = `
        width: 100%;
        aspect-ratio: 1 / 1;
        min-height: 0;
        background: transparent;
        border: 0;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; position: relative; font-size: 9px;
        z-index: 2;
      `;
      cell.addEventListener('mouseenter', () => { cell.style.background = 'rgba(154,51,43,0.22)'; });
      cell.addEventListener('mouseleave', () => { cell.style.background = 'transparent'; });
      cell.addEventListener('click', () => onClick(i));
      cell.addEventListener('contextmenu', (e) => { e.preventDefault(); onRight(i, e); });
      grid.appendChild(cell);
      sink.push(cell);
    }
    return grid;
  }

  private renderOfferSlot(side: 'mine' | 'theirs', i: number): void {
    const els = side === 'mine' ? this.myOfferEls : this.theirOfferEls;
    const arr = side === 'mine' ? this.myOffer : this.theirOffer;
    const el = els[i];
    if (!el) return;
    const s = arr[i];
    if (s) this.setSlotInner(el, s.itemId, s.quantity);
    else el.innerHTML = '';
  }
  private setSlotInner(el: HTMLElement, itemId: number, quantity: number): void {
    const def = this.itemDefs.get(itemId);
    renderItemSlot(el, def, this.itemDefs, {
      size: 32,
      extraStyle: 'max-width:32px;max-height:32px;width:100%;height:100%;',
      quantity,
      placeholderSize: 26,
    });
  }

  private labelCss(): string {
    return `color: #f4ded5; font-size: 12px; margin-bottom: 4px; font-weight: bold; text-shadow: ${TRADE_TEXT_SHADOW};`;
  }

  private actionButtonCss(): string {
    return `
      background: ${TRADE_BUTTON_BG};
      border: 1px solid ${TRADE_BUTTON_BORDER};
      color: #f4ded5;
      padding: 5px 10px;
      min-width: 70px;
      border-radius: 2px;
      cursor: pointer;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12px;
      font-weight: bold;
      text-shadow: ${TRADE_TEXT_SHADOW};
      box-shadow: inset 0 0 0 1px rgba(255,190,150,0.08);
    `;
  }

  private installButtonHover(button: HTMLButtonElement): void {
    button.addEventListener('mouseenter', () => { if (!button.disabled) button.style.background = TRADE_BUTTON_HOVER_BG; });
    button.addEventListener('mouseleave', () => { button.style.background = TRADE_BUTTON_BG; });
  }

  offerInventorySlot(slot: number, quantity: number): void {
    const s = this.invSlots[slot];
    if (!s) return;
    if (this.previewMode) {
      this.addPreviewOfferFromInventory(slot, quantity);
      return;
    }
    this.network.sendRaw(encodePacket(ClientOpcode.TRADE_OFFER_ITEM, slot, s.itemId, quantity));
  }

  private removeOfferSlot(slot: number, quantity: number): void {
    const s = this.myOffer[slot];
    if (!s) return;
    if (this.previewMode) {
      this.removePreviewOffer(slot, quantity);
      return;
    }
    this.network.sendRaw(encodePacket(ClientOpcode.TRADE_REMOVE_OFFERED, slot, s.itemId, quantity));
  }

  private addPreviewOfferFromInventory(slot: number, quantity: number): void {
    const s = this.invSlots[slot];
    if (!s) return;
    const toOffer = quantity === -1 ? s.quantity : Math.min(Math.max(quantity, 1), s.quantity);
    if (!Number.isSafeInteger(toOffer) || toOffer <= 0) return;

    let offerSlot = this.myOffer.findIndex(o => o?.itemId === s.itemId);
    if (offerSlot < 0) offerSlot = this.myOffer.findIndex(o => o === null);
    if (offerSlot < 0) return;

    const existing = this.myOffer[offerSlot];
    if (existing) existing.quantity += toOffer;
    else this.myOffer[offerSlot] = { itemId: s.itemId, quantity: toOffer };
    this.renderOfferSlot('mine', offerSlot);
    this.resetPreviewAcceptState();
  }

  private removePreviewOffer(slot: number, quantity: number): void {
    const s = this.myOffer[slot];
    if (!s) return;
    const toRemove = quantity === -1 ? s.quantity : Math.min(Math.max(quantity, 1), s.quantity);
    if (!Number.isSafeInteger(toRemove) || toRemove <= 0) return;

    s.quantity -= toRemove;
    if (s.quantity <= 0) this.myOffer[slot] = null;
    this.renderOfferSlot('mine', slot);
    this.resetPreviewAcceptState();
  }

  private resetPreviewAcceptState(): void {
    if (!this.previewMode) return;
    this.previewMyStage = 0;
    this.previewTheirStage = 0;
    this.updateAcceptState(this.previewMyStage, this.previewTheirStage);
  }

  private sendAccept(): void {
    if (!this.previewMode) {
      this.network.sendRaw(encodePacket(ClientOpcode.TRADE_ACCEPT));
      return;
    }
    if (this.previewMyStage === 0) {
      this.previewMyStage = 1;
      this.previewTheirStage = 1;
    } else if (this.previewMyStage === 1) {
      this.previewMyStage = 2;
      this.previewTheirStage = 2;
    }
    this.updateAcceptState(this.previewMyStage, this.previewTheirStage);
  }

  private sendDecline(): void {
    if (this.previewMode) {
      this.close(0);
      return;
    }
    this.network.sendRaw(encodePacket(ClientOpcode.TRADE_DECLINE));
  }

  private showQtyMenu(ev: MouseEvent, opts: { label: string; n: number }[], cb: (n: number) => void): void {
    createContextMenu(opts.map((opt) => ({
      label: opt.label,
      action: () => cb(opt.n),
    })), {
      x: ev.clientX,
      y: ev.clientY,
      minWidthPx: 110,
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
