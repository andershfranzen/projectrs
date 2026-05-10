import {
  type PlayerAppearance,
  DEFAULT_APPEARANCE,
  SHIRT_COLORS,
  PANTS_COLORS,
  SHOES_COLORS,
  HAIR_COLORS,
  SKIN_COLORS,
  HAIR_STYLE_COUNT,
} from '@projectrs/shared';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3, Color3 } from '@babylonjs/core/Maths/math';
import type { Observer } from '@babylonjs/core/Misc/observable';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import { CharacterEntity } from '../rendering/CharacterEntity';
// Side-effect import: extends AbstractEngine.prototype with registerView /
// unRegisterView. Without this, the multi-canvas preview throws
// "engine.registerView is not a function" because individual Babylon imports
// don't pull in this prototype patch.
import '@babylonjs/core/Engines/AbstractEngine/abstractEngine.views';

export type CharacterCreatorCallback = (appearance: PlayerAppearance) => void;

/**
 * Layer-mask bit reserved for the CharacterCreator preview. Meshes/lights
 * marked with this mask are visible only to the preview camera; the main
 * world camera ignores them (default mask 0x0FFFFFFF doesn't include this
 * bit). Picked outside Babylon's default mask so it can't collide with
 * unset meshes.
 */
const PREVIEW_LAYER_MASK = 0x10000000;

/**
 * Far-away anchor where the preview character lives so it never overlaps
 * the playable world. Picked deep below the world floor.
 */
const PREVIEW_ANCHOR = new Vector3(0, -1000, 0);

/**
 * Full-screen character creation overlay shown to new accounts.
 *
 * Renders the live 3D preview INTO the main game's existing Babylon engine +
 * scene by registering the preview canvas as an additional view (see
 * `engine.registerView`). The preview character lives at PREVIEW_ANCHOR with
 * a unique layer mask so the world camera doesn't see it. Sharing the engine
 * avoids creating a second WebGL context (browser context cap is ~16; opening
 * the creator a few times under the old design would evict the main game's
 * context and cause multi-second hitches).
 */
export class CharacterCreator {
  private container: HTMLDivElement;
  private onConfirm: CharacterCreatorCallback;
  private appearance: PlayerAppearance;

  private gameScene: Scene;
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewCamera: ArcRotateCamera | null = null;
  private previewLights: { hemi: HemisphericLight; dir: DirectionalLight } | null = null;
  private previewCharacter: CharacterEntity | null = null;

  // Saved fog state restored after the preview camera renders each frame
  private fogObserver: Observer<Camera> | null = null;
  private fogObserverAfter: Observer<Camera> | null = null;

  constructor(gameScene: Scene, onConfirm: CharacterCreatorCallback) {
    this.gameScene = gameScene;
    this.onConfirm = onConfirm;
    this.appearance = { ...DEFAULT_APPEARANCE };
    this.container = this.buildUI();
    document.body.appendChild(this.container);
    // Defer preview init to next frame so the DOM canvas is attached
    requestAnimationFrame(() => this.initPreview());
  }

  private buildUI(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.id = 'character-creator';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.85);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      z-index: 10000; font-family: monospace;
    `;

    const title = document.createElement('div');
    title.textContent = 'Create Your Character';
    title.style.cssText = `
      font-size: 32px; font-weight: bold; color: #fc0;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.8), 0 0 20px rgba(255,204,0,0.3);
      margin-bottom: 6px; letter-spacing: 2px;
    `;
    overlay.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.textContent = 'Choose your appearance';
    subtitle.style.cssText = `font-size: 13px; color: #8a7a60; margin-bottom: 24px;`;
    overlay.appendChild(subtitle);

    const card = document.createElement('div');
    card.style.cssText = `
      display: flex; gap: 24px;
      background: rgba(30, 25, 18, 0.95);
      border: 2px solid #5a4a35; border-radius: 6px;
      padding: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    `;

