import { ClientOpcode, encodePacket, INVENTORY_SIZE, TRADE_OFFER_SIZE, type ItemDef } from '@projectrs/shared';
import type { NetworkManager } from '../managers/NetworkManager';

interface OfferSlotData { itemId: number; quantity: number }

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
  private itemDefs: Map<number, ItemDef> = new Map();
  private visible = false;
  private myOffer: (OfferSlotData | null)[] = new Array(TRADE_OFFER_SIZE).fill(null);
  private theirOffer: (OfferSlotData | null)[] = new Array(TRADE_OFFER_SIZE).fill(null);
  private invSlots: (OfferSlotData | null)[] = new Array(INVENTORY_SIZE).fill(null);
  private myOfferEls: HTMLDivElement[] = [];
  private theirOfferEls: HTMLDivElement[] = [];
  private invSlotEls: HTMLDivElement[] = [];
  private otherName: string = '';
  private acceptBtn!: HTMLButtonElement;
  private declineBtn!: HTMLButtonElement;
  private statusLabel!: HTMLDivElement;
  private titleEl!: HTMLSpanElement;

  // Incoming-request popup is a separate small floating element.
  private requestPopup: HTMLDivElement | null = null;

  constructor(network: NetworkManager) {
    this.network = network;
    this.container = this.buildUI();
    document.body.appendChild(this.container);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.visible) this.sendDecline();
    });
  }

  setItemDefs(defs: Map<number, ItemDef>): void {
    this.itemDefs = defs;
    for (let i = 0; i < this.myOffer.length; i++) this.renderOfferSlot('mine', i);
    for (let i = 0; i < this.theirOffer.length; i++) this.renderOfferSlot('theirs', i);
    for (let i = 0; i < this.invSlots.length; i++) this.renderInvSlot(i);
  }

  /** Mirror inventory state so the deposit-into-offer slots are accurate. */
  updateInventorySlot(slot: number, itemId: number, quantity: number): void {
    if (slot < 0 || slot >= this.invSlots.length) return;
    this.invSlots[slot] = itemId === 0 ? null : { itemId, quantity };
    this.renderInvSlot(slot);
  }

  showIncomingRequest(requesterId: number, name: string): void {
    // If a popup is already up, replace it.
    this.requestPopup?.remove();
    const pop = document.createElement('div');
    pop.style.cssText = `
      position: fixed; right: 16px; bottom: 80px; z-index: 600;
      background: #1a1410; border: 2px solid #aa8844; border-radius: 6px;
      padding: 12px; font-family: monospace; color: #ddd;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      min-width: 220px;
    `;
    const text = document.createElement('div');
    text.innerHTML = `<b style="color:#ffcc44;">${escapeHtml(name)}</b> wants to trade.`;
    text.style.cssText = `font-size: 13px; margin-bottom: 10px;`;
    pop.appendChild(text);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = `display: flex; gap: 8px;`;
    const accept = document.createElement('button');
    accept.textContent = 'Accept';
    accept.style.cssText = `flex: 1; background: #3a6633; border: 1px solid #5a8855; color: #fff; padding: 6px; cursor: pointer; font-family: monospace;`;
    accept.onclick = () => {
      this.network.sendRaw(encodePacket(ClientOpcode.TRADE_ACCEPT_REQUEST, requesterId));
      pop.remove();
      this.requestPopup = null;
    };
    const decline = document.createElement('button');
    decline.textContent = 'Decline';
    decline.style.cssText = `flex: 1; background: #663333; border: 1px solid #885555; color: #fff; padding: 6px; cursor: pointer; font-family: monospace;`;
    decline.onclick = () => {
      this.network.sendRaw(encodePacket(ClientOpcode.TRADE_DECLINE));
      pop.remove();
      this.requestPopup = null;
    };
    btnRow.appendChild(accept); btnRow.appendChild(decline);
    pop.appendChild(btnRow);

    document.body.appendChild(pop);
    this.requestPopup = pop;
    // Auto-dismiss after 30s.
    setTimeout(() => { if (this.requestPopup === pop) { pop.remove(); this.requestPopup = null; } }, 30000);
  }

  openSession(otherEntityId: number, otherName: string): void {
    this.otherName = otherName;
    this.titleEl.textContent = `Trade with ${otherName}`;
    this.myOffer.fill(null); this.theirOffer.fill(null);
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
      this.statusLabel.textContent = 'Drag items into your offer.';
      this.statusLabel.style.color = '#aaa';
      this.acceptBtn.textContent = 'Accept';
      this.acceptBtn.disabled = false;
    } else if (myStage === 0 && theirStage > 0) {
      this.statusLabel.textContent = `${this.otherName} has accepted. Are you sure?`;
      this.statusLabel.style.color = '#fc0';
      this.acceptBtn.textContent = 'Accept';
      this.acceptBtn.disabled = false;
    } else if (myStage === 1 && theirStage < 1) {
      this.statusLabel.textContent = `Waiting for ${this.otherName}...`;
      this.statusLabel.style.color = '#aaa';
      this.acceptBtn.textContent = 'Waiting...';
      this.acceptBtn.disabled = true;
    } else if (myStage === 1 && theirStage >= 1) {
      this.statusLabel.textContent = 'Confirm trade.';
      this.statusLabel.style.color = '#fc0';
      this.acceptBtn.textContent = 'Confirm';
      this.acceptBtn.disabled = false;
    } else if (myStage === 2 && theirStage < 2) {
      this.statusLabel.textContent = `Waiting for ${this.otherName} to confirm...`;
      this.statusLabel.style.color = '#aaa';
      this.acceptBtn.textContent = 'Waiting...';
      this.acceptBtn.disabled = true;
    }
  }

  close(_reason: number): void {
    this.visible = false;
    this.container.style.display = 'none';
    this.myOffer.fill(null); this.theirOffer.fill(null);
    for (let i = 0; i < this.myOffer.length; i++) this.renderOfferSlot('mine', i);
    for (let i = 0; i < this.theirOffer.length; i++) this.renderOfferSlot('theirs', i);
  }

  private buildUI(): HTMLDivElement {
    const root = document.createElement('div');
    root.id = 'trade-panel';
    root.style.cssText = `
      position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(720px, 92vw); max-height: 90vh;
      display: none; flex-direction: column;
      background: #1a1410; border: 2px solid #aa8844;
      border-radius: 6px; z-index: 500;
      font-family: monospace; color: #ddd; user-select: none;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 12px; background: #2a1f17; border-bottom: 1px solid #aa8844;
    `;
    const title = document.createElement('span');
    title.textContent = 'Trade';
    title.style.cssText = 'font-size: 16px; color: #ffcc44; font-weight: bold;';
    this.titleEl = title;
    const close = document.createElement('button');
    close.textContent = 'X';
    close.style.cssText = `background: #444; border: 1px solid #666; color: #ddd; padding: 2px 8px; cursor: pointer; font-family: monospace;`;
    close.onclick = () => this.sendDecline();
    header.appendChild(title); header.appendChild(close);
    root.appendChild(header);

    // Two-pane offers
    const offersRow = document.createElement('div');
    offersRow.style.cssText = `display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 8px 12px;`;

    const myWrap = document.createElement('div');
    const myLabel = document.createElement('div');
    myLabel.textContent = 'My offer';
    myLabel.style.cssText = `color: #fc0; font-size: 12px; margin-bottom: 4px;`;
    myWrap.appendChild(myLabel);
    const myGrid = this.makeGrid(7, TRADE_OFFER_SIZE, (slot) => {
      const s = this.myOffer[slot];
      if (!s) return;
      this.network.sendRaw(encodePacket(ClientOpcode.TRADE_REMOVE_OFFERED, slot, s.itemId, 1));
    }, (slot, ev) => {
      const s = this.myOffer[slot];
      if (!s) return;
      this.showQtyMenu(ev, [
        { label: 'Remove 1', n: 1 },
        { label: 'Remove 5', n: 5 },
        { label: 'Remove 10', n: 10 },
        { label: 'Remove All', n: -1 },
      ], (n) => this.network.sendRaw(encodePacket(ClientOpcode.TRADE_REMOVE_OFFERED, slot, s.itemId, n)));
    }, this.myOfferEls);
    myWrap.appendChild(myGrid);
    offersRow.appendChild(myWrap);

    const theirWrap = document.createElement('div');
    const theirLabel = document.createElement('div');
    theirLabel.textContent = 'Their offer';
    theirLabel.style.cssText = `color: #fc0; font-size: 12px; margin-bottom: 4px;`;
    theirWrap.appendChild(theirLabel);
    // Their offer is read-only; clicks do nothing.
    const theirGrid = this.makeGrid(7, TRADE_OFFER_SIZE, () => {}, () => {}, this.theirOfferEls);
    theirWrap.appendChild(theirGrid);
    offersRow.appendChild(theirWrap);

    root.appendChild(offersRow);

    // Accept/Decline row
    const ctrlRow = document.createElement('div');
    ctrlRow.style.cssText = `display: flex; gap: 8px; padding: 0 12px 8px; align-items: center;`;
    this.statusLabel = document.createElement('div');
    this.statusLabel.style.cssText = `flex: 1; font-size: 12px; color: #aaa;`;
    this.statusLabel.textContent = 'Drag items into your offer.';
    ctrlRow.appendChild(this.statusLabel);
    this.acceptBtn = document.createElement('button');
    this.acceptBtn.textContent = 'Accept';
    this.acceptBtn.style.cssText = `background: #3a6633; border: 1px solid #5a8855; color: #fff; padding: 6px 14px; cursor: pointer; font-family: monospace;`;
    this.acceptBtn.onclick = () => this.network.sendRaw(encodePacket(ClientOpcode.TRADE_ACCEPT));
    this.declineBtn = document.createElement('button');
    this.declineBtn.textContent = 'Decline';
    this.declineBtn.style.cssText = `background: #663333; border: 1px solid #885555; color: #fff; padding: 6px 14px; cursor: pointer; font-family: monospace;`;
    this.declineBtn.onclick = () => this.sendDecline();
    ctrlRow.appendChild(this.acceptBtn); ctrlRow.appendChild(this.declineBtn);
    root.appendChild(ctrlRow);

    // Inventory mirror
    const invLabel = document.createElement('div');
    invLabel.textContent = 'Click an inventory item to add it to your offer';
    invLabel.style.cssText = `color: #aaa; font-size: 11px; padding: 4px 12px 0; text-align: center;`;
    root.appendChild(invLabel);
    const invGrid = this.makeGrid(5, INVENTORY_SIZE, (slot) => {
      const s = this.invSlots[slot];
      if (!s) return;
      this.network.sendRaw(encodePacket(ClientOpcode.TRADE_OFFER_ITEM, slot, s.itemId, 1));
    }, (slot, ev) => {
      const s = this.invSlots[slot];
      if (!s) return;
      this.showQtyMenu(ev, [
        { label: 'Offer 1', n: 1 },
        { label: 'Offer 5', n: 5 },
        { label: 'Offer 10', n: 10 },
        { label: 'Offer All', n: -1 },
      ], (n) => this.network.sendRaw(encodePacket(ClientOpcode.TRADE_OFFER_ITEM, slot, s.itemId, n)));
    }, this.invSlotEls);
    invGrid.style.margin = '4px 12px 12px';
    root.appendChild(invGrid);

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
      display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 2px;
      background: rgba(0,0,0,0.4); padding: 4px; border: 1px inset #3a3025;
    `;
    for (let i = 0; i < cells; i++) {
      const cell = document.createElement('div');
      cell.style.cssText = `
        width: 100%; aspect-ratio: 1 / 1; min-height: 38px;
        background: rgba(0,0,0,0.3); border: 1px solid #2a2218;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; position: relative; font-size: 9px;
      `;
      cell.addEventListener('mouseenter', () => { cell.style.background = 'rgba(255,255,255,0.06)'; });
      cell.addEventListener('mouseleave', () => { cell.style.background = 'rgba(0,0,0,0.3)'; });
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
    el.innerHTML = s ? this.slotInnerHtml(s.itemId, s.quantity) : '';
  }
  private renderInvSlot(i: number): void {
    const el = this.invSlotEls[i];
    if (!el) return;
    const s = this.invSlots[i];
    el.innerHTML = s ? this.slotInnerHtml(s.itemId, s.quantity) : '';
  }

  private slotInnerHtml(itemId: number, quantity: number): string {
    const def = this.itemDefs.get(itemId);
    const sprite = def?.sprite;
    const icon = def?.icon;
    const imgStyle = `max-width:30px;max-height:30px;width:100%;height:100%;image-rendering:pixelated;object-fit:contain;`;
    const iconHtml = sprite
      ? `<img src="/sprites/items/${sprite}" style="${imgStyle}" />`
      : icon
      ? `<img src="/items/${icon}" style="${imgStyle}" />`
      : `<div style="width:22px;height:22px;background:#555;border-radius:3px;"></div>`;
    const qtyLabel = quantity > 1
      ? `<div style="position:absolute;top:1px;left:3px;font-size:9px;font-weight:bold;color:#ffe066;text-shadow:1px 1px 0 #000;">${quantity}</div>`
      : '';
    return `${iconHtml}${qtyLabel}`;
  }

  private sendDecline(): void {
    this.network.sendRaw(encodePacket(ClientOpcode.TRADE_DECLINE));
  }

  private showQtyMenu(ev: MouseEvent, opts: { label: string; n: number }[], cb: (n: number) => void): void {
    const menu = document.createElement('div');
    menu.style.cssText = `
      position: fixed; left: ${ev.clientX}px; top: ${ev.clientY}px;
      background: #3a3125; border: 2px solid #5a4a35;
      font-family: monospace; font-size: 12px; z-index: 1001;
      min-width: 110px; box-shadow: 2px 2px 8px rgba(0,0,0,0.5);
    `;
    for (const opt of opts) {
      const item = document.createElement('div');
      item.textContent = opt.label;
      item.style.cssText = `padding: 4px 12px; color: #ffcc00; cursor: pointer;`;
      item.addEventListener('mouseenter', () => item.style.background = '#5a4a35');
      item.addEventListener('mouseleave', () => item.style.background = 'transparent');
      item.addEventListener('click', () => { cb(opt.n); menu.remove(); });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    setTimeout(() => document.addEventListener('click', close), 0);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
