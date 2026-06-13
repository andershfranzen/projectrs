import {
  type PlayerAppearance,
  BODY_TYPE_COUNT, BODY_TYPE_NAMES,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  SHIRT_COLORS, SHIRT_COLOR_NAMES,
  PANTS_COLORS, PANTS_COLOR_NAMES,
  SHOES_COLORS, SHOES_COLOR_NAMES,
  HAIR_COLORS, HAIR_COLOR_NAMES,
  SKIN_COLORS, SKIN_COLOR_NAMES,
  BELT_COLORS, BELT_COLOR_NAMES,
  HAIR_STYLE_COUNT,
  hairStyleChoicesForBodyType,
  hairStyleName,
  CHARACTER_TARGET_HEIGHT,
  CHARACTER_IDLE_ANIM,
  getCharacterModelPath,
} from '@projectrs/shared';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { CharacterEntity } from '../rendering/CharacterEntity';
import { createModalPanel, mountModalInGameFrame } from './ModalPanel';
import { closeActiveContextMenu } from './popupStyle';

export type CharacterCreatorCallback = (appearance: PlayerAppearance) => void;
type CharacterCreatorCancelCallback = () => void;
type AppearanceIndexKey =
  | 'shirtColor'
  | 'pantsColor'
  | 'shoesColor'
  | 'hairColor'
  | 'beltColor'
  | 'skinColor';

/**
 * Layer-mask bit reserved for the CharacterCreator preview character.
 */
const PREVIEW_LAYER_MASK = 0x10000000;
const PREVIEW_CAMERA_MASK = PREVIEW_LAYER_MASK;
const HIDDEN_LAYER_MASK = 0x20000000;
const CHARACTER_CREATOR_STYLE_ID = 'eq-character-creator-styles';

