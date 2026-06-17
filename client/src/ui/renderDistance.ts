export type RenderDistanceValue = 'low';

export interface RenderDistanceOption {
  value: RenderDistanceValue;
  label: string;
  description: string;
  viewDistanceTiles: number;
  cameraMaxZ: number;
  chunkRadius: number;
}

const STORAGE_KEY = 'projectrs_render_distance';

export const RENDER_DISTANCE_OPTIONS: readonly RenderDistanceOption[] = [
  {
    value: 'low',
    label: 'Low',
    description: 'Short player-centered world view.',
    viewDistanceTiles: 21,
    cameraMaxZ: 38,
    chunkRadius: 2,
  },
];

let activeValue: RenderDistanceValue = 'low';
let installed = false;

export function normalizeRenderDistanceValue(_value: unknown): RenderDistanceValue {
  return 'low';
}

export function renderDistanceOptionFor(value: RenderDistanceValue): RenderDistanceOption {
  return RENDER_DISTANCE_OPTIONS.find(option => option.value === normalizeRenderDistanceValue(value))
    ?? RENDER_DISTANCE_OPTIONS[0];
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
        viewDistanceTiles: option.viewDistanceTiles,
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
