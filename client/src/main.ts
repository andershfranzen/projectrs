import { LoginScreen } from './ui/LoginScreen';
import { LoadingScreen } from './ui/LoadingScreen';
import { BackgroundParticles } from './ui/BackgroundParticles';
import { installGlobalScrollbars } from './ui/globalScrollbars';
import { preloadAssets } from './managers/AssetPreloader';
import type { GameManager as GameManagerType } from './managers/GameManager';
import { Logger } from '@babylonjs/core/Misc/logger';

if (!import.meta.env.DEV) {
  Logger.LogLevels = Logger.ErrorLogLevel;
}

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const gameFrame = document.getElementById('game-frame') as HTMLDivElement;
installGlobalScrollbars();

let game: GameManagerType | null = null;
let loginScreen: LoginScreen | null = null;
let backgroundParticles: BackgroundParticles | null = null;
let gamePrepPromise: Promise<GameManagerType> | null = null;

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
 * Lazy-loaded GameManager module. Kicked off in bootstrap() in parallel
 * with the asset preload, so by the time the user has signed in the
 * (large) Babylon-dependent bundle is already on disk.
 *
 * Type comes from the static `import type` above, which Vite erases at
 * build time — the runtime cost is just the dynamic import().
 */
let gameModulePromise: Promise<typeof import('./managers/GameManager')> | null = null;

function loadGameModule(): Promise<typeof import('./managers/GameManager')> {
  if (!gameModulePromise) gameModulePromise = import('./managers/GameManager');
  return gameModulePromise;
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
    reportPrepProgress(0, 'Loading game code');

    // Warm lightweight JSON/static cache entries in the background. The real
    // Babylon scene load below owns parsing; waiting for this first makes cold
    // production loads feel like two serial loading screens.
    void preloadAssets((p) => {
      reportPrepProgress(p.pct * 0.15, p.status);
    }).catch((err) => {
      console.warn('[bootstrap] asset cache warm failed:', err);
    });

    const { GameManager } = await loadGameModule();
    reportPrepProgress(0.18, 'Preparing game engine');

    // Lay out the hidden game frame so Babylon reads real canvas dimensions,
    // but keep it invisible until login/auth has completed.
    gameFrame.style.display = 'grid';
    gameFrame.style.visibility = 'hidden';
    void canvas.offsetWidth;

    game = new GameManager(canvas, '', '', handleDisconnect);
    await game.whenPreloaded((pct, status) => {
      reportPrepProgress(0.18 + pct * 0.82, status);
    });
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
  if (game) {
    game.destroy();
    game = null;
  }
  gamePrepPromise = null;
  lastPrepProgress = { pct: 0, status: 'Preparing game' };
  // Clear stored session so we don't auto-login with a dead token
  localStorage.removeItem('projectrs_token');
  localStorage.removeItem('projectrs_username');
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

function showLoginScreen() {
  gameFrame.style.visibility = 'hidden';
  gameFrame.style.display = 'none';
  backgroundParticles?.setVisible(false);
  loginScreen?.destroy();
  loginScreen = new LoginScreen(async (token, username) => {
    backgroundParticles?.setVisible(false);
    try {
      const preparedGame = await prepareGame();
      // The login form hides the game frame after preload. Put it back into
      // layout before auth finalization so Babylon has real canvas dimensions
      // while map/entity packets settle, then reveal it after the form is gone.
      gameFrame.style.display = 'grid';
      gameFrame.style.visibility = 'hidden';
      void canvas.offsetWidth;
      window.dispatchEvent(new Event('resize'));
      await preparedGame.connectAndAuth(token, username);
      if (loginScreen) {
        loginScreen.destroy();
        loginScreen = null;
      }
      revealGame();
    } catch (err) {
      console.error('[startGame] connect failed:', err);
      backgroundParticles?.setVisible(false);
      throw err;
    }
  });
}

async function validateSavedToken(): Promise<{ token: string; username: string } | null> {
  const savedToken = localStorage.getItem('projectrs_token');
  const savedUsername = localStorage.getItem('projectrs_username');
  if (!savedToken || !savedUsername) return null;
  try {
    const res = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: savedToken }),
    });
    const data = await res.json();
    if (data.ok) return { token: savedToken, username: savedUsername };
  } catch {
    // Server unreachable — treat as invalid; bootstrap() will fall through
    // to the login screen, where the user can retry once the server is
    // reachable. No need to flag the error explicitly.
  }
  localStorage.removeItem('projectrs_token');
  localStorage.removeItem('projectrs_username');
  return null;
}

/**
 * Boot sequence:
 *   1. Show a single LoadingScreen immediately.
 *   2. Start game preparation in the background: download the dynamic
 *      GameManager bundle, construct the hidden scene, parse character
 *      assets, and load the default map area.
 *   3. Validate any saved token in parallel.
 *   4. If there is no saved token, keep the LoadingScreen up until game
 *      preparation is complete, then show the login form. The login screen
 *      should never mask hidden model/map loading.
 *   5. If there is a saved token, keep the LoadingScreen up until the
 *      prepared scene connects and becomes playable.
 */
async function bootstrap() {
  // Fire field belongs to the login screen only. Keep it hidden while the
  // OSRS-style loading screen is doing real preload work.
  backgroundParticles = new BackgroundParticles();
  backgroundParticles.setVisible(false);

  const loadingScreen = new LoadingScreen();
  loadingScreen.show();

  const unwatch = watchPrepProgress((p) => {
    loadingScreen.setProgress(p.pct);
    loadingScreen.setStatus(p.status);
  });
  const prepPromise = prepareGame();
  void prepPromise.catch((err) => {
    console.error('[bootstrap] background game preparation failed:', err);
  });
  const tokenResult = await validateSavedToken();

  if (tokenResult) {
    unwatch();
    loadingScreen.resetProgress();
    loadingScreen.setStatus('Connecting to server');
    try {
      const preparedGame = await prepPromise;
      await preparedGame.connectAndAuth(tokenResult.token, tokenResult.username, (pct, status) => {
        loadingScreen.setProgress(pct);
        loadingScreen.setStatus(status);
      });
      loadingScreen.hide();
      revealGame(340);
    } catch (err) {
      console.error('[bootstrap] auto-login failed:', err);
      loadingScreen.hide();
      showLoginScreen();
    }
  } else {
    try {
      await prepPromise;
      unwatch();
      loadingScreen.hide();
      // Match LoadingScreen fade-out before revealing login chrome; otherwise
      // the login panel appears underneath the fading overlay.
      setTimeout(() => showLoginScreen(), 260);
    } catch (err) {
      console.error('[bootstrap] game preparation failed:', err);
      unwatch();
      loadingScreen.setStatus('Failed to load. Please reload the page.');
    }
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
