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
  private hidden = false;

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
        margin-bottom: 56px;
      }
      .evilmud-loading-spinner {
        width: 48px; height: 48px; margin-bottom: 18px;
        border: 3px solid rgba(252, 204, 0, 0.15);
        border-top-color: #fc0;
        border-radius: 50%;
        animation: evilmud-spin 1.1s linear infinite;
      }
      .evilmud-loading-status {
        font-size: 14px; color: #c8b690;
        animation: evilmud-pulse 1.6s ease-in-out infinite;
        letter-spacing: 1px;
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
