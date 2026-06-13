export type ClientSizeMode = 'dynamic' | 'fixed';

export interface FixedClientSize {
  width: number;
  height: number;
}

const MODE_KEY = 'projectrs_client_size_mode';
export const FIXED_CLIENT_SIZE: FixedClientSize = { width: 1100, height: 720 };
const MOBILE_QUERY = '(max-width: 760px), (pointer: coarse) and (max-width: 900px), (max-height: 520px) and (max-width: 900px) and (orientation: landscape)';

let media: MediaQueryList | null = null;
let installed = false;

function getMedia(): MediaQueryList {
  media ??= window.matchMedia(MOBILE_QUERY);
  return media;
}

export function isDesktopClientSizeSettingAvailable(): boolean {
  return !getMedia().matches;
}

export function getClientSizeMode(): ClientSizeMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'fixed' ? 'fixed' : 'dynamic';
  } catch {
    return 'dynamic';
  }
}

export function applyClientSizeMode(): void {
  const frame = document.getElementById('game-frame') as HTMLDivElement | null;
  if (!frame) return;

  const fixedEnabled = getClientSizeMode() === 'fixed' && isDesktopClientSizeSettingAvailable();
  document.documentElement.classList.toggle('eq-fixed-client-size', fixedEnabled);

  if (!fixedEnabled) {
    frame.style.width = '';
    frame.style.height = '';
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('evilquest:viewportchange'));
    return;
  }

  frame.style.width = `${FIXED_CLIENT_SIZE.width}px`;
  frame.style.height = `${FIXED_CLIENT_SIZE.height}px`;
  window.dispatchEvent(new Event('resize'));
  window.dispatchEvent(new Event('evilquest:viewportchange'));
}

export function setClientSizeMode(mode: ClientSizeMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Ignore storage failures; apply the requested mode for this active page.
  }

  applyClientSizeMode();
}

export function installClientSizeModeController(): void {
  if (installed) return;
  installed = true;

  const refresh = () => applyClientSizeMode();
  getMedia().addEventListener('change', refresh);
  applyClientSizeMode();
}
