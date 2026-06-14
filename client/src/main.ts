import './debug/ClientConsoleGuard';
import { LoginScreen } from './ui/LoginScreen';
import { LoadingScreen } from './ui/LoadingScreen';
import { BackgroundParticles } from './ui/BackgroundParticles';
import { dismissLoginMessage, showLoginMessage } from './ui/LoginMessageModal';
import { installGlobalScrollbars } from './ui/globalScrollbars';
import { preloadAssets } from './managers/AssetPreloader';
import { startupTrace } from './debug/StartupTrace';
import { installSafeDynamicTextureUpdate } from './rendering/safeDynamicTexture';
import { installBrightnessController } from './ui/brightness';
import { installChatSettingsController } from './ui/chatSettings';
import { installClientSizeModeController } from './ui/clientSizeMode';
import { installGameSettingsController } from './ui/gameSettings';
import { installRenderDistanceController } from './ui/renderDistance';
import {
  decreaseUiScale,
  increaseUiScale,
  installUiScaleController,
  resetUiScale,
  type UiScaleValue,
} from './ui/uiScale';
import type { GameManager as GameManagerType } from './managers/GameManager';

const WEBGL_STARTUP_ERROR_PREFIX = 'USER_VISIBLE:';
const WEBGL_STARTUP_MESSAGE = 'EvilQuest could not start WebGL on this device. Enable hardware acceleration, update your graphics drivers, then reload.';
const AUTH_TOKEN_KEY = 'evilquest_token';
const AUTH_USERNAME_KEY = 'evilquest_username';
const LEGACY_AUTH_TOKEN_KEY = 'projectrs_token';
const LEGACY_AUTH_USERNAME_KEY = 'projectrs_username';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const gameFrame = document.getElementById('game-frame') as HTMLDivElement;
const PAGE_ZOOM_DPR_EPSILON = 0.04;
const initialDevicePixelRatio = getCurrentDevicePixelRatio();
installGlobalScrollbars();
installSafeDynamicTextureUpdate();
installClientSizeModeController();
installUiScaleController();
installBrightnessController();
installChatSettingsController();
installGameSettingsController();
installRenderDistanceController();
startupTrace.mark('entry');

function migrateSavedAuth(): void {
  const legacyToken = localStorage.getItem(LEGACY_AUTH_TOKEN_KEY);
  const legacyUsername = localStorage.getItem(LEGACY_AUTH_USERNAME_KEY);
  if (legacyToken && !localStorage.getItem(AUTH_TOKEN_KEY)) {
    localStorage.setItem(AUTH_TOKEN_KEY, legacyToken);
  }
  if (legacyUsername && !localStorage.getItem(AUTH_USERNAME_KEY)) {
    localStorage.setItem(AUTH_USERNAME_KEY, legacyUsername);
  }
  if (legacyToken || legacyUsername) {
    localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY);
    localStorage.removeItem(LEGACY_AUTH_USERNAME_KEY);
  }
}

function clearSavedAuth(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USERNAME_KEY);
  localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY);
  localStorage.removeItem(LEGACY_AUTH_USERNAME_KEY);
}