    // Left: 3D preview
    const previewCol = document.createElement('div');
    previewCol.style.cssText = `display: flex; flex-direction: column; align-items: center;`;

    const canvas = document.createElement('canvas');
    canvas.id = 'character-preview-canvas';
    canvas.width = 280;
    canvas.height = 400;
    canvas.style.cssText = `
      width: 280px; height: 400px;
      border: 1px solid #5a4a35; border-radius: 4px;
      background: #1a1a1a;
    `;
    this.previewCanvas = canvas;
    previewCol.appendChild(canvas);

    const hint = document.createElement('div');
    hint.textContent = 'Drag to rotate';
    hint.style.cssText = `font-size: 10px; color: #666; margin-top: 6px;`;
    previewCol.appendChild(hint);
    card.appendChild(previewCol);

    // Right: swatches + confirm
    const swatchCol = document.createElement('div');
    swatchCol.style.cssText = `display: flex; flex-direction: column; min-width: 280px; max-height: 420px; overflow-y: auto;`;

    this.addIndexRow(swatchCol, 'Hair', 'hairStyle', HAIR_STYLE_COUNT, true);
    this.addColorRow(swatchCol, 'Hair Color', 'hairColor', HAIR_COLORS);
    this.addColorRow(swatchCol, 'Skin', 'skinColor', SKIN_COLORS);
    this.addColorRow(swatchCol, 'Shirt', 'shirtColor', SHIRT_COLORS);
    this.addColorRow(swatchCol, 'Pants', 'pantsColor', PANTS_COLORS);
    this.addColorRow(swatchCol, 'Shoes', 'shoesColor', SHOES_COLORS);

