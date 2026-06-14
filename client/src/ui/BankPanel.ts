import { ClientOpcode, encodePacket, encodeQuantityPacket, BANK_SIZE, type ItemDef } from '@projectrs/shared';
import type { NetworkManager } from '../managers/NetworkManager';
import { createModalPanel } from './ModalPanel';
import { closeActiveContextMenu, createContextMenu, suppressNextContextMenuClick } from './popupStyle';
import { renderItemSlot } from '../rendering/ItemIcon';
import type { QuantityInputRequester } from './QuantityInputPanel';

interface BankSlotData { itemId: number; quantity: number }
type QuantityMenuOption = { label: string; n?: number; action?: () => void };

interface BankTouchDragState {
  pointerId: number;
  slot: number;
  itemId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  ghost: HTMLDivElement | null;
  dropSlot: number | null;
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
const BANK_SLOT_DRAG_MIME = 'application/x-evilquest-bank-slot';

/** Bank UI — opens inside the playable game frame with the bank grid.
 *  - Click a bank slot → withdraw 1
 *  - Right-click a bank slot → 5 / 10 / All
 *  - Deposit from the normal inventory panel while the bank is open
 *  All operations are server-authoritative; this panel only renders state
 *  pushed by BANK_OPEN / BANK_UPDATE_SLOT.
 *  The close button (or Escape) sends BANK_CLOSE; the server is also free to send
 *  a server-driven BANK_CLOSE when the player walks/attacks/etc. */
export class BankPanel {
  private container: HTMLDivElement;
  private bankGridEl: HTMLDivElement;
  private bankSlots: (BankSlotData | null)[] = new Array(BANK_SIZE).fill(null);
  private bankSlotElements: HTMLDivElement[] = [];
  private network: NetworkManager;
  private itemDefs: Map<number, ItemDef> = new Map();
  private visible: boolean = false;
  private touchDrag: BankTouchDragState | null = null;
  private suppressClickUntil: number = 0;
  private requestQuantity: QuantityInputRequester | null;
  private adminItemDeletionEnabled: boolean = false;
  private withdrawMode: 'item' | 'note' = 'item';
  private withdrawItemButton: HTMLButtonElement | null = null;
  private withdrawNoteButton: HTMLButtonElement | null = null;

