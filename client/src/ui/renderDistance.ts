import { CHUNK_LOAD_RADIUS } from '@projectrs/shared';

export type RenderDistanceValue = 'low' | 'medium' | 'max';

export interface RenderDistanceOption {
  value: RenderDistanceValue;
  label: string;
  description: string;
  cameraMaxZ: number;
  chunkRadius: number;
}

const STORAGE_KEY = 'projectrs_render_distance';
const DEFAULT_CAMERA_MAX_Z = 60;

export const RENDER_DISTANCE_OPTIONS: readonly RenderDistanceOption[] = [
  {
    value: 'low',
    label: 'Low',
    description: 'Shorter world view and fewer streamed chunks.',
    cameraMaxZ: 38,
    chunkRadius: 1,
  },
  {
    value: 'medium',
    label: 'Med',
    description: 'Balanced world view and chunk streaming.',
    cameraMaxZ: 50,
    chunkRadius: 1,
  },
  {
    value: 'max',
    label: 'Max',
    description: 'Current maximum world view.',
    cameraMaxZ: DEFAULT_CAMERA_MAX_Z,
    chunkRadius: CHUNK_LOAD_RADIUS,
  },
];

let activeValue: RenderDistanceValue = 'max';
let installed = false;

export function normalizeRenderDistanceValue(value: unknown): RenderDistanceValue {
  return value === 'low' || value === 'medium' || value === 'max' ? value : 'max';
}

export function renderDistanceOptionFor(value: RenderDistanceValue): RenderDistanceOption {
  return RENDER_DISTANCE_OPTIONS.find(option => option.value === normalizeRenderDistanceValue(value))
    ?? RENDER_DISTANCE_OPTIONS[RENDER_DISTANCE_OPTIONS.length - 1];
}

export function getRenderDistance(): RenderDistanceValue {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== null) activeValue = normalizeRenderDistanceValue(stored);
    }
  } catch {
    // Storage can be blocked; keep the session value.
  }
  return activeValue;
}

export function applyRenderDistance(): void {
  const value = getRenderDistance();
  const option = renderDistanceOptionFor(value);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('evilquest:renderdistancechange', {
      detail: {
        value,
        cameraMaxZ: option.cameraMaxZ,
        chunkRadius: option.chunkRadius,
      },
    }));
  }
}

export function setRenderDistance(value: RenderDistanceValue): void {
  activeValue = normalizeRenderDistanceValue(value);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, activeValue);
    }
  } catch {
    // Ignore storage failures; apply the value for this active page.
  }
  applyRenderDistance();
}

export function installRenderDistanceController(): void {
  if (installed) return;
  installed = true;

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) applyRenderDistance();
    });
  }
}
