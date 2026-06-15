import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Space } from '@babylonjs/core/Maths/math.axis';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { HEAD_RENDER_MODES, type HeadRenderMode } from '../../../shared/types';
import { EQUIP_SLOT_BONES, HEAD_HAIR_MORPH_KEYS, type GearOverride, type HeadHairFit, type HeadHairMorphKey } from '../data/EquipmentConfig';
import { getThumbnail } from '../rendering/ThumbnailRenderer';

type SlotGetter = (slot: string) => TransformNode | null;
type BoneGetter = (slot: string) => string;
type ItemInfoGetter = (slot: string) => { id: number; name: string; toolType?: string; modelPath?: string; headRenderMode?: HeadRenderMode } | null;
type SaveCallback = (itemId: number, override: GearOverride) => Promise<void>;
type BulkSaveCallback = (sourceItemId: number, slot: string, override: GearOverride) => Promise<number>;
type LoadGlbCallback = (slot: string, path: string, itemId?: number, override?: GearOverride) => Promise<void>;
type AnimCallback = (anim: string) => void;
type UnequipCallback = (slot: string) => void;
type OverrideGetter = (itemId: number) => GearOverride | null;
type SkinnedChecker = (slot: string) => boolean;
type AuthTokenGetter = () => string;
type BodyTypeGetter = () => number;
type HeadHairPreviewCallback = (fit: HeadHairFit | null) => void;

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
  group: 'pos' | 'rot' | 'mesh' | 'scale';
  color: string;
}

const PARAMS: ParamDef[] = [
  { key: 'pos.x', label: 'X', min: -1, max: 1, step: 0.001, fineStep: 0.001, value: 0, group: 'pos', color: '#f66' },
  { key: 'pos.y', label: 'Y', min: -1, max: 1, step: 0.001, fineStep: 0.001, value: 0, group: 'pos', color: '#6f6' },
  { key: 'pos.z', label: 'Z', min: -1, max: 1, step: 0.001, fineStep: 0.001, value: 0, group: 'pos', color: '#66f' },
  { key: 'rot.x', label: 'X', min: -3.15, max: 3.15, step: 0.01, fineStep: 0.001, value: 0, group: 'rot', color: '#f66' },
  { key: 'rot.y', label: 'Y', min: -3.15, max: 3.15, step: 0.01, fineStep: 0.001, value: 0, group: 'rot', color: '#6f6' },
  { key: 'rot.z', label: 'Z', min: -3.15, max: 3.15, step: 0.01, fineStep: 0.001, value: 0, group: 'rot', color: '#66f' },
  { key: 'mesh.x', label: 'X', min: -1, max: 1, step: 0.001, fineStep: 0.001, value: 0, group: 'mesh', color: '#f66' },
  { key: 'mesh.y', label: 'Y', min: -1, max: 1, step: 0.001, fineStep: 0.001, value: 0, group: 'mesh', color: '#6f6' },
  { key: 'mesh.z', label: 'Z', min: -1, max: 1, step: 0.001, fineStep: 0.001, value: 0, group: 'mesh', color: '#66f' },
  { key: 'scale', label: 'S', min: 0.05, max: 3, step: 0.01, fineStep: 0.001, value: 1, group: 'scale', color: '#f8c' },
];
const PARAM_BY_KEY = new Map(PARAMS.map((p) => [p.key, p]));

const HEAD_HAIR_PARAM_DEFS: { key: HeadHairMorphKey; label: string; title: string }[] = [
  { key: 'topFlatten', label: 'TOP', title: 'Flatten hair above the hat brim' },
  { key: 'topLower', label: 'LOW', title: 'Lower the upper hair volume' },
  { key: 'sideSqueeze', label: 'SIDE', title: 'Pull side volume inward' },
  { key: 'backTuck', label: 'BACK', title: 'Tuck rear hair under the hat' },
  { key: 'frontTrim', label: 'FRNT', title: 'Pull front hair back from the brim' },
];

const HEAD_HAIR_MODE_LABELS: Record<HeadRenderMode, string> = {
  helmet: 'Full helmet',
  hat: 'Normal hair',
  hairTuck: 'Generic tuck',
  hairFit: 'Custom fit',
};

const SLOTS = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];

const SLOT_COLORS: Record<string, string> = {
  weapon: '#f66', shield: '#66f', head: '#ff6', body: '#6cf',
  legs: '#c96', neck: '#f6f', ring: '#6f6', hands: '#fc6', feet: '#c6f', cape: '#6ff',
};