function getCurrentDevicePixelRatio(): number {
  const dpr = window.devicePixelRatio || 1;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

function getBrowserPageScale(): number {
  const scale = window.visualViewport?.scale ?? 1;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function getBrowserPageZoomRatio(): number {
  return getCurrentDevicePixelRatio() / Math.max(0.001, initialDevicePixelRatio);
}

function isBrowserPageZoomed(): boolean {
  return getBrowserPageScale() > 1.01 || Math.abs(getBrowserPageZoomRatio() - 1) > PAGE_ZOOM_DPR_EPSILON;
}

function installMobileViewportVars(): void {
  const root = document.documentElement;
  let framePending = false;
  let pageZoomed = false;

  const apply = () => {
    framePending = false;
    const visualViewport = window.visualViewport;
    const layoutWidth = window.innerWidth || root.clientWidth || 0;
    const layoutHeight = window.innerHeight || root.clientHeight || 0;
    const width = visualViewport?.width ?? layoutWidth;
    const height = visualViewport?.height ?? layoutHeight;
    const left = visualViewport?.offsetLeft ?? 0;
    const top = visualViewport?.offsetTop ?? 0;
    const right = Math.max(0, layoutWidth - left - width);
    const bottom = Math.max(0, layoutHeight - top - height);
    const scale = getBrowserPageScale();
    const dpr = getCurrentDevicePixelRatio();
    const pageZoomRatio = getBrowserPageZoomRatio();
    const nextPageZoomed = isBrowserPageZoomed();

    root.style.setProperty('--eq-viewport-width', `${Math.round(width)}px`);
    root.style.setProperty('--eq-viewport-height', `${Math.round(height)}px`);
    root.style.setProperty('--eq-viewport-left', `${Math.round(left)}px`);
    root.style.setProperty('--eq-viewport-top', `${Math.round(top)}px`);
    root.style.setProperty('--eq-viewport-right', `${Math.round(right)}px`);
    root.style.setProperty('--eq-viewport-bottom', `${Math.round(bottom)}px`);
    root.style.setProperty('--eq-viewport-scale', `${scale.toFixed(3)}`);
    root.style.setProperty('--eq-device-pixel-ratio', dpr.toFixed(3));
    root.style.setProperty('--eq-page-zoom-ratio', pageZoomRatio.toFixed(3));
    root.classList.toggle('eq-browser-page-zoomed', nextPageZoomed);
    if (nextPageZoomed !== pageZoomed) {
      pageZoomed = nextPageZoomed;
      window.dispatchEvent(new CustomEvent('evilquest:browserzoomchanged', {
        detail: { zoomed: nextPageZoomed, pageZoomRatio, viewportScale: scale },
      }));
    }
    window.dispatchEvent(new Event('evilquest:viewportchange'));
  };

  const schedule = () => {
    if (framePending) return;
    framePending = true;
    window.requestAnimationFrame(apply);
  };

  apply();
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  window.visualViewport?.addEventListener('resize', schedule, { passive: true });
  window.visualViewport?.addEventListener('scroll', schedule, { passive: true });
}

function installMobilePageZoomGuard(): void {
  let lastWheelUiScaleAt = 0;

  const isGameSurface = (event: Event): boolean => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.some((target) => (
      target instanceof Element
      && !!target.closest('#game-frame, .eq-preauth-overlay')
    ))) {
      return true;
    }

    if (document.querySelector('.eq-preauth-overlay')) return true;
    return getComputedStyle(gameFrame).display !== 'none';
  };

  const shouldLetBrowserRecoverZoom = (): boolean => isBrowserPageZoomed();

  const dispatchBrowserZoomBlocked = (input: 'gesture' | 'dblclick' | 'keyboard' | 'wheel', scale?: UiScaleValue) => {
    window.dispatchEvent(new CustomEvent('evilquest:browserzoomblocked', {
      detail: { input, uiScale: scale ?? null },
    }));
  };

  const preventNativeScaleAtNormalZoom = (event: Event) => {
    if (!isGameSurface(event)) return;
    if (shouldLetBrowserRecoverZoom()) return;
    event.preventDefault();
    if (event.type === 'dblclick') return;
    dispatchBrowserZoomBlocked(event.type === 'dblclick' ? 'dblclick' : 'gesture');
  };

  const isBrowserZoomKey = (event: KeyboardEvent): boolean => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
    const key = event.key.toLowerCase();
    return key === '+' || key === '=' || key === '-' || key === '_' || key === '0';
  };

  document.addEventListener('keydown', (event) => {
    if (!isBrowserZoomKey(event) || !isGameSurface(event)) return;
    if (shouldLetBrowserRecoverZoom()) return;

    event.preventDefault();
    event.stopPropagation();
    let scale: UiScaleValue;
    const key = event.key.toLowerCase();
    if (key === '+' || key === '=') scale = increaseUiScale();
    else if (key === '-' || key === '_') scale = decreaseUiScale();
    else scale = resetUiScale();
    dispatchBrowserZoomBlocked('keyboard', scale);
  }, { capture: true });

  document.addEventListener('wheel', (event) => {
    if (!(event.ctrlKey || event.metaKey) || !isGameSurface(event)) return;
    if (shouldLetBrowserRecoverZoom()) return;

    event.preventDefault();
    event.stopPropagation();

    const now = performance.now();
    if (now - lastWheelUiScaleAt < 220) return;
    lastWheelUiScaleAt = now;
    const scale = event.deltaY < 0 ? increaseUiScale() : decreaseUiScale();
    dispatchBrowserZoomBlocked('wheel', scale);
  }, { passive: false, capture: true });

  document.addEventListener('gesturestart', preventNativeScaleAtNormalZoom, { passive: false });
  document.addEventListener('gesturechange', preventNativeScaleAtNormalZoom, { passive: false });
  document.addEventListener('gestureend', preventNativeScaleAtNormalZoom, { passive: false });
  document.addEventListener('dblclick', preventNativeScaleAtNormalZoom, { passive: false, capture: true });
}