    const btn = document.createElement('button');
    btn.textContent = 'Confirm';
    btn.style.cssText = `
      width: 100%; padding: 12px; margin-top: 16px;
      background: linear-gradient(180deg, #5a4a35 0%, #3a3025 100%);
      border: 2px solid #7a6a50; border-radius: 4px;
      color: #fc0; font-family: monospace; font-size: 16px;
      font-weight: bold; cursor: pointer; letter-spacing: 1px;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'linear-gradient(180deg, #7a6a50 0%, #5a4a35 100%)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'linear-gradient(180deg, #5a4a35 0%, #3a3025 100%)';
    });
    btn.addEventListener('click', () => {
      this.onConfirm({ ...this.appearance });
    });
    swatchCol.appendChild(btn);

    card.appendChild(swatchCol);
    overlay.appendChild(card);
    return overlay;
  }

  private initPreview(): void {
    if (!this.previewCanvas) return;

    const engine = this.gameScene.getEngine();

    // Camera lives in the main scene. layerMask scopes it to preview-tagged
    // meshes only — anything in the playable world (default mask) is invisible
    // to this camera, so the preview window never shows world geometry.
    const cam = new ArcRotateCamera(
      'previewCam', Math.PI * 0.75, Math.PI * 0.4, 3.0,
      PREVIEW_ANCHOR.add(new Vector3(0, 0.7, 0)),
      this.gameScene,
    );
    cam.layerMask = PREVIEW_LAYER_MASK;
    cam.lowerRadiusLimit = 2;
    cam.upperRadiusLimit = 5;
    cam.lowerBetaLimit = 0.3;
    cam.upperBetaLimit = Math.PI * 0.55;
    cam.attachControl(this.previewCanvas, true);
    cam.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
    this.previewCamera = cam;

    // Preview-only lights. includeOnlyWithLayerMask makes them affect *only*
    // preview-tagged meshes, so they don't double up on the world's lighting.
    const hemi = new HemisphericLight('previewHemi', new Vector3(0, 1, 0), this.gameScene);
    hemi.intensity = 0.6;
    hemi.groundColor = new Color3(0.15, 0.15, 0.15);
    hemi.includeOnlyWithLayerMask = PREVIEW_LAYER_MASK;
    const dir = new DirectionalLight('previewDir', new Vector3(-0.5, -1, 0.5), this.gameScene);
    dir.intensity = 0.5;
    dir.includeOnlyWithLayerMask = PREVIEW_LAYER_MASK;
    this.previewLights = { hemi, dir };

    // Disable scene fog only while the preview camera is rendering so the
    // creator backdrop stays clean (the world's fog tints meshes by depth and
    // would muddy the preview at PREVIEW_ANCHOR's distance from origin).
    let savedFogEnabled = false;
    this.fogObserver = this.gameScene.onBeforeCameraRenderObservable.add((c: Camera) => {
      if (c === cam) {
        savedFogEnabled = this.gameScene.fogEnabled;
        this.gameScene.fogEnabled = false;
      }
    });
    this.fogObserverAfter = this.gameScene.onAfterCameraRenderObservable.add((c: Camera) => {
      if (c === cam) {
        this.gameScene.fogEnabled = savedFogEnabled;
      }
    });

    // Register the preview canvas as a second view of the same engine. The
    // engine renders the scene once to its main canvas, then again per
    // registered view (with the view's camera) to that view's canvas. Same
    // GL context, same materials, same parsed GLBs.
    engine.registerView(this.previewCanvas, cam);

    this.loadPreviewCharacter();
  }

  private loadPreviewCharacter(): void {
    this.previewCharacter = new CharacterEntity(this.gameScene, {
      name: 'previewChar',
      modelPath: this.getModelPath(),
      targetHeight: 1.53,
      layerMask: PREVIEW_LAYER_MASK,
      additionalAnimations: [
        { name: 'idle', path: '/Character models/new animations/idle.glb' },
      ],
    });
    this.previewCharacter.setPositionXYZ(PREVIEW_ANCHOR.x, PREVIEW_ANCHOR.y, PREVIEW_ANCHOR.z);
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

  private rebuildPreview(): void {
    if (this.previewCharacter) {
      this.previewCharacter.dispose();
      this.previewCharacter = null;
    }
    this.loadPreviewCharacter();
  }

  private addColorRow(parent: HTMLDivElement, label: string, slot: keyof PlayerAppearance, palette: [number, number, number][]): void {
    const row = document.createElement('div');
    row.style.cssText = `margin-bottom: 14px;`;
    const labelEl = document.createElement('div');
    labelEl.textContent = label;
    labelEl.style.cssText = `font-size: 12px; color: #ccc; margin-bottom: 6px; font-weight: bold;`;
    row.appendChild(labelEl);

    const swatches = document.createElement('div');
    swatches.style.cssText = `display: flex; flex-wrap: wrap; gap: 6px;`;

