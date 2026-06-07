import type { ItemDef } from '@projectrs/shared';
import {
  buildThumbnailOptionsFromOverride,
  invalidateThumbnailOverrides,
  type ThumbnailOverride,
} from '../rendering/ItemIcon';
import { renderThumbnailPreview } from '../rendering/ThumbnailRenderer';

type AuthTokenGetter = () => string;
type MessageCallback = (message: string) => void;

interface RotateDebugTarget {
  def: ItemDef;
  modelPath: string;
}

interface NumericParam {
  key: keyof ThumbnailOverride;
  label: string;
  kind: 'deg' | 'raw';
  min: number;
  max: number;
  step: number;
  fallback: number;
}

const DEFAULT_ALPHA = -Math.PI / 4;
const DEFAULT_BETA = Math.PI / 2.6;
const DEFAULT_DISTANCE_MULT = 0.75;

const PARAMS: NumericParam[] = [
  { key: 'alpha', label: 'Cam A', kind: 'deg', min: -180, max: 180, step: 1, fallback: DEFAULT_ALPHA },
  { key: 'beta', label: 'Cam B', kind: 'deg', min: 5, max: 175, step: 1, fallback: DEFAULT_BETA },
  { key: 'distanceMult', label: 'Zoom', kind: 'raw', min: 0.2, max: 2, step: 0.01, fallback: DEFAULT_DISTANCE_MULT },
  { key: 'rotationX', label: 'Rot X', kind: 'deg', min: -180, max: 180, step: 1, fallback: 0 },
  { key: 'rotationY', label: 'Rot Y', kind: 'deg', min: -180, max: 180, step: 1, fallback: 0 },
  { key: 'rotationZ', label: 'Rot Z', kind: 'deg', min: -180, max: 180, step: 1, fallback: 0 },
  { key: 'iconScale', label: 'Scale', kind: 'raw', min: 0.2, max: 2, step: 0.01, fallback: 1 },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function radToDeg(value: number): number {
  return value * 180 / Math.PI;
}

function degToRad(value: number): number {
  return value * Math.PI / 180;
}

function valueForUi(param: NumericParam, override: ThumbnailOverride): number {
  const raw = override[param.key];
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : param.fallback;
  return param.kind === 'deg' ? radToDeg(value) : value;
}

function valueForOverride(param: NumericParam, value: number): number {
  return param.kind === 'deg' ? degToRad(value) : value;
}

function readOverride(data: unknown, itemId: number): ThumbnailOverride {
  if (!data || typeof data !== 'object') return {};
  const raw = (data as Record<string, unknown>)[String(itemId)];
  return raw && typeof raw === 'object' ? raw as ThumbnailOverride : {};
}

function fmt(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, '') : '0';
}

export class RotateDebugPanel {
  private container: HTMLDivElement;
  private previewImg: HTMLImageElement;
  private titleEl: HTMLDivElement;
  private modelEl: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private sliders = new Map<keyof ThumbnailOverride, HTMLInputElement>();
  private inputs = new Map<keyof ThumbnailOverride, HTMLInputElement>();
  private target: RotateDebugTarget | null = null;
  private override: ThumbnailOverride = {};
  private visible = false;
  private renderSeq = 0;
  private renderTimer: number | null = null;
  private isDragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private getAuthToken: AuthTokenGetter = () => '';
  private showMessage: MessageCallback = () => {};

  constructor() {
    const built = this.buildUI();
    this.container = built.container;
    this.previewImg = built.previewImg;
    this.titleEl = built.titleEl;
    this.modelEl = built.modelEl;
    this.statusEl = built.statusEl;
    document.body.appendChild(this.container);
  }

  setAuthTokenGetter(getter: AuthTokenGetter): void {
    this.getAuthToken = getter;
  }

