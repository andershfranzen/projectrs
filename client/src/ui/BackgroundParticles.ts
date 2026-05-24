/**
 * Full-screen retro fire field for pre-auth screens.
 *
 * The effect renders into a tiny indexed-color buffer, then scales that
 * buffer up with nearest-neighbor filtering. This deliberately avoids soft
 * gradients and particle glow so the bottom-of-screen fire reads like an
 * old software-rendered RPG menu instead of a modern canvas particle system.
 */

type RGB = [number, number, number];

const FIRE_PALETTE: RGB[] = [
  [0, 0, 0],
  [12, 3, 3],
  [24, 5, 4],
  [38, 7, 4],
  [55, 10, 5],
  [76, 16, 6],
  [98, 25, 8],
  [122, 38, 10],
  [146, 54, 13],
  [168, 73, 18],
  [190, 94, 26],
  [208, 118, 38],
  [222, 144, 56],
  [232, 170, 82],
  [238, 190, 112],
  [242, 205, 142],
];

export class BackgroundParticles {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private bufferCanvas: HTMLCanvasElement;
  private bufferCtx: CanvasRenderingContext2D | null = null;
  private imageData: ImageData | null = null;
  private heat: Uint8Array = new Uint8Array(0);
  private raf: number = 0;
  private lastMs: number = 0;
  private accumulator: number = 0;
  private resizeHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private hidden: boolean = false;
  private logicalW: number = 0;
  private logicalH: number = 0;
  private fireTopPx: number = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'background-particles';
    // Keep the same id/class contract used by main.ts, but render a chunky
    // indexed fire strip rather than full-resolution floating particles.
    this.canvas.style.cssText = `
      position: fixed; inset: 0;
      z-index: 100000; pointer-events: none;
      background: transparent;
      image-rendering: pixelated;
    `;
    this.bufferCanvas = document.createElement('canvas');
    document.body.appendChild(this.canvas);
    this.start();
  }

  pause(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  resume(): void {
    if (this.raf) return;
    this.lastMs = performance.now();
    this.loop();
  }

  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? '' : 'none';
    this.hidden = !visible;
    if (visible) this.resume();
    else this.pause();
  }

  destroy(): void {
    this.pause();
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    if (this.visibilityHandler) document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.canvas.remove();
  }

  private start(): void {
    const ctx = this.canvas.getContext('2d');
    const bufferCtx = this.bufferCanvas.getContext('2d', { alpha: true });
    if (!ctx || !bufferCtx) return;
    this.ctx = ctx;
    this.bufferCtx = bufferCtx;
    ctx.imageSmoothingEnabled = false;
    bufferCtx.imageSmoothingEnabled = false;

    const resize = () => this.resize();
    resize();
    this.resizeHandler = resize;
    window.addEventListener('resize', resize);

    const onVis = () => {
      if (document.visibilityState === 'hidden') this.pause();
      else if (!this.hidden) this.resume();
    };
    this.visibilityHandler = onVis;
    document.addEventListener('visibilitychange', onVis);

    this.lastMs = performance.now();
    this.loop();
  }

  private resize(): void {
    const ctx = this.ctx;
    if (!ctx || !this.bufferCtx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    // Tiny simulation grid. About 6 CSS pixels per fire pixel gives a chunky
    // low-res look while still filling wide monitors cleanly.
    const pixelSize = Math.max(5, Math.min(8, Math.floor(w / 180)));
    this.logicalW = Math.max(120, Math.ceil(w / pixelSize));
    this.logicalH = Math.max(18, Math.ceil(h * 0.15 / pixelSize));
    this.fireTopPx = Math.max(0, h - this.logicalH * pixelSize);

    this.bufferCanvas.width = this.logicalW;
    this.bufferCanvas.height = this.logicalH;
    this.imageData = this.bufferCtx.createImageData(this.logicalW, this.logicalH);
    this.heat = new Uint8Array(this.logicalW * this.logicalH);
    this.seedBaseRows();
  }

  private loop(): void {
    const tick = (now: number) => {
      const dt = Math.min(80, now - this.lastMs) / 1000;
      this.lastMs = now;
      this.accumulator += dt;

      // Fixed low frame rate on purpose. The stepped cadence helps the fire
      // feel like old menu art instead of high-refresh particle animation.
      const stepMs = 1 / 11;
      while (this.accumulator >= stepMs) {
        this.step();
        this.accumulator -= stepMs;
      }
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private seedBaseRows(): void {
    const w = this.logicalW;
    const h = this.logicalH;
    if (!w || !h) return;
    for (let y = h - 4; y < h; y++) {
      for (let x = 0; x < w; x++) {
        this.heat[y * w + x] = Math.random() > 0.18 ? 15 : 10;
      }
    }
  }

  private step(): void {
    const w = this.logicalW;
    const h = this.logicalH;
    if (!w || !h) return;

    // Staggered hot coals along the bottom. Short dark gaps make the base
    // look tiled and hand-authored instead of a smooth continuous gradient.
    for (let x = 0; x < w; x++) {
      const coalBand = Math.floor(x / 8) % 4;
      const spark = Math.random() > (coalBand === 0 ? 0.66 : 0.52);
      this.heat[(h - 1) * w + x] = spark ? 14 : 4 + Math.floor(Math.random() * 5);
      this.heat[(h - 2) * w + x] = spark ? 11 : 4;
    }

    for (let y = 0; y < h - 2; y++) {
      for (let x = 0; x < w; x++) {
        const below = y + 1;
        const drift = Math.floor(Math.random() * 3) - 1;
        const srcX = Math.max(0, Math.min(w - 1, x + drift));
        const src = below * w + srcX;
        const decay = Math.random() > 0.12 ? 1 : 0;
        const cooled = Math.max(0, this.heat[src] - decay);
        this.heat[y * w + x] = cooled;
      }
    }

    // A few square sparks break off from the flame tops.
    for (let i = 0; i < Math.max(1, w / 110); i++) {
      if (Math.random() > 0.12) continue;
      const x = Math.floor(Math.random() * w);
      const y = Math.floor(Math.random() * Math.max(6, h * 0.38));
      this.heat[y * w + x] = 7 + Math.floor(Math.random() * 3);
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    const bufferCtx = this.bufferCtx;
    const imageData = this.imageData;
    if (!ctx || !bufferCtx || !imageData) return;

    const data = imageData.data;
    for (let i = 0; i < this.heat.length; i++) {
      const heat = this.heat[i];
      const [r, g, b] = FIRE_PALETTE[heat] ?? FIRE_PALETTE[0];
      const dst = i * 4;
      data[dst] = r;
      data[dst + 1] = g;
      data[dst + 2] = b;
      data[dst + 3] = heat <= 2 ? 0 : Math.min(145, 20 + heat * 8);
    }
    bufferCtx.putImageData(imageData, 0, 0);

    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.imageSmoothingEnabled = false;

    // Paint only the lower strip, leaving the title/login card area clean.
    const drawH = cssH - this.fireTopPx;
    ctx.drawImage(this.bufferCanvas, 0, this.fireTopPx, cssW, drawH);

    // Hard, dithered floor shadow helps anchor the fire to the bottom edge.
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#050506';
    for (let y = cssH - 24; y < cssH; y += 4) {
      ctx.fillRect(0, y, cssW, 2);
    }
    ctx.globalAlpha = 1;
  }
}
