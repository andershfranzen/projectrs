import { ClientOpcode, DUEL_STAKE_SIZE, INVENTORY_SIZE, encodePacket, encodeQuantityPacket, type ItemDef } from '@projectrs/shared';
import type { NetworkManager } from '../managers/NetworkManager';
import { createModalPanel } from './ModalPanel';
import { closeActiveContextMenu, createContextMenu, installLongPressContextMenu } from './popupStyle';
import { renderItemSlot } from '../rendering/ItemIcon';

interface StakeSlotData { itemId: number; quantity: number }

const DUEL_TEXT_SHADOW = '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000';
const DUEL_BUTTON_BG = 'rgba(43, 10, 8, 0.9)';
const DUEL_BUTTON_HOVER_BG = 'rgba(78, 18, 14, 0.95)';
const DUEL_BUTTON_BORDER = '#9a332b';

export class DuelPanel {
  private container: HTMLDivElement;
  private network: NetworkManager;
  private onClose: (() => void) | null;
  private itemDefs: Map<number, ItemDef> = new Map();
  private visible = false;
  private myStake: (StakeSlotData | null)[] = new Array(DUEL_STAKE_SIZE).fill(null);
  private theirStake: (StakeSlotData | null)[] = new Array(DUEL_STAKE_SIZE).fill(null);
  private invSlots: (StakeSlotData | null)[] = new Array(INVENTORY_SIZE).fill(null);
  private myStakeEls: HTMLDivElement[] = [];
  private theirStakeEls: HTMLDivElement[] = [];
  private otherName: string = '';
  private acceptBtn!: HTMLButtonElement;
  private declineBtn!: HTMLButtonElement;
  private statusLabel!: HTMLDivElement;
  private titleEl!: HTMLSpanElement;

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
    for (let i = 0; i < this.myStake.length; i++) this.renderStakeSlot('mine', i);
    for (let i = 0; i < this.theirStake.length; i++) this.renderStakeSlot('theirs', i);
  }

  updateInventorySlot(slot: number, itemId: number, quantity: number): void {
    if (slot < 0 || slot >= this.invSlots.length) return;
    this.invSlots[slot] = itemId === 0 ? null : { itemId, quantity };
  }

  openSession(otherEntityId: number, otherName: string): void {
    void otherEntityId;
    closeActiveContextMenu();
    this.otherName = otherName;
    this.titleEl.textContent = `Duel with ${otherName}`;
    this.myStake.fill(null);
    this.theirStake.fill(null);
    for (let i = 0; i < this.myStake.length; i++) this.renderStakeSlot('mine', i);
    for (let i = 0; i < this.theirStake.length; i++) this.renderStakeSlot('theirs', i);
    this.updateAcceptState(0, 0);
    this.visible = true;
    this.container.style.display = 'flex';
  }

  /** side: 0=mine, 1=theirs */
  updateStake(side: number, slot: number, itemId: number, quantity: number): void {
    const arr = side === 0 ? this.myStake : this.theirStake;
    if (slot < 0 || slot >= arr.length) return;
    arr[slot] = itemId === 0 ? null : { itemId, quantity };
    this.renderStakeSlot(side === 0 ? 'mine' : 'theirs', slot);
  }

  updateAcceptState(myStage: number, theirStage: number): void {
    if (myStage === 0 && theirStage === 0) {
      this.statusLabel.textContent = 'Click inventory items to stake.';
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
      this.statusLabel.textContent = 'Confirm duel.';
      this.statusLabel.style.color = '#d8372b';
      this.acceptBtn.textContent = 'Confirm';
      this.acceptBtn.disabled = false;
    } else if (myStage === 2 && theirStage < 2) {
      this.statusLabel.textContent = `Waiting for ${this.otherName} to confirm...`;
      this.statusLabel.style.color = '#aaa';
      this.acceptBtn.textContent = 'Waiting...';
      this.acceptBtn.disabled = true;
    } else if (myStage >= 2 && theirStage >= 2) {
      this.statusLabel.textContent = 'Duel confirmed.';
      this.statusLabel.style.color = '#aaa';
      this.acceptBtn.textContent = 'Confirmed';
      this.acceptBtn.disabled = true;
    }
  }

  close(_reason: number): void {
    const wasVisible = this.visible;
    this.visible = false;
    this.container.style.display = 'none';
    this.myStake.fill(null);
    this.theirStake.fill(null);
    for (let i = 0; i < this.myStake.length; i++) this.renderStakeSlot('mine', i);
    for (let i = 0; i < this.theirStake.length; i++) this.renderStakeSlot('theirs', i);
    if (wasVisible) this.onClose?.();
  }

  offerInventorySlot(slot: number, quantity: number): void {
    const s = this.invSlots[slot];
    if (!s) return;
    this.network.sendRaw(encodeQuantityPacket(ClientOpcode.DUEL_STAKE_ITEM, slot, s.itemId, quantity));
  }

  private removeStakeSlot(slot: number, quantity: number): void {
    const s = this.myStake[slot];
    if (!s) return;
    this.network.sendRaw(encodeQuantityPacket(ClientOpcode.DUEL_REMOVE_STAKE, slot, s.itemId, quantity));
  }

  private buildUI(): HTMLDivElement {
    const modal = createModalPanel({
      id: 'duel-panel',
      title: 'Duel',
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

    const stakesRow = document.createElement('div');
    stakesRow.style.cssText = `display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 8px 10px 5px;`;

    const myWrap = document.createElement('div');
    const myLabel = document.createElement('div');
    myLabel.textContent = 'My stake';
    myLabel.style.cssText = this.labelCss();
    myWrap.appendChild(myLabel);
    const myGrid = this.makeGrid(5, DUEL_STAKE_SIZE, (slot) => {
      this.removeStakeSlot(slot, 1);
    }, (slot, ev) => {
      const s = this.myStake[slot];
      if (!s) return;
      this.showQtyMenu(ev, [
        { label: 'Remove 1', n: 1 },
        { label: 'Remove 5', n: 5 },
        { label: 'Remove 10', n: 10 },
        { label: 'Remove All', n: -1 },
      ], (n) => this.removeStakeSlot(slot, n));
    }, this.myStakeEls);
    myWrap.appendChild(myGrid);
    stakesRow.appendChild(myWrap);

    const theirWrap = document.createElement('div');
    const theirLabel = document.createElement('div');
    theirLabel.textContent = 'Their stake';
    theirLabel.style.cssText = this.labelCss();
    theirWrap.appendChild(theirLabel);
    const theirGrid = this.makeGrid(5, DUEL_STAKE_SIZE, () => {}, () => {}, this.theirStakeEls);
    theirWrap.appendChild(theirGrid);
    stakesRow.appendChild(theirWrap);
    root.appendChild(stakesRow);

    const ctrlRow = document.createElement('div');
    ctrlRow.style.cssText = `display: flex; gap: 6px; padding: 0 10px 6px; align-items: center;`;
    this.statusLabel = document.createElement('div');
    this.statusLabel.style.cssText = `flex: 1; font-size: 12px; color: #f4ded5; min-width: 0; text-shadow: ${DUEL_TEXT_SHADOW};`;
    this.statusLabel.textContent = 'Click inventory items to stake.';
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
    ctrlRow.appendChild(this.acceptBtn);
    ctrlRow.appendChild(this.declineBtn);
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
        touch-action: manipulation;
        user-select: none; -webkit-user-select: none;
        -webkit-touch-callout: none;
        z-index: 2;
      `;
      cell.addEventListener('mouseenter', () => { cell.style.background = 'rgba(154,51,43,0.22)'; });
      cell.addEventListener('mouseleave', () => { cell.style.background = 'transparent'; });
      cell.addEventListener('click', () => onClick(i));
      cell.addEventListener('contextmenu', (e) => { e.preventDefault(); onRight(i, e); });
      installLongPressContextMenu(cell, (e) => onRight(i, e));
      grid.appendChild(cell);
      sink.push(cell);
    }
    return grid;
  }

  private renderStakeSlot(side: 'mine' | 'theirs', i: number): void {
    const els = side === 'mine' ? this.myStakeEls : this.theirStakeEls;
    const arr = side === 'mine' ? this.myStake : this.theirStake;
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
    return `color: #f4ded5; font-size: 12px; margin-bottom: 4px; font-weight: bold; text-shadow: ${DUEL_TEXT_SHADOW};`;
  }

  private actionButtonCss(): string {
    return `
      background: ${DUEL_BUTTON_BG};
      border: 1px solid ${DUEL_BUTTON_BORDER};
      color: #f4ded5;
      padding: 5px 10px;
      min-width: 70px;
      border-radius: 2px;
      cursor: pointer;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12px;
      font-weight: bold;
      text-shadow: ${DUEL_TEXT_SHADOW};
      box-shadow: inset 0 0 0 1px rgba(255,190,150,0.08);
    `;
  }

  private installButtonHover(button: HTMLButtonElement): void {
    button.addEventListener('mouseenter', () => { if (!button.disabled) button.style.background = DUEL_BUTTON_HOVER_BG; });
    button.addEventListener('mouseleave', () => { button.style.background = DUEL_BUTTON_BG; });
  }

  private sendAccept(): void {
    this.network.sendRaw(encodePacket(ClientOpcode.DUEL_ACCEPT));
  }

  private sendDecline(): void {
    this.network.sendRaw(encodePacket(ClientOpcode.DUEL_DECLINE));
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
