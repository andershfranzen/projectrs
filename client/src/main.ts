import { LoginScreen } from './ui/LoginScreen';
import { LoadingScreen } from './ui/LoadingScreen';
import { BackgroundParticles } from './ui/BackgroundParticles';
import { preloadAssets } from './managers/AssetPreloader';
import type { GameManager as GameManagerType } from './managers/GameManager';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const gameFrame = document.getElementById('game-frame') as HTMLDivElement;

let game: GameManagerType | null = null;
let loginScreen: LoginScreen | null = null;
let backgroundParticles: BackgroundParticles | null = null;

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

function handleDisconnect() {
  if (game) {
    game.destroy();
    game = null;
  }
  // Clear stored session so we don't auto-login with a dead token
  localStorage.removeItem('projectrs_token');
  localStorage.removeItem('projectrs_username');
  showLoginScreen();
}

/** Reveal the game canvas + tear down pre-auth chrome. Called once the
 *  player is fully authenticated and the LoadingScreen fade-out has
 *  completed, so no transparent overlay exposes the canvas briefly. */
function revealGame(): void {
  // 340ms covers the LoadingScreen fade-out animation (320ms + a small
  // buffer). Until then the canvas stays visibility:hidden so the
  // disappearing overlay doesn't unmask it mid-fade.
  setTimeout(() => {
    gameFrame.style.visibility = 'visible';
    backgroundParticles?.setVisible(false);
  }, 340);
}

function showLoginScreen() {
  // If we got here via disconnect rather than initial boot, a destroyed
  // GameManager left the canvas in an unusable state — re-route through
  // a fresh page load so the next sign-in restarts the preload cycle
  // from scratch. Cheap, robust, avoids partial-cleanup bugs.
  if (game === null && document.querySelector('#game-canvas')?.parentElement?.style?.display === 'grid') {
    location.reload();
    return;
  }
  backgroundParticles?.setVisible(true);
  loginScreen = new LoginScreen(async (token, username) => {
    // Manual login: bring up the LoadingScreen FIRST so the canvas stays
    // covered, then dismiss the login form. Reversing the order leaves a
    // one-frame window with no overlay → game-world flash.
    const ls = new LoadingScreen();
    ls.show();
    ls.setStatus('Connecting to server');
    backgroundParticles?.setVisible(false);
    if (loginScreen) {
      loginScreen.destroy();
      loginScreen = null;
    }
    try {
      if (!game) {
        // Reload path: rare. We'd normally still have a pre-built game.
        const { GameManager } = await loadGameModule();
        game = new GameManager(canvas, '', '', handleDisconnect, ls);
        await game.whenPreloaded();
      }
      await game!.connectAndAuth(token, username);
      ls.hide();
      revealGame();
    } catch (err) {
      console.error('[startGame] connect failed:', err);
      ls.setStatus('Failed to connect. Please reload.');
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
 *   2. Pre-fetch every static asset the game needs in parallel so the
 *      browser HTTP cache is warm. Drive a progress bar from this.
 *   3. Also in parallel: validate any saved token, and download the
 *      dynamically-imported GameManager module.
 *   4. Construct GameManager *pre-auth* on the hidden canvas. This
 *      parses the character GLB, all 10 animation GLBs, world-object
 *      models, default kcmap chunks — every visual asset the game
 *      needs to render. No WebSocket connection is opened yet.
 *   5. Wait for the GameManager to report whenPreloaded() — at that
 *      point every parse is complete and the world is one network
 *      round-trip from being playable.
 *   6. If we have a saved token, call connectAndAuth() to open the
 *      socket and wait for LOGIN_OK to land the player. Hide the
 *      LoadingScreen.
 *   7. Otherwise hide the LoadingScreen and show the login form. On
 *      submit, call connectAndAuth() on the already-preloaded game.
 */
async function bootstrap() {
  // Fire field belongs to the login screen only. Keep it hidden while the
  // OSRS-style loading screen is doing real preload work.
  backgroundParticles = new BackgroundParticles();
  backgroundParticles.setVisible(false);

  const loadingScreen = new LoadingScreen();
  loadingScreen.show();

  // Phase 1: warm HTTP cache + dynamic-import the game bundle + token
  // validate. AssetPreloader drives the bar 0 → 1/2; phase 2 below drives
  // it the rest of the way to 1.
  const [, tokenResult] = await Promise.all([
    preloadAssets((p) => {
      loadingScreen.setProgress(p.pct * 0.5);
      loadingScreen.setStatus(p.status);
    }),
    validateSavedToken(),
    loadGameModule(),
  ]);

  // Phase 2: construct GameManager and parse every visual asset before the
  // login form is ever shown. gameFrame is laid out (display:grid) so the
  // canvas has a real size for the Babylon engine, but kept visibility:
  // hidden so it never visually appears until the entire sign-in chain
  // (loading → login → connect) completes. visibility:hidden preserves
  // layout (clientWidth/clientHeight read correctly) while making the
  // canvas non-rendering, so overlay fades can't unmask the game world.
  const { GameManager } = await loadGameModule();
  loadingScreen.setStatus('Preparing game engine');
  gameFrame.style.display = 'grid';
  gameFrame.style.visibility = 'hidden';
  void canvas.offsetWidth; // force layout so Engine reads a real size

  game = new GameManager(canvas, '', '', handleDisconnect, undefined);
  await game.whenPreloaded((pct, status) => {
    // Map the three preload milestones into the second half of the bar
    // (50% → 100%) so the user sees continuous forward motion across
    // both phases.
    loadingScreen.setProgress(0.5 + pct * 0.5);
    loadingScreen.setStatus(status);
  });
  loadingScreen.setProgress(1);

  // Phase 3: either auto-login (saved token) or hand off to the login form.
  // The world is fully built either way — sign-in is the only step left.
  if (tokenResult) {
    loadingScreen.setStatus('Connecting to server');
    try {
      await game.connectAndAuth(tokenResult.token, tokenResult.username);
      loadingScreen.hide();
      revealGame();
    } catch (err) {
      console.error('[bootstrap] auto-login failed:', err);
      loadingScreen.hide();
      showLoginScreen();
    }
  } else {
    loadingScreen.hide();
    showLoginScreen();
  }
}

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