  setMessageCallback(callback: MessageCallback): void {
    this.showMessage = callback;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  async show(target: RotateDebugTarget): Promise<void> {
    this.target = target;
    this.visible = true;
    this.container.style.display = 'flex';
    this.titleEl.textContent = `${target.def.name} (${target.def.id})`;
    this.modelEl.textContent = target.modelPath;
    this.status('Loading override...');
    this.override = await this.loadOverride(target.def.id);
    this.syncControlsFromOverride();
    this.status('Live preview ready.');
    this.scheduleRender(0);
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = 'none';
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }

  destroy(): void {
    this.hide();
    this.container.remove();
  }

  private buildUI(): {
    container: HTMLDivElement;
    previewImg: HTMLImageElement;
    titleEl: HTMLDivElement;
    modelEl: HTMLDivElement;
    statusEl: HTMLDivElement;
  } {
    const container = document.createElement('div');
    container.id = 'rotate-debug-panel';
    Object.assign(container.style, {
      position: 'fixed',
      top: '72px',
      right: '14px',
      width: '340px',
      maxHeight: 'calc(100vh - 96px)',
      overflow: 'hidden',
      display: 'none',
      flexDirection: 'column',
      background: 'rgba(14, 12, 10, 0.96)',
      color: '#e7ddcb',
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: '12px',
      border: '1px solid #584a34',
      borderRadius: '6px',
      boxShadow: '0 8px 28px rgba(0,0,0,0.55)',
      zIndex: '10000',
      userSelect: 'none',
    });
    for (const eventName of ['pointerdown', 'contextmenu', 'wheel']) {
      container.addEventListener(eventName, (event) => {
        event.stopPropagation();
      }, true);
    }
    container.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    const titleBar = document.createElement('div');
    Object.assign(titleBar.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      padding: '8px 10px',
      cursor: 'move',
      background: '#18130e',
      borderBottom: '1px solid #3d3122',
      flexShrink: '0',
    });
    const titleWrap = document.createElement('div');
    titleWrap.style.cssText = 'min-width:0;flex:1;';
    const heading = document.createElement('div');
    heading.textContent = 'ROTATE DEBUG';
    heading.style.cssText = 'font-weight:bold;color:#d8aa45;font-size:11px;letter-spacing:1px;';
    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-weight:bold;color:#fff;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    titleWrap.appendChild(heading);
    titleWrap.appendChild(titleEl);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'x';
    Object.assign(closeBtn.style, {
      width: '24px',
      height: '24px',
      border: '1px solid #3b3023',
      borderRadius: '4px',
      background: '#211a13',
      color: '#cdbb9e',
      cursor: 'pointer',
      flexShrink: '0',
    });
    closeBtn.addEventListener('click', () => this.hide());
    titleBar.appendChild(titleWrap);
    titleBar.appendChild(closeBtn);
    container.appendChild(titleBar);

    titleBar.addEventListener('mousedown', (event) => {
      this.isDragging = true;
      this.dragOffsetX = event.clientX - container.offsetLeft;
      this.dragOffsetY = event.clientY - container.offsetTop;
      event.preventDefault();
    });
    document.addEventListener('mousemove', (event) => {
      if (!this.isDragging) return;
      container.style.left = `${event.clientX - this.dragOffsetX}px`;
      container.style.top = `${event.clientY - this.dragOffsetY}px`;
      container.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { this.isDragging = false; });

    const body = document.createElement('div');
    Object.assign(body.style, {
      padding: '10px',
      overflowY: 'auto',
      flex: '1',
    });

    const previewWrap = document.createElement('div');
    Object.assign(previewWrap.style, {
      height: '152px',
      display: 'grid',
      placeItems: 'center',
      background: '#0b0a08',
      border: '1px solid #30271d',
      borderRadius: '4px',
      marginBottom: '8px',
    });
    const previewImg = document.createElement('img');
    previewImg.alt = 'Item thumbnail preview';
    Object.assign(previewImg.style, {
      width: '128px',
      height: '128px',
      objectFit: 'contain',
      imageRendering: 'auto',
    });
    previewWrap.appendChild(previewImg);
    body.appendChild(previewWrap);

    const modelEl = document.createElement('div');
    modelEl.style.cssText = 'color:#867967;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:8px;';
    body.appendChild(modelEl);

    for (const param of PARAMS) {
      body.appendChild(this.buildParamRow(param));
    }

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:10px;';
    buttons.appendChild(this.button('Save', () => void this.save()));
    buttons.appendChild(this.button('Reload', () => void this.reload()));
    buttons.appendChild(this.button('Bake', () => this.openBake()));
    body.appendChild(buttons);

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'min-height:16px;margin-top:8px;color:#a99678;font-size:11px;';
    body.appendChild(statusEl);

    container.appendChild(body);
    return { container, previewImg, titleEl, modelEl, statusEl };
  }

  private buildParamRow(param: NumericParam): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:54px 1fr 64px;gap:6px;align-items:center;margin:6px 0;';
    const label = document.createElement('label');
    label.textContent = param.label;
    label.style.cssText = 'color:#ccb891;font-size:11px;';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(param.min);
    slider.max = String(param.max);
    slider.step = String(param.step);
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(param.min);
    input.max = String(param.max);
    input.step = String(param.step);
    Object.assign(input.style, {
      width: '58px',
      boxSizing: 'border-box',
      background: '#120f0b',
      color: '#eadcc1',
      border: '1px solid #3b3023',
      borderRadius: '3px',
      padding: '3px',
      fontSize: '11px',
    });
    const applyUiValue = (rawValue: number): void => {
      const next = clamp(rawValue, param.min, param.max);
      slider.value = fmt(next, param.kind === 'deg' ? 0 : 2);
      input.value = fmt(next, param.kind === 'deg' ? 0 : 2);
      this.override[param.key] = valueForOverride(param, next);
      this.scheduleRender();
    };
    slider.addEventListener('input', () => applyUiValue(Number(slider.value)));
    input.addEventListener('input', () => applyUiValue(Number(input.value)));
    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(input);
    this.sliders.set(param.key, slider);
    this.inputs.set(param.key, input);
    return row;
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    Object.assign(btn.style, {
      height: '28px',
      border: '1px solid #4a3c2a',
      borderRadius: '4px',
      background: '#211a13',
      color: '#eadcc1',
      cursor: 'pointer',
      fontWeight: 'bold',
      fontSize: '11px',
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  private async loadOverride(itemId: number): Promise<ThumbnailOverride> {
    try {
      const token = this.getAuthToken();
      const res = await fetch('/data/thumbnail-overrides.json', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) return {};
      return readOverride(await res.json(), itemId);
    } catch {
      return {};
    }
  }

  private syncControlsFromOverride(): void {
    for (const param of PARAMS) {
      const value = clamp(valueForUi(param, this.override), param.min, param.max);
      const text = fmt(value, param.kind === 'deg' ? 0 : 2);
      const slider = this.sliders.get(param.key);
      const input = this.inputs.get(param.key);
      if (slider) slider.value = text;
      if (input) input.value = text;
      this.override[param.key] = valueForOverride(param, value);
    }
  }

  private scheduleRender(delayMs = 90): void {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      void this.render();
    }, delayMs);
  }

  private async render(): Promise<void> {
    if (!this.target || !this.visible) return;
    const seq = ++this.renderSeq;
    this.status('Rendering...');
    const opts = buildThumbnailOptionsFromOverride(this.target.def, this.override, this.target.def);
    try {
      const url = await renderThumbnailPreview(this.target.modelPath, opts);
      if (seq !== this.renderSeq || !this.visible) return;
      if (url) {
        this.previewImg.src = url;
        this.status('Live preview ready.');
      } else {
        this.status('Preview failed.');
      }
    } catch (error) {
      if (seq !== this.renderSeq || !this.visible) return;
      const msg = error instanceof Error ? error.message : 'Preview failed.';
      this.status(msg);
    }
  }

  private async save(): Promise<void> {
    if (!this.target) return;
    this.status('Saving...');
    const token = this.getAuthToken();
    try {
      const res = await fetch('/api/dev/thumbnail-override', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          type: 'item',
          key: this.target.def.id,
          ...this.override,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(typeof data?.error === 'string' ? data.error : `Save failed (${res.status})`);
      }
      invalidateThumbnailOverrides();
      this.status('Saved.');
      this.showMessage(`Saved thumbnail rotation for ${this.target.def.name}.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Save failed.';
      this.status(msg);
      this.showMessage(msg);
    }
  }

  private async reload(): Promise<void> {
    if (!this.target) return;
    this.override = await this.loadOverride(this.target.def.id);
    this.syncControlsFromOverride();
    this.scheduleRender(0);
    this.status('Reloaded.');
  }

  private openBake(): void {
    if (!this.target) return;
    window.open(`/?bake=1&item=${encodeURIComponent(String(this.target.def.id))}`, '_blank');
    this.status(`Opened single-item bake for ${this.target.def.id}.`);
  }

  private status(message: string): void {
    this.statusEl.textContent = message;
  }
}
