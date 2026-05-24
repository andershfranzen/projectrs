import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { EQUIP_SLOT_BONES } from '../data/EquipmentConfig';
import type { GearOverride } from '../data/EquipmentConfig';
import { getThumbnail } from '../rendering/ThumbnailRenderer';

type SlotGetter = (slot: string) => TransformNode | null;
type BoneGetter = (slot: string) => string;
type ItemInfoGetter = (slot: string) => { id: number; name: string; toolType?: string } | null;
type SaveCallback = (itemId: number, override: GearOverride) => Promise<void>;
type BulkSaveCallback = (sourceItemId: number, slot: string, override: GearOverride) => Promise<number>;
type LoadGlbCallback = (slot: string, path: string) => Promise<void>;
type AnimCallback = (anim: string) => void;
type UnequipCallback = (slot: string) => void;
type OverrideGetter = (itemId: number) => GearOverride | null;
type SkinnedChecker = (slot: string) => boolean;
type AuthTokenGetter = () => string;

interface GearFileInfo {
  file: string;
  path: string;
  itemId: number;
  name: string;
}

interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  fineStep: number;
  value: number;
  group: 'pos' | 'rot' | 'scale';
  color: string;
}

const PARAMS: ParamDef[] = [
  { key: 'pos.x', label: 'X', min: -1, max: 1, step: 0.001, fineStep: 0.001, value: 0, group: 'pos', color: '#f66' },
  { key: 'pos.y', label: 'Y', min: -1, max: 1, step: 0.001, fineStep: 0.001, value: 0, group: 'pos', color: '#6f6' },
  { key: 'pos.z', label: 'Z', min: -1, max: 1, step: 0.001, fineStep: 0.001, value: 0, group: 'pos', color: '#66f' },
  { key: 'rot.x', label: 'X', min: -3.15, max: 3.15, step: 0.01, fineStep: 0.001, value: 0, group: 'rot', color: '#f66' },
  { key: 'rot.y', label: 'Y', min: -3.15, max: 3.15, step: 0.01, fineStep: 0.001, value: 0, group: 'rot', color: '#6f6' },
  { key: 'rot.z', label: 'Z', min: -3.15, max: 3.15, step: 0.01, fineStep: 0.001, value: 0, group: 'rot', color: '#66f' },
  { key: 'scale', label: 'S', min: 0.05, max: 3, step: 0.01, fineStep: 0.001, value: 1, group: 'scale', color: '#f8c' },
];

const SLOTS = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];

const SLOT_COLORS: Record<string, string> = {
  weapon: '#f66', shield: '#66f', head: '#ff6', body: '#6cf',
  legs: '#c96', neck: '#f6f', ring: '#6f6', hands: '#fc6', feet: '#c6f', cape: '#6ff',
};

const ANIMS = ['idle', 'walk', 'attack', 'chop', 'mine'];
const THUMB_SIZE = 52;

export class GearDebugPanel {
  private container: HTMLDivElement;
  private visible = false;
  private target: TransformNode | null = null;
  private sliders: Map<string, HTMLInputElement> = new Map();
  private numInputs: Map<string, HTMLInputElement> = new Map();
  private slotButtons: Map<string, HTMLButtonElement> = new Map();
  private animButtons: Map<string, HTMLButtonElement> = new Map();
  private itemInfoLabel!: HTMLDivElement;
  private boneLabel!: HTMLSpanElement;
  private statusLabel!: HTMLSpanElement;
  private overrideStatusEl!: HTMLSpanElement;
  private glbInput!: HTMLInputElement;
  private thumbGrid!: HTMLDivElement;
  private thumbToggleBtn!: HTMLButtonElement;
  private getSlotNode: SlotGetter = () => null;
  private getSlotBone: BoneGetter = () => '';
  private getItemInfo: ItemInfoGetter = () => null;
  private saveCallback: SaveCallback | null = null;
  private bulkSaveCallback: BulkSaveCallback | null = null;
  private loadGlbCallback: LoadGlbCallback | null = null;
  private animCallback: AnimCallback | null = null;
  private unequipCallback: UnequipCallback | null = null;
  private overrideGetter: OverrideGetter = () => null;
  private isSkinnedArmor: SkinnedChecker = () => false;
  private getAuthToken: AuthTokenGetter = () => '';
  private activeSlot = 'weapon';
  private thumbGridOpen = true;
  private thumbCache: Map<string, string> = new Map();
  private slotFilesCache: Map<string, GearFileInfo[]> = new Map();
  private loadedGlbPath: string | null = null;