installMobileViewportVars();
installMobilePageZoomGuard();

let game: GameManagerType | null = null;
let loginScreen: LoginScreen | null = null;
let backgroundParticles: BackgroundParticles | null = null;
let gamePrepPromise: Promise<GameManagerType> | null = null;
let loginMessageTimer: ReturnType<typeof setTimeout> | null = null;

interface PrepProgress {
  pct: number;
  status: string;
}

const prepProgressListeners = new Set<(progress: PrepProgress) => void>();
let lastPrepProgress: PrepProgress = { pct: 0, status: 'Preparing game' };

document.addEventListener('dragstart', (event) => {
  if (!(event.target instanceof HTMLElement)) return;
  const target = event.target;

  // Keep real text fields usable, but prevent browser-native image drags
  // from UI sprites/icons. Inventory reordering starts from the slot div,
  // not the inner PNG, so this does not block the intended item drag action.
  if (target.closest('input, textarea, [contenteditable="true"]')) return;
  if (target instanceof HTMLImageElement || target.closest('img')) {
    event.preventDefault();
  }
}, true);

/**
 * Lazy-loaded GameManager module. It is pulled only after saved-token
 * validation or a successful manual login, keeping the anonymous login path
 * free of Babylon/map/model work.
 *
 * Type comes from the static `import type` above, which Vite erases at
 * build time — the runtime cost is just the dynamic import().
 */
let gameModulePromise: Promise<typeof import('./managers/GameManager')> | null = null;

function loadGameModule(): Promise<typeof import('./managers/GameManager')> {
  if (!gameModulePromise) gameModulePromise = import('./managers/GameManager');
  return gameModulePromise;
}

function userVisibleStartupError(message: string): Error {
  return new Error(`${WEBGL_STARTUP_ERROR_PREFIX}${message}`);
}

function isUserVisibleStartupError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(WEBGL_STARTUP_ERROR_PREFIX);
}

function releaseProbeContext(ctx: WebGLRenderingContext | WebGL2RenderingContext | null): void {
  ctx?.getExtension('WEBGL_lose_context')?.loseContext();
}

function isLikelyWebGlStartupError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /webgl|webgl2|graphics|gpu|failed to create engine|failed to create webgl context|exhausted gl driver|tryangle/i.test(message);
}

async function ensureWebGlAvailable(): Promise<void> {
  if (typeof window.WebGLRenderingContext === 'undefined') {
    throw userVisibleStartupError('Your browser or device does not appear to support WebGL. Enable hardware acceleration or try a current browser to play EvilQuest.');
  }

  const probeCanvas = document.createElement('canvas');
  let ctx: WebGLRenderingContext | WebGL2RenderingContext | null = null;

  try {
    ctx = probeCanvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false })
      ?? probeCanvas.getContext('webgl', { failIfMajorPerformanceCaveat: false })
      ?? (probeCanvas.getContext('experimental-webgl', { failIfMajorPerformanceCaveat: false }) as WebGLRenderingContext | null);
  } catch {
    throw userVisibleStartupError(WEBGL_STARTUP_MESSAGE);
  } finally {
    releaseProbeContext(ctx);
  }

  if (!ctx) throw userVisibleStartupError(WEBGL_STARTUP_MESSAGE);

  try {
    const { Engine } = await import('@babylonjs/core/Engines/engine');
    if (!Engine.isSupported()) throw userVisibleStartupError(WEBGL_STARTUP_MESSAGE);
  } catch (err) {
    if (isUserVisibleStartupError(err)) throw err;
    if (isLikelyWebGlStartupError(err)) throw userVisibleStartupError(WEBGL_STARTUP_MESSAGE);
    console.warn('[bootstrap] Babylon WebGL support probe failed:', err);
  }
}

function reportPrepProgress(pct: number, status: string): void {
  const clamped = Math.max(0, Math.min(1, pct));
  lastPrepProgress = { pct: Math.max(lastPrepProgress.pct, clamped), status };
  for (const listener of prepProgressListeners) listener(lastPrepProgress);
}

function watchPrepProgress(listener: (progress: PrepProgress) => void): () => void {
  prepProgressListeners.add(listener);
  listener(lastPrepProgress);
  return () => prepProgressListeners.delete(listener);
}

