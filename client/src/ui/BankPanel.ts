import { ClientOpcode, encodePacket, encodeQuantityPacket, BANK_SIZE, INVENTORY_SIZE, type ItemDef } from '@projectrs/shared';
import type { NetworkManager } from '../managers/NetworkManager';
import { createModalPanel } from './ModalPanel';
import { closeActiveContextMenu, createContextMenu, suppressNextContextMenuClick } from './popupStyle';
import { renderItemSlot } from '../rendering/ItemIcon';
import type { QuantityInputRequester } from './QuantityInputPanel';

interface BankSlotData { itemId: number; quantity: number }
type BankDragSource = 'bank' | 'inventory';
type BankDropTarget = 'bank' | 'inventory';

interface BankTouchDragState {
  pointerId: number;
  source: BankDragSource;
  slot: number;
  itemId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  ghost: HTMLDivElement | null;
  dropTarget: BankDropTarget | null;
  sourceEl: HTMLDivElement;
  longPressTimer: number;
  contextMenuShown: boolean;
}

const BANK_TEXT_SHADOW = '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000';
const BANK_BUTTON_BG = 'rgba(43, 10, 8, 0.9)';
const BANK_BUTTON_HOVER_BG = 'rgba(78, 18, 14, 0.95)';
const BANK_BUTTON_BORDER = '#9a332b';
const TOUCH_DRAG_START_PX = 7;
const TOUCH_CONTEXT_MENU_LONG_PRESS_MS = 450;