  // Drag state
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private isDragging = false;

  constructor() {
    this.container = this.buildUI();
    document.body.appendChild(this.container);
  }

  setSlotGetter(getter: SlotGetter): void { this.getSlotNode = getter; }
  setSlotBoneGetter(getter: BoneGetter): void { this.getSlotBone = getter; }
  setItemInfoGetter(getter: ItemInfoGetter): void { this.getItemInfo = getter; }
  setSaveCallback(cb: SaveCallback): void { this.saveCallback = cb; }
  setBulkSaveCallback(cb: BulkSaveCallback): void { this.bulkSaveCallback = cb; }
  setLoadGlbCallback(cb: LoadGlbCallback): void { this.loadGlbCallback = cb; }
  setAnimCallback(cb: AnimCallback): void { this.animCallback = cb; }
  setUnequipCallback(cb: UnequipCallback): void { this.unequipCallback = cb; }
  setOverrideGetter(getter: OverrideGetter): void { this.overrideGetter = getter; }
  setSkinnedChecker(checker: SkinnedChecker): void { this.isSkinnedArmor = checker; }
  setAuthTokenGetter(getter: AuthTokenGetter): void { this.getAuthToken = getter; }

  private buildUI(): HTMLDivElement {
    const div = document.createElement('div');
    div.id = 'gear-debug-panel';
    Object.assign(div.style, {
      position: 'fixed', top: '60px', left: '10px', width: '320px',
      maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
      background: 'rgba(15,12,8,0.95)', color: '#ddd', fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: '12px', borderRadius: '6px', zIndex: '9999',
      userSelect: 'none', border: '1px solid #554a3a',
      boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
    });
    div.style.display = 'none';

    // Draggable title bar
    const titleBar = document.createElement('div');
    Object.assign(titleBar.style, {
      padding: '8px 12px', cursor: 'move',
      background: 'rgba(20,16,10,0.98)',
      borderBottom: '1px solid #3a3020',
      borderRadius: '6px 6px 0 0',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      flexShrink: '0',
    });
    const title = document.createElement('span');
    title.style.cssText = 'font-weight:bold;color:#d8372b;font-size:13px;letter-spacing:1px;';
    title.textContent = 'GEAR FITTING';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      background: 'none', border: 'none', color: '#666', fontSize: '18px',
      cursor: 'pointer', padding: '0 4px', lineHeight: '1',
    });
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#f66'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#666'; });
    closeBtn.addEventListener('click', () => this.toggle());
    titleBar.appendChild(title);
    titleBar.appendChild(closeBtn);
    div.appendChild(titleBar);

    // Drag handlers
    titleBar.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragOffsetX = e.clientX - div.offsetLeft;
      this.dragOffsetY = e.clientY - div.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      div.style.left = `${e.clientX - this.dragOffsetX}px`;
      div.style.top = `${e.clientY - this.dragOffsetY}px`;
      div.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { this.isDragging = false; });

    // Scrollable body
    const body = document.createElement('div');
    Object.assign(body.style, {
      padding: '10px 12px 12px', overflowY: 'auto', flex: '1',
    });

    // Slot grid
    const slotGrid = document.createElement('div');
    slotGrid.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-bottom:8px;';
    for (const slot of SLOTS) {
      const btn = document.createElement('button');
      btn.textContent = slot;
      Object.assign(btn.style, {
        padding: '4px 6px', cursor: 'pointer',
        background: '#1a1510', color: '#555',
        border: '1px solid #2a2520', borderRadius: '3px',
        fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '10px',
        transition: 'all 0.15s',
      });
      btn.addEventListener('click', () => this.switchSlot(slot));
      slotGrid.appendChild(btn);
      this.slotButtons.set(slot, btn);
    }
    body.appendChild(slotGrid);

    // Item info + override status
    this.itemInfoLabel = document.createElement('div');
    Object.assign(this.itemInfoLabel.style, {
      padding: '6px 8px', marginBottom: '4px',
      background: '#1a1510', borderRadius: '4px',
      border: '1px solid #2a2520', minHeight: '32px',
    });
    body.appendChild(this.itemInfoLabel);

    this.overrideStatusEl = document.createElement('div');
    this.overrideStatusEl.style.cssText = 'font-size:10px;margin-bottom:6px;padding:0 2px;';
    body.appendChild(this.overrideStatusEl);

    this.boneLabel = document.createElement('div');
    this.boneLabel.style.cssText = 'color:#555;font-size:10px;margin-bottom:8px;';
    body.appendChild(this.boneLabel);

    // --- Thumbnail browser section ---
    const thumbHeader = document.createElement('div');
    thumbHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;';
    const thumbLabel = document.createElement('span');
    thumbLabel.style.cssText = 'color:#aaa;font-size:10px;font-weight:bold;';
    thumbLabel.textContent = 'AVAILABLE GEAR';
    this.thumbToggleBtn = document.createElement('button');
    this.thumbToggleBtn.textContent = '▾';
    Object.assign(this.thumbToggleBtn.style, {
      background: 'none', border: 'none', color: '#666', cursor: 'pointer',
      fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '12px', padding: '0 4px',
    });
    this.thumbToggleBtn.addEventListener('click', () => {
      this.thumbGridOpen = !this.thumbGridOpen;
      this.thumbGrid.style.display = this.thumbGridOpen ? 'grid' : 'none';
      this.thumbToggleBtn.textContent = this.thumbGridOpen ? '▾' : '▸';
    });
    thumbHeader.appendChild(thumbLabel);
    thumbHeader.appendChild(this.thumbToggleBtn);
    body.appendChild(thumbHeader);

    this.thumbGrid = document.createElement('div');
    Object.assign(this.thumbGrid.style, {
      display: 'grid',
      gridTemplateColumns: `repeat(auto-fill, minmax(${THUMB_SIZE + 8}px, 1fr))`,
      gap: '4px', marginBottom: '8px',
      maxHeight: '200px', overflowY: 'auto',
      background: '#0e0c08', borderRadius: '4px',
      border: '1px solid #1a1510', padding: '4px',
    });
    body.appendChild(this.thumbGrid);

    // Load GLB manual input
    const glbRow = document.createElement('div');
    glbRow.style.cssText = 'display:flex;gap:4px;margin-bottom:10px;';
    this.glbInput = document.createElement('input');
    this.glbInput.type = 'text';
    this.glbInput.placeholder = '/assets/equipment/weapon/99.glb';
    Object.assign(this.glbInput.style, {
      flex: '1', background: '#1a1510', color: '#ddd',
      border: '1px solid #3a3530', borderRadius: '3px',
      padding: '4px 6px', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '10px',
    });
    const loadBtn = this.makeButton('Load', '#1a2a3a', '#48c', () => this.loadGlb());
    loadBtn.style.fontSize = '10px';
    loadBtn.style.padding = '4px 8px';
    glbRow.appendChild(this.glbInput);
    glbRow.appendChild(loadBtn);
    body.appendChild(glbRow);

    // Control groups
    const groups: [string, string, ParamDef[]][] = [
      ['Position', '#8cf', PARAMS.filter(p => p.group === 'pos')],
      ['Rotation', '#cf8', PARAMS.filter(p => p.group === 'rot')],
      ['Scale', '#f8c', PARAMS.filter(p => p.group === 'scale')],
    ];

    for (const [groupName, color, params] of groups) {
      const groupLabel = document.createElement('div');
      groupLabel.style.cssText = `color:${color};font-size:11px;font-weight:bold;margin:6px 0 3px;`;
      groupLabel.textContent = groupName;
      body.appendChild(groupLabel);

      for (const p of params) {
        body.appendChild(this.buildRow(p));
      }
    }

    // Animation toggles
    const animLabel = document.createElement('div');
    animLabel.style.cssText = 'color:#aaa;font-size:10px;font-weight:bold;margin:10px 0 4px;';
    animLabel.textContent = 'PREVIEW ANIM';
    body.appendChild(animLabel);

    const animRow = document.createElement('div');
    animRow.style.cssText = 'display:flex;gap:3px;margin-bottom:10px;';
    for (const anim of ANIMS) {
      const btn = document.createElement('button');
      btn.textContent = anim;
      Object.assign(btn.style, {
        flex: '1', padding: '4px 2px', cursor: 'pointer',
        background: anim === 'idle' ? '#2a2a20' : '#12100c',
        color: anim === 'idle' ? '#d8372b' : '#666',
        border: `1px solid ${anim === 'idle' ? '#554a3a' : '#2a2520'}`,
        borderRadius: '3px', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '10px',
      });
      btn.addEventListener('click', () => this.playAnim(anim));
      animRow.appendChild(btn);
      this.animButtons.set(anim, btn);
    }
    body.appendChild(animRow);

    // Action buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;';

    const saveBtn = this.makeButton('Save', '#1a3a1a', '#4a4', () => this.saveOverride());
    const applySlotBtn = this.makeButton('Apply Slot', '#1a2f3a', '#48a', () => this.applyToSlotClass());
    const copyBtn = this.makeButton('Copy', '#2a3a2a', '#484', () => this.copyCode());
    const resetBtn = this.makeButton('Reset', '#3a2a1a', '#a84', () => this.resetToDefaults());
    const zeroBtn = this.makeButton('Zero', '#4a2a2a', '#a44', () => this.resetAll());
    const unequipBtn = this.makeButton('Unequip', '#2a1a2a', '#a4a', () => this.unequipSlot());
    saveBtn.style.flex = '2';
    applySlotBtn.style.flex = '2';
    copyBtn.style.flex = '1';
    resetBtn.style.flex = '1';
    zeroBtn.style.flex = '1';
    unequipBtn.style.flex = '1';
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(applySlotBtn);
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(resetBtn);
    btnRow.appendChild(zeroBtn);
    btnRow.appendChild(unequipBtn);
    body.appendChild(btnRow);

    // Status
    this.statusLabel = document.createElement('div');
    this.statusLabel.style.cssText = 'color:#666;font-size:10px;margin-top:6px;text-align:center;height:14px;';
    body.appendChild(this.statusLabel);

    div.appendChild(body);
    return div;
  }

  private buildRow(p: ParamDef): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;margin-bottom:2px;gap:4px;';

    const label = document.createElement('span');
    label.style.cssText = `width:14px;flex-shrink:0;color:${p.color};font-weight:bold;font-size:11px;`;
    label.textContent = p.label;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(p.min);
    slider.max = String(p.max);
    slider.step = String(p.step);
    slider.value = String(p.value);
    slider.style.cssText = `flex:1;height:14px;cursor:pointer;accent-color:${p.color};`;

    const numInput = document.createElement('input');
    numInput.type = 'number';
    numInput.min = String(p.min);
    numInput.max = String(p.max);
    numInput.step = String(p.fineStep);
    numInput.value = p.value.toFixed(3);
    Object.assign(numInput.style, {
      width: '58px', flexShrink: '0', background: '#1a1510', color: '#ddd',
      border: '1px solid #3a3530', borderRadius: '2px', padding: '1px 3px',
      fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '11px', textAlign: 'right',
    });

    const resetBtn = document.createElement('button');
    resetBtn.textContent = '↺';
    Object.assign(resetBtn.style, {
      width: '18px', height: '18px', flexShrink: '0', background: 'none',
      color: '#666', border: 'none', cursor: 'pointer', padding: '0',
      fontSize: '12px', lineHeight: '18px',
    });
    resetBtn.addEventListener('mouseenter', () => { resetBtn.style.color = '#d8372b'; });
    resetBtn.addEventListener('mouseleave', () => { resetBtn.style.color = '#666'; });

    slider.addEventListener('input', () => {
      numInput.value = parseFloat(slider.value).toFixed(3);
      this.applyToTarget();
      this.updateOverrideStatus();
    });
    numInput.addEventListener('input', () => {
      const v = parseFloat(numInput.value);
      if (!isNaN(v)) {
        slider.value = String(v);
        this.applyToTarget();
        this.updateOverrideStatus();
      }
    });
    resetBtn.addEventListener('click', () => {
      let def = p.group === 'scale' ? 1 : 0;
      if (!this.isSkinnedArmor(this.activeSlot)) {
        const defaults = EQUIP_SLOT_BONES[this.activeSlot];
        if (defaults) {
          if (p.key === 'pos.x') def = defaults.localPosition.x;
          else if (p.key === 'pos.y') def = defaults.localPosition.y;
          else if (p.key === 'pos.z') def = defaults.localPosition.z;
          else if (p.key === 'rot.x') def = defaults.localRotation.x;
          else if (p.key === 'rot.y') def = defaults.localRotation.y;
          else if (p.key === 'rot.z') def = defaults.localRotation.z;
          else if (p.key === 'scale') def = defaults.scale;
        }
      }
      slider.value = String(def);
      numInput.value = def.toFixed(3);
      this.applyToTarget();
      this.updateOverrideStatus();
    });

    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(numInput);
    row.appendChild(resetBtn);

    this.sliders.set(p.key, slider);
    this.numInputs.set(p.key, numInput);
    return row;
  }

  private makeButton(text: string, bg: string, borderColor: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    Object.assign(btn.style, {
      padding: '5px 8px', cursor: 'pointer', background: bg, color: '#ddd',
      border: `1px solid ${borderColor}`, borderRadius: '3px',
      fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '11px',
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'flex' : 'none';
    if (this.visible) {
      this.switchSlot(this.activeSlot);
    } else {
      if (this.animCallback) this.animCallback('idle');
    }
  }

  private updateSlotButtons(): void {
    for (const [slot, btn] of this.slotButtons) {
      const hasGear = !!this.getSlotNode(slot);
      const isActive = slot === this.activeSlot;
      const color = SLOT_COLORS[slot] || '#888';

      if (isActive) {
        btn.style.background = '#3a3020';
        btn.style.color = color;
        btn.style.border = `1px solid ${color}`;
        btn.style.fontWeight = 'bold';
      } else if (hasGear) {
        btn.style.background = '#1a1510';
        btn.style.color = color;
        btn.style.border = `1px solid ${color}44`;
        btn.style.fontWeight = 'normal';
      } else {
        btn.style.background = '#1a1510';
        btn.style.color = '#444';
        btn.style.border = '1px solid #2a2520';
        btn.style.fontWeight = 'normal';
      }
    }
  }

  private switchSlot(slot: string): void {
    this.activeSlot = slot;
    this.updateSlotButtons();

    const node = this.getSlotNode(slot);
    const bone = this.getSlotBone(slot);
    const item = this.getItemInfo(slot);
    const color = SLOT_COLORS[slot] || '#888';

    if (node && item) {
      this.itemInfoLabel.innerHTML = '';
      const nameEl = document.createElement('div');
      nameEl.style.cssText = `color:${color};font-size:13px;font-weight:bold;`;
      nameEl.textContent = item.name;
      this.itemInfoLabel.appendChild(nameEl);

      const detailEl = document.createElement('div');
      detailEl.style.cssText = 'color:#888;font-size:10px;margin-top:2px;';
      const parts = [`id: ${item.id}`, `slot: ${slot}`];
      if (item.toolType) parts.push(`tool: ${item.toolType}`);
      detailEl.textContent = parts.join('  |  ');
      this.itemInfoLabel.appendChild(detailEl);

      this.itemInfoLabel.style.borderColor = `${color}44`;
    } else {
      this.itemInfoLabel.innerHTML = `<span style="color:#555;font-size:11px;">No gear in <span style="color:${color}">${slot}</span> slot</span>`;
      this.itemInfoLabel.style.borderColor = '#2a2520';
    }

    this.boneLabel.textContent = bone ? `bone: ${bone}` : '';

    if (node) {
      this.target = node;
      this.setVal('pos.x', node.position.x);
      this.setVal('pos.y', node.position.y);
      this.setVal('pos.z', node.position.z);
      this.setVal('rot.x', node.rotation.x);
      this.setVal('rot.y', node.rotation.y);
      this.setVal('rot.z', node.rotation.z);
      this.setVal('scale', node.scaling.x);
    } else {
      this.target = null;
    }

    const existingOverride = item ? this.overrideGetter(item.id) : null;
    this.loadedGlbPath = existingOverride?.file || null;

    this.updateOverrideStatus();
    this.loadThumbGrid(slot);
  }

  // --- Thumbnail grid ---

  private async loadThumbGrid(slot: string): Promise<void> {
    this.thumbGrid.innerHTML = '';

    let files: GearFileInfo[] = this.slotFilesCache.get(slot) || [];
    if (files.length === 0 && !this.slotFilesCache.has(slot)) {
      try {
        const token = this.getAuthToken();
        const res = await fetch(`/api/dev/gear-files?slot=${slot}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const data = await res.json();
        files = data.files || [];
      } catch { /* keep empty */ }
      this.slotFilesCache.set(slot, files);
    }

    if (files.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#444;font-size:10px;text-align:center;padding:8px;grid-column:1/-1;';
      empty.textContent = `No gear files in /assets/equipment/${slot}/`;
      this.thumbGrid.appendChild(empty);
      return;
    }

    const equippedItemId = this.getItemInfo(slot)?.id ?? -1;
    const color = SLOT_COLORS[slot] || '#888';

    for (const info of files) {
      const cell = document.createElement('div');
      const isEquipped = info.itemId === equippedItemId && equippedItemId > 0;
      const isLoadedPreview = info.path === this.loadedGlbPath;

      Object.assign(cell.style, {
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '3px', cursor: 'pointer',
        background: (isEquipped || isLoadedPreview) ? `${color}18` : '#1a1510',
        border: `1px solid ${(isEquipped || isLoadedPreview) ? color : '#2a2520'}`,
        borderRadius: '4px', transition: 'all 0.1s',
      });

      // Thumbnail
      const thumbEl = document.createElement('div');
      Object.assign(thumbEl.style, {
        width: `${THUMB_SIZE}px`, height: `${THUMB_SIZE}px`,
        background: '#0e0c08', borderRadius: '3px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      });

      const cached = this.thumbCache.get(info.path);
      if (cached) {
        const img = document.createElement('img');
        img.src = cached;
        img.style.cssText = `width:${THUMB_SIZE}px;height:${THUMB_SIZE}px;object-fit:contain;`;
        thumbEl.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.style.cssText = 'color:#333;font-size:9px;';
        placeholder.textContent = '...';
        thumbEl.appendChild(placeholder);
        this.renderThumb(info.path, thumbEl);
      }
      cell.appendChild(thumbEl);

      // Label
      const labelEl = document.createElement('div');
      Object.assign(labelEl.style, {
        color: (isEquipped || isLoadedPreview) ? color : '#999', fontSize: '8px',
        fontWeight: (isEquipped || isLoadedPreview) ? 'bold' : 'normal',
        marginTop: '2px', textAlign: 'center',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        width: '100%',
      });
      labelEl.textContent = info.name;
      cell.appendChild(labelEl);

      cell.title = `${info.name} (${info.file})`;
      cell.addEventListener('click', () => this.loadGlbFromGrid(info));
      cell.addEventListener('mouseenter', () => {
        if (!isEquipped && !isLoadedPreview) { cell.style.background = '#252015'; cell.style.borderColor = '#3a3520'; }
      });
      cell.addEventListener('mouseleave', () => {
        if (!isEquipped && !isLoadedPreview) { cell.style.background = '#1a1510'; cell.style.borderColor = '#2a2520'; }
      });

      this.thumbGrid.appendChild(cell);
    }
  }

  private async renderThumb(path: string, container: HTMLElement): Promise<void> {
    const url = await getThumbnail(path);
    if (url) {
      this.thumbCache.set(path, url);
      container.innerHTML = '';
      const img = document.createElement('img');
      img.src = url;
      img.style.cssText = `width:${THUMB_SIZE}px;height:${THUMB_SIZE}px;object-fit:contain;`;
      container.appendChild(img);
    } else {
      container.innerHTML = '<div style="color:#444;font-size:8px;">fail</div>';
    }
  }

  private async loadGlbFromGrid(info: GearFileInfo): Promise<void> {
    if (!this.loadGlbCallback) return;
    this.flashStatus(`Loading ${info.name}...`);
    try {
      await this.loadGlbCallback(this.activeSlot, info.path);
      this.loadedGlbPath = info.path;
      // Refresh view after a tick so the attached gear node is available
      setTimeout(() => {
        this.switchSlot(this.activeSlot);
        this.flashStatus(`Loaded ${info.name}`);
      }, 100);
    } catch (e: any) {
      this.flashStatus(`Failed: ${e.message || e}`);
    }
  }

  // --- Override status ---

  private updateOverrideStatus(): void {
    const item = this.getItemInfo(this.activeSlot);
    if (!item) {
      this.overrideStatusEl.innerHTML = '';
      return;
    }

    const override = this.overrideGetter(item.id);
    const skinned = this.isSkinnedArmor(this.activeSlot);
    const defaults = EQUIP_SLOT_BONES[this.activeSlot];
    const zeroDefaults = { localPosition: { x: 0, y: 0, z: 0 }, localRotation: { x: 0, y: 0, z: 0 }, scale: 1 };
    const def = skinned ? zeroDefaults : defaults;
    if (!def) {
      this.overrideStatusEl.innerHTML = '';
      return;
    }

    const saved = override || {
      localPosition: def.localPosition,
      localRotation: def.localRotation,
      scale: def.scale,
    };
    const ref = {
      px: saved.localPosition?.x ?? def.localPosition.x,
      py: saved.localPosition?.y ?? def.localPosition.y,
      pz: saved.localPosition?.z ?? def.localPosition.z,
      rx: saved.localRotation?.x ?? def.localRotation.x,
      ry: saved.localRotation?.y ?? def.localRotation.y,
      rz: saved.localRotation?.z ?? def.localRotation.z,
      s: saved.scale ?? def.scale,
    };

    const cur = {
      px: this.getVal('pos.x'), py: this.getVal('pos.y'), pz: this.getVal('pos.z'),
      rx: this.getVal('rot.x'), ry: this.getVal('rot.y'), rz: this.getVal('rot.z'),
      s: this.getVal('scale'),
    };

    const close = (a: number, b: number) => Math.abs(a - b) < 0.001;
    const matches = close(cur.px, ref.px) && close(cur.py, ref.py) && close(cur.pz, ref.pz)
      && close(cur.rx, ref.rx) && close(cur.ry, ref.ry) && close(cur.rz, ref.rz)
      && close(cur.s, ref.s);

    if (override && matches) {
      this.overrideStatusEl.innerHTML = '<span style="color:#4a4;">● saved override</span>';
    } else if (!override && matches) {
      this.overrideStatusEl.innerHTML = '<span style="color:#666;">○ slot default</span>';
    } else {
      this.overrideStatusEl.innerHTML = '<span style="color:#d8372b;">● unsaved changes</span>';
    }
  }

  // --- Values ---

  private setVal(key: string, value: number): void {
    const slider = this.sliders.get(key);
    const num = this.numInputs.get(key);
    if (slider) slider.value = String(value);
    if (num) num.value = value.toFixed(3);
  }

  private getVal(key: string): number {
    return parseFloat(this.numInputs.get(key)?.value ?? '0');
  }

  private applyToTarget(): void {
    if (!this.target) return;
    this.target.position.set(this.getVal('pos.x'), this.getVal('pos.y'), this.getVal('pos.z'));
    this.target.rotation.set(this.getVal('rot.x'), this.getVal('rot.y'), this.getVal('rot.z'));
    const s = this.getVal('scale');
    this.target.scaling.set(s, s, s);
  }

  private resetToDefaults(): void {
    if (this.isSkinnedArmor(this.activeSlot)) {
      this.setVal('pos.x', 0); this.setVal('pos.y', 0); this.setVal('pos.z', 0);
      this.setVal('rot.x', 0); this.setVal('rot.y', 0); this.setVal('rot.z', 0);
      this.setVal('scale', 1);
    } else {
      const defaults = EQUIP_SLOT_BONES[this.activeSlot];
      if (!defaults) return;
      this.setVal('pos.x', defaults.localPosition.x);
      this.setVal('pos.y', defaults.localPosition.y);
      this.setVal('pos.z', defaults.localPosition.z);
      this.setVal('rot.x', defaults.localRotation.x);
      this.setVal('rot.y', defaults.localRotation.y);
      this.setVal('rot.z', defaults.localRotation.z);
      this.setVal('scale', defaults.scale);
    }
    this.applyToTarget();
    this.updateOverrideStatus();
    this.flashStatus('Reset to slot defaults');
  }

  private resetAll(): void {
    for (const p of PARAMS) {
      const def = p.group === 'scale' ? 1 : 0;
      this.setVal(p.key, def);
    }
    this.applyToTarget();
    this.updateOverrideStatus();
    this.flashStatus('Reset to zero');
  }

  private unequipSlot(): void {
    if (!this.unequipCallback) return;
    this.unequipCallback(this.activeSlot);
    this.loadedGlbPath = null;
    this.target = null;
    this.switchSlot(this.activeSlot);
    this.flashStatus(`Unequipped ${this.activeSlot}`);
  }

  private async saveOverride(): Promise<void> {
    const item = this.getItemInfo(this.activeSlot);
    if (!item) {
      this.flashStatus('No item to save');
      return;
    }
    if (!this.saveCallback) {
      this.flashStatus('Save not available');
      return;
    }

    const override = this.buildCurrentOverride(true);
    if (!override) {
      this.flashStatus('Could not build override');
      return;
    }

    try {
      await this.saveCallback(item.id, override);
      this.updateOverrideStatus();
      this.flashStatus(`Saved override for item ${item.id}`);
    } catch (e: any) {
      this.flashStatus(`Save failed: ${e.message || e}`);
    }
  }

  private buildCurrentOverride(includeFile: boolean): GearOverride | null {
    const item = this.getItemInfo(this.activeSlot);
    if (!item) return null;

    const override: GearOverride = {
      localPosition: { x: this.getVal('pos.x'), y: this.getVal('pos.y'), z: this.getVal('pos.z') },
      localRotation: { x: this.getVal('rot.x'), y: this.getVal('rot.y'), z: this.getVal('rot.z') },
      scale: this.getVal('scale'),
    };

    const defaults = EQUIP_SLOT_BONES[this.activeSlot];
    const currentBone = this.getSlotBone(this.activeSlot);
    if (defaults && currentBone !== defaults.boneName) {
      override.boneName = currentBone;
    }

    if (includeFile && this.loadedGlbPath) {
      const defaultPath = `/assets/equipment/${this.activeSlot}/${item.id}.glb`;
      if (this.loadedGlbPath !== defaultPath) {
        override.file = this.loadedGlbPath;
      }
    }

    return override;
  }

  private async applyToSlotClass(): Promise<void> {
    const item = this.getItemInfo(this.activeSlot);
    if (!item) {
      this.flashStatus('No source item');
      return;
    }
    if (!this.bulkSaveCallback) {
      this.flashStatus('Bulk save not available');
      return;
    }

    const override = this.buildCurrentOverride(false);
    if (!override) {
      this.flashStatus('Could not build override');
      return;
    }
    const currentBone = this.getSlotBone(this.activeSlot);
    if (currentBone) override.boneName = currentBone;

    const ok = window.confirm(
      `Apply ${item.name}'s pose to every modeled item in the ${this.activeSlot} slot?\n\n` +
      'This copies position, rotation, scale, and bone only. It does not copy the GLB file.'
    );
    if (!ok) return;

    try {
      const count = await this.bulkSaveCallback(item.id, this.activeSlot, override);
      this.updateOverrideStatus();
      this.flashStatus(`Applied pose to ${count} ${this.activeSlot} item(s)`);
    } catch (e: any) {
      this.flashStatus(`Bulk save failed: ${e.message || e}`);
    }
  }

  private copyCode(): void {
    const slot = this.activeSlot;
    const item = this.getItemInfo(slot);
    const px = this.getVal('pos.x'), py = this.getVal('pos.y'), pz = this.getVal('pos.z');
    const rx = this.getVal('rot.x'), ry = this.getVal('rot.y'), rz = this.getVal('rot.z');
    const s = this.getVal('scale');

    let code: string;
    if (item) {
      code = `// ${item.name} (id: ${item.id}${item.toolType ? `, toolType: ${item.toolType}` : ''})\n"${item.id}": { "localPosition": { "x": ${px}, "y": ${py}, "z": ${pz} }, "localRotation": { "x": ${rx}, "y": ${ry}, "z": ${rz} }, "scale": ${s} }`;
    } else {
      const bone = this.getSlotBone(slot);
      code = `// ${slot}\n${slot}: { boneName: '${bone}', localPosition: { x: ${px}, y: ${py}, z: ${pz} }, localRotation: { x: ${rx}, y: ${ry}, z: ${rz} }, scale: ${s} },`;
    }

    navigator.clipboard.writeText(code).then(() => {
      this.flashStatus('Copied to clipboard');
    }).catch(() => {
      this.flashStatus('Copy failed — see console');
    });
    console.log(`[GearDebug] ${code}`);
  }

  private async loadGlb(): Promise<void> {
    const path = this.glbInput.value.trim();
    if (!path) {
      this.flashStatus('Enter a GLB path');
      return;
    }
    if (!this.loadGlbCallback) {
      this.flashStatus('Load GLB not available');
      return;
    }
    this.flashStatus('Loading...');
    try {
      await this.loadGlbCallback(this.activeSlot, path);
      this.loadedGlbPath = path;
      setTimeout(() => {
        this.switchSlot(this.activeSlot);
        this.flashStatus('Loaded');
      }, 100);
    } catch (e: any) {
      this.flashStatus(`Load failed: ${e.message || e}`);
    }
  }

  private playAnim(anim: string): void {
    if (this.animCallback) this.animCallback(anim);

    for (const [name, btn] of this.animButtons) {
      const isActive = name === anim;
      btn.style.background = isActive ? '#2a2a20' : '#12100c';
      btn.style.color = isActive ? '#d8372b' : '#666';
      btn.style.border = `1px solid ${isActive ? '#554a3a' : '#2a2520'}`;
    }
  }

  private flashStatus(msg: string): void {
    this.statusLabel.textContent = msg;
    this.statusLabel.style.color = '#d8372b';
    setTimeout(() => {
      this.statusLabel.style.color = '#666';
      this.statusLabel.textContent = '';
    }, 2000);
  }

  dispose(): void {
    this.container.remove();
  }
}
