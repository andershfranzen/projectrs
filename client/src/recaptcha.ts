// reCAPTCHA v3 token retrieval.
//
// Site key is baked at build time via VITE_RECAPTCHA_SITE_KEY. When unset the
// helper is a no-op so local dev keeps working without keys — the server
// matches this by skipping verification when RECAPTCHA_SECRET is unset.

const SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;
const SCRIPT_ID = 'eq-recaptcha-v3';

declare global {
  interface Window {
    grecaptcha?: {
      ready: (cb: () => void) => void;
      execute: (siteKey: string, opts: { action: string }) => Promise<string>;
    };
  }
}

let loadPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (!SITE_KEY) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    if (document.getElementById(SCRIPT_ID)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(SITE_KEY)}`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loadPromise = null;
      reject(new Error('Failed to load reCAPTCHA script'));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}

/** Preload the reCAPTCHA script. Safe to call early so the script is ready
 *  by the time the user submits the form. No-op when no site key is configured. */
export function preloadRecaptcha(): void {
  if (!SITE_KEY) return;
  void loadScript().catch(() => {});
}

/** Returns a v3 token for the given action, or null when reCAPTCHA is not
 *  configured (dev) or fails to load. The server side mirrors this by treating
 *  a missing token as "skip verification" only when its own secret is unset. */
export async function getRecaptchaToken(action: string): Promise<string | null> {
  if (!SITE_KEY) return null;
  try {
    await loadScript();
    const grecaptcha = window.grecaptcha;
    if (!grecaptcha) return null;
    await new Promise<void>((resolve) => grecaptcha.ready(resolve));
    return await grecaptcha.execute(SITE_KEY, { action });
  } catch (err) {
    console.warn('[recaptcha] token retrieval failed:', err);
    return null;
  }
}
