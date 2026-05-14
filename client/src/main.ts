import { LoginScreen } from './ui/LoginScreen';
import { LoadingScreen } from './ui/LoadingScreen';
import { preloadAssets } from './managers/AssetPreloader';
import type { GameManager as GameManagerType } from './managers/GameManager';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const gameFrame = document.getElementById('game-frame') as HTMLDivElement;

let game: GameManagerType | null = null;
let loginScreen: LoginScreen | null = null;

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

async function startGame(token: string, username: string, preloadedLoadingScreen?: LoadingScreen) {
  gameFrame.style.display = 'grid';

  if (loginScreen) {
    loginScreen.destroy();
    loginScreen = null;
  }

  // Force a synchronous layout pass before constructing the Babylon engine
  // so it reads the correct canvas dimensions on its very first frame.
  // Without this, `display: grid` was just applied in the line above but
  // the browser hasn't reflowed yet — `Engine` sees clientWidth=0,
  // initializes a 0×0 framebuffer, and the first render produces a black
  // canvas until our ResizeObserver eventually fires.
  void canvas.offsetWidth;

  const { GameManager } = await loadGameModule();
  game = new GameManager(canvas, token, username, () => {
    handleDisconnect();
  }, preloadedLoadingScreen);
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

function showLoginScreen() {
  gameFrame.style.display = 'none';
  loginScreen = new LoginScreen((token, username) => {
    // Manual login: the pre-auth LoadingScreen has already been hidden by
    // bootstrap(). Spin a fresh one up now so the post-submit gap (WS
    // connect + LOGIN_OK + scene init) doesn't show a blank canvas.
    const ls = new LoadingScreen();
    ls.show();
    ls.setStatus('Connecting to world…');
    void startGame(token, username, ls);
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
 *   2. Pre-fetch every static asset the game needs (character GLB, animation
 *      GLBs, world-object GLBs, default map data, def JSON) in parallel so
 *      the browser HTTP cache is warm. Drive a progress bar from this.
 *   3. In parallel, validate any saved token so we know whether to skip the
 *      login screen on completion.
 *   4. If we have a valid saved token, hand the same LoadingScreen to
 *      GameManager — it switches the status text and reuses the overlay
 *      through to first playable frame.
 *   5. Otherwise hide the LoadingScreen and present the login form. The
 *      login submit path opens a fresh LoadingScreen for the brief
 *      WS-connect + scene-init gap.
 */
async function bootstrap() {
  const loadingScreen = new LoadingScreen();
  loadingScreen.show();

  // Three things in parallel: warm the HTTP asset cache, validate any
  // saved token, and download the dynamically-imported GameManager
  // bundle (Babylon + game code, ~2 MB). The dynamic import is the
  // single biggest JS payload, so doing it during preload means it's
  // ready the instant the user hits Login.
  const [, tokenResult] = await Promise.all([
    preloadAssets((p) => {
      loadingScreen.setProgress(p.pct);
      loadingScreen.setStatus(p.status);
    }),
    validateSavedToken(),
    loadGameModule(),
  ]);

  if (tokenResult) {
    loadingScreen.setProgress(1);
    loadingScreen.setStatus('Connecting to world…');
    void startGame(tokenResult.token, tokenResult.username, loadingScreen);
  } else {
    loadingScreen.hide();
    showLoginScreen();
  }
}

void bootstrap();
