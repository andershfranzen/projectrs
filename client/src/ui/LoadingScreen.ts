/**
 * Full-screen overlay shown while the game preloads. Stays up until
 * `hide()` is called AND a minimum display window has elapsed — even on
 * cached reloads where preload finishes in 50ms — so the brand mark
 * gets a moment to read.
 *
 * This overlay intentionally stays sparse and dark, closer to an old MMO
 * loading screen than a modern splash screen.
 *
 * Usage:
 *   const screen = new LoadingScreen();
 *   screen.show();
 *   screen.setStatus('Loading character…');
 *   screen.setProgress(0.42);
 *   // …later
 *   screen.hide(); // fades out after the min display time has elapsed
 */

import { ensurePreAuthTheme } from './preAuthTheme';

export class LoadingScreen {
  private overlay: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private progressTrack: HTMLDivElement;
  private progressFill: HTMLDivElement;
  private progressTextEl: HTMLDivElement;
  private hidden = false;
  private currentPct: number = 0;
  private shownAtMs: number = 0;
  /** Even on a cache-warm reload, keep the screen up long enough for the
   *  user to register the brand mark instead of seeing a flicker. */
  private static readonly MIN_DISPLAY_MS = 1500;

  constructor() {
    ensurePreAuthTheme();

    this.overlay = document.createElement('div');
    this.overlay.className = 'eq-preauth-overlay eq-loading-overlay';

    const title = document.createElement('div');
    title.className = 'eq-preauth-brand eq-loading-brand';
    title.textContent = 'EvilQuest';
    this.overlay.appendChild(title);

    const heading = document.createElement('div');
    heading.className = 'eq-loading-heading';
    heading.textContent = 'Loading - please wait.';
    this.overlay.appendChild(heading);

    const progressWrap = document.createElement('div');
    progressWrap.className = 'eq-loading-progress-wrap';
    this.progressTrack = document.createElement('div');
    this.progressTrack.className = 'eq-loading-progress-track';
    this.progressFill = document.createElement('div');
    this.progressFill.className = 'eq-loading-progress-fill';
    this.progressTrack.appendChild(this.progressFill);
    this.progressTextEl = document.createElement('div');
    this.progressTextEl.className = 'eq-loading-progress-text';
    this.progressTextEl.textContent = '0%';
    this.progressTrack.appendChild(this.progressTextEl);
    progressWrap.appendChild(this.progressTrack);
    this.overlay.appendChild(progressWrap);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'eq-loading-status';
    this.statusEl.textContent = 'Loading…';
    this.overlay.appendChild(this.statusEl);
  }

  show(): void {
    if (this.overlay.isConnected) return;
    document.body.appendChild(this.overlay);
    this.shownAtMs = performance.now();
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  /** Set progress 0–1. Values are clamped and never go backwards within a
   *  single phase — call `resetProgress()` to start a new phase. */
  setProgress(pct: number): void {
    const clamped = Math.max(0, Math.min(1, pct));
    if (clamped < this.currentPct) return;
    this.currentPct = clamped;
    const pctRounded = Math.round(clamped * 100);
    this.progressFill.style.width = `${pctRounded}%`;
    this.progressTextEl.textContent = `${pctRounded}%`;
  }

  /** Reset the progress bar for a new phase. Useful when the same overlay
   *  is reused across multiple distinct load phases (e.g. asset preload →
   *  WS connect + scene init): the bar would otherwise sit pinned at 100%
   *  with a spinner suggesting work is still happening, which reads as a
   *  hang to the user. Hides the percentage label while indeterminate. */
  resetProgress(): void {
    this.currentPct = 0;
    this.progressFill.style.width = '0%';
    this.progressTextEl.textContent = '';
  }

  /** Hide the overlay. Delays the fade-out so the screen has been on
   *  display for at least `MIN_DISPLAY_MS` — protects the brand mark on
   *  cache-warm reloads where the actual work takes <100ms. */
  hide(): void {
    if (this.hidden) return;
    const elapsed = performance.now() - this.shownAtMs;
    const wait = Math.max(0, LoadingScreen.MIN_DISPLAY_MS - elapsed);
    if (wait > 0) {
      setTimeout(() => this._hideNow(), wait);
    } else {
      this._hideNow();
    }
  }

  private _hideNow(): void {
    if (this.hidden) return;
    this.hidden = true;
    this.overlay.classList.add('fading-out');
    setTimeout(() => {
      this.overlay.remove();
    }, 240);
  }
}
