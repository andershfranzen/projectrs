export const DEFAULT_MAX_RENDER_FPS = 60;
export const DEFAULT_RENDER_FRAME_MS = 1000 / DEFAULT_MAX_RENDER_FPS;
export const FRAME_LIMIT_EPSILON_MS = 0.75;

export interface FrameLimiter {
  readonly maxFps: number;
  reset(nowMs?: number): void;
  shouldRun(nowMs?: number): boolean;
}

function currentTimeMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function normalizeMaxFps(maxFps: number): number {
  return Number.isFinite(maxFps) && maxFps > 0 ? maxFps : DEFAULT_MAX_RENDER_FPS;
}

export function createFrameLimiter(
  maxFps: number = DEFAULT_MAX_RENDER_FPS,
  initialNowMs: number = currentTimeMs(),
): FrameLimiter {
  const normalizedMaxFps = normalizeMaxFps(maxFps);
  const targetFrameMs = 1000 / normalizedMaxFps;
  let nextFrameAt = initialNowMs;

  return {
    maxFps: normalizedMaxFps,
    reset(nowMs: number = currentTimeMs()): void {
      nextFrameAt = nowMs;
    },
    shouldRun(nowMs: number = currentTimeMs()): boolean {
      if (nowMs + FRAME_LIMIT_EPSILON_MS < nextFrameAt) return false;

      if (nowMs - nextFrameAt > targetFrameMs * 2) {
        nextFrameAt = nowMs + targetFrameMs;
      } else {
        nextFrameAt += targetFrameMs;
        if (nowMs - nextFrameAt > targetFrameMs) nextFrameAt = nowMs + targetFrameMs;
      }

      return true;
    },
  };
}