  constructor(network: NetworkManager, hooks: { requestQuantity?: QuantityInputRequester } = {}) {
    this.network = network;
    this.requestQuantity = hooks.requestQuantity ?? null;
    const built = this.buildUI();
    this.container = built.root;
    this.bankGridEl = built.bankGrid;
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

  show(): void {
    closeActiveContextMenu();
    this.visible = true;
    this.container.style.display = 'flex';
    this.sendWithdrawMode();
  }
  hide(notifyServer: boolean): void {
    this.visible = false;
    this.container.style.display = 'none';
    if (notifyServer) this.network.sendRaw(encodePacket(ClientOpcode.BANK_CLOSE));
  }
  isVisible(): boolean { return this.visible; }

  setAdminItemDeletionEnabled(enabled: boolean): void {
    this.adminItemDeletionEnabled = enabled;
  }

  private buildUI(): { root: HTMLDivElement; bankGrid: HTMLDivElement } {
    const { root } = createModalPanel({
      id: 'bank-panel',
      title: 'Bank of EvilQuest',
      geometry: {
        kind: 'game-canvas',
        width: 'min(520px, calc(100% - var(--right-rail-width, 300px) - 18px))',
        maxHeight: 'calc(100% - var(--chat-height, 220px) - 18px)',
      },
      chrome: 'dialogue',
      closeButton: false,
      onClose: () => this.hide(true),
    });

    // Body — bank contents only; deposits use the real inventory panel.
    const body = document.createElement('div');
    body.className = 'bank-panel-body';
    body.style.cssText = `display: flex; padding: 9px 10px 6px; flex: 1; min-height: 0; overflow: hidden;`;

    // Bank column
    const bankCol = document.createElement('div');
    bankCol.className = 'bank-panel-bank-col';
    bankCol.style.cssText = `flex: 1.45 1 0; display: flex; flex-direction: column; min-height: 0; min-width: 0;`;
    const bankHeader = document.createElement('div');
    bankHeader.className = 'bank-panel-header';
    bankHeader.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:5px;';
    const bankLabel = document.createElement('div');
    bankLabel.className = 'bank-panel-label';
    bankLabel.textContent = `Bank (${BANK_SIZE} slots)`;
    bankLabel.style.cssText = `${this.labelCss()}margin-bottom:0;flex:1;min-width:0;`;
    bankHeader.appendChild(bankLabel);
    const modeToggle = this.makeWithdrawModeToggle();
    bankHeader.appendChild(modeToggle);
    bankCol.appendChild(bankHeader);

    const bankGrid = document.createElement('div');
    bankGrid.className = 'bank-panel-bank-grid';
    bankGrid.style.cssText = this.inventoryGridCss(8, true);
    this.addInventoryStitch(bankGrid);
    for (let i = 0; i < BANK_SIZE; i++) {
      const slot = this.makeSlot();
      slot.dataset.bankSlot = String(i);
      this.installTouchDrag(slot, i);
      this.installBankSlotDrag(slot, i);
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

    root.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'bank-panel-footer';
    footer.style.cssText = `display: flex; align-items: center; gap: 8px; padding: 0 10px 8px;`;
    const hint = document.createElement('div');
    hint.className = 'bank-panel-hint';
    hint.textContent = 'Left-click bank = withdraw 1 · Right-click bank = 5/10/X/All · Deposit from Inventory';
    hint.style.cssText = `flex: 1; min-width: 0; font-size: 11px; color: #f4ded5; opacity: 0.82; text-shadow: ${BANK_TEXT_SHADOW};`;
    footer.appendChild(hint);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = this.actionButtonCss();
    this.installButtonHover(closeBtn);
    closeBtn.onclick = () => this.hide(true);
    footer.appendChild(closeBtn);
    root.appendChild(footer);

    return { root, bankGrid };
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
    if (!s) {
      el.innerHTML = '';
      el.draggable = false;
      return;
    }
    el.draggable = true;
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

  private makeWithdrawModeToggle(): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = `
      display: grid;
      grid-template-columns: repeat(2, 44px);
      border: 1px solid ${BANK_BUTTON_BORDER};
      background: rgba(18, 8, 5, 0.92);
      box-shadow: inset 0 0 0 1px rgba(255,190,150,0.08);
    `;
    this.withdrawItemButton = this.makeModeButton('Item', 'item');
    this.withdrawNoteButton = this.makeModeButton('Note', 'note');
    wrap.append(this.withdrawItemButton, this.withdrawNoteButton);
    this.refreshWithdrawModeButtons();
    return wrap;
  }

  private makeModeButton(label: string, mode: 'item' | 'note'): HTMLButtonElement {
    const button = document.createElement('button');
    button.textContent = label;
    button.style.cssText = `
      border: 0;
      border-radius: 0;
      padding: 4px 0;
      cursor: pointer;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 11px;
      font-weight: bold;
      color: #f4ded5;
      text-shadow: ${BANK_TEXT_SHADOW};
      background: transparent;
    `;
    button.onclick = () => this.setWithdrawMode(mode);
    return button;
  }

  private setWithdrawMode(mode: 'item' | 'note'): void {
    if (this.withdrawMode === mode) return;
    this.withdrawMode = mode;
    this.refreshWithdrawModeButtons();
    this.sendWithdrawMode();
  }

  private refreshWithdrawModeButtons(): void {
    if (this.withdrawItemButton) this.withdrawItemButton.style.background = this.withdrawMode === 'item' ? BANK_BUTTON_HOVER_BG : 'transparent';
    if (this.withdrawNoteButton) this.withdrawNoteButton.style.background = this.withdrawMode === 'note' ? BANK_BUTTON_HOVER_BG : 'transparent';
  }

  private sendWithdrawMode(): void {
    this.network.sendRaw(encodePacket(ClientOpcode.BANK_SET_WITHDRAW_MODE, this.withdrawMode === 'note' ? 1 : 0));
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

  private installTouchDrag(slot: HTMLDivElement, index: number): void {
    slot.addEventListener('pointerdown', (event) => this.beginTouchDrag(event, index, slot));
    slot.addEventListener('pointermove', (event) => this.moveTouchDrag(event));
    slot.addEventListener('pointerup', (event) => this.finishTouchDrag(event));
    slot.addEventListener('pointercancel', (event) => this.cancelTouchDrag(event));
    slot.addEventListener('lostpointercapture', (event) => this.cancelTouchDrag(event));
  }

  private beginTouchDrag(event: PointerEvent, slot: number, sourceEl: HTMLDivElement): void {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const data = this.bankSlots[slot];
    if (!data) return;
    this.touchDrag = {
      pointerId: event.pointerId,
      slot,
      itemId: data.itemId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      ghost: null,
      dropSlot: null,
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
        this.onBankRightClick(slot, event);
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
    this.setDropTarget(this.bankSlotAt(event.clientX, event.clientY));
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
      const targetSlot = this.bankSlotAt(event.clientX, event.clientY);
      if (targetSlot !== null && targetSlot !== drag.slot && this.bankSlots[drag.slot]?.itemId === drag.itemId) {
        this.network.sendRaw(encodePacket(ClientOpcode.BANK_MOVE_ITEM, drag.slot, targetSlot, drag.itemId));
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

  private bankSlotAt(clientX: number, clientY: number): number | null {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const slotEl = el && this.bankGridEl.contains(el) ? el.closest('[data-bank-slot]') as HTMLElement | null : null;
    const slot = slotEl?.dataset.bankSlot;
    if (slot === undefined) return null;
    const parsed = Number(slot);
    return Number.isInteger(parsed) ? parsed : null;
  }

  private setDropTarget(targetSlot: number | null): void {
    const drag = this.touchDrag;
    if (!drag || drag.dropSlot === targetSlot) return;
    if (drag.dropSlot !== null) this.bankSlotElements[drag.dropSlot]?.style.removeProperty('outline');
    drag.dropSlot = targetSlot;
    if (targetSlot === null || targetSlot === drag.slot) return;
    this.bankSlotElements[targetSlot].style.outline = '1px solid rgba(255, 200, 80, 0.9)';
    this.bankSlotElements[targetSlot].style.outlineOffset = '-2px';
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

  private installBankSlotDrag(slot: HTMLDivElement, index: number): void {
    slot.addEventListener('dragstart', (event) => {
      const data = this.bankSlots[index];
      if (!data) {
        event.preventDefault();
        return;
      }
      if (!event.dataTransfer) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData(BANK_SLOT_DRAG_MIME, String(index));
      event.dataTransfer.effectAllowed = 'move';
      slot.style.opacity = '0.45';
    });
    slot.addEventListener('dragend', () => {
      slot.style.opacity = '';
      this.clearBankDragOver();
    });
    slot.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      slot.style.outline = '1px solid rgba(255, 200, 80, 0.9)';
      slot.style.outlineOffset = '-2px';
    });
    slot.addEventListener('dragleave', () => {
      slot.style.removeProperty('outline');
    });
    slot.addEventListener('drop', (event) => {
      event.preventDefault();
      this.clearBankDragOver();
      const fromStr = event.dataTransfer?.getData(BANK_SLOT_DRAG_MIME);
      if (!fromStr) return;
      const from = parseInt(fromStr, 10);
      if (!Number.isInteger(from) || from === index) return;
      const src = this.bankSlots[from];
      if (!src) return;
      this.network.sendRaw(encodePacket(ClientOpcode.BANK_MOVE_ITEM, from, index, src.itemId));
      this.suppressClickUntil = performance.now() + 350;
    });
  }

  private clearBankDragOver(): void {
    for (const el of this.bankSlotElements) el.style.removeProperty('outline');
  }

  private onBankClick(slot: number): void {
    const s = this.bankSlots[slot];
    if (!s) return;
    this.sendBankQuantity(ClientOpcode.BANK_WITHDRAW, slot, s.itemId, 1);
  }
  private onBankRightClick(slot: number, ev: MouseEvent): void {
    const s = this.bankSlots[slot];
    if (!s) return;
    const name = this.itemName(s.itemId);
    const options: QuantityMenuOption[] = [
      { label: 'Withdraw 1', n: 1 },
      { label: 'Withdraw 5', n: 5 },
      { label: 'Withdraw 10', n: 10 },
      { label: 'Withdraw X', n: 0 },
      { label: 'Withdraw All', n: -1 },
    ];
    if (this.adminItemDeletionEnabled) {
      options.push({
        label: `Delete ${name}`,
        action: () => this.network.sendRaw(encodePacket(ClientOpcode.BANK_DELETE, slot, s.itemId)),
      });
    }
    this.showQuantityMenu(ev, options, (n) => {
      if (n === 0) {
        this.promptWithdrawQuantity(slot, s);
        return;
      }
      this.sendBankQuantity(ClientOpcode.BANK_WITHDRAW, slot, s.itemId, n);
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

  private itemName(itemId: number): string {
    return this.itemDefs.get(itemId)?.name ?? 'items';
  }

  private showQuantityMenu(ev: MouseEvent, opts: QuantityMenuOption[], cb: (n: number) => void): void {
    createContextMenu(opts.map((opt) => ({
      label: opt.label,
      action: () => opt.action ? opt.action() : cb(opt.n ?? 1),
    })), {
      x: ev.clientX,
      y: ev.clientY,
      minWidthPx: 110,
    });
  }
}
