import {
  type PlayerAppearance,
  DEFAULT_APPEARANCE,
  SHIRT_COLORS, SHIRT_COLOR_NAMES,
  PANTS_COLORS, PANTS_COLOR_NAMES,
  SHOES_COLORS, SHOES_COLOR_NAMES,
  HAIR_COLORS, HAIR_COLOR_NAMES,
  SKIN_COLORS, SKIN_COLOR_NAMES,
  BELT_COLORS, BELT_COLOR_NAMES,
  HAIR_STYLE_COUNT,
  hairStyleName,
} from '@projectrs/shared';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { CharacterEntity } from '../rendering/CharacterEntity';
import { createModalPanel } from './ModalPanel';
import { closeActiveContextMenu } from './popupStyle';

export type CharacterCreatorCallback = (appearance: PlayerAppearance) => void;

/**
 * Layer-mask bit reserved for the CharacterCreator preview character.
 */
const PREVIEW_LAYER_MASK = 0x10000000;
const PREVIEW_CAMERA_MASK = PREVIEW_LAYER_MASK;
const HIDDEN_LAYER_MASK = 0x20000000;

/**
 * Fallback anchor used when no `localPlayer` ref is supplied (e.g. if the
 * creator is opened before the player has spawned). Sits deep below the
 * world floor so it doesn't collide with playable geometry.
 */
const FALLBACK_PREVIEW_ANCHOR = new Vector3(0, -1000, 0);

/** Stepper row spec — one per appearance slot. The picker UI is identical
 *  for all rows; only the value-display differs (color swatch vs label). */
interface StepperRow {
  label: string;
  /** Inclusive bounds of the slot's index. */
  min: number;
  max: number;
  /** Read current index from the appearance struct. */
  get: (a: PlayerAppearance) => number;
  /** Write a new index back to the appearance struct (mutates). */
  set: (a: PlayerAppearance, idx: number) => void;
  /** Display name for the current index (e.g. "Dark Blue", "Style 3"). */
  name: (idx: number) => string;
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
  private appearance: PlayerAppearance;

  private gameScene: Scene;
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewEngine: Engine | null = null;
  private previewScene: Scene | null = null;
  private previewCamera: ArcRotateCamera | null = null;
  private previewLights: { hemi: HemisphericLight; dir: DirectionalLight } | null = null;
  private previewCharacter: CharacterEntity | null = null;

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

  /**
   * @param gameScene  Main Babylon scene (preview re-uses its engine + GL context)
   * @param onConfirm  Called with the final appearance when the user clicks Confirm
   * @param opts       Optional:
   *   - `initial`: starting appearance — `/appearance` edits should pass the
   *     player's current appearance so the stepper opens on existing values.
   *   - `localPlayer`: player's CharacterEntity. While the creator is open,
   *     the local player is hidden and the preview character spawns at their
   *     world position so the preview shows them in their actual environment.
   *     If omitted, the preview falls back to the deep-below-world studio
   *     anchor and shows the character on a flat backdrop.
   */
  constructor(
    gameScene: Scene,
    onConfirm: CharacterCreatorCallback,
    opts?: { initial?: PlayerAppearance; localPlayer?: CharacterEntity | null },
  ) {
    closeActiveContextMenu();
    this.gameScene = gameScene;
    this.onConfirm = onConfirm;
    this.appearance = { ...(opts?.initial ?? DEFAULT_APPEARANCE) };
    this.localPlayer = opts?.localPlayer ?? null;
    this.rowSpecs = this.buildRowSpecs();
    this.container = this.buildUI();
    document.body.appendChild(this.container);

    // Hide the local player while the creator is open so the preview char
    // doesn't double up with the world-rendered character. The character GLB
    // may still be loading when SHOW_CHARACTER_CREATOR arrives, so retry once
    // the entity reports ready.
    this.hideLocalPlayer();
    if (this.localPlayer) {
      void this.localPlayer.whenReady().then(() => this.hideLocalPlayer());
    }

    // Defer preview init to next frame so the DOM canvas is attached
    requestAnimationFrame(() => this.initPreview());
  }

