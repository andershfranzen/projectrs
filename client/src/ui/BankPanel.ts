import { ClientOpcode, encodePacket, BANK_SIZE, INVENTORY_SIZE, type ItemDef } from '@projectrs/shared';
import type { NetworkManager } from '../managers/NetworkManager';
import { createModalPanel } from './ModalPanel';
import { closeActiveContextMenu, createContextMenu } from './popupStyle';
import { renderItemSlot } from '../rendering/ItemIcon';

interface BankSlotData { itemId: number; quantity: number }

/** Bank UI — opens as a centered modal with the bank grid on the left and a
 *  mirror of the player's inventory on the right.
 *  - Click a bank slot → withdraw 1
 *  - Right-click a bank slot → 5 / 10 / All
 *  - Click an inventory slot → deposit 1
 *  - Right-click an inventory slot → 5 / 10 / All
 *  All operations are server-authoritative; this panel only renders state
 *  pushed by BANK_OPEN / BANK_UPDATE_SLOT and the existing inventory packets.
 *  The X button (or Escape) sends BANK_CLOSE; the server is also free to send
 *  a server-driven BANK_CLOSE when the player walks/attacks/etc. */
export class BankPanel {
  private container: HTMLDivElement;
  private bankGridEl: HTMLDivElement;
  private invGridEl: HTMLDivElement;
  private bankSlots: (BankSlotData | null)[] = new Array(BANK_SIZE).fill(null);
  private bankSlotElements: HTMLDivElement[] = [];
  private invSlots: (BankSlotData | null)[] = new Array(INVENTORY_SIZE).fill(null);
  private invSlotElements: HTMLDivElement[] = [];
  private network: NetworkManager;
  private itemDefs: Map<number, ItemDef> = new Map();
  private visible: boolean = false;