    palette.forEach((rgb, index) => {
      const swatch = document.createElement('div');
      const isNoBelt = slot === 'beltColor' && index === 0;
      const r = Math.round(Math.pow(rgb[0], 1 / 2.2) * 255);
      const g = Math.round(Math.pow(rgb[1], 1 / 2.2) * 255);
      const b = Math.round(Math.pow(rgb[2], 1 / 2.2) * 255);
      const isSelected = this.appearance[slot] === index;
      swatch.style.cssText = `
        width: ${isNoBelt ? 'auto' : '28px'}; height: 28px; border-radius: 3px; cursor: pointer;
        background: ${isNoBelt ? 'linear-gradient(135deg, #555, #333)' : `rgb(${r}, ${g}, ${b})`};
        border: 2px solid ${isSelected ? '#fc0' : '#555'};
        transition: border-color 0.15s, transform 0.1s;
        ${isNoBelt ? 'padding: 0 6px; display: flex; align-items: center; font-size: 9px; color: #ccc; font-family: monospace;' : ''}
      `;
      if (isNoBelt) swatch.textContent = 'None';
      swatch.dataset.slot = slot;
      swatch.dataset.index = String(index);
      swatch.addEventListener('mouseenter', () => {
        if (this.appearance[slot] !== index) { swatch.style.borderColor = '#aaa'; swatch.style.transform = 'scale(1.1)'; }
      });
      swatch.addEventListener('mouseleave', () => {
        swatch.style.borderColor = this.appearance[slot] === index ? '#fc0' : '#555'; swatch.style.transform = 'scale(1)';
      });
      swatch.addEventListener('click', () => {
        this.appearance[slot] = index;
        swatches.querySelectorAll('div').forEach((s) => {
          const el = s as HTMLDivElement;
          el.style.borderColor = (el.dataset.slot === slot && el.dataset.index === String(index)) ? '#fc0' : '#555';
        });
        this.updatePreview();
      });
      swatches.appendChild(swatch);
    });
    row.appendChild(swatches);
    parent.appendChild(row);
  }

  private addIndexRow(parent: HTMLDivElement, label: string, slot: keyof PlayerAppearance, count: number, hasNone: boolean): void {
    const row = document.createElement('div');
    row.style.cssText = `margin-bottom: 14px;`;
    const labelEl = document.createElement('div');
    labelEl.textContent = label;
    labelEl.style.cssText = `font-size: 12px; color: #ccc; margin-bottom: 6px; font-weight: bold;`;
    row.appendChild(labelEl);

    const btns = document.createElement('div');
    btns.style.cssText = `display: flex; flex-wrap: wrap; gap: 4px;`;

    const start = hasNone ? 0 : 0;
    const end = hasNone ? count : count - 1;

    for (let i = start; i <= end; i++) {
      const btn = document.createElement('div');
      btn.textContent = (hasNone && i === 0) ? '—' : String(i + (hasNone ? 0 : 1));
      const isSelected = this.appearance[slot] === i;
      btn.dataset.index = String(i);
      btn.style.cssText = `
        width: 26px; height: 26px; border-radius: 3px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-family: monospace; font-weight: bold;
        background: ${isSelected ? 'rgba(90,74,53,0.6)' : 'rgba(40,35,28,0.6)'};
        color: ${isSelected ? '#fc0' : '#999'};
        border: 2px solid ${isSelected ? '#fc0' : '#555'};
        transition: all 0.15s;
      `;
      btn.addEventListener('mouseenter', () => {
        if (this.appearance[slot] !== i) { btn.style.borderColor = '#aaa'; btn.style.color = '#ccc'; }
      });
      btn.addEventListener('mouseleave', () => {
        const sel = this.appearance[slot] === i;
        btn.style.borderColor = sel ? '#fc0' : '#555'; btn.style.color = sel ? '#fc0' : '#999';
      });
      btn.addEventListener('click', () => {
        if (this.appearance[slot] === i) return;
        this.appearance[slot] = i;
        btns.querySelectorAll('div').forEach((b) => {
          const el = b as HTMLDivElement;
          const sel = el.dataset.index === String(i);
          el.style.borderColor = sel ? '#fc0' : '#555';
          el.style.color = sel ? '#fc0' : '#999';
          el.style.background = sel ? 'rgba(90,74,53,0.6)' : 'rgba(40,35,28,0.6)';
        });
        this.updatePreview();
      });
      btns.appendChild(btn);
    }
    row.appendChild(btns);
    parent.appendChild(row);
  }

  destroy(): void {
    if (this.previewCharacter) { this.previewCharacter.dispose(); this.previewCharacter = null; }

    if (this.fogObserver) {
      this.gameScene.onBeforeCameraRenderObservable.remove(this.fogObserver);
      this.fogObserver = null;
    }
    if (this.fogObserverAfter) {
      this.gameScene.onAfterCameraRenderObservable.remove(this.fogObserverAfter);
      this.fogObserverAfter = null;
    }

    if (this.previewCanvas) {
      this.gameScene.getEngine().unRegisterView(this.previewCanvas);
    }
    if (this.previewCamera) {
      this.previewCamera.dispose();
      this.previewCamera = null;
    }
    if (this.previewLights) {
      this.previewLights.hemi.dispose();
      this.previewLights.dir.dispose();
      this.previewLights = null;
    }
    this.container.remove();
  }
}
