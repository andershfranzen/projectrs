export type BrightnessLevel = 1 | 2 | 3 | 4;

export interface BrightnessOption {
  value: BrightnessLevel;
  label: string;
  description: string;
}

const STORAGE_KEY = 'projectrs_brightness_level';

export const BRIGHTNESS_OPTIONS: readonly BrightnessOption[] = [
  { value: 1, label: '1', description: 'A bit darker.' },
  { value: 2, label: '2', description: 'Slightly darker.' },
  { value: 3, label: '3', description: 'Current game brightness.' },
  { value: 4, label: '4', description: 'Brighter.' },
];

const BRIGHTNESS_MULTIPLIERS: Readonly<Record<BrightnessLevel, number>> = {
  1: 0.86,
  2: 0.93,
  3: 1,
  4: 1.12,
};

let installed = false;
let activeLevel: BrightnessLevel = 3;

export function normalizeBrightnessLevel(value: unknown): BrightnessLevel {
  const numeric = Math.round(typeof value === 'number' ? value : Number(value));
  if (numeric <= 1) return 1;
  if (numeric === 2) return 2;
  if (numeric === 4) return 4;
  return 3;
}

export function brightnessMultiplierForLevel(level: BrightnessLevel): number {
  return BRIGHTNESS_MULTIPLIERS[normalizeBrightnessLevel(level)];
}

export function getBrightnessLevel(): BrightnessLevel {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== null) activeLevel = normalizeBrightnessLevel(stored);
    }
  } catch {
    // Storage can be blocked; keep the session value.
  }
  return activeLevel;
}

export function applyBrightnessLevel(): void {
  const level = getBrightnessLevel();
  const multiplier = brightnessMultiplierForLevel(level);
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (root) {
    root.style.setProperty('--eq-game-brightness', multiplier.toFixed(2));
    root.dataset.eqBrightnessLevel = String(level);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('evilquest:brightnesschange', { detail: { level, multiplier } }));
  }
}

export function setBrightnessLevel(level: BrightnessLevel): void {
  activeLevel = normalizeBrightnessLevel(level);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, String(activeLevel));
    }
  } catch {
    // Ignore storage failures; apply the value for this active page.
  }
  applyBrightnessLevel();
}

export function installBrightnessController(): void {
  if (installed) return;
  installed = true;

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) applyBrightnessLevel();
    });
  }
  applyBrightnessLevel();
}