/** Bank UI — opens inside the playable game frame with the bank grid on the left and a
 *  mirror of the player's inventory on the right.
 *  - Click a bank slot → withdraw 1
 *  - Right-click a bank slot → 5 / 10 / All
 *  - Click an inventory slot → deposit 1
 *  - Right-click an inventory slot → 5 / 10 / All
 *  All operations are server-authoritative; this panel only renders state
 *  pushed by BANK_OPEN / BANK_UPDATE_SLOT and the existing inventory packets.
 *  The close button (or Escape) sends BANK_CLOSE; the server is also free to send
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
  private touchDrag: BankTouchDragState | null = null;
  private suppressClickUntil: number = 0;
  private requestQuantity: QuantityInputRequester | null;

  constructor(network: NetworkManager, hooks: { requestQuantity?: QuantityInputRequester } = {}) {
    this.network = network;
    this.requestQuantity = hooks.requestQuantity ?? null;
    const built = this.buildUI();
    this.container = built.root;
    this.bankGridEl = built.bankGrid;
    this.invGridEl = built.invGrid;
    (document.getElementById('game-frame') ?? document.body).appendChild(this.container);

    // Escape closes the bank.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.visible) {
        e.preventDefault();
        e.stopPropagation();
        this.hide(/*notifyServer*/ true);
      }
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
      geometry: {
        kind: 'game-canvas',
        width: 'min(690px, calc(100% - var(--right-rail-width, 300px) - 18px))',
        maxHeight: 'calc(100% - var(--chat-height, 220px) - 18px)',
      },
      chrome: 'dialogue',
      closeButton: false,
      onClose: () => this.hide(true),
    });

    // Body — two columns
    const body = document.createElement('div');
    body.className = 'bank-panel-body';
    body.style.cssText = `display: flex; gap: 10px; padding: 9px 10px 6px; flex: 1; min-height: 0; overflow: hidden;`;

    // Bank column
    const bankCol = document.createElement('div');
    bankCol.className = 'bank-panel-bank-col';
    bankCol.style.cssText = `flex: 1.45 1 0; display: flex; flex-direction: column; min-height: 0; min-width: 0;`;
    const bankLabel = document.createElement('div');
    bankLabel.className = 'bank-panel-label';
    bankLabel.textContent = `Bank (${BANK_SIZE} slots)`;
    bankLabel.style.cssText = this.labelCss();
    bankCol.appendChild(bankLabel);

    const bankGrid = document.createElement('div');
    bankGrid.className = 'bank-panel-bank-grid';
    bankGrid.style.cssText = this.inventoryGridCss(8, true);
    this.addInventoryStitch(bankGrid);
    for (let i = 0; i < BANK_SIZE; i++) {
      const slot = this.makeSlot();
      this.installTouchDrag(slot, 'bank', i);
      slot.addEventListener('click', (e) => {
        if (this.shouldSuppressClick()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        this.onBankClick(i);
      });
      slot.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onBankRightClick(i, e); });
      bankGrid.appendChild(slot);
      this.bankSlotElements.push(slot);
    }
    bankCol.appendChild(bankGrid);
    body.appendChild(bankCol);

    // Inventory column
    const invCol = document.createElement('div');
    invCol.className = 'bank-panel-inv-col';
    invCol.style.cssText = `flex: 1 1 0; display: flex; flex-direction: column; min-width: 0;`;
    const invLabel = document.createElement('div');
    invLabel.className = 'bank-panel-label';
    invLabel.textContent = 'Inventory';
    invLabel.style.cssText = this.labelCss();
    invCol.appendChild(invLabel);

    const invGrid = document.createElement('div');
    invGrid.className = 'bank-panel-inv-grid';
    invGrid.style.cssText = this.inventoryGridCss(5, false);
    this.addInventoryStitch(invGrid);
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const slot = this.makeSlot();
      this.installTouchDrag(slot, 'inventory', i);
      slot.addEventListener('click', (e) => {
        if (this.shouldSuppressClick()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        this.onInvClick(i);
      });
      slot.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onInvRightClick(i, e); });
      invGrid.appendChild(slot);
      this.invSlotElements.push(slot);
    }
    invCol.appendChild(invGrid);
    body.appendChild(invCol);

    root.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'bank-panel-footer';
    footer.style.cssText = `display: flex; align-items: center; gap: 8px; padding: 0 10px 8px;`;
    const hint = document.createElement('div');
    hint.className = 'bank-panel-hint';
    hint.textContent = 'Left-click = 1 · Right-click = 5/10/X/All';
    hint.style.cssText = `flex: 1; min-width: 0; font-size: 11px; color: #f4ded5; opacity: 0.82; text-shadow: ${BANK_TEXT_SHADOW};`;
    footer.appendChild(hint);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = this.actionButtonCss();
    this.installButtonHover(closeBtn);
    closeBtn.onclick = () => this.hide(true);
    footer.appendChild(closeBtn);
    root.appendChild(footer);

    return { root, bankGrid, invGrid };
  }

  private inventoryGridCss(cols: number, scroll: boolean): string {
    return `
      display: grid;
      grid-template-columns: repeat(${cols}, minmax(var(--bank-slot-min-size, 44px), 1fr));
      grid-auto-rows: minmax(var(--bank-slot-min-size, 44px), auto);
      align-content: start;
      gap: 0;
      position: relative;
      overflow-y: ${scroll ? 'auto' : 'hidden'};
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      touch-action: pan-y;
      scrollbar-gutter: stable;
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
      flex: ${scroll ? '1 1 auto' : '0 0 auto'};
      min-height: 0;
    `;
  }

  private addInventoryStitch(grid: HTMLDivElement): void {
    const stitch = document.createElement('div');
    stitch.style.cssText = `
      position: absolute; inset: 3px;
      border: 1px dotted rgba(150, 82, 46, 0.38);
      border-radius: 1px;
      box-shadow: 0 0 0 1px rgba(35, 16, 9, 0.7);
      pointer-events: none; z-index: 1;
    `;
    grid.appendChild(stitch);
  }

  private makeSlot(): HTMLDivElement {
    const slot = document.createElement('div');
    slot.style.cssText = `
      width: 100%; aspect-ratio: 1 / 1;
      min-width: var(--bank-slot-min-size, 44px);
      min-height: var(--bank-slot-min-size, 44px);
      background: transparent; border: 0;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; position: relative; font-size: 9px;
      touch-action: pan-y; user-select: none; -webkit-user-select: none;
      -webkit-touch-callout: none;
      z-index: 2;
    `;
    slot.addEventListener('mouseenter', () => { slot.style.background = 'rgba(154,51,43,0.22)'; });
    slot.addEventListener('mouseleave', () => { slot.style.background = 'transparent'; });
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
      draggable: false,
      extraStyle: 'max-width:32px;max-height:32px;width:100%;height:100%;pointer-events:none;',
      quantity,
      placeholderSize: 24,
    });
  }

  private labelCss(): string {
    return `color: #f4ded5; font-size: 12px; margin-bottom: 5px; font-weight: bold; text-shadow: ${BANK_TEXT_SHADOW};`;
  }

  private actionButtonCss(): string {
    return `
      background: ${BANK_BUTTON_BG};
      border: 1px solid ${BANK_BUTTON_BORDER};
      color: #f4ded5;
      padding: 5px 11px;
      min-width: 74px;
      border-radius: 2px;
      cursor: pointer;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12px;
      font-weight: bold;
      text-shadow: ${BANK_TEXT_SHADOW};
      box-shadow: inset 0 0 0 1px rgba(255,190,150,0.08);
    `;
  }

  private installButtonHover(button: HTMLButtonElement): void {
    button.addEventListener('mouseenter', () => { if (!button.disabled) button.style.background = BANK_BUTTON_HOVER_BG; });
    button.addEventListener('mouseleave', () => { button.style.background = BANK_BUTTON_BG; });
  }

  private shouldSuppressClick(): boolean {
    return performance.now() < this.suppressClickUntil;
  }

  private installTouchDrag(slot: HTMLDivElement, source: BankDragSource, index: number): void {
    slot.addEventListener('pointerdown', (event) => this.beginTouchDrag(event, source, index, slot));
    slot.addEventListener('pointermove', (event) => this.moveTouchDrag(event));
    slot.addEventListener('pointerup', (event) => this.finishTouchDrag(event));
    slot.addEventListener('pointercancel', (event) => this.cancelTouchDrag(event));
    slot.addEventListener('lostpointercapture', (event) => this.cancelTouchDrag(event));
  }

  private beginTouchDrag(event: PointerEvent, source: BankDragSource, slot: number, sourceEl: HTMLDivElement): void {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const data = source === 'bank' ? this.bankSlots[slot] : this.invSlots[slot];
    if (!data) return;
    this.touchDrag = {
      pointerId: event.pointerId,
      source,
      slot,
      itemId: data.itemId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      ghost: null,
      dropTarget: null,
      sourceEl,
      longPressTimer: 0,
      contextMenuShown: false,
    };
    this.touchDrag.longPressTimer = window.setTimeout(() => {
      if (this.touchDrag !== null && this.touchDrag.pointerId === event.pointerId && !this.touchDrag.dragging) {
        this.touchDrag.contextMenuShown = true;
        this.suppressClickUntil = performance.now() + 700;
        suppressNextContextMenuClick(sourceEl, this.touchDrag.startX, this.touchDrag.startY);
        try {
          sourceEl.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is best-effort on mobile browsers.
        }
        if (source === 'bank') this.onBankRightClick(slot, event);
        else this.onInvRightClick(slot, event);
      }
    }, TOUCH_CONTEXT_MENU_LONG_PRESS_MS);
  }

  private moveTouchDrag(event: PointerEvent): void {
    const drag = this.touchDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.contextMenuShown) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < TOUCH_DRAG_START_PX) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.15) {
        this.clearTouchDrag(event.pointerId);
        return;
      }
      this.startTouchDragVisual(drag, event.clientX, event.clientY);
    }

    event.preventDefault();
    event.stopPropagation();
    this.moveTouchDragGhost(drag, event.clientX, event.clientY);
    this.setDropTarget(this.dropTargetAt(event.clientX, event.clientY));
  }

  private finishTouchDrag(event: PointerEvent): void {
    const drag = this.touchDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.contextMenuShown) {
      event.preventDefault();
      event.stopPropagation();
      this.suppressClickUntil = performance.now() + 350;
      this.clearTouchDrag(event.pointerId);
      return;
    }
    if (drag.dragging) {
      event.preventDefault();
      event.stopPropagation();
      const target = this.dropTargetAt(event.clientX, event.clientY);
      if (drag.source === 'inventory' && target === 'bank' && this.invSlots[drag.slot]?.itemId === drag.itemId) {
        this.sendBankQuantity(ClientOpcode.BANK_DEPOSIT, drag.slot, drag.itemId, 1);
      } else if (drag.source === 'bank' && target === 'inventory' && this.bankSlots[drag.slot]?.itemId === drag.itemId) {
        this.sendBankQuantity(ClientOpcode.BANK_WITHDRAW, drag.slot, drag.itemId, 1);
      }
      this.suppressClickUntil = performance.now() + 350;
    }
    this.clearTouchDrag(event.pointerId);
  }

  private cancelTouchDrag(event: PointerEvent): void {
    const drag = this.touchDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.clearTouchDrag(event.pointerId);
  }

  private startTouchDragVisual(drag: BankTouchDragState, clientX: number, clientY: number): void {
    window.clearTimeout(drag.longPressTimer);
    drag.dragging = true;
    drag.sourceEl.style.opacity = '0.45';
    try {
      drag.sourceEl.setPointerCapture(drag.pointerId);
    } catch {
      // Pointer capture is best-effort on mobile browsers.
    }
    const rect = drag.sourceEl.getBoundingClientRect();
    const ghost = drag.sourceEl.cloneNode(true) as HTMLDivElement;
    ghost.style.cssText = `
      position: fixed;
      left: 0;
      top: 0;
      width: ${Math.max(34, rect.width)}px;
      height: ${Math.max(34, rect.height)}px;
      z-index: 1000;
      pointer-events: none;
      opacity: 0.92;
      transform: translate(-50%, -50%);
      background: rgba(43, 10, 8, 0.88);
      border: 1px solid rgba(255, 200, 80, 0.75);
      border-radius: 3px;
      box-shadow: 0 5px 16px rgba(0,0,0,0.45);
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    this.moveTouchDragGhost(drag, clientX, clientY);
  }

  private moveTouchDragGhost(drag: BankTouchDragState, clientX: number, clientY: number): void {
    if (!drag.ghost) return;
    drag.ghost.style.left = `${clientX}px`;
    drag.ghost.style.top = `${clientY}px`;
  }

  private dropTargetAt(clientX: number, clientY: number): BankDropTarget | null {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!el) return null;
    if (this.bankGridEl.contains(el)) return 'bank';
    if (this.invGridEl.contains(el)) return 'inventory';
    return null;
  }

  private setDropTarget(target: BankDropTarget | null): void {
    const drag = this.touchDrag;
    if (!drag || drag.dropTarget === target) return;
    this.bankGridEl.style.outline = '';
    this.invGridEl.style.outline = '';
    drag.dropTarget = target;
    const validTarget =
      (drag.source === 'inventory' && target === 'bank')
      || (drag.source === 'bank' && target === 'inventory');
    if (!validTarget) return;
    const grid = target === 'bank' ? this.bankGridEl : this.invGridEl;
    grid.style.outline = '1px solid rgba(255, 200, 80, 0.9)';
    grid.style.outlineOffset = '-2px';
  }

  private clearTouchDrag(pointerId: number): void {
    const drag = this.touchDrag;
    if (!drag || drag.pointerId !== pointerId) return;
    this.setDropTarget(null);
    window.clearTimeout(drag.longPressTimer);
    drag.sourceEl.style.opacity = '';
    drag.ghost?.remove();
    this.touchDrag = null;
    try {
      if (drag.sourceEl.hasPointerCapture(pointerId)) drag.sourceEl.releasePointerCapture(pointerId);
    } catch {
      // Capture may already have been released by the browser.
    }
  }

  private onBankClick(slot: number): void {
    const s = this.bankSlots[slot];
    if (!s) return;
    this.sendBankQuantity(ClientOpcode.BANK_WITHDRAW, slot, s.itemId, 1);
  }
  private onBankRightClick(slot: number, ev: MouseEvent): void {
    const s = this.bankSlots[slot];
    if (!s) return;
    this.showQuantityMenu(ev, [
      { label: 'Withdraw 1', n: 1 },
      { label: 'Withdraw 5', n: 5 },
      { label: 'Withdraw 10', n: 10 },
      { label: 'Withdraw X', n: 0 },
      { label: 'Withdraw All', n: -1 },
    ], (n) => {
      if (n === 0) {
        this.promptWithdrawQuantity(slot, s);
        return;
      }
      this.sendBankQuantity(ClientOpcode.BANK_WITHDRAW, slot, s.itemId, n);
    });
  }
  private onInvClick(slot: number): void {
    const s = this.invSlots[slot];
    if (!s) return;
    this.sendBankQuantity(ClientOpcode.BANK_DEPOSIT, slot, s.itemId, 1);
  }
  private onInvRightClick(slot: number, ev: MouseEvent): void {
    const s = this.invSlots[slot];
    if (!s) return;
    this.showQuantityMenu(ev, [
      { label: 'Deposit 1', n: 1 },
      { label: 'Deposit 5', n: 5 },
      { label: 'Deposit 10', n: 10 },
      { label: 'Deposit X', n: 0 },
      { label: 'Deposit All', n: -1 },
    ], (n) => {
      if (n === 0) {
        this.promptDepositQuantity(slot, s);
        return;
      }
      this.sendBankQuantity(ClientOpcode.BANK_DEPOSIT, slot, s.itemId, n);
    });
  }

  private sendBankQuantity(opcode: ClientOpcode, slot: number, itemId: number, quantity: number): void {
    this.network.sendRaw(encodeQuantityPacket(opcode, slot, itemId, quantity));
  }

  private promptWithdrawQuantity(slot: number, original: BankSlotData): void {
    if (!this.requestQuantity || original.quantity <= 0) return;
    const name = this.itemName(original.itemId);
    this.requestQuantity({
      title: 'Withdraw X',
      prompt: `How many ${name} do you want to withdraw?`,
      max: original.quantity,
      submitLabel: 'Withdraw',
      onSubmit: (quantity) => {
        const current = this.bankSlots[slot];
        if (!this.visible || !current || current.itemId !== original.itemId) return;
        this.sendBankQuantity(ClientOpcode.BANK_WITHDRAW, slot, original.itemId, quantity);
      },
    });
  }

  private promptDepositQuantity(slot: number, original: BankSlotData): void {
    if (!this.requestQuantity) return;
    const max = this.maxDepositable(original);
    if (max <= 0) return;
    const name = this.itemName(original.itemId);
    this.requestQuantity({
      title: 'Deposit X',
      prompt: `How many ${name} do you want to deposit?`,
      max,
      submitLabel: 'Deposit',
      onSubmit: (quantity) => {
        const current = this.invSlots[slot];
        if (!this.visible || !current || current.itemId !== original.itemId) return;
        this.sendBankQuantity(ClientOpcode.BANK_DEPOSIT, slot, original.itemId, quantity);
      },
    });
  }

  private maxDepositable(original: BankSlotData): number {
    const def = this.itemDefs.get(original.itemId);
    if (def?.stackable) return original.quantity;
    return this.invSlots.reduce((total, slot) => total + (slot?.itemId === original.itemId ? 1 : 0), 0);
  }

  private itemName(itemId: number): string {
    return this.itemDefs.get(itemId)?.name ?? 'items';
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