const MOVE_NUDGE_STEPS = [0.001, 0.01, 0.05];
const ROTATION_NUDGE_STEPS = [
  { label: '5', value: Math.PI / 36 },
  { label: '15', value: Math.PI / 12 },
  { label: '45', value: Math.PI / 4 },
  { label: '90', value: Math.PI / 2 },
];
const ANIMS: { key: string; label: string }[] = [
  { key: 'idle', label: 'idle' },
  { key: 'walk', label: 'walk' },
  { key: 'attack', label: 'attack' },
  { key: 'chop', label: 'chop' },
  { key: 'mine', label: 'mine' },
  { key: 'fish_net', label: 'net' },
  { key: 'fish_rod', label: 'rod' },
  { key: 'fish_harpoon', label: 'harpoon' },
];
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
  private centerOriginInput!: HTMLInputElement;
  private thumbGrid!: HTMLDivElement;
  private thumbToggleBtn!: HTMLButtonElement;
  private headHairSection!: HTMLDivElement;
  private headHairModeSelect!: HTMLSelectElement;
  private headHairInputs: Map<HeadHairMorphKey, HTMLInputElement> = new Map();
  private headHairSliders: Map<HeadHairMorphKey, HTMLInputElement> = new Map();
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
  private getBodyType: BodyTypeGetter = () => 0;
  private headHairPreviewCallback: HeadHairPreviewCallback | null = null;
  private activeSlot = 'weapon';
  private thumbGridOpen = true;
  private thumbCache: Map<string, string> = new Map();
  private slotFilesCache: Map<string, GearFileInfo[]> = new Map();
  private loadedGlbSlot: string | null = null;
  private loadedGlbPath: string | null = null;
  private loadedGlbItemId: number | undefined;
  private loadedPreviewOverride: GearOverride | null = null;
  private previewReloadSeq = 0;
  private moveNudgeStep = 0.01;
  private rotationNudgeStep = Math.PI / 12;
  private moveStepButtons: HTMLButtonElement[] = [];
  private rotationStepButtons: HTMLButtonElement[] = [];
  private meshOffsetBaseTarget: TransformNode | null = null;
  private meshOffsetBasePositions: Map<TransformNode, Vector3> = new Map();

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
  setBodyTypeGetter(getter: BodyTypeGetter): void { this.getBodyType = getter; }
  setHeadHairPreviewCallback(cb: HeadHairPreviewCallback): void { this.headHairPreviewCallback = cb; }

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
    thumbLabel.textContent = 'BRONZE BASE FITS';
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

    const pivotModeRow = document.createElement('label');
    pivotModeRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:-4px 0 8px;color:#888;font-size:10px;';
    this.centerOriginInput = document.createElement('input');
    this.centerOriginInput.type = 'checkbox';
    this.centerOriginInput.style.cssText = 'margin:0;accent-color:#8cf;';
    this.centerOriginInput.addEventListener('change', () => {
      this.updateOverrideStatus();
      void this.reloadCurrentPreview('Origin mode applied');
    });
    const pivotModeText = document.createElement('span');
    pivotModeText.textContent = 'keep authored GLB origin on load';
    pivotModeRow.appendChild(this.centerOriginInput);
    pivotModeRow.appendChild(pivotModeText);
    body.appendChild(pivotModeRow);

    // Control groups
    const groups: [string, string, ParamDef[]][] = [
      ['Position', '#8cf', PARAMS.filter(p => p.group === 'pos')],
      ['Rotation', '#cf8', PARAMS.filter(p => p.group === 'rot')],
      ['Visual Offset', '#fc8', PARAMS.filter(p => p.group === 'mesh')],
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
      if (groupName === 'Position') {
        body.appendChild(this.buildMoveNudgeSection());
      } else if (groupName === 'Rotation') {
        body.appendChild(this.buildRotationNudgeSection());
      } else if (groupName === 'Visual Offset') {
        body.appendChild(this.buildMeshOffsetNudgeSection());
      }
    }

    this.headHairSection = this.buildHeadHairSection();
    body.appendChild(this.headHairSection);

    // Animation toggles
    const animLabel = document.createElement('div');
    animLabel.style.cssText = 'color:#aaa;font-size:10px;font-weight:bold;margin:10px 0 4px;';
    animLabel.textContent = 'PREVIEW ANIM';
    body.appendChild(animLabel);

    const animRow = document.createElement('div');
    animRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-bottom:10px;';
    for (const anim of ANIMS) {
      const btn = document.createElement('button');
      btn.textContent = anim.label;
      btn.title = anim.key;
      Object.assign(btn.style, {
        flex: '1 0 46px', padding: '4px 2px', cursor: 'pointer',
        background: anim.key === 'idle' ? '#2a2a20' : '#12100c',
        color: anim.key === 'idle' ? '#d8372b' : '#666',
        border: `1px solid ${anim.key === 'idle' ? '#554a3a' : '#2a2520'}`,
        borderRadius: '3px', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '10px',
      });
      btn.addEventListener('click', () => this.playAnim(anim.key));
      animRow.appendChild(btn);
      this.animButtons.set(anim.key, btn);
    }
    body.appendChild(animRow);

    // Action buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;';

    const saveBtn = this.makeButton('Save', '#1a3a1a', '#4a4', () => this.saveOverride());
    const applySlotBtn = this.makeButton('Apply Family', '#1a2f3a', '#48a', () => this.applyToSlotClass());
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

  private buildMoveNudgeSection(): HTMLDivElement {
    const section = this.buildNudgeSection();
    const header = this.buildStepHeader('MOVE STEP');
    this.moveStepButtons = [];
    for (const step of MOVE_NUDGE_STEPS) {
      const btn = this.makeNudgeButton(step.toString(), `Use ${step}m movement nudges`, () => {
        this.moveNudgeStep = step;
        this.updateMoveStepButtons();
      });
      btn.dataset.step = String(step);
      this.moveStepButtons.push(btn);
      header.appendChild(btn);
    }
    section.appendChild(header);
    section.appendChild(this.buildNudgeButtonRow('VIEW', [
      { text: 'L', title: 'Move left on screen', onClick: () => this.nudgeViewPosition('right', -1) },
      { text: 'R', title: 'Move right on screen', onClick: () => this.nudgeViewPosition('right', 1) },
      { text: 'U', title: 'Move up on screen', onClick: () => this.nudgeViewPosition('up', 1) },
      { text: 'D', title: 'Move down on screen', onClick: () => this.nudgeViewPosition('up', -1) },
      { text: 'IN', title: 'Move into the screen', onClick: () => this.nudgeViewPosition('forward', 1) },
      { text: 'OUT', title: 'Move out of the screen', onClick: () => this.nudgeViewPosition('forward', -1) },
    ]));
    section.appendChild(this.buildNudgeButtonRow('WORLD', [
      { text: 'X-', title: 'Move along world -X', onClick: () => this.nudgeWorldPosition('x', -1) },
      { text: 'X+', title: 'Move along world +X', onClick: () => this.nudgeWorldPosition('x', 1) },
      { text: 'Y-', title: 'Move along world -Y', onClick: () => this.nudgeWorldPosition('y', -1) },
      { text: 'Y+', title: 'Move along world +Y', onClick: () => this.nudgeWorldPosition('y', 1) },
      { text: 'Z-', title: 'Move along world -Z', onClick: () => this.nudgeWorldPosition('z', -1) },
      { text: 'Z+', title: 'Move along world +Z', onClick: () => this.nudgeWorldPosition('z', 1) },
    ]));
    this.updateMoveStepButtons();
    return section;
  }

  private buildRotationNudgeSection(): HTMLDivElement {
    const section = this.buildNudgeSection();
    const header = this.buildStepHeader('ROT STEP');
    this.rotationStepButtons = [];
    for (const step of ROTATION_NUDGE_STEPS) {
      const btn = this.makeNudgeButton(step.label, `Use ${step.label} degree rotation nudges`, () => {
        this.rotationNudgeStep = step.value;
        this.updateRotationStepButtons();
      });
      btn.dataset.step = String(step.value);
      this.rotationStepButtons.push(btn);
      header.appendChild(btn);
    }
    section.appendChild(header);
    section.appendChild(this.buildNudgeButtonRow('LOCAL', [
      { text: 'X-', title: 'Rotate around local -X', onClick: () => this.nudgeRotation('x', -1) },
      { text: 'X+', title: 'Rotate around local +X', onClick: () => this.nudgeRotation('x', 1) },
      { text: 'Y-', title: 'Rotate around local -Y', onClick: () => this.nudgeRotation('y', -1) },
      { text: 'Y+', title: 'Rotate around local +Y', onClick: () => this.nudgeRotation('y', 1) },
      { text: 'Z-', title: 'Rotate around local -Z', onClick: () => this.nudgeRotation('z', -1) },
      { text: 'Z+', title: 'Rotate around local +Z', onClick: () => this.nudgeRotation('z', 1) },
    ]));
    section.appendChild(this.buildNudgeButtonRow('VIEW', [
      { text: 'P-', title: 'Pitch down on screen', onClick: () => this.nudgeViewRotation('right', -1) },
      { text: 'P+', title: 'Pitch up on screen', onClick: () => this.nudgeViewRotation('right', 1) },
      { text: 'Y-', title: 'Yaw left on screen', onClick: () => this.nudgeViewRotation('up', -1) },
      { text: 'Y+', title: 'Yaw right on screen', onClick: () => this.nudgeViewRotation('up', 1) },
      { text: 'R-', title: 'Roll counter-clockwise on screen', onClick: () => this.nudgeViewRotation('forward', -1) },
      { text: 'R+', title: 'Roll clockwise on screen', onClick: () => this.nudgeViewRotation('forward', 1) },
    ]));
    section.appendChild(this.buildNudgeButtonRow('WORLD', [
      { text: 'X-', title: 'Rotate around world -X', onClick: () => this.nudgeWorldRotation('x', -1) },
      { text: 'X+', title: 'Rotate around world +X', onClick: () => this.nudgeWorldRotation('x', 1) },
      { text: 'Y-', title: 'Rotate around world -Y', onClick: () => this.nudgeWorldRotation('y', -1) },
      { text: 'Y+', title: 'Rotate around world +Y', onClick: () => this.nudgeWorldRotation('y', 1) },
      { text: 'Z-', title: 'Rotate around world -Z', onClick: () => this.nudgeWorldRotation('z', -1) },
      { text: 'Z+', title: 'Rotate around world +Z', onClick: () => this.nudgeWorldRotation('z', 1) },
    ]));
    this.updateRotationStepButtons();
    return section;
  }

  private buildMeshOffsetNudgeSection(): HTMLDivElement {
    const section = this.buildNudgeSection();
    section.appendChild(this.buildNudgeButtonRow('AUTO', [
      { text: 'CENTER', title: 'Move mesh so its bounds center sits on the attachment pivot', onClick: () => this.snapMeshOffsetToBounds('center') },
      { text: 'BOTTOM', title: 'Move mesh so its lower bounds center sits on the attachment pivot', onClick: () => this.snapMeshOffsetToBounds('bottom') },
      { text: 'RESET', title: 'Clear visual offset', onClick: () => this.resetMeshOffset() },
    ]));
    section.appendChild(this.buildNudgeButtonRow('VIEW', [
      { text: 'L', title: 'Move mesh left on screen without moving the attachment pivot', onClick: () => this.nudgeViewMeshOffset('right', -1) },
      { text: 'R', title: 'Move mesh right on screen without moving the attachment pivot', onClick: () => this.nudgeViewMeshOffset('right', 1) },
      { text: 'U', title: 'Move mesh up on screen without moving the attachment pivot', onClick: () => this.nudgeViewMeshOffset('up', 1) },
      { text: 'D', title: 'Move mesh down on screen without moving the attachment pivot', onClick: () => this.nudgeViewMeshOffset('up', -1) },
      { text: 'IN', title: 'Move mesh into the screen without moving the attachment pivot', onClick: () => this.nudgeViewMeshOffset('forward', 1) },
      { text: 'OUT', title: 'Move mesh out of the screen without moving the attachment pivot', onClick: () => this.nudgeViewMeshOffset('forward', -1) },
    ]));
    section.appendChild(this.buildNudgeButtonRow('WORLD', [
      { text: 'X-', title: 'Move mesh along world -X without moving the attachment pivot', onClick: () => this.nudgeWorldMeshOffset('x', -1) },
      { text: 'X+', title: 'Move mesh along world +X without moving the attachment pivot', onClick: () => this.nudgeWorldMeshOffset('x', 1) },
      { text: 'Y-', title: 'Move mesh along world -Y without moving the attachment pivot', onClick: () => this.nudgeWorldMeshOffset('y', -1) },
      { text: 'Y+', title: 'Move mesh along world +Y without moving the attachment pivot', onClick: () => this.nudgeWorldMeshOffset('y', 1) },
      { text: 'Z-', title: 'Move mesh along world -Z without moving the attachment pivot', onClick: () => this.nudgeWorldMeshOffset('z', -1) },
      { text: 'Z+', title: 'Move mesh along world +Z without moving the attachment pivot', onClick: () => this.nudgeWorldMeshOffset('z', 1) },
    ]));
    return section;
  }

  private buildNudgeSection(): HTMLDivElement {
    const section = document.createElement('div');
    Object.assign(section.style, {
      margin: '4px 0 7px',
      padding: '6px',
      background: '#0e0c08',
      border: '1px solid #242018',
      borderRadius: '4px',
    });
    return section;
  }

  private buildStepHeader(label: string): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:3px;margin-bottom:4px;';
    const labelEl = document.createElement('span');
    labelEl.style.cssText = 'width:62px;flex-shrink:0;color:#777;font-size:9px;font-weight:bold;';
    labelEl.textContent = label;
    row.appendChild(labelEl);
    return row;
  }

  private buildNudgeButtonRow(label: string, buttons: { text: string; title: string; onClick: () => void }[]): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:3px;margin-top:3px;';
    const labelEl = document.createElement('span');
    labelEl.style.cssText = 'width:62px;flex-shrink:0;color:#777;font-size:9px;font-weight:bold;';
    labelEl.textContent = label;
    row.appendChild(labelEl);
    for (const def of buttons) {
      row.appendChild(this.makeNudgeButton(def.text, def.title, def.onClick));
    }
    return row;
  }

  private makeNudgeButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = this.makeButton(text, '#12100c', '#2f2a20', onClick);
    btn.title = title;
    Object.assign(btn.style, {
      flex: '1 1 0',
      minWidth: '0',
      padding: '3px 2px',
      fontSize: '9px',
      lineHeight: '13px',
    });
    return btn;
  }

  private updateMoveStepButtons(): void {
    this.updateStepButtons(this.moveStepButtons, String(this.moveNudgeStep), '#8cf');
  }

  private updateRotationStepButtons(): void {
    this.updateStepButtons(this.rotationStepButtons, String(this.rotationNudgeStep), '#cf8');
  }

  private updateStepButtons(buttons: HTMLButtonElement[], activeStep: string, activeColor: string): void {
    for (const btn of buttons) {
      const active = btn.dataset.step === activeStep;
      btn.style.background = active ? '#2a2a20' : '#12100c';
      btn.style.color = active ? activeColor : '#777';
      btn.style.borderColor = active ? activeColor : '#2f2a20';
      btn.style.fontWeight = active ? 'bold' : 'normal';
    }
  }

  private nudgeWorldPosition(axis: 'x' | 'y' | 'z', sign: -1 | 1): void {
    const delta = Vector3.Zero();
    if (axis === 'x') delta.x = this.moveNudgeStep * sign;
    else if (axis === 'y') delta.y = this.moveNudgeStep * sign;
    else delta.z = this.moveNudgeStep * sign;
    this.applyWorldPositionDelta(delta);
  }

  private nudgeViewPosition(axis: 'right' | 'up' | 'forward', sign: -1 | 1): void {
    const worldDirection = this.getViewDirection(axis);
    if (!worldDirection) return;
    this.applyWorldPositionDelta(worldDirection.scaleInPlace(this.moveNudgeStep * sign));
  }

  private applyWorldPositionDelta(worldDelta: Vector3): void {
    if (!this.target) return;
    let localDelta = worldDelta.clone();
    const parent = this.target.parent as TransformNode | null;
    if (parent) {
      parent.computeWorldMatrix(true);
      const parentInverse = parent.getWorldMatrix().clone();
      parentInverse.invert();
      localDelta = Vector3.TransformNormal(worldDelta, parentInverse);
    }
    this.setVal('pos.x', this.getVal('pos.x') + localDelta.x);
    this.setVal('pos.y', this.getVal('pos.y') + localDelta.y);
    this.setVal('pos.z', this.getVal('pos.z') + localDelta.z);
    this.applyToTarget();
    this.updateOverrideStatus();
  }

  private nudgeWorldMeshOffset(axis: 'x' | 'y' | 'z', sign: -1 | 1): void {
    const delta = this.worldAxisVector(axis).scaleInPlace(this.moveNudgeStep * sign);
    this.applyWorldMeshOffsetDelta(delta);
  }

  private nudgeViewMeshOffset(axis: 'right' | 'up' | 'forward', sign: -1 | 1): void {
    const worldDirection = this.getViewDirection(axis);
    if (!worldDirection) return;
    this.applyWorldMeshOffsetDelta(worldDirection.scaleInPlace(this.moveNudgeStep * sign));
  }

  private applyWorldMeshOffsetDelta(worldDelta: Vector3): void {
    if (!this.target) return;
    this.target.computeWorldMatrix(true);
    const targetInverse = this.target.getWorldMatrix().clone();
    targetInverse.invert();
    const localDelta = Vector3.TransformNormal(worldDelta, targetInverse);
    this.setVal('mesh.x', this.getVal('mesh.x') + localDelta.x);
    this.setVal('mesh.y', this.getVal('mesh.y') + localDelta.y);
    this.setVal('mesh.z', this.getVal('mesh.z') + localDelta.z);
    this.applyToTarget();
    this.updateOverrideStatus();
  }

  private nudgeRotation(axis: 'x' | 'y' | 'z', sign: -1 | 1): void {
    this.setVal(`rot.${axis}`, this.wrapRadians(this.getVal(`rot.${axis}`) + this.rotationNudgeStep * sign));
    this.applyToTarget();
    this.updateOverrideStatus();
  }

  private nudgeWorldRotation(axis: 'x' | 'y' | 'z', sign: -1 | 1): void {
    this.applyWorldRotationDelta(this.worldAxisVector(axis), sign);
  }

  private nudgeViewRotation(axis: 'right' | 'up' | 'forward', sign: -1 | 1): void {
    const worldDirection = this.getViewDirection(axis);
    if (!worldDirection) return;
    this.applyWorldRotationDelta(worldDirection, sign);
  }

  private applyWorldRotationDelta(worldAxis: Vector3, sign: -1 | 1): void {
    if (!this.target) return;
    if (worldAxis.lengthSquared() < 0.000001) return;
    this.applyToTarget();
    this.target.computeWorldMatrix(true);
    this.target.rotate(worldAxis.normalize(), this.rotationNudgeStep * sign, Space.WORLD);
    this.syncRotationInputsFromTarget();
    this.applyMeshOffsetToTarget();
    this.updateOverrideStatus();
  }

  private syncRotationInputsFromTarget(): void {
    if (!this.target) return;
    if (this.target.rotationQuaternion) {
      const euler = this.target.rotationQuaternion.toEulerAngles();
      this.target.rotationQuaternion = null;
      this.target.rotation.copyFrom(euler);
    }
    this.setVal('rot.x', this.wrapRadians(this.target.rotation.x));
    this.setVal('rot.y', this.wrapRadians(this.target.rotation.y));
    this.setVal('rot.z', this.wrapRadians(this.target.rotation.z));
  }

  private getViewDirection(axis: 'right' | 'up' | 'forward'): Vector3 | null {
    if (!this.target) return null;
    const camera = this.target.getScene().activeCamera;
    if (!camera) {
      this.flashStatus('No active camera');
      return null;
    }
    const localAxis = axis === 'right'
      ? new Vector3(1, 0, 0)
      : axis === 'up'
        ? new Vector3(0, 1, 0)
        : new Vector3(0, 0, 1);
    const worldDirection = camera.getDirection(localAxis);
    if (worldDirection.lengthSquared() < 0.000001) return null;
    return worldDirection.normalize();
  }

  private worldAxisVector(axis: 'x' | 'y' | 'z'): Vector3 {
    if (axis === 'x') return new Vector3(1, 0, 0);
    if (axis === 'y') return new Vector3(0, 1, 0);
    return new Vector3(0, 0, 1);
  }

  private currentMeshOffset(): Vector3 {
    return new Vector3(this.getVal('mesh.x'), this.getVal('mesh.y'), this.getVal('mesh.z'));
  }

  private captureMeshOffsetBase(target: TransformNode, currentOffset: Vector3): void {
    this.meshOffsetBaseTarget = target;
    this.meshOffsetBasePositions.clear();
    for (const child of target.getChildren()) {
      if (!(child instanceof TransformNode)) continue;
      this.meshOffsetBasePositions.set(child, child.position.subtract(currentOffset));
    }
  }

  private applyMeshOffsetToTarget(): void {
    if (!this.target) return;
    const offset = this.currentMeshOffset();
    if (this.meshOffsetBaseTarget !== this.target) {
      this.captureMeshOffsetBase(this.target, offset);
    }
    for (const [child, basePosition] of this.meshOffsetBasePositions) {
      if (child.isDisposed()) continue;
      child.position.copyFrom(basePosition.add(offset));
    }
  }

  private resetMeshOffset(): void {
    this.setVal('mesh.x', 0);
    this.setVal('mesh.y', 0);
    this.setVal('mesh.z', 0);
    this.applyToTarget();
    this.updateOverrideStatus();
  }

  private snapMeshOffsetToBounds(anchor: 'center' | 'bottom'): void {
    const bounds = this.computeTargetLocalMeshBounds();
    if (!bounds) return;
    const anchorLocal = anchor === 'center'
      ? bounds.min.add(bounds.max).scaleInPlace(0.5)
      : new Vector3(
        (bounds.min.x + bounds.max.x) * 0.5,
        bounds.min.y,
        (bounds.min.z + bounds.max.z) * 0.5,
      );
    const next = this.currentMeshOffset().subtract(anchorLocal);
    this.setVal('mesh.x', next.x);
    this.setVal('mesh.y', next.y);
    this.setVal('mesh.z', next.z);
    this.applyToTarget();
    this.updateOverrideStatus();
    this.flashStatus(anchor === 'center' ? 'Pivot snapped to bounds center' : 'Pivot snapped to lower bounds');
  }

  private computeTargetLocalMeshBounds(): { min: Vector3; max: Vector3 } | null {
    if (!this.target) return null;
    this.target.computeWorldMatrix(true);
    const inverseTarget = this.target.getWorldMatrix().clone();
    inverseTarget.invert();

    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    let found = false;
    const meshes: AbstractMesh[] = this.target.getChildMeshes(false);
    for (const mesh of meshes) {
      if (mesh.getTotalVertices() === 0) continue;
      mesh.computeWorldMatrix(true);
      for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
        const local = Vector3.TransformCoordinates(corner, inverseTarget);
        min.minimizeInPlace(local);
        max.maximizeInPlace(local);
        found = true;
      }
    }

    if (!found) {
      this.flashStatus('No mesh bounds');
      return null;
    }
    return { min, max };
  }

  private wrapRadians(value: number): number {
    if (!Number.isFinite(value)) return 0;
    let wrapped = value;
    while (wrapped > Math.PI) wrapped -= Math.PI * 2;
    while (wrapped < -Math.PI) wrapped += Math.PI * 2;
    return wrapped;
  }

  private buildHeadHairSection(): HTMLDivElement {
    const section = document.createElement('div');
    Object.assign(section.style, {
      marginTop: '10px',
      paddingTop: '8px',
      borderTop: '1px solid #2a2520',
    });

    const label = document.createElement('div');
    label.style.cssText = 'color:#ff6;font-size:11px;font-weight:bold;margin-bottom:5px;';
    label.textContent = 'HEAD HAIR FIT';
    section.appendChild(label);

    const modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:5px;';

    this.headHairModeSelect = document.createElement('select');
    Object.assign(this.headHairModeSelect.style, {
      flex: '1',
      background: '#1a1510',
      color: '#ddd',
      border: '1px solid #3a3530',
      borderRadius: '3px',
      padding: '3px 5px',
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: '10px',
    });

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Item default';
    this.headHairModeSelect.appendChild(defaultOption);
    for (const mode of HEAD_RENDER_MODES) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = HEAD_HAIR_MODE_LABELS[mode];
      this.headHairModeSelect.appendChild(option);
    }
    this.headHairModeSelect.addEventListener('change', () => {
      this.updateHeadHairControlState();
      this.applyHeadHairPreview();
      this.updateOverrideStatus();
    });
    modeRow.appendChild(this.headHairModeSelect);
    section.appendChild(modeRow);

    const presetRow = document.createElement('div');
    presetRow.style.cssText = 'display:flex;gap:3px;margin-bottom:6px;';
    const autoBtn = this.makeButton('Fit Hat', '#2f2812', '#aa8', () => this.applyHeadHairPreset('auto'));
    const brimBtn = this.makeButton('Brim', '#1a2f2a', '#4a8', () => this.applyHeadHairPreset('brim'));
    const capBtn = this.makeButton('Cap', '#2a2238', '#86a', () => this.applyHeadHairPreset('cap'));
    const clearBtn = this.makeButton('Clear', '#2a1a1a', '#844', () => this.applyHeadHairPreset('clear'));
    for (const btn of [autoBtn, brimBtn, capBtn, clearBtn]) {
      btn.style.flex = '1';
      btn.style.padding = '4px 2px';
      btn.style.fontSize = '10px';
    }
    presetRow.appendChild(autoBtn);
    presetRow.appendChild(brimBtn);
    presetRow.appendChild(capBtn);
    presetRow.appendChild(clearBtn);
    section.appendChild(presetRow);

    for (const def of HEAD_HAIR_PARAM_DEFS) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;margin-bottom:2px;gap:4px;';

      const rowLabel = document.createElement('span');
      rowLabel.style.cssText = 'width:30px;flex-shrink:0;color:#aa8;font-weight:bold;font-size:9px;';
      rowLabel.textContent = def.label;
      rowLabel.title = def.title;

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '1';
      slider.step = '0.01';
      slider.value = '0';
      slider.style.cssText = 'flex:1;height:14px;cursor:pointer;accent-color:#cc8;';

      const numInput = document.createElement('input');
      numInput.type = 'number';
      numInput.min = '0';
      numInput.max = '1';
      numInput.step = '0.01';
      numInput.value = '0.00';
      Object.assign(numInput.style, {
        width: '48px',
        flexShrink: '0',
        background: '#1a1510',
        color: '#ddd',
        border: '1px solid #3a3530',
        borderRadius: '2px',
        padding: '1px 3px',
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: '10px',
        textAlign: 'right',
      });

      slider.addEventListener('input', () => {
        numInput.value = parseFloat(slider.value).toFixed(2);
        if (this.headHairModeSelect.value !== 'hairFit') {
          this.headHairModeSelect.value = 'hairFit';
          this.updateHeadHairControlState();
        }
        this.applyHeadHairPreview();
        this.updateOverrideStatus();
      });
      numInput.addEventListener('input', () => {
        const value = parseFloat(numInput.value);
        if (!Number.isFinite(value)) return;
        const clamped = Math.max(0, Math.min(1, value));
        slider.value = String(clamped);
        numInput.value = clamped.toFixed(2);
        if (this.headHairModeSelect.value !== 'hairFit') {
          this.headHairModeSelect.value = 'hairFit';
          this.updateHeadHairControlState();
        }
        this.applyHeadHairPreview();
        this.updateOverrideStatus();
      });

      row.appendChild(rowLabel);
      row.appendChild(slider);
      row.appendChild(numInput);
      section.appendChild(row);
      this.headHairSliders.set(def.key, slider);
      this.headHairInputs.set(def.key, numInput);
    }

    return section;
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
    const existingOverride = item ? this.overrideGetter(item.id) : null;
    const previewOverride = this.loadedGlbSlot === slot ? this.loadedPreviewOverride : null;
    const activeOverride = previewOverride ?? existingOverride;
    if (this.loadedGlbSlot !== slot) {
      this.loadedGlbSlot = null;
      this.loadedGlbPath = existingOverride?.file || null;
      this.loadedGlbItemId = undefined;
      this.loadedPreviewOverride = null;
    }
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
      if (slot === 'head') parts.push(`hair: ${item.headRenderMode ?? 'helmet'}`);
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
      const meshOffset = activeOverride?.meshOffset ?? { x: 0, y: 0, z: 0 };
      this.setVal('pos.x', node.position.x);
      this.setVal('pos.y', node.position.y);
      this.setVal('pos.z', node.position.z);
      this.setVal('rot.x', node.rotation.x);
      this.setVal('rot.y', node.rotation.y);
      this.setVal('rot.z', node.rotation.z);
      this.setVal('mesh.x', meshOffset.x);
      this.setVal('mesh.y', meshOffset.y);
      this.setVal('mesh.z', meshOffset.z);
      this.setVal('scale', node.scaling.x);
      this.captureMeshOffsetBase(node, new Vector3(meshOffset.x, meshOffset.y, meshOffset.z));
    } else {
      this.target = null;
      this.meshOffsetBaseTarget = null;
      this.meshOffsetBasePositions.clear();
      this.setVal('mesh.x', 0);
      this.setVal('mesh.y', 0);
      this.setVal('mesh.z', 0);
    }

    if (this.centerOriginInput) {
      const skinned = this.isSkinnedArmor(slot);
      this.centerOriginInput.disabled = skinned;
      this.centerOriginInput.checked = skinned ? false : activeOverride?.centerOrigin ?? false;
    }
    if (this.headHairSection) {
      this.headHairSection.style.display = slot === 'head' && !!item ? 'block' : 'none';
      this.setHeadHairControls(activeOverride?.headHair ?? null);
    }

    this.updateOverrideStatus();
    this.loadThumbGrid(slot);
  }

  // --- Thumbnail grid ---

  private async loadThumbGrid(slot: string): Promise<void> {
    this.thumbGrid.innerHTML = '';

    const bodyType = this.getBodyType();
    const cacheKey = `${slot}:${bodyType}`;
    let files: GearFileInfo[] = this.slotFilesCache.get(cacheKey) || [];
    if (files.length === 0 && !this.slotFilesCache.has(cacheKey)) {
      try {
        const token = this.getAuthToken();
        const res = await fetch(`/api/dev/gear-files?slot=${encodeURIComponent(slot)}&fitBase=1&bodyType=${bodyType}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const data = await res.json();
        files = data.files || [];
      } catch { /* keep empty */ }
      this.slotFilesCache.set(cacheKey, files);
    }

    if (files.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#444;font-size:10px;text-align:center;padding:8px;grid-column:1/-1;';
      empty.textContent = `No bronze base fit items for ${slot}`;
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

      cell.title = `${info.name} (${info.itemId > 0 ? `item ${info.itemId}, ` : ''}${info.file})`;
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
      const previewOverride = this.buildCurrentTransformOverride(true);
      const itemId = info.itemId > 0 ? info.itemId : undefined;
      await this.loadGlbCallback(this.activeSlot, info.path, itemId, previewOverride);
      this.setLoadedPreview(this.activeSlot, info.path, itemId, previewOverride);
      // Refresh view after a tick so the attached gear node is available
      setTimeout(() => {
        this.switchSlot(this.activeSlot);
        this.flashStatus(`Loaded ${info.name}`);
      }, 100);
    } catch (e: any) {
      this.flashStatus(`Failed: ${e.message || e}`);
    }
  }

  private setLoadedPreview(slot: string, path: string, itemId: number | undefined, override: GearOverride): void {
    this.loadedGlbSlot = slot;
    this.loadedGlbPath = path;
    this.loadedGlbItemId = itemId;
    this.loadedPreviewOverride = { ...override };
  }

  private getCurrentPreviewPath(): string {
    if (this.loadedGlbSlot === this.activeSlot && this.loadedGlbPath) return this.loadedGlbPath;
    const item = this.getItemInfo(this.activeSlot);
    if (item?.modelPath) return item.modelPath;
    if (item) return `/assets/equipment/${this.activeSlot}/${item.id}.glb`;
    return this.glbInput?.value.trim() || '';
  }

  private getCurrentPreviewItemId(): number | undefined {
    if (this.loadedGlbSlot === this.activeSlot) return this.loadedGlbItemId;
    const item = this.getItemInfo(this.activeSlot);
    return item && item.id > 0 ? item.id : undefined;
  }

  private async reloadCurrentPreview(successMessage: string): Promise<void> {
    if (!this.loadGlbCallback) return;
    if (this.centerOriginInput?.disabled) return;
    const path = this.getCurrentPreviewPath();
    if (!path) return;

    const seq = ++this.previewReloadSeq;
    const itemId = this.getCurrentPreviewItemId();
    const previewOverride = this.buildCurrentTransformOverride(true);
    this.flashStatus('Reloading GLB...');
    try {
      await this.loadGlbCallback(this.activeSlot, path, itemId, previewOverride);
      if (seq !== this.previewReloadSeq) return;
      this.setLoadedPreview(this.activeSlot, path, itemId, previewOverride);
      setTimeout(() => {
        if (seq !== this.previewReloadSeq) return;
        this.switchSlot(this.activeSlot);
        this.flashStatus(successMessage);
      }, 100);
    } catch (e: any) {
      if (seq !== this.previewReloadSeq) return;
      this.flashStatus(`Reload failed: ${e.message || e}`);
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
      meshOffset: { x: 0, y: 0, z: 0 },
      scale: def.scale,
      centerOrigin: false,
    };
    const ref = {
      px: saved.localPosition?.x ?? def.localPosition.x,
      py: saved.localPosition?.y ?? def.localPosition.y,
      pz: saved.localPosition?.z ?? def.localPosition.z,
      rx: saved.localRotation?.x ?? def.localRotation.x,
      ry: saved.localRotation?.y ?? def.localRotation.y,
      rz: saved.localRotation?.z ?? def.localRotation.z,
      mx: saved.meshOffset?.x ?? 0,
      my: saved.meshOffset?.y ?? 0,
      mz: saved.meshOffset?.z ?? 0,
      s: saved.scale ?? def.scale,
      centerOrigin: saved.centerOrigin ?? false,
    };

    const cur = {
      px: this.getVal('pos.x'), py: this.getVal('pos.y'), pz: this.getVal('pos.z'),
      rx: this.getVal('rot.x'), ry: this.getVal('rot.y'), rz: this.getVal('rot.z'),
      mx: this.getVal('mesh.x'), my: this.getVal('mesh.y'), mz: this.getVal('mesh.z'),
      s: this.getVal('scale'),
      centerOrigin: this.centerOriginInput?.checked ?? false,
    };

    const close = (a: number, b: number) => Math.abs(a - b) < 0.001;
    const transformMatches = close(cur.px, ref.px) && close(cur.py, ref.py) && close(cur.pz, ref.pz)
      && close(cur.rx, ref.rx) && close(cur.ry, ref.ry) && close(cur.rz, ref.rz)
      && close(cur.mx, ref.mx) && close(cur.my, ref.my) && close(cur.mz, ref.mz)
      && close(cur.s, ref.s)
      && cur.centerOrigin === ref.centerOrigin;
    const hairMatches = this.activeSlot !== 'head'
      || this.headHairFitsEqual(this.buildCurrentHeadHairFit(), override?.headHair ?? null);
    const matches = transformMatches && hairMatches;

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
    const fallback = PARAM_BY_KEY.get(key)?.value ?? 0;
    const next = Number.isFinite(value) ? value : fallback;
    const slider = this.sliders.get(key);
    const num = this.numInputs.get(key);
    if (slider) slider.value = String(next);
    if (num) num.value = next.toFixed(3);
  }

  private getVal(key: string): number {
    const value = parseFloat(this.numInputs.get(key)?.value ?? '');
    return Number.isFinite(value) ? value : (PARAM_BY_KEY.get(key)?.value ?? 0);
  }

  private setHeadHairVal(key: HeadHairMorphKey, value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    const slider = this.headHairSliders.get(key);
    const input = this.headHairInputs.get(key);
    if (slider) slider.value = String(clamped);
    if (input) input.value = clamped.toFixed(2);
  }

  private getHeadHairVal(key: HeadHairMorphKey): number {
    const value = parseFloat(this.headHairInputs.get(key)?.value ?? '0');
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  }

  private setHeadHairControls(fit: HeadHairFit | null): void {
    this.headHairModeSelect.value = fit?.mode ?? '';
    for (const key of HEAD_HAIR_MORPH_KEYS) {
      this.setHeadHairVal(key, fit?.morphs?.[key] ?? 0);
    }
    this.updateHeadHairControlState();
  }

  private buildCurrentHeadHairFit(): HeadHairFit | undefined {
    if (this.activeSlot !== 'head' || !this.headHairModeSelect) return undefined;
    const modeValue = this.headHairModeSelect.value;
    const mode = HEAD_RENDER_MODES.includes(modeValue as HeadRenderMode)
      ? modeValue as HeadRenderMode
      : undefined;
    if (!mode) return undefined;

    const fit: HeadHairFit = { mode };
    if (mode === 'hairFit') {
      const morphs: NonNullable<HeadHairFit['morphs']> = {};
      for (const key of HEAD_HAIR_MORPH_KEYS) {
        const value = this.getHeadHairVal(key);
        if (value > 0.001) morphs[key] = Number(value.toFixed(3));
      }
      if (Object.keys(morphs).length > 0) fit.morphs = morphs;
    }
    return fit;
  }

  private updateHeadHairControlState(): void {
    const custom = this.headHairModeSelect.value === 'hairFit';
    for (const key of HEAD_HAIR_MORPH_KEYS) {
      const slider = this.headHairSliders.get(key);
      const input = this.headHairInputs.get(key);
      if (slider) {
        slider.disabled = !custom;
        slider.style.opacity = custom ? '1' : '0.38';
      }
      if (input) {
        input.disabled = !custom;
        input.style.opacity = custom ? '1' : '0.45';
      }
    }
  }

  private applyHeadHairPreview(): void {
    if (this.activeSlot !== 'head') return;
    this.headHairPreviewCallback?.(this.buildCurrentHeadHairFit() ?? null);
  }

  private applyHeadHairPreset(kind: 'auto' | 'brim' | 'cap' | 'clear'): void {
    let preset = kind;
    if (kind === 'auto') {
      const name = this.getItemInfo(this.activeSlot)?.name.toLowerCase() ?? '';
      if (/(mask|eyepatch|circlet|headband)/.test(name)) preset = 'clear';
      else if (/(coif|skullcap|hood|beret)/.test(name)) preset = 'cap';
      else preset = 'brim';
    }

    if (preset === 'clear') {
      this.headHairModeSelect.value = '';
      for (const key of HEAD_HAIR_MORPH_KEYS) this.setHeadHairVal(key, 0);
    } else {
      this.headHairModeSelect.value = 'hairFit';
      const values: Record<HeadHairMorphKey, number> = preset === 'cap'
        ? { topFlatten: 1, topLower: 0.32, sideSqueeze: 0.72, backTuck: 0.46, frontTrim: 0.28 }
        : { topFlatten: 0.82, topLower: 0.12, sideSqueeze: 0.42, backTuck: 0.24, frontTrim: 0.12 };
      for (const key of HEAD_HAIR_MORPH_KEYS) this.setHeadHairVal(key, values[key]);
    }

    this.updateHeadHairControlState();
    this.applyHeadHairPreview();
    this.updateOverrideStatus();
  }

  private headHairFitsEqual(a?: HeadHairFit | null, b?: HeadHairFit | null): boolean {
    const norm = (fit?: HeadHairFit | null) => {
      if (!fit?.mode) return null;
      const out: HeadHairFit = { mode: fit.mode };
      if (fit.mode === 'hairFit') {
        const morphs: NonNullable<HeadHairFit['morphs']> = {};
        for (const key of HEAD_HAIR_MORPH_KEYS) {
          const value = fit.morphs?.[key];
          if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) > 0.001) {
            morphs[key] = Number(Math.max(0, Math.min(1, value)).toFixed(3));
          }
        }
        if (Object.keys(morphs).length > 0) out.morphs = morphs;
      }
      return out;
    };
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  }

  private applyToTarget(): void {
    if (!this.target) return;
    this.target.position.set(this.getVal('pos.x'), this.getVal('pos.y'), this.getVal('pos.z'));
    this.target.rotation.set(this.getVal('rot.x'), this.getVal('rot.y'), this.getVal('rot.z'));
    const s = this.getVal('scale');
    this.target.scaling.set(s, s, s);
    this.applyMeshOffsetToTarget();
  }

  private resetToDefaults(): void {
    if (this.isSkinnedArmor(this.activeSlot)) {
      this.setVal('pos.x', 0); this.setVal('pos.y', 0); this.setVal('pos.z', 0);
      this.setVal('rot.x', 0); this.setVal('rot.y', 0); this.setVal('rot.z', 0);
      this.setVal('mesh.x', 0); this.setVal('mesh.y', 0); this.setVal('mesh.z', 0);
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
      this.setVal('mesh.x', 0);
      this.setVal('mesh.y', 0);
      this.setVal('mesh.z', 0);
      this.setVal('scale', defaults.scale);
    }
    if (this.centerOriginInput) this.centerOriginInput.checked = false;
    this.applyToTarget();
    this.updateOverrideStatus();
    this.flashStatus('Reset to slot defaults');
  }

  private resetAll(): void {
    for (const p of PARAMS) {
      const def = p.group === 'scale' ? 1 : 0;
      this.setVal(p.key, def);
    }
    if (this.centerOriginInput) this.centerOriginInput.checked = false;
    this.applyToTarget();
    this.updateOverrideStatus();
    this.flashStatus('Reset to zero');
  }

  private unequipSlot(): void {
    if (!this.unequipCallback) return;
    this.unequipCallback(this.activeSlot);
    this.loadedGlbSlot = null;
    this.loadedGlbPath = null;
    this.loadedGlbItemId = undefined;
    this.loadedPreviewOverride = null;
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

  private buildCurrentTransformOverride(includeFile: boolean): GearOverride {
    const override: GearOverride = {
      localPosition: { x: this.getVal('pos.x'), y: this.getVal('pos.y'), z: this.getVal('pos.z') },
      localRotation: { x: this.getVal('rot.x'), y: this.getVal('rot.y'), z: this.getVal('rot.z') },
      meshOffset: { x: this.getVal('mesh.x'), y: this.getVal('mesh.y'), z: this.getVal('mesh.z') },
      scale: this.getVal('scale'),
      centerOrigin: this.centerOriginInput?.checked ?? false,
    };
    if (this.activeSlot === 'head') {
      const headHair = this.buildCurrentHeadHairFit();
      if (headHair) override.headHair = headHair;
    }

    if (includeFile && this.loadedGlbPath) {
      const item = this.getItemInfo(this.activeSlot);
      const defaultPath = item?.modelPath ?? (item ? `/assets/equipment/${this.activeSlot}/${item.id}.glb` : '');
      if (!defaultPath || this.loadedGlbPath !== defaultPath) {
        override.file = this.loadedGlbPath;
      }
    }

    return override;
  }

  private buildCurrentOverride(includeFile: boolean): GearOverride | null {
    const item = this.getItemInfo(this.activeSlot);
    if (!item) return null;

    const override: GearOverride = this.buildCurrentTransformOverride(includeFile);

    const defaults = EQUIP_SLOT_BONES[this.activeSlot];
    const currentBone = this.getSlotBone(this.activeSlot);
    if (defaults && currentBone !== defaults.boneName) {
      override.boneName = currentBone;
    }

    if (this.activeSlot === 'head') {
      const headHair = this.buildCurrentHeadHairFit();
      if (headHair) override.headHair = headHair;
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
      `Apply ${item.name}'s pose to matching tier-family items in the ${this.activeSlot} slot?\n\n` +
      `This copies position, rotation, scale, bone${this.activeSlot === 'head' ? ', and head-hair fit' : ''}. It does not copy the GLB file.`
    );
    if (!ok) return;

    try {
      const count = await this.bulkSaveCallback(item.id, this.activeSlot, override);
      this.updateOverrideStatus();
      this.flashStatus(`Applied pose to ${count} matching item(s)`);
    } catch (e: any) {
      this.flashStatus(`Bulk save failed: ${e.message || e}`);
    }
  }

  private copyCode(): void {
    const slot = this.activeSlot;
    const item = this.getItemInfo(slot);
    const px = this.getVal('pos.x'), py = this.getVal('pos.y'), pz = this.getVal('pos.z');
    const rx = this.getVal('rot.x'), ry = this.getVal('rot.y'), rz = this.getVal('rot.z');
    const mx = this.getVal('mesh.x'), my = this.getVal('mesh.y'), mz = this.getVal('mesh.z');
    const s = this.getVal('scale');
    const centerOrigin = this.centerOriginInput?.checked ?? false;
    const pivotSnippet = `, "meshOffset": { "x": ${mx}, "y": ${my}, "z": ${mz} }, "centerOrigin": ${centerOrigin}`;

    let code: string;
    if (item) {
      const headHair = this.activeSlot === 'head' ? this.buildCurrentHeadHairFit() : undefined;
      const headHairSnippet = headHair ? `, "headHair": ${JSON.stringify(headHair)}` : '';
      code = `// ${item.name} (id: ${item.id}${item.toolType ? `, toolType: ${item.toolType}` : ''})\n"${item.id}": { "localPosition": { "x": ${px}, "y": ${py}, "z": ${pz} }, "localRotation": { "x": ${rx}, "y": ${ry}, "z": ${rz} }${pivotSnippet}, "scale": ${s}${headHairSnippet} }`;
    } else {
      const bone = this.getSlotBone(slot);
      code = `// ${slot}\n${slot}: { boneName: '${bone}', localPosition: { x: ${px}, y: ${py}, z: ${pz} }, localRotation: { x: ${rx}, y: ${ry}, z: ${rz} }, meshOffset: { x: ${mx}, y: ${my}, z: ${mz} }, centerOrigin: ${centerOrigin}, scale: ${s} },`;
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
      const previewOverride = this.buildCurrentTransformOverride(true);
      await this.loadGlbCallback(this.activeSlot, path, undefined, previewOverride);
      this.setLoadedPreview(this.activeSlot, path, undefined, previewOverride);
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