function prepareGame(): Promise<GameManagerType> {
  if (gamePrepPromise) return gamePrepPromise;

  gamePrepPromise = (async () => {
    startupTrace.mark('game_prepare_start');
    reportPrepProgress(0, 'Loading game code');

    // Warm lightweight JSON/static cache entries in the background. The real
    // Babylon scene load below owns parsing; waiting for this first makes cold
    // production loads feel like two serial loading screens.
    void preloadAssets((p) => {
      reportPrepProgress(p.pct * 0.15, p.status);
    }).catch((err) => {
      console.warn('[bootstrap] asset cache warm failed:', err);
    });

    if (!import.meta.env.DEV) {
      const { Logger } = await import('@babylonjs/core/Misc/logger');
      Logger.LogLevels = Logger.ErrorLogLevel;
    }

    reportPrepProgress(0.16, 'Checking graphics support');
    await ensureWebGlAvailable();

    const { GameManager } = await loadGameModule();
    startupTrace.mark('game_module_loaded');
    reportPrepProgress(0.18, 'Preparing game engine');

    // Lay out the hidden game frame so Babylon reads real canvas dimensions,
    // but keep it invisible until login/auth has completed.
    gameFrame.style.display = 'grid';
    gameFrame.style.visibility = 'hidden';
    void canvas.offsetWidth;

    try {
      game = new GameManager(canvas, '', '', handleDisconnect);
    } catch (err) {
      if (isLikelyWebGlStartupError(err)) throw userVisibleStartupError(WEBGL_STARTUP_MESSAGE);
      throw err;
    }
    startupTrace.mark('game_manager_created');
    await game.whenPreloaded((pct, status) => {
      reportPrepProgress(0.18 + pct * 0.82, status);
    });
    startupTrace.mark('game_preloaded');
    startupTrace.measure('game_prepare_total', 'game_prepare_start', 'game_preloaded');
    reportPrepProgress(1, 'Game ready');
    return game;
  })().catch((err) => {
    gamePrepPromise = null;
    lastPrepProgress = { pct: 0, status: 'Failed to prepare game' };
    for (const listener of prepProgressListeners) listener(lastPrepProgress);
    throw err;
  });

  return gamePrepPromise;
}

function handleDisconnect() {
  clearLoginMessage();
  if (game) {
    game.destroy();
    game = null;
  }
  gamePrepPromise = null;
  lastPrepProgress = { pct: 0, status: 'Preparing game' };
  // Clear stored session so we don't auto-login with a dead token
  clearSavedAuth();
  showLoginScreen();
}

/** Reveal the game canvas + tear down pre-auth chrome. Called once the
 *  player is fully authenticated and the LoadingScreen fade-out has
 *  completed, so no transparent overlay exposes the canvas briefly. */
function revealGame(afterMs: number = 0): void {
  setTimeout(() => {
    gameFrame.style.display = 'grid';
    gameFrame.style.visibility = 'visible';
    void canvas.offsetWidth;
    window.dispatchEvent(new Event('resize'));
    backgroundParticles?.setVisible(false);
  }, afterMs);
}

function clearLoginMessage(): void {
  if (loginMessageTimer !== null) {
    clearTimeout(loginMessageTimer);
    loginMessageTimer = null;
  }
  dismissLoginMessage();
}

function showLoginMessageAfterReveal(username: string, lastLoginTs: number | null, afterMs: number = 380): void {
  clearLoginMessage();
  loginMessageTimer = setTimeout(() => {
    loginMessageTimer = null;
    if (gameFrame.style.display === 'none' || gameFrame.style.visibility === 'hidden') return;
    showLoginMessage({ username, lastLoginTs });
  }, afterMs);
}

function showLoginScreen() {
  startupTrace.mark('login_screen_show');
  clearLoginMessage();
  gameFrame.style.visibility = 'hidden';
  gameFrame.style.display = 'none';
  backgroundParticles?.setVisible(false);
  loginScreen?.destroy();
  loginScreen = new LoginScreen(async (token, username, lastLoginTs) => {
    startupTrace.mark('manual_login_ok');
    backgroundParticles?.setVisible(false);
    const loadingScreen = new LoadingScreen();
    loadingScreen.show();
    const unwatch = watchPrepProgress((p) => {
      loadingScreen.setProgress(p.pct);
      loadingScreen.setStatus(p.status);
    });
    try {
      const preparedGame = await prepareGame();
      unwatch();
      loadingScreen.resetProgress();
      loadingScreen.setStatus('Connecting to server');
      // The login form hides the game frame after preload. Put it back into
      // layout before auth finalization so Babylon has real canvas dimensions
      // while map/entity packets settle, then reveal it after the form is gone.
      gameFrame.style.display = 'grid';
      gameFrame.style.visibility = 'hidden';
      void canvas.offsetWidth;
      window.dispatchEvent(new Event('resize'));
      await preparedGame.connectAndAuth(token, username, (pct, status) => {
        loadingScreen.setProgress(pct);
        loadingScreen.setStatus(status);
      });
      startupTrace.mark('manual_game_connected');
      if (loginScreen) {
        loginScreen.destroy();
        loginScreen = null;
      }
      loadingScreen.hide();
      revealGame(340);
      showLoginMessageAfterReveal(username, lastLoginTs);
    } catch (err) {
      console.error('[startGame] connect failed:', err);
      unwatch();
      loadingScreen.hide();
      backgroundParticles?.setVisible(false);
      throw err;
    }
  });
}

