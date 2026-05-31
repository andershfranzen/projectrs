'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Modal } from './components/Modal';

const TOKEN_KEY = 'evilquest_token';
const USERNAME_KEY = 'evilquest_username';
const LEGACY_TOKEN_KEY = 'projectrs_token';
const LEGACY_USERNAME_KEY = 'projectrs_username';
const DEVICE_KEY = 'evilmud_device_id';
const RECAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || process.env.NEXT_PUBLIC_VITE_RECAPTCHA_SITE_KEY || '';
const RECAPTCHA_SCRIPT_ID = 'eq-recaptcha-v3';

type AuthState =
  | { status: 'checking' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; username: string; isAdmin: boolean };

type LoginResponse = {
  ok?: boolean;
  token?: string;
  username?: string;
  error?: string;
};

type SessionResponse = {
  ok?: boolean;
  username?: string;
  isAdmin?: boolean;
};

declare global {
  interface Window {
    grecaptcha?: {
      ready: (cb: () => void) => void;
      execute: (siteKey: string, opts: { action: string }) => Promise<string>;
    };
  }
}

let recaptchaLoadPromise: Promise<void> | null = null;

function loadRecaptcha(): Promise<void> {
  if (!RECAPTCHA_SITE_KEY) return Promise.resolve();
  if (recaptchaLoadPromise) return recaptchaLoadPromise;
  recaptchaLoadPromise = new Promise<void>((resolve, reject) => {
    if (document.getElementById(RECAPTCHA_SCRIPT_ID)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.id = RECAPTCHA_SCRIPT_ID;
    script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(RECAPTCHA_SITE_KEY)}`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      recaptchaLoadPromise = null;
      reject(new Error('Failed to load reCAPTCHA script'));
    };
    document.head.appendChild(script);
  });
  return recaptchaLoadPromise;
}

function preloadRecaptcha(): void {
  if (!RECAPTCHA_SITE_KEY) return;
  void loadRecaptcha().catch(() => {});
}

async function getRecaptchaToken(action: string): Promise<string | null> {
  if (!RECAPTCHA_SITE_KEY) return null;
  try {
    await loadRecaptcha();
    const grecaptcha = window.grecaptcha;
    if (!grecaptcha) return null;
    await new Promise<void>((resolve) => grecaptcha.ready(resolve));
    return await grecaptcha.execute(RECAPTCHA_SITE_KEY, { action });
  } catch (err) {
    console.warn('[recaptcha] token retrieval failed:', err);
    return null;
  }
}

function fallbackDeviceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = Math.random() * 16 | 0;
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

async function getDeviceId(): Promise<string> {
  const existing = window.localStorage.getItem(DEVICE_KEY);
  if (existing && existing.length >= 8 && existing.length <= 64) return existing;

  try {
    const res = await fetch('/api/device-id', { credentials: 'same-origin', cache: 'no-store' });
    const data = await res.json() as { deviceId?: unknown };
    if (typeof data.deviceId === 'string' && data.deviceId.length >= 8 && data.deviceId.length <= 64) {
      window.localStorage.setItem(DEVICE_KEY, data.deviceId);
      return data.deviceId;
    }
  } catch {
    // Fall back below; the login endpoint will surface any server-side issue.
  }

  const fresh = fallbackDeviceId();
  window.localStorage.setItem(DEVICE_KEY, fresh);
  return fresh;
}

function getSavedToken(): string {
  migrateSavedAuth();
  return window.localStorage.getItem(TOKEN_KEY) || '';
}

function clearSavedAuth(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(LEGACY_TOKEN_KEY);
  window.localStorage.removeItem(LEGACY_USERNAME_KEY);
}

function migrateSavedAuth(): void {
  const legacyToken = window.localStorage.getItem(LEGACY_TOKEN_KEY);
  const legacyUsername = window.localStorage.getItem(LEGACY_USERNAME_KEY);
  if (legacyToken && !window.localStorage.getItem(TOKEN_KEY)) {
    window.localStorage.setItem(TOKEN_KEY, legacyToken);
  }
  if (legacyUsername && !window.localStorage.getItem(USERNAME_KEY)) {
    window.localStorage.setItem(USERNAME_KEY, legacyUsername);
  }
  if (legacyToken || legacyUsername) {
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
    window.localStorage.removeItem(LEGACY_USERNAME_KEY);
  }
}

async function fetchSession(token: string): Promise<SessionResponse> {
  const res = await fetch('/api/session', {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Authorization: `Bearer ${token}` },
  });
  return await res.json() as SessionResponse;
}

async function loadSession(token: string): Promise<SessionResponse> {
  const first = await fetchSession(token);
  if (first.ok) return first;

  const validate = await fetch('/api/validate', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const validated = await validate.json() as { ok?: boolean };
  if (!validated.ok) return first;

  return await fetchSession(token);
}

export function AuthTopBar() {
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    preloadRecaptcha();

    async function validate() {
      const token = getSavedToken();
      if (!token) {
        if (!cancelled) setAuth({ status: 'signed-out' });
        return;
      }

      try {
        const data = await loadSession(token);
        if (data.ok && typeof data.username === 'string') {
          window.localStorage.setItem(USERNAME_KEY, data.username);
          if (!cancelled) setAuth({ status: 'signed-in', username: data.username, isAdmin: data.isAdmin === true });
          return;
        }
      } catch {
        // Treat validation errors as signed out; the user can sign in again.
      }

      clearSavedAuth();
      if (!cancelled) setAuth({ status: 'signed-out' });
    }

    void validate();
    return () => { cancelled = true; };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const nextUsername = username.trim();
    if (!nextUsername || !password) {
      setError('Enter your username and password.');
      return;
    }

    setIsSubmitting(true);
    try {
      const deviceId = await getDeviceId();
      const recaptchaToken = await getRecaptchaToken('login');
      const res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: nextUsername, password, deviceId, recaptchaToken }),
      });
      const data = await res.json() as LoginResponse;
      if (!data.ok || !data.token || !data.username) {
        setError(data.error || 'Login failed.');
        return;
      }

      window.localStorage.setItem(TOKEN_KEY, data.token);
      window.localStorage.setItem(USERNAME_KEY, data.username);
      window.localStorage.removeItem(LEGACY_TOKEN_KEY);
      window.localStorage.removeItem(LEGACY_USERNAME_KEY);
      setAuth({ status: 'signed-in', username: data.username, isAdmin: false });
      setPassword('');
      setIsLoginOpen(false);
    } catch {
      setError('Connection failed. Is the server running?');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleLogout() {
    const token = getSavedToken();
    clearSavedAuth();
    setAuth({ status: 'signed-out' });
    if (!token) return;

    try {
      const res = await fetch('/api/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.status === 409) {
        const savedUsername = window.localStorage.getItem(USERNAME_KEY) || 'your account';
        window.localStorage.setItem(TOKEN_KEY, token);
        setAuth({ status: 'signed-in', username: savedUsername, isAdmin: false });
        setError('You cannot log out while your character is in combat.');
        setIsLoginOpen(true);
      }
    } catch {
      // Local sign-out already happened; stale server session will expire.
    }
  }

  const signedIn = auth.status === 'signed-in';

  return (
    <>
      <header className="auth-topbar" aria-label="Account">
        <nav className="auth-topbar-actions" aria-label="Account actions">
          {auth.status === 'checking' ? (
            <span className="auth-topbar-status">Checking account...</span>
          ) : signedIn ? (
            <>
              <span className="auth-topbar-status">
                Signed in as <strong>{auth.username}</strong>{auth.isAdmin ? ' (admin)' : ''}
              </span>
              <a className="auth-topbar-link" href="/play">Play</a>
              <button type="button" className="auth-topbar-button" onClick={handleLogout}>Sign Out</button>
            </>
          ) : (
            <>
              <button type="button" className="auth-topbar-button" onClick={() => {
                setError('');
                setUsername(window.localStorage.getItem(USERNAME_KEY) || '');
                setPassword('');
                setIsLoginOpen(true);
              }}>
                Sign In
              </button>
              <a className="auth-topbar-link" href="/play?mode=signup">Create Account</a>
            </>
          )}
        </nav>
      </header>

      <Modal isOpen={isLoginOpen} onClose={() => setIsLoginOpen(false)} title="Sign In">
        <form className="auth-form" onSubmit={handleSubmit}>
          {error ? <div className="auth-form-error" role="alert">{error}</div> : null}
          <label className="auth-form-field">
            <span>Username</span>
            <input
              autoComplete="username"
              maxLength={16}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="auth-form-field">
            <span>Password</span>
            <input
              autoComplete="current-password"
              maxLength={64}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button type="submit" className="button auth-form-submit" disabled={isSubmitting}>
            {isSubmitting ? 'Signing In...' : 'Sign In'}
          </button>
          {RECAPTCHA_SITE_KEY ? (
            <p className="auth-form-recaptcha">
              This sign-in is protected by reCAPTCHA and the Google{' '}
              <a href="https://policies.google.com/privacy" rel="noreferrer" target="_blank">Privacy Policy</a>
              {' '}and{' '}
              <a href="https://policies.google.com/terms" rel="noreferrer" target="_blank">Terms of Service</a>
              {' '}apply.
            </p>
          ) : null}
          <p className="auth-form-note">
            New accounts are created from the game client.
            {' '}
            <a href="/play">Open the game</a>
          </p>
        </form>
      </Modal>
    </>
  );
}