function ensureCharacterCreatorStyles(): void {
  if (document.getElementById(CHARACTER_CREATOR_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = CHARACTER_CREATOR_STYLE_ID;
  style.textContent = `
    #character-creator.eq-character-creator {
      --eq-character-padding: 12px;
      --eq-character-gap: 12px;
      --eq-character-preview-width: 280px;
      --eq-character-preview-height: clamp(220px, calc(var(--eq-viewport-height, 100vh) - 160px), 400px);
      --eq-character-label-width: 90px;
      --eq-character-arrow-size: 32px;
      --eq-character-arrow-height: 26px;
      min-width: 0;
      overflow: hidden;
    }

    #character-creator .eq-character-creator-header {
      gap: 8px;
      min-width: 0;
    }

    #character-creator .eq-character-creator-title,
    #character-creator .eq-character-creator-subtitle {
      min-width: 0;
    }

    #character-creator .eq-character-creator-subtitle {
      flex-shrink: 1;
      text-align: right;
    }

    @media (max-width: 600px) {
      #character-creator.eq-character-creator {
        --eq-character-padding: 8px;
        --eq-character-gap: 8px;
        --eq-character-preview-width: min(180px, calc(var(--eq-viewport-width, 100vw) - 48px));
        --eq-character-preview-height: clamp(150px, 30vh, 230px);
        --eq-character-label-width: 70px;
        --eq-character-arrow-size: 34px;
        --eq-character-arrow-height: 30px;
      }

      #character-creator .eq-character-creator-body {
        grid-template-columns: minmax(0, 1fr) !important;
        overflow-y: auto !important;
      }

      #character-creator .eq-character-creator-preview-col {
        width: 100% !important;
      }

      #character-creator .eq-character-creator-hint {
        display: none !important;
      }

      #character-creator .eq-character-creator-footer {
        padding: 7px 8px !important;
      }

      #character-creator .eq-character-creator-footer button {
        padding-left: 12px !important;
        padding-right: 12px !important;
      }
    }

    @media (max-width: 420px) {
      #character-creator .eq-character-creator-subtitle {
        display: none !important;
      }
    }

    @media (max-width: 360px) {
      #character-creator.eq-character-creator {
        --eq-character-preview-width: min(160px, calc(var(--eq-viewport-width, 100vw) - 40px));
        --eq-character-preview-height: clamp(138px, 28vh, 190px);
        --eq-character-label-width: 62px;
        --eq-character-arrow-size: 32px;
      }

      #character-creator .eq-character-creator-footer button {
        padding-left: 8px !important;
        padding-right: 8px !important;
      }
    }

    @media (max-height: 520px) and (max-width: 900px) {
      #character-creator.eq-character-creator {
        --eq-character-padding: 8px;
        --eq-character-gap: 8px;
        --eq-character-preview-width: 190px;
        --eq-character-preview-height: clamp(120px, calc(var(--eq-viewport-height, 100vh) - 170px), 210px);
        --eq-character-label-width: 74px;
        --eq-character-arrow-size: 32px;
        --eq-character-arrow-height: 28px;
      }

      #character-creator .eq-character-creator-hint {
        display: none !important;
      }
    }

    @media (max-height: 520px) and (max-width: 900px) and (orientation: landscape) {
      #character-creator .eq-character-creator-body {
        grid-template-columns: minmax(0, var(--eq-character-preview-width, 190px)) minmax(0, 1fr) !important;
        overflow: hidden !important;
      }
    }
  `;
  document.head.appendChild(style);
}

/** Stepper row spec — one per appearance slot. The picker UI is identical
 *  for all rows; only the value-display differs (color swatch vs label). */
interface StepperRow {
  label: string;
  /** Inclusive bounds of the slot's index. */
  min: number;
  max: number;
  /** Optional dynamic value set for rows whose choices depend on other rows. */
  choices?: (a: PlayerAppearance) => readonly number[];
  /** Read current index from the appearance struct. */
  get: (a: PlayerAppearance) => number;
  /** Write a new index back to the appearance struct (mutates). */
  set: (a: PlayerAppearance, idx: number) => void;
  /** Display name for the current index (e.g. "Dark Blue", "Style 3"). */
  name: (idx: number, appearance: PlayerAppearance) => string;
  /** Optional swatch color (RGB 0-1 linear). Slots without a colored swatch
   *  (hair style, gear color) return null. */
  swatch: (idx: number) => [number, number, number] | null;
}

/**
 * Full-screen character creation overlay.
 *
 * Renders a live 3D preview in an isolated Babylon scene so the modal never
 * changes the gameplay canvas camera or render views.
 *
 * UI is RS-style stepper rows (label + < value > arrows) for appearance
 * slots. Visual style matches BankPanel/SidePanel — wood + parchment + red
 * accents.
 */
export class CharacterCreator {
  private container: HTMLDivElement;
  private onConfirm: CharacterCreatorCallback;
  private onCancel?: CharacterCreatorCancelCallback;
  private appearance: PlayerAppearance;

  private previewCanvas: HTMLCanvasElement | null = null;
  private previewEngine: Engine | null = null;
  private previewScene: Scene | null = null;
  private previewCamera: ArcRotateCamera | null = null;
  private previewLights: { hemi: HemisphericLight; dir: DirectionalLight } | null = null;
  private previewCharacter: CharacterEntity | null = null;
  private previewModelPath: string | null = null;
  private previewInitFrame: number | null = null;
  private previewResizeObserver: ResizeObserver | null = null;
  private destroyed: boolean = false;

  // Local player ref + saved enabled state. While the creator is open the
  // local player is hidden so they don't double-render with the preview char
  // at the same world position. Restored on destroy().
  private localPlayer: CharacterEntity | null = null;
  private localPlayerWasEnabled: boolean = true;
  private localPlayerHidden: boolean = false;
  private localPlayerMeshMasks: Map<AbstractMesh, number> = new Map();

  // Saved layerMasks for nearby remote players + NPCs that need to disappear
  // from the preview camera so the preview shows world geometry only (without
  // a crowd of overlapping characters at the player's spot).
  // (No-op for now — kept as a hook if remote-player flicker becomes an issue.)

  // Per-row DOM refs so step() can update only what changed without rebuilding
  // the whole panel.
  private rowSpecs: StepperRow[] = [];
  private rowSwatchEls: (HTMLDivElement | null)[] = [];
  private rowValueEls: HTMLDivElement[] = [];
  private readonly resizePreview = (): void => {
    if (this.destroyed) return;
    this.previewEngine?.resize();
  };
  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.onCancel) return;
    event.preventDefault();
    event.stopPropagation();
    this.onCancel();
  };

  /**
   * @param _gameScene Main Babylon scene retained in the constructor signature
   *                   for existing call sites; the preview now owns an
   *                   isolated scene/engine.
   * @param onConfirm  Called with the final appearance when the user clicks Confirm
   * @param opts       Optional:
   *   - `initial`: starting appearance — `/appearance` edits should pass the
   *     player's current appearance so the stepper opens on existing values.
   *   - `onCancel`: closes in-game edits without saving. Omitted for first
   *     login so a new character must still choose an appearance.
   *   - `localPlayer`: player's CharacterEntity. While the creator is open,
   *     the local player is hidden and the isolated preview scene displays a
   *     separate copy so the gameplay camera/world cannot affect framing.
   */
  constructor(
    _gameScene: Scene,
    onConfirm: CharacterCreatorCallback,
    opts?: { initial?: PlayerAppearance; onCancel?: CharacterCreatorCancelCallback; localPlayer?: CharacterEntity | null },
  ) {
    closeActiveContextMenu();
    this.onConfirm = onConfirm;
    this.onCancel = opts?.onCancel;
    this.appearance = normalizeAppearance(opts?.initial ?? DEFAULT_APPEARANCE);
    this.localPlayer = opts?.localPlayer ?? null;
    this.rowSpecs = this.buildRowSpecs();
    this.container = this.buildUI();
    mountModalInGameFrame(this.container);
    if (this.onCancel) document.addEventListener('keydown', this.handleKeyDown, true);

    // Hide the local player while the creator is open so the preview char
    // doesn't double up with the world-rendered character. The character GLB
    // may still be loading when SHOW_CHARACTER_CREATOR arrives, so retry once
    // the entity reports ready.
    this.hideLocalPlayer();
    if (this.localPlayer) {
      void this.localPlayer.whenReady().then(() => {
        if (!this.destroyed) this.hideLocalPlayer();
      });
    }

    // Defer preview init to next frame so the DOM canvas is attached
    this.previewInitFrame = requestAnimationFrame(() => {
      this.previewInitFrame = null;
      if (!this.destroyed) this.initPreview();
    });
  }

  /** One spec per appearance slot. Order = visual order in the panel. */
  private buildRowSpecs(): StepperRow[] {
    const colorRow = (
      label: string,
      key: AppearanceIndexKey,
      palette: [number, number, number][],
      names: string[],
    ): StepperRow => ({
      label,
      min: 0,
      max: palette.length - 1,
      get: (a) => a[key],
      set: (a, i) => { a[key] = i; },
      name: (i) => names[i] ?? `#${i}`,
      swatch: (i) => palette[i] ?? null,
    });
    return [
      { label: 'Body',       min: 0, max: BODY_TYPE_COUNT - 1,
        get: (a) => a.bodyType, set: (a, i) => { a.bodyType = i; },
        name: (i) => BODY_TYPE_NAMES[i] ?? `#${i}`,
        swatch: () => null },
      { label: 'Skin',       min: 0, max: SKIN_COLORS.length - 1,
        get: (a) => a.skinColor, set: (a, i) => { a.skinColor = i; },
        name: (i) => SKIN_COLOR_NAMES[i] ?? `#${i}`,
        swatch: (i) => SKIN_COLORS[i] ?? null },
      { label: 'Hair',       min: 0, max: HAIR_STYLE_COUNT,
        choices: (a) => hairStyleChoicesForBodyType(a.bodyType),
        get: (a) => a.hairStyle, set: (a, i) => { a.hairStyle = i; },
        name: (i, a) => hairStyleName(i, a.bodyType),
        swatch: () => null },
      { label: 'Hair Color', min: 0, max: HAIR_COLORS.length - 1,
        get: (a) => a.hairColor, set: (a, i) => { a.hairColor = i; },
        name: (i) => HAIR_COLOR_NAMES[i] ?? `#${i}`,
        swatch: (i) => HAIR_COLORS[i] ?? null },
      colorRow('Shirt', 'shirtColor', SHIRT_COLORS, SHIRT_COLOR_NAMES),
      colorRow('Pants', 'pantsColor', PANTS_COLORS, PANTS_COLOR_NAMES),
      colorRow('Shoes', 'shoesColor', SHOES_COLORS, SHOES_COLOR_NAMES),
      colorRow('Belt',  'beltColor',  BELT_COLORS,  BELT_COLOR_NAMES),
    ];
  }

  private buildUI(): HTMLDivElement {
    ensureCharacterCreatorStyles();
    // No full-screen overlay — the panel sits directly in the playable area
    // so the world is visible around it. Matches SmithingPanel/ShopPanel which
    // also center themselves inside the canvas without dimming the background.
    const { root: panel, header, title, subtitle } = createModalPanel({
      id: 'character-creator',
      title: 'Create Your Character',
      subtitle: 'Choose your appearance',
      geometry: {
        kind: 'game-canvas',
        width: 'min(640px, calc(100% - var(--right-rail-width, 300px) - 24px))',
        maxHeight: 'calc(100% - var(--chat-height, 220px) - 24px)',
        zIndex: 10000,
      },
      chrome: 'stone',
      closeButton: !!this.onCancel,
      onClose: () => this.onCancel?.(),
      display: 'flex',
    });
    panel.classList.add('eq-character-creator');
    header.classList.add('eq-character-creator-header');
    title.classList.add('eq-character-creator-title');
    subtitle?.classList.add('eq-character-creator-subtitle');

    // Body — 2-column: 3D preview on left, stepper rows on right.
    const body = document.createElement('div');
    body.className = 'eq-character-creator-body';
    body.style.cssText = `
      display: grid;
      grid-template-columns: minmax(0, var(--eq-character-preview-width, 280px)) minmax(0, 1fr);
      gap: var(--eq-character-gap, 12px);
      padding: var(--eq-character-padding, 12px);
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
    `;

    // Preview column (fixed-shrink so the canvas always renders at full size)
    const previewCol = document.createElement('div');
    previewCol.className = 'eq-character-creator-preview-col';
    previewCol.style.cssText = `
      display: flex; flex-direction: column; align-items: center;
      width: var(--eq-character-preview-width, 280px);
      min-width: 0;
    `;
    const canvas = document.createElement('canvas');
    canvas.id = 'character-preview-canvas';
    canvas.width = 280;
    canvas.height = 400;
    canvas.style.cssText = `
      width: var(--eq-character-preview-width, 280px);
      height: var(--eq-character-preview-height, 400px);
      max-width: 100%;
      background: rgba(0,0,0,0.4);
      border: 2px inset #3a2a1a; border-radius: 3px;
      touch-action: none;
    `;
    this.previewCanvas = canvas;
    previewCol.appendChild(canvas);
    const hint = document.createElement('div');
    hint.className = 'eq-character-creator-hint';
    hint.textContent = 'Drag to rotate · Scroll to zoom';
    hint.style.cssText = `font-size: 10px; color: #8a857c; margin-top: 6px; text-shadow: 1px 1px 0 #000;`;
    previewCol.appendChild(hint);
    body.appendChild(previewCol);

    // Stepper column
    const stepperCol = document.createElement('div');
    stepperCol.className = 'eq-character-creator-stepper-col';
    stepperCol.style.cssText = `
      flex: 1; display: flex; flex-direction: column; gap: 4px;
      min-width: 0; overflow-y: auto; overflow-x: hidden;
    `;
    this.rowSwatchEls = [];
    this.rowValueEls = [];
    for (let i = 0; i < this.rowSpecs.length; i++) {
      stepperCol.appendChild(this.buildStepperRow(i));
    }
    body.appendChild(stepperCol);

    panel.appendChild(body);

    // Footer — Randomize on the left, Confirm on the right.
    const footer = document.createElement('div');
    footer.className = 'eq-character-creator-footer';
    footer.style.cssText = `
      display: flex; gap: 8px; padding: 8px 12px;
      background: url('/ui/stone-light.png') repeat;
      border-top: 2px solid #1a1510;
      border-radius: 0 0 2px 2px;
    `;
    const randomize = this.makeFooterBtn('Randomize', () => {
      for (const spec of this.rowSpecs) {
        const choices = this.choicesFor(spec);
        const idx = choices[Math.floor(Math.random() * choices.length)] ?? spec.min;
        spec.set(this.appearance, idx);
      }
      this.appearance = normalizeAppearance(this.appearance);
      this.refreshAllRows();
      this.updatePreview();
    });
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    const confirm = this.makeFooterBtn('Confirm', () => {
      this.onConfirm(normalizeAppearance(this.appearance));
    });
    footer.appendChild(randomize);
    footer.appendChild(spacer);
    if (this.onCancel) footer.appendChild(this.makeFooterBtn('Cancel', () => this.onCancel?.()));
    footer.appendChild(confirm);
    panel.appendChild(footer);

    return panel;
  }

  private makeFooterBtn(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    // Same gradient + border treatment as SmithingPanel's buttons so the
    // creator's footer reads as part of the same UI family.
    btn.style.cssText = `
      background: linear-gradient(180deg, #5a3a2a 0%, #3a2518 100%);
      border: 1px solid #6a4a35; color: #d8372b;
      font-family: Arial, Helvetica, sans-serif; font-size: 13px; font-weight: bold;
      padding: 6px 18px; cursor: pointer; border-radius: 3px;
      letter-spacing: 0.5px;
      text-shadow: 1px 1px 0 #000;
      touch-action: manipulation;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'linear-gradient(180deg, #6a4a35 0%, #4a3528 100%)';
      btn.style.color = '#d8372b';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'linear-gradient(180deg, #5a3a2a 0%, #3a2518 100%)';
      btn.style.color = '#d8372b';
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** One stepper row: label · [<] · swatch + name · [>] */
  private buildStepperRow(rowIdx: number): HTMLDivElement {
    const spec = this.rowSpecs[rowIdx];
    const row = document.createElement('div');
    row.className = 'eq-character-creator-stepper-row';
    row.style.cssText = `
      display: grid;
      grid-template-columns:
        minmax(0, var(--eq-character-label-width, 90px))
        var(--eq-character-arrow-size, 32px)
        minmax(0, 1fr)
        var(--eq-character-arrow-size, 32px);
      gap: 6px; align-items: center;
      padding: 4px 6px;
      background: rgba(0,0,0,0.25); border: 1px outset #3a2a1a;
      border-radius: 2px;
    `;

    const label = document.createElement('div');
    label.textContent = spec.label;
    label.style.cssText = `
      min-width: 0;
      font-size: 12px; line-height: 1.08;
      color: #d8372b; font-weight: bold; text-shadow: 1px 1px 0 #000;
      overflow-wrap: anywhere;
    `;
    row.appendChild(label);

    const prev = this.makeArrowBtn('<', () => this.step(rowIdx, -1));
    row.appendChild(prev);

    // Value cell — swatch (if applicable) + name. Same DOM regardless so the
    // grid columns stay aligned across rows. Clicking the cell cycles to next
    // (matches RS feel — clicking the current value is a quick "next").
    const valueCell = document.createElement('div');
    valueCell.style.cssText = `
      display: flex; align-items: center; gap: 8px;
      padding: 2px 6px; min-height: 22px;
      background: rgba(0,0,0,0.4); border: 1px inset #1a1510;
      border-radius: 2px; cursor: pointer;
      min-width: 0;
      touch-action: manipulation;
    `;
    valueCell.addEventListener('click', () => this.step(rowIdx, 1));

    const swatch = document.createElement('div');
    swatch.style.cssText = `
      width: 16px; height: 16px; border-radius: 2px;
      border: 1px solid #1a1510; flex-shrink: 0;
      display: none; /* shown only for color rows */
    `;
    valueCell.appendChild(swatch);
    this.rowSwatchEls[rowIdx] = swatch;

    const valueText = document.createElement('div');
    valueText.style.cssText = `
      min-width: 0;
      font-size: 12px; color: #d8372b; flex: 1; text-shadow: 1px 1px 0 #000;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    `;
    valueCell.appendChild(valueText);
    this.rowValueEls[rowIdx] = valueText;

    row.appendChild(valueCell);

    const next = this.makeArrowBtn('>', () => this.step(rowIdx, 1));
    row.appendChild(next);

    // Initial render
    this.refreshRow(rowIdx);

    return row;
  }

  private makeArrowBtn(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    // Stone-style chip — same visual family as the footer buttons but smaller.
    btn.style.cssText = `
      width: var(--eq-character-arrow-size, 32px);
      height: var(--eq-character-arrow-height, 26px);
      background: linear-gradient(180deg, #5a3a2a 0%, #3a2518 100%);
      border: 1px solid #6a4a35; color: #d8372b;
      font-family: Arial, Helvetica, sans-serif; font-size: 14px; font-weight: bold;
      cursor: pointer; padding: 0; line-height: 1;
      text-shadow: 1px 1px 0 #000;
      touch-action: manipulation;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'linear-gradient(180deg, #6a4a35 0%, #4a3528 100%)';
      btn.style.color = '#d8372b';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'linear-gradient(180deg, #5a3a2a 0%, #3a2518 100%)';
      btn.style.color = '#d8372b';
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** Cycle row `rowIdx` by +1 / -1 with wrap. Updates UI + 3D preview. */
  private step(rowIdx: number, delta: number): void {
    const spec = this.rowSpecs[rowIdx];
    const choices = this.choicesFor(spec);
    const cur = spec.get(this.appearance);
    const curIdx = choices.indexOf(cur);
    const next = curIdx >= 0
      ? choices[((curIdx + delta) % choices.length + choices.length) % choices.length]
      : choices[delta < 0 ? choices.length - 1 : 0];
    if (next === undefined) return;
    if (next === cur) return;
    spec.set(this.appearance, next);
    this.appearance = normalizeAppearance(this.appearance);
    this.refreshAllRows();
    this.updatePreview();
  }

  private choicesFor(spec: StepperRow): readonly number[] {
    if (spec.choices) return spec.choices(this.appearance);
    return Array.from({ length: spec.max - spec.min + 1 }, (_, i) => spec.min + i);
  }

  private refreshRow(rowIdx: number): void {
    const spec = this.rowSpecs[rowIdx];
    const idx = spec.get(this.appearance);
    const swatchEl = this.rowSwatchEls[rowIdx];
    const valueEl = this.rowValueEls[rowIdx];
    const swatch = spec.swatch(idx);
    if (swatch && swatchEl) {
      // sRGB-ish gamma so the swatch matches what the player sees on the model.
      const r = Math.round(Math.pow(swatch[0], 1 / 2.2) * 255);
      const g = Math.round(Math.pow(swatch[1], 1 / 2.2) * 255);
      const b = Math.round(Math.pow(swatch[2], 1 / 2.2) * 255);
      swatchEl.style.background = `rgb(${r}, ${g}, ${b})`;
      swatchEl.style.display = 'block';
    } else if (swatchEl) {
      swatchEl.style.display = 'none';
    }
    if (valueEl) valueEl.textContent = spec.name(idx, this.appearance);
  }

  private refreshAllRows(): void {
    for (let i = 0; i < this.rowSpecs.length; i++) this.refreshRow(i);
  }

  private hideLocalPlayer(): void {
    if (this.destroyed) return;
    if (!this.localPlayer) return;
    const root = this.localPlayer.getRoot();
    if (!root) return;
    if (!this.localPlayerHidden) {
      this.localPlayerWasEnabled = root.isEnabled();
      this.localPlayerMeshMasks.clear();
    }
    const meshes = new Set<AbstractMesh>([
      ...this.localPlayer.getMeshes(),
      ...root.getChildMeshes(false),
    ]);
    for (const mesh of meshes) {
      if (!this.localPlayerMeshMasks.has(mesh)) {
        this.localPlayerMeshMasks.set(mesh, mesh.layerMask);
      }
      mesh.layerMask = HIDDEN_LAYER_MASK;
    }
    root.setEnabled(false);
    this.localPlayerHidden = true;
  }

  private initPreview(): void {
    if (this.destroyed) return;
    if (!this.previewCanvas) return;

    const engine = new Engine(this.previewCanvas, false, { antialias: false, adaptToDeviceRatio: false });
    engine.setHardwareScalingLevel(1);
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new Color4(0.07, 0.10, 0.15, 1);
    this.previewEngine = engine;
    this.previewScene = scene;
    if (typeof ResizeObserver !== 'undefined') {
      this.previewResizeObserver = new ResizeObserver(this.resizePreview);
      this.previewResizeObserver.observe(this.previewCanvas);
    }
    window.addEventListener('resize', this.resizePreview);
    window.addEventListener('evilquest:viewportchange', this.resizePreview);
    requestAnimationFrame(this.resizePreview);
    const anchor = Vector3.Zero();

    // Preview camera sees only the preview character layer. Rendering the
    // world into this small canvas can place walls/props between the camera
    // and character depending on spawn position.
    const cam = new ArcRotateCamera(
      'previewCam', Math.PI * 0.75, Math.PI * 0.4, 3.0,
      anchor.add(new Vector3(0, 0.7, 0)),
      scene,
    );
    cam.layerMask = PREVIEW_CAMERA_MASK;
    cam.lowerRadiusLimit = 1.8;
    cam.upperRadiusLimit = 5;
    cam.lowerBetaLimit = 0.3;
    cam.upperBetaLimit = Math.PI * 0.55;
    cam.attachControl(this.previewCanvas, true);
    cam.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
    this.previewCamera = cam;

    // Preview-only lights. includeOnlyWithLayerMask scopes them to the preview
    // character layer.
    const hemi = new HemisphericLight('previewHemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.6;
    hemi.groundColor = new Color3(0.15, 0.15, 0.15);
    hemi.includeOnlyWithLayerMask = PREVIEW_LAYER_MASK;
    const dir = new DirectionalLight('previewDir', new Vector3(-0.5, -1, 0.5), scene);
    dir.intensity = 0.5;
    dir.includeOnlyWithLayerMask = PREVIEW_LAYER_MASK;
    this.previewLights = { hemi, dir };

    this.loadPreviewCharacter(anchor);
    engine.runRenderLoop(() => {
      scene.render();
    });
  }

  private loadPreviewCharacter(anchor: Vector3): void {
    const scene = this.previewScene;
    if (!scene || this.destroyed) return;
    const modelPath = this.getModelPath();
    this.previewModelPath = modelPath;
    const character = new CharacterEntity(scene, {
      name: 'previewChar',
      modelPath,
      targetHeight: CHARACTER_TARGET_HEIGHT,
      layerMask: PREVIEW_LAYER_MASK,
      additionalAnimations: [
        { name: 'idle', path: CHARACTER_IDLE_ANIM },
      ],
    });
    this.previewCharacter = character;
    character.setPositionXYZ(anchor.x, anchor.y, anchor.z);
    character.whenReady().then(() => {
      if (!this.destroyed && this.previewCharacter === character) {
        character.applyAppearance(this.appearance);
      }
    });
  }

  private getModelPath(): string {
    return getCharacterModelPath(this.appearance);
  }

  private updatePreview(): void {
    const nextModelPath = this.getModelPath();
    if (nextModelPath !== this.previewModelPath) {
      const anchor = this.previewCharacter?.position.clone() ?? Vector3.Zero();
      if (this.previewCharacter) {
        this.previewCharacter.dispose();
        this.previewCharacter = null;
      }
      this.loadPreviewCharacter(anchor);
      return;
    }
    if (this.previewCharacter?.isReady) {
      this.previewCharacter.applyAppearance(this.appearance);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.previewInitFrame !== null) {
      cancelAnimationFrame(this.previewInitFrame);
      this.previewInitFrame = null;
    }
    if (this.previewCharacter) { this.previewCharacter.dispose(); this.previewCharacter = null; }
    if (this.previewResizeObserver) {
      this.previewResizeObserver.disconnect();
      this.previewResizeObserver = null;
    }
    window.removeEventListener('resize', this.resizePreview);
    window.removeEventListener('evilquest:viewportchange', this.resizePreview);
    document.removeEventListener('keydown', this.handleKeyDown, true);
    if (this.previewCamera) {
      this.previewCamera.dispose();
      this.previewCamera = null;
    }
    if (this.previewLights) {
      this.previewLights.hemi.dispose();
      this.previewLights.dir.dispose();
      this.previewLights = null;
    }
    if (this.previewEngine) {
      this.previewEngine.stopRenderLoop();
    }
    if (this.previewScene) {
      this.previewScene.dispose();
      this.previewScene = null;
    }
    if (this.previewEngine) {
      this.previewEngine.dispose();
      this.previewEngine = null;
    }
    // Restore the local player to whatever enabled state it had before we
    // hid it. Important if the player was already hidden by some other path
    // (e.g. spawning, cutscene) — we don't want to force-enable in that case.
    if (this.localPlayer && this.localPlayerHidden) {
      const root = this.localPlayer.getRoot();
      for (const [mesh, layerMask] of this.localPlayerMeshMasks) {
        if (!mesh.isDisposed()) mesh.layerMask = layerMask;
      }
      this.localPlayerMeshMasks.clear();
      if (root) root.setEnabled(this.localPlayerWasEnabled);
      this.localPlayerHidden = false;
    }
    this.container.remove();
  }
}
