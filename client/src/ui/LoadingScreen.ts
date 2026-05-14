/**
 * Full-screen overlay shown while the local player's character GLB
 * and animation files are loading. Hides the T-pose flash on refresh.
 *
 * Usage:
 *   const screen = new LoadingScreen();
 *   screen.show();
 *   screen.setStatus('Loading character…');
 *   // …later
 *   screen.hide(); // fades out and removes from DOM
 */
export class LoadingScreen {
  private overlay: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  private progressTrack: HTMLDivElement;
  private progressFill: HTMLDivElement;
  private progressPctEl: HTMLDivElement;
  private hidden = false;
  private currentPct: number = 0;

  constructor() {
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = `
      @keyframes evilmud-fade-in   { from { opacity: 0; } to { opacity: 1; } }
      @keyframes evilmud-fade-out  { from { opacity: 1; } to { opacity: 0; } }
      @keyframes evilmud-pulse     { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
      @keyframes evilmud-spin      { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes evilmud-glow      {
        0%,100% { text-shadow: 0 0 20px rgba(255,204,0,0.4), 0 0 40px rgba(255,80,0,0.2), 2px 2px 6px rgba(0,0,0,0.9); }
        50%     { text-shadow: 0 0 30px rgba(255,204,0,0.7), 0 0 60px rgba(255,80,0,0.4), 2px 2px 6px rgba(0,0,0,0.9); }
      }
      @keyframes evilmud-shimmer {
        0% { background-position: -200% 0; }
        100% { background-position: 200% 0; }
      }
      .evilmud-loading-overlay {
        position: fixed; inset: 0;
        background:
          radial-gradient(ellipse at center, rgba(40,28,16,0.92) 0%, rgba(8,4,2,0.98) 80%),
          repeating-linear-gradient(45deg, transparent 0 4px, rgba(255,255,255,0.02) 4px 5px);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        z-index: 99999; font-family: monospace;
        animation: evilmud-fade-in 220ms ease-out;
      }
      .evilmud-loading-overlay.fading-out {
        animation: evilmud-fade-out 320ms ease-in forwards;
        pointer-events: none;
      }
      .evilmud-loading-title {
        font-size: 64px; font-weight: bold; letter-spacing: 6px;
        color: #fc0;
        animation: evilmud-glow 2.6s ease-in-out infinite;
        margin-bottom: 8px;
        user-select: none;
      }
      .evilmud-loading-sub {
        font-size: 13px; color: #8a7a60;
        letter-spacing: 3px; text-transform: uppercase;
        margin-bottom: 40px;
      }
      .evilmud-loading-spinner {
        width: 36px; height: 36px; margin-bottom: 22px;
        border: 3px solid rgba(252, 204, 0, 0.15);
        border-top-color: #fc0;
        border-radius: 50%;
        animation: evilmud-spin 1.1s linear infinite;
      }
      .evilmud-loading-progress-wrap {
        width: 340px; max-width: 70vw;
        display: flex; flex-direction: column; align-items: center;
        gap: 8px;
      }
      .evilmud-loading-progress-track {
        width: 100%; height: 12px;
        background: rgba(0,0,0,0.55);
        border: 1px solid #5a4a35;
        border-radius: 2px;
        overflow: hidden;
        box-shadow: inset 0 2px 4px rgba(0,0,0,0.6);
      }
      .evilmud-loading-progress-fill {
        height: 100%; width: 0%;
        background: linear-gradient(90deg, #5a4a35 0%, #fc0 40%, #ffb840 100%);
        background-size: 200% 100%;
        animation: evilmud-shimmer 2.2s linear infinite;
        transition: width 220ms ease-out;
        box-shadow: 0 0 12px rgba(255,204,0,0.45);
      }
      .evilmud-loading-progress-pct {
        font-size: 11px; color: #c8b690;
        letter-spacing: 2px;
        font-variant-numeric: tabular-nums;
      }
      .evilmud-loading-status {
        margin-top: 14px;
        font-size: 13px; color: #c8b690;
        animation: evilmud-pulse 1.6s ease-in-out infinite;
        letter-spacing: 1px;
        max-width: 70vw; text-align: center;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
    `;
    document.head.appendChild(this.styleEl);

    this.overlay = document.createElement('div');
    this.overlay.className = 'evilmud-loading-overlay';

    const title = document.createElement('div');
    title.className = 'evilmud-loading-title';
    title.textContent = 'EvilQuest';
    this.overlay.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'evilmud-loading-sub';
    sub.textContent = 'Awakening the world…';
    this.overlay.appendChild(sub);

    const spinner = document.createElement('div');
    spinner.className = 'evilmud-loading-spinner';
    this.overlay.appendChild(spinner);

    const progressWrap = document.createElement('div');
    progressWrap.className = 'evilmud-loading-progress-wrap';
    this.progressTrack = document.createElement('div');
    this.progressTrack.className = 'evilmud-loading-progress-track';
    this.progressFill = document.createElement('div');
    this.progressFill.className = 'evilmud-loading-progress-fill';
    this.progressTrack.appendChild(this.progressFill);
    progressWrap.appendChild(this.progressTrack);
    this.progressPctEl = document.createElement('div');
    this.progressPctEl.className = 'evilmud-loading-progress-pct';
    this.progressPctEl.textContent = '0%';
    progressWrap.appendChild(this.progressPctEl);
    this.overlay.appendChild(progressWrap);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'evilmud-loading-status';
    this.statusEl.textContent = 'Loading…';
    this.overlay.appendChild(this.statusEl);
  }

  show(): void {
    if (this.overlay.isConnected) return;
    document.body.appendChild(this.overlay);
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  /** Set progress 0–1. Values are clamped and never go backwards. */
  setProgress(pct: number): void {
    const clamped = Math.max(0, Math.min(1, pct));
    if (clamped < this.currentPct) return;
    this.currentPct = clamped;
    const pctRounded = Math.round(clamped * 100);
    this.progressFill.style.width = `${pctRounded}%`;
    this.progressPctEl.textContent = `${pctRounded}%`;
  }

  hide(): void {
    if (this.hidden) return;
    this.hidden = true;
    this.overlay.classList.add('fading-out');
    setTimeout(() => {
      this.overlay.remove();
      this.styleEl.remove();
    }, 340);
  }
}