  /** One spec per appearance slot. Order = visual order in the panel. */
  private buildRowSpecs(): StepperRow[] {
    const colorRow = (
      label: string,
      key: keyof PlayerAppearance,
      palette: [number, number, number][],
      names: string[],
    ): StepperRow => ({
      label,
      min: 0,
      max: palette.length - 1,
      get: (a) => a[key] as number,
      set: (a, i) => { (a as any)[key] = i; },
      name: (i) => names[i] ?? `#${i}`,
      swatch: (i) => palette[i] ?? null,
    });
    return [
      { label: 'Skin',       min: 0, max: SKIN_COLORS.length - 1,
        get: (a) => a.skinColor, set: (a, i) => { a.skinColor = i; },
        name: (i) => SKIN_COLOR_NAMES[i] ?? `#${i}`,
        swatch: (i) => SKIN_COLORS[i] ?? null },
      { label: 'Hair',       min: 0, max: HAIR_STYLE_COUNT,
        get: (a) => a.hairStyle, set: (a, i) => { a.hairStyle = i; },
        name: hairStyleName,
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
    // No full-screen overlay — the panel sits directly in the playable area
    // so the world is visible around it. Matches SmithingPanel/ShopPanel which
    // also center themselves inside the canvas without dimming the background.
    const { root: panel } = createModalPanel({
      id: 'character-creator',
      title: 'Create Your Character',
      subtitle: 'Choose your appearance',
      geometry: { kind: 'center', width: 'min(640px, 92vw)', maxHeight: '92vh', zIndex: 10000 },
      chrome: 'stone',
      closeButton: false,
      display: 'flex',
    });

    // Body — 2-column: 3D preview on left, stepper rows on right.
    const body = document.createElement('div');
    body.style.cssText = `
      display: flex; gap: 12px; padding: 12px; flex: 1; min-height: 0;
    `;

    // Preview column (fixed-shrink so the canvas always renders at full size)
    const previewCol = document.createElement('div');
    previewCol.style.cssText = `display: flex; flex-direction: column; align-items: center; flex-shrink: 0;`;
    const canvas = document.createElement('canvas');
    canvas.id = 'character-preview-canvas';
    canvas.width = 280;
    canvas.height = 400;
    canvas.style.cssText = `
      width: 280px; height: 400px;
      background: rgba(0,0,0,0.4);
      border: 2px inset #3a2a1a; border-radius: 3px;
    `;
    this.previewCanvas = canvas;
    previewCol.appendChild(canvas);
    const hint = document.createElement('div');
    hint.textContent = 'Drag to rotate · Scroll to zoom';
    hint.style.cssText = `font-size: 10px; color: #8a857c; margin-top: 6px; text-shadow: 1px 1px 0 #000;`;
    previewCol.appendChild(hint);
    body.appendChild(previewCol);

    // Stepper column
    const stepperCol = document.createElement('div');
    stepperCol.style.cssText = `
      flex: 1; display: flex; flex-direction: column; gap: 4px;
      min-width: 240px; overflow-y: auto;
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
    footer.style.cssText = `
      display: flex; gap: 8px; padding: 8px 12px;
      background: url('/ui/stone-light.png') repeat;
      border-top: 2px solid #1a1510;
      border-radius: 0 0 2px 2px;
    `;
    const randomize = this.makeFooterBtn('Randomize', () => {
      for (const spec of this.rowSpecs) {
        const idx = spec.min + Math.floor(Math.random() * (spec.max - spec.min + 1));
        spec.set(this.appearance, idx);
      }
      this.refreshAllRows();
      this.updatePreview();
    });
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    const confirm = this.makeFooterBtn('Confirm', () => {
      this.onConfirm({ ...this.appearance });
    });
    footer.appendChild(randomize);
    footer.appendChild(spacer);
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
    row.style.cssText = `
      display: grid;
      grid-template-columns: 90px 32px 1fr 32px;
      gap: 6px; align-items: center;
      padding: 4px 6px;
      background: rgba(0,0,0,0.25); border: 1px outset #3a2a1a;
      border-radius: 2px;
    `;

    const label = document.createElement('div');
    label.textContent = spec.label;
    label.style.cssText = `font-size: 12px; color: #d8372b; font-weight: bold; text-shadow: 1px 1px 0 #000;`;
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
    valueText.style.cssText = `font-size: 12px; color: #d8372b; flex: 1; text-shadow: 1px 1px 0 #000;`;
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
      width: 32px; height: 26px;
      background: linear-gradient(180deg, #5a3a2a 0%, #3a2518 100%);
      border: 1px solid #6a4a35; color: #d8372b;
      font-family: Arial, Helvetica, sans-serif; font-size: 14px; font-weight: bold;
      cursor: pointer; padding: 0; line-height: 1;
      text-shadow: 1px 1px 0 #000;
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
    const cur = spec.get(this.appearance);
    const range = spec.max - spec.min + 1;
    const next = ((cur - spec.min + delta) % range + range) % range + spec.min;
    if (next === cur) return;
    spec.set(this.appearance, next);
    this.refreshRow(rowIdx);
    this.updatePreview();
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
    if (valueEl) valueEl.textContent = spec.name(idx);
  }

  private refreshAllRows(): void {
    for (let i = 0; i < this.rowSpecs.length; i++) this.refreshRow(i);
  }

  /** Use the deep-below-world studio anchor always. Spawning at the local
   *  player's world position made framing unreliable — variable terrain Y
   *  and the character-rig feet-offset meant the character would slip above
   *  or below the preview camera's target. The studio anchor gives a clean,
   *  fixed reference. */
  private getAnchor(): Vector3 {
    return FALLBACK_PREVIEW_ANCHOR.clone();
  }

  private hideLocalPlayer(): void {
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
    if (!this.previewCanvas) return;

    const engine = new Engine(this.previewCanvas, false, { antialias: false, adaptToDeviceRatio: false });
    engine.setHardwareScalingLevel(1);
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new Color4(0.07, 0.10, 0.15, 1);
    this.previewEngine = engine;
    this.previewScene = scene;
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
    engine.runRenderLoop(() => scene.render());
  }

  private loadPreviewCharacter(anchor: Vector3): void {
    const scene = this.previewScene;
    if (!scene) return;
    this.previewCharacter = new CharacterEntity(scene, {
      name: 'previewChar',
      modelPath: this.getModelPath(),
      targetHeight: 1.53,
      layerMask: PREVIEW_LAYER_MASK,
      additionalAnimations: [
        { name: 'idle', path: '/Character models/new animations/idle.glb' },
      ],
    });
    this.previewCharacter.setPositionXYZ(anchor.x, anchor.y, anchor.z);
    this.previewCharacter.whenReady().then(() => {
      if (this.previewCharacter) {
        this.previewCharacter.applyAppearance(this.appearance);
      }
    });
  }

  private getModelPath(): string {
    return '/Character models/main character.glb';
  }

  private updatePreview(): void {
    if (this.previewCharacter?.isReady) {
      this.previewCharacter.applyAppearance(this.appearance);
    }
  }

  destroy(): void {
    if (this.previewCharacter) { this.previewCharacter.dispose(); this.previewCharacter = null; }
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
