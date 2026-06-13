export type GroundItemLabelMode = 'off' | 'valuable' | 'all';
export type NameplateMode = 'off' | 'friends' | 'players' | 'all';
export type TooltipMode = 'off' | 'on';
export type FramePaceMode = 'smooth' | 'battery';

export interface GameSettings {
  groundItemLabels: GroundItemLabelMode;
  nameplates: NameplateMode;
  tooltips: TooltipMode;
  framePace: FramePaceMode;
}

export interface GameSettingsOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

const STORAGE_KEY = 'projectrs_game_settings_v1';

export const GROUND_ITEM_LABEL_OPTIONS: readonly GameSettingsOption<GroundItemLabelMode>[] = [
  { value: 'off', label: 'Off', description: 'Hide ground item labels.' },
  { value: 'valuable', label: 'Valuable only', description: 'Show labels for valuable nearby drops.' },
  { value: 'all', label: 'All nearby', description: 'Show labels for all nearby drops.' },
];

export const NAMEPLATE_OPTIONS: readonly GameSettingsOption<NameplateMode>[] = [
  { value: 'off', label: 'Off', description: 'Hide player and NPC nameplates.' },
  { value: 'friends', label: 'Friends', description: 'Show nameplates for friends only.' },
  { value: 'players', label: 'Players', description: 'Show player nameplates and hide NPC nameplates.' },
  { value: 'all', label: 'All', description: 'Show all player and NPC nameplates.' },
];

export const TOOLTIP_OPTIONS: readonly GameSettingsOption<TooltipMode>[] = [
  { value: 'off', label: 'Off', description: 'Hide hover tooltips.' },
  { value: 'on', label: 'On', description: 'Show hover tooltips.' },
];

export const FRAME_PACE_OPTIONS: readonly GameSettingsOption<FramePaceMode>[] = [
  { value: 'smooth', label: 'Smooth', description: 'Render every display frame.' },
  { value: 'battery', label: 'Battery', description: 'Pace rendering to a display-friendly lower cadence while keeping input and camera updates live.' },
];

const DEFAULT_GAME_SETTINGS: GameSettings = {
  groundItemLabels: 'off',
  nameplates: 'all',
  tooltips: 'on',
  framePace: 'smooth',
};

let installed = false;
let activeSettings: GameSettings = { ...DEFAULT_GAME_SETTINGS };

export function normalizeGroundItemLabelMode(value: unknown): GroundItemLabelMode {
  return value === 'valuable' || value === 'all' || value === 'off' ? value : DEFAULT_GAME_SETTINGS.groundItemLabels;
}

export function normalizeNameplateMode(value: unknown): NameplateMode {
  return value === 'friends' || value === 'players' || value === 'all' || value === 'off'
    ? value
    : DEFAULT_GAME_SETTINGS.nameplates;
}

export function normalizeTooltipMode(value: unknown): TooltipMode {
  return value === 'off' || value === 'on' || value === 'instant' || value === 'delayed'
    ? value === 'off'
      ? 'off'
      : 'on'
    : DEFAULT_GAME_SETTINGS.tooltips;
}

export function normalizeFramePaceMode(value: unknown): FramePaceMode {
  return value === 'battery' || value === 'smooth' ? value : DEFAULT_GAME_SETTINGS.framePace;
}

function normalizeGameSettings(value: Partial<GameSettings> | null | undefined): GameSettings {
  return {
    groundItemLabels: normalizeGroundItemLabelMode(value?.groundItemLabels),
    nameplates: normalizeNameplateMode(value?.nameplates),
    tooltips: normalizeTooltipMode(value?.tooltips),
    framePace: normalizeFramePaceMode(value?.framePace),
  };
}

function readStoredSettings(): GameSettings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_GAME_SETTINGS };
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_GAME_SETTINGS };
    return normalizeGameSettings(JSON.parse(stored) as Partial<GameSettings>);
  } catch {
    return { ...DEFAULT_GAME_SETTINGS };
  }
}

function saveSettings(settings: GameSettings): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }
  } catch {
    // Ignore storage failures; apply the value for this active page.
  }
}

export function getGameSettings(): GameSettings {
  activeSettings = readStoredSettings();
  return { ...activeSettings };
}

export function applyGameSettings(settings: GameSettings = getGameSettings()): void {
  activeSettings = normalizeGameSettings(settings);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('evilquest:gamesettingschange', {
      detail: { ...activeSettings },
    }));
  }
}

export function setGroundItemLabelMode(mode: GroundItemLabelMode): GroundItemLabelMode {
  activeSettings = getGameSettings();
  activeSettings.groundItemLabels = normalizeGroundItemLabelMode(mode);
  saveSettings(activeSettings);
  applyGameSettings(activeSettings);
  return activeSettings.groundItemLabels;
}

export function setNameplateMode(mode: NameplateMode): NameplateMode {
  activeSettings = getGameSettings();
  activeSettings.nameplates = normalizeNameplateMode(mode);
  saveSettings(activeSettings);
  applyGameSettings(activeSettings);
  return activeSettings.nameplates;
}

export function setTooltipMode(mode: TooltipMode): TooltipMode {
  activeSettings = getGameSettings();
  activeSettings.tooltips = normalizeTooltipMode(mode);
  saveSettings(activeSettings);
  applyGameSettings(activeSettings);
  return activeSettings.tooltips;
}

export function setFramePaceMode(mode: FramePaceMode): FramePaceMode {
  activeSettings = getGameSettings();
  activeSettings.framePace = normalizeFramePaceMode(mode);
  saveSettings(activeSettings);
  applyGameSettings(activeSettings);
  return activeSettings.framePace;
}

export function installGameSettingsController(): void {
  if (installed) return;
  installed = true;

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) applyGameSettings();
    });
  }
  applyGameSettings();
}