  constructor(network: NetworkManager) {
    this.network = network;
    const built = this.buildUI();
    this.container = built.root;
    this.bankGridEl = built.bankGrid;
    this.invGridEl = built.invGrid;
    document.body.appendChild(this.container);

    // Escape closes the bank.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.visible) this.hide(/*notifyServer*/ true);
    });
  }

  setItemDefs(defs: Map<number, ItemDef>): void {
    this.itemDefs = defs;
    for (let i = 0; i < this.bankSlots.length; i++) this.renderBankSlot(i);
    for (let i = 0; i < this.invSlots.length; i++) this.renderInvSlot(i);
  }

  /** Called when BANK_OPEN arrives — also triggers showing the panel. */
  openWithContents(filled: { slot: number; itemId: number; quantity: number }[]): void {
    this.bankSlots.fill(null);
    for (const f of filled) {
      if (f.slot >= 0 && f.slot < this.bankSlots.length) {
        this.bankSlots[f.slot] = { itemId: f.itemId, quantity: f.quantity };
      }
    }
    for (let i = 0; i < this.bankSlots.length; i++) this.renderBankSlot(i);
    this.show();
  }

  updateBankSlot(slot: number, itemId: number, quantity: number): void {
    if (slot < 0 || slot >= this.bankSlots.length) return;
    this.bankSlots[slot] = itemId === 0 ? null : { itemId, quantity };
    this.renderBankSlot(slot);
  }

  /** Mirror inventory state from the side panel. */
  updateInventorySlot(slot: number, itemId: number, quantity: number): void {
    if (slot < 0 || slot >= this.invSlots.length) return;
    this.invSlots[slot] = itemId === 0 ? null : { itemId, quantity };
    this.renderInvSlot(slot);
  }

  show(): void {
    closeActiveContextMenu();
    this.visible = true;
    this.container.style.display = 'flex';
  }
  hide(notifyServer: boolean): void {
    this.visible = false;
    this.container.style.display = 'none';
    if (notifyServer) this.network.sendRaw(encodePacket(ClientOpcode.BANK_CLOSE));
  }
  isVisible(): boolean { return this.visible; }

  private buildUI(): { root: HTMLDivElement; bankGrid: HTMLDivElement; invGrid: HTMLDivElement } {
    const { root } = createModalPanel({
      id: 'bank-panel',
      title: 'Bank of EvilQuest',
      geometry: { kind: 'viewport' },
      onClose: () => this.hide(true),
    });

    // Body — two columns
    const body = document.createElement('div');
    body.style.cssText = `display: flex; gap: 12px; padding: 12px; flex: 1; min-height: 0;`;

    // Bank column
    const bankCol = document.createElement('div');
    bankCol.style.cssText = `flex: 1.6 1 0; display: flex; flex-direction: column; min-height: 0;`;
    const bankLabel = document.createElement('div');
    bankLabel.textContent = `Bank (${BANK_SIZE} slots)`;
    bankLabel.style.cssText = `color: #d8372b; font-size: 12px; margin-bottom: 6px;`;
    bankCol.appendChild(bankLabel);

    const bankGrid = document.createElement('div');
    bankGrid.style.cssText = `
      display: grid; grid-template-columns: repeat(8, 1fr);
      gap: 2px; overflow-y: auto;
      background: rgba(0,0,0,0.4); padding: 4px; border: 1px inset #3a3025;
      flex: 1; min-height: 0;
    `;
    for (let i = 0; i < BANK_SIZE; i++) {
      const slot = this.makeSlot();
      slot.addEventListener('click', () => this.onBankClick(i));
      slot.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onBankRightClick(i, e); });
      bankGrid.appendChild(slot);
      this.bankSlotElements.push(slot);
    }
    bankCol.appendChild(bankGrid);
    body.appendChild(bankCol);

    // Inventory column
    const invCol = document.createElement('div');
    invCol.style.cssText = `flex: 1 1 0; display: flex; flex-direction: column; min-width: 0;`;
    const invLabel = document.createElement('div');
    invLabel.textContent = 'Inventory';
    invLabel.style.cssText = `color: #d8372b; font-size: 12px; margin-bottom: 6px;`;
    invCol.appendChild(invLabel);

    const invGrid = document.createElement('div');
    invGrid.style.cssText = `
      display: grid; grid-template-columns: repeat(5, 1fr);
      gap: 2px;
      background: rgba(0,0,0,0.4); padding: 4px; border: 1px inset #3a3025;
    `;
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const slot = this.makeSlot();
      slot.addEventListener('click', () => this.onInvClick(i));
      slot.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onInvRightClick(i, e); });
      invGrid.appendChild(slot);
      this.invSlotElements.push(slot);
    }
    invCol.appendChild(invGrid);
    body.appendChild(invCol);

    root.appendChild(body);

    // Hint footer
    const hint = document.createElement('div');
    hint.textContent = 'Left-click = 1 · Right-click = 5/10/All';
    hint.style.cssText = `padding: 6px 12px; font-size: 11px; color: #888; border-top: 1px solid #333; text-align: center;`;
    root.appendChild(hint);

    return { root, bankGrid, invGrid };
  }

  private makeSlot(): HTMLDivElement {
    const slot = document.createElement('div');
    slot.style.cssText = `
      width: 100%; aspect-ratio: 1 / 1; min-height: 40px;
      background: rgba(0,0,0,0.3); border: 1px solid #2a2218;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; position: relative; font-size: 9px;
    `;
    slot.addEventListener('mouseenter', () => { slot.style.background = 'rgba(255,255,255,0.06)'; });
    slot.addEventListener('mouseleave', () => { slot.style.background = 'rgba(0,0,0,0.3)'; });
    return slot;
  }

  private renderBankSlot(i: number): void {
    const el = this.bankSlotElements[i];
    if (!el) return;
    const s = this.bankSlots[i];
    if (!s) { el.innerHTML = ''; return; }
    this.setSlotInner(el, s.itemId, s.quantity);
  }
  private renderInvSlot(i: number): void {
    const el = this.invSlotElements[i];
    if (!el) return;
    const s = this.invSlots[i];
    if (!s) { el.innerHTML = ''; return; }
    this.setSlotInner(el, s.itemId, s.quantity);
  }

  private setSlotInner(el: HTMLElement, itemId: number, quantity: number): void {
    const def = this.itemDefs.get(itemId);
    renderItemSlot(el, def, this.itemDefs, {
      size: 32,
      extraStyle: 'max-width:32px;max-height:32px;width:100%;height:100%;',
      quantity,
      placeholderSize: 24,
    });
  }

  private onBankClick(slot: number): void {
    const s = this.bankSlots[slot];
    if (!s) return;
    this.network.sendRaw(encodePacket(ClientOpcode.BANK_WITHDRAW, slot, s.itemId, 1));
  }
  private onBankRightClick(slot: number, ev: MouseEvent): void {
    const s = this.bankSlots[slot];
    if (!s) return;
    this.showQuantityMenu(ev, [
      { label: 'Withdraw 1', n: 1 },
      { label: 'Withdraw 5', n: 5 },
      { label: 'Withdraw 10', n: 10 },
      { label: 'Withdraw All', n: -1 },
    ], (n) => this.network.sendRaw(encodePacket(ClientOpcode.BANK_WITHDRAW, slot, s.itemId, n)));
  }
  private onInvClick(slot: number): void {
    const s = this.invSlots[slot];
    if (!s) return;
    this.network.sendRaw(encodePacket(ClientOpcode.BANK_DEPOSIT, slot, s.itemId, 1));
  }
  private onInvRightClick(slot: number, ev: MouseEvent): void {
    const s = this.invSlots[slot];
    if (!s) return;
    this.showQuantityMenu(ev, [
      { label: 'Deposit 1', n: 1 },
      { label: 'Deposit 5', n: 5 },
      { label: 'Deposit 10', n: 10 },
      { label: 'Deposit All', n: -1 },
    ], (n) => this.network.sendRaw(encodePacket(ClientOpcode.BANK_DEPOSIT, slot, s.itemId, n)));
  }

  private showQuantityMenu(ev: MouseEvent, opts: { label: string; n: number }[], cb: (n: number) => void): void {
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