async function validateSavedToken(): Promise<{ token: string; username: string; lastLoginTs: number | null } | null> {
  startupTrace.mark('token_validate_start');
  migrateSavedAuth();
  const savedToken = localStorage.getItem(AUTH_TOKEN_KEY);
  const savedUsername = localStorage.getItem(AUTH_USERNAME_KEY);
  if (!savedToken || !savedUsername) {
    startupTrace.mark('token_missing');
    return null;
  }
  try {
    const res = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: savedToken }),
    });
    const data = await res.json();
    if (data.ok) {
      startupTrace.mark('token_valid');
      const username = typeof data.username === 'string' && data.username ? data.username : savedUsername;
      const lastLoginTs = typeof data.lastLoginTs === 'number' ? data.lastLoginTs : null;
      return { token: savedToken, username, lastLoginTs };
    }
  } catch {
    // Server unreachable — treat as invalid; bootstrap() will fall through
    // to the login screen, where the user can retry once the server is
    // reachable. No need to flag the error explicitly.
  }
  clearSavedAuth();
  startupTrace.mark('token_invalid');
  return null;
}

/**
 * Boot sequence:
 *   1. Show a single LoadingScreen immediately.
 *   2. Validate any saved token before pulling in the game bundle.
 *   3. If there is no saved token, show the login form immediately and defer
 *      Babylon/map/model work until login succeeds.
 *   4. If there is a saved token, prepare the hidden scene, connect, then
 *      reveal the playable canvas.
 */
async function bootstrap() {
  startupTrace.mark('bootstrap_start');
  // Fire field belongs to the login screen only. Keep it hidden while the
  // OSRS-style loading screen is doing real preload work.
  backgroundParticles = new BackgroundParticles();
  backgroundParticles.setVisible(false);

  const loadingScreen = new LoadingScreen();
  loadingScreen.show();

  const tokenResult = await validateSavedToken();
  if (!tokenResult) {
    loadingScreen.hide();
    setTimeout(() => showLoginScreen(), 260);
    return;
  }

  const unwatch = watchPrepProgress((p) => {
    loadingScreen.setProgress(p.pct);
    loadingScreen.setStatus(p.status);
  });
  const prepPromise = prepareGame();
  void prepPromise.catch((err) => {
    console.error('[bootstrap] background game preparation failed:', err);
  });
  try {
    const preparedGame = await prepPromise;
    unwatch();
    loadingScreen.resetProgress();
    loadingScreen.setStatus('Connecting to server');
    await preparedGame.connectAndAuth(tokenResult.token, tokenResult.username, (pct, status) => {
      loadingScreen.setProgress(pct);
      loadingScreen.setStatus(status);
    });
    startupTrace.mark('auto_game_connected');
    loadingScreen.hide();
    revealGame(340);
    showLoginMessageAfterReveal(tokenResult.username, tokenResult.lastLoginTs);
  } catch (err) {
    console.error('[bootstrap] auto-login failed:', err);
    unwatch();
    loadingScreen.hide();
    showLoginScreen();
  }
}

// Dev-only bake mode. Visiting `?bake=1` short-circuits the normal login/game
// path and instead renders every item GLB into a PNG, POSTing each to the
// server. Run once after adding new item GLBs; see client/src/bake/BakeApp.ts.
if (new URLSearchParams(window.location.search).get('bake') === '1') {
  void import('./bake/BakeApp').then(({ runBake }) => runBake()).catch((err) => {
    console.error('[bake] failed to load bake module:', err);
  });
} else {
  void bootstrap().catch((err) => {
    console.error('[bootstrap] failed:', err);
    // A failed dynamic-import on the GameManager chunk (deploy mid-load,
    // network drop) is the most likely cause. Surface a recoverable
    // message on whatever LoadingScreen is currently visible.
    const statusEl = document.querySelector<HTMLDivElement>('.eq-loading-status');
    if (statusEl) {
      statusEl.textContent = 'Failed to load. Please reload the page.';
    }
  });
}
