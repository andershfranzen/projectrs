import { isDesktopClientSizeSettingAvailable } from './clientSizeMode';

export type UiScaleValue = 1 | 1.25 | 1.5;

export interface UiScaleOption {
  value: UiScaleValue;
  label: string;
}

const STORAGE_KEY = 'projectrs_ui_scale';
export const UI_SCALE_OPTIONS: readonly UiScaleOption[] = [
  { value: 1, label: '100%' },
  { value: 1.25, label: '125%' },
  { value: 1.5, label: '150%' },
];

let installed = false;
let activeScale: UiScaleValue = 1;

function normalizeUiScale(value: unknown): UiScaleValue {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 1;

  let best: UiScaleValue = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of UI_SCALE_OPTIONS) {
    const distance = Math.abs(option.value - numeric);
    if (distance < bestDistance) {
      best = option.value;
      bestDistance = distance;
    }
  }
  return best;
}

function optionIndex(scale: UiScaleValue): number {
  return UI_SCALE_OPTIONS.findIndex(option => option.value === scale);
}

export function getUiScale(): UiScaleValue {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      activeScale = normalizeUiScale(stored);
    }
  } catch {
    // Storage can be blocked; keep the session value.
  }
  return activeScale;
}

export function applyUiScale(): void {
  const appliedScale = isDesktopClientSizeSettingAvailable() ? getUiScale() : 1;
  const root = document.documentElement;
  root.style.setProperty('--eq-ui-scale', appliedScale.toFixed(2));
  root.style.setProperty('--eq-ui-scale-inverse-percent', `${(100 / appliedScale).toFixed(4)}%`);
  root.dataset.eqUiScale = appliedScale.toFixed(2);
  root.classList.toggle('eq-ui-scale-active', appliedScale > 1.01);
  window.dispatchEvent(new CustomEvent('evilquest:uiscalechange', { detail: { scale: appliedScale } }));
  window.dispatchEvent(new Event('resize'));
  window.dispatchEvent(new Event('evilquest:viewportchange'));
}

export function setUiScale(scale: UiScaleValue): void {
  activeScale = normalizeUiScale(scale);
  try {
    localStorage.setItem(STORAGE_KEY, String(activeScale));
  } catch {
    // Ignore storage failures; apply the value for this active page.
  }
  applyUiScale();
}

export function increaseUiScale(): UiScaleValue {
  const current = getUiScale();
  const nextIndex = Math.min(UI_SCALE_OPTIONS.length - 1, Math.max(0, optionIndex(current)) + 1);
  const next = UI_SCALE_OPTIONS[nextIndex]?.value ?? current;
  setUiScale(next);
  return next;
}

export function decreaseUiScale(): UiScaleValue {
  const current = getUiScale();
  const nextIndex = Math.max(0, optionIndex(current) - 1);
  const next = UI_SCALE_OPTIONS[nextIndex]?.value ?? current;
  setUiScale(next);
  return next;
}

export function resetUiScale(): UiScaleValue {
  setUiScale(1);
  return 1;
}

export function installUiScaleController(): void {
  if (installed) return;
  installed = true;

  const refresh = () => applyUiScale();
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) refresh();
  });
  window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 900px), (max-height: 520px) and (max-width: 900px) and (orientation: landscape)')
    .addEventListener('change', refresh);
  applyUiScale();
}
