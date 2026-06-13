import { afterEach, describe, expect, test } from 'bun:test';
import { formatFramePacingForChat, GameManager, isStableLowFrameCadence, targetRenderFpsForFramePace } from './GameManager';

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

function installLocalStorageStub(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  });
  return store;
}

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    delete (globalThis as Partial<typeof globalThis>).localStorage;
  }
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    delete (globalThis as Partial<typeof globalThis>).window;
  }
  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator);
  } else {
    delete (globalThis as Partial<typeof globalThis>).navigator;
  }
  if (originalFetch) {
    Object.defineProperty(globalThis, 'fetch', originalFetch);
  } else {
    delete (globalThis as Partial<typeof globalThis>).fetch;
  }
});

function installWindowStub(devicePixelRatio: number = 1, search: string = ''): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { devicePixelRatio, location: { search } },
  });
}

function makeQualityManager() {
  const canvas = {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
    dataset: {},
  } as HTMLCanvasElement;
  const hardwareScaleCalls: number[] = [];
  const messages: string[] = [];
  const qualityLogs: string[] = [];
  const manager = Object.create(GameManager.prototype) as any;
  manager.baseHardwareScalingLevel = 1;
  manager.renderHardwareScalingLevel = 1;
  manager.engine = {
    getRenderingCanvas: () => canvas,
    setHardwareScalingLevel: (level: number) => hardwareScaleCalls.push(level),
    resize: () => {},
  };
  manager.chatPanel = {
    addSystemMessage: (message: string) => messages.push(message),
  };
  manager.reportRenderQualityChange = (quality: string) => qualityLogs.push(quality);
  return { manager, canvas, hardwareScaleCalls, messages, qualityLogs };
}

describe('GameManager render quality command', () => {
  test('frame pace target picks clean display divisors near 60 FPS', () => {
    expect(targetRenderFpsForFramePace(60)).toBeNull();
    expect(targetRenderFpsForFramePace(75)).toBeNull();
    expect(targetRenderFpsForFramePace(85)).toBeNull();
    expect(targetRenderFpsForFramePace(89.1)).toBeNull();
    expect(targetRenderFpsForFramePace(89.5)).toBe(44.75);
    expect(targetRenderFpsForFramePace(90)).toBe(45);
    expect(targetRenderFpsForFramePace(120)).toBe(60);
    expect(targetRenderFpsForFramePace(144)).toBe(48);
    expect(targetRenderFpsForFramePace(165)).toBe(55);
    expect(targetRenderFpsForFramePace(240)).toBe(60);
  });

  test('sets low quality immediately and persists it', () => {
    const storage = installLocalStorageStub();
    const { manager, canvas, hardwareScaleCalls, messages, qualityLogs } = makeQualityManager();

    expect(manager.handleChatCommand('/quality low')).toBe(true);

    expect(storage.get('projectrs_low_quality')).toBe('1');
    expect(manager.baseHardwareScalingLevel).toBe(2);
    expect(manager.renderHardwareScalingLevel).toBe(2);
    expect(hardwareScaleCalls).toEqual([2]);
    expect(canvas.dataset.renderScale).toBe('2.00');
    expect(messages.at(-1)).toBe('Render quality set to low (scale 2.0).');
    expect(qualityLogs).toEqual(['low']);
  });

  test('canvas picking coordinates remain aligned after low-quality render scaling', () => {
    const canvas = {
      getBoundingClientRect: () => ({ left: 20, top: 30, width: 1000, height: 800 }),
    } as HTMLCanvasElement;
    const manager = Object.create(GameManager.prototype) as any;
    manager.engine = {
      isDisposed: false,
      getRenderingCanvas: () => canvas,
      getRenderWidth: () => 500,
      getRenderHeight: () => 400,
    };
    manager.scene = { isDisposed: false };

    expect(manager.canvasPointFromClient(220, 430)).toEqual({ x: 200, y: 400 });
  });

  test('world overlays project into canvas layout coordinates after low-quality render scaling', () => {
    const canvas = {
      clientWidth: 1000,
      clientHeight: 800,
    } as HTMLCanvasElement;
    const manager = Object.create(GameManager.prototype) as any;
    manager._overlayTransformReady = false;
    manager._overlayTransform = {};
    manager._overlayVp = { x: 0, y: 0, width: 0, height: 0 };
    manager.engine = {
      getRenderingCanvas: () => canvas,
      getRenderWidth: () => 500,
      getRenderHeight: () => 400,
    };
    manager.scene = {
      activeCamera: {
        getViewMatrix: () => ({ multiplyToRef: () => {} }),
        getProjectionMatrix: () => ({}),
      },
    };

    expect(manager.ensureOverlayTransform()).toBe(true);

    expect(manager._overlayVp).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  test('sets high quality for the session and clears low quality preference', () => {
    const storage = installLocalStorageStub();
    storage.set('projectrs_low_quality', '1');
    storage.set('projectrs_auto_low_quality', '1');
    const { manager, canvas, hardwareScaleCalls, messages, qualityLogs } = makeQualityManager();
    manager.baseHardwareScalingLevel = 2;
    manager.renderHardwareScalingLevel = 2;

    expect(manager.handleChatCommand('/quality high')).toBe(true);

    expect(storage.has('projectrs_low_quality')).toBe(false);
    expect(storage.has('projectrs_auto_low_quality')).toBe(false);
    expect(manager.baseHardwareScalingLevel).toBe(1);
    expect(manager.renderHardwareScalingLevel).toBe(1);
    expect(hardwareScaleCalls).toEqual([1]);
    expect(canvas.dataset.renderScale).toBe('1.00');
    expect(messages.at(-1)).toBe('Render quality set to high (scale 1.0).');
    expect(qualityLogs).toEqual(['high']);
  });

  test('auto quality clears low preferences and returns to full resolution', () => {
    const storage = installLocalStorageStub();
    storage.set('projectrs_low_quality', '1');
    storage.set('projectrs_auto_low_quality', '1');
    const { manager, hardwareScaleCalls, messages, qualityLogs } = makeQualityManager();

    expect(manager.handleChatCommand('/quality auto')).toBe(true);

    expect(storage.has('projectrs_low_quality')).toBe(false);
    expect(storage.has('projectrs_auto_low_quality')).toBe(false);
    expect(manager.baseHardwareScalingLevel).toBe(1);
    expect(manager.renderHardwareScalingLevel).toBe(1);
    expect(hardwareScaleCalls).toEqual([]);
    expect(messages.at(-1)).toBe('Render quality set to auto (scale 1.0).');
    expect(qualityLogs).toEqual(['auto']);
  });

  test('shows usage without changing scale for incomplete command', () => {
    installLocalStorageStub();
    const { manager, hardwareScaleCalls, messages, qualityLogs } = makeQualityManager();

    expect(manager.handleChatCommand('/quality')).toBe(true);

    expect(manager.baseHardwareScalingLevel).toBe(1);
    expect(manager.renderHardwareScalingLevel).toBe(1);
    expect(hardwareScaleCalls).toEqual([]);
    expect(messages.at(-1)).toBe('Render quality: scale 1.0. Usage: /quality low, /quality high, or /quality auto.');
    expect(qualityLogs).toEqual([]);
  });

  test('legacy auto low quality preference is ignored and cleared on startup detection', () => {
    const storage = installLocalStorageStub();
    storage.set('projectrs_auto_low_quality', '1');
    installWindowStub();
    const { manager } = makeQualityManager();

    expect(manager.detectBaseHardwareScalingLevel()).toBe(1);

    expect(storage.has('projectrs_auto_low_quality')).toBe(false);
  });

  test('software renderers do not automatically lower startup resolution', () => {
    installLocalStorageStub();
    installWindowStub();
    const { manager } = makeQualityManager();
    manager.getWebGlDiagnostics = () => ({ context: 'webgl2', unmaskedRenderer: 'ANGLE (Google, SwiftShader driver)' });

    expect(manager.detectBaseHardwareScalingLevel()).toBe(1);
  });

  test('explicit quality URL can still request low resolution', () => {
    installLocalStorageStub();
    installWindowStub(1, '?quality=low');
    const { manager } = makeQualityManager();

    expect(manager.detectBaseHardwareScalingLevel()).toBe(2);
  });

  test('explicit quality URL can still request high resolution', () => {
    const storage = installLocalStorageStub();
    storage.set('projectrs_low_quality', '1');
    installWindowStub(1, '?quality=high');
    const { manager } = makeQualityManager();

    expect(manager.detectBaseHardwareScalingLevel()).toBe(1);

    expect(storage.get('projectrs_low_quality')).toBe('1');
  });

  test('diagnostic flags distinguish Brave low FPS on an apparently hardware renderer', () => {
    installWindowStub();
    const { manager } = makeQualityManager();

    const flags = manager.getPerformanceDiagnosticFlags(
      { context: 'webgl2', unmaskedRenderer: 'ANGLE (NVIDIA, GeForce RTX)' },
      { brave: true },
      null,
      32,
    );

    expect(flags).toContain('brave-browser');
    expect(flags).toContain('low-fps-measured');
    expect(flags).toContain('brave-low-fps');
    expect(flags).toContain('low-fps-with-hardware-renderer');
    expect(flags).not.toContain('software-renderer-likely');
    expect(flags).not.toContain('low-fps-after-render-scale');
  });

  test('diagnostic flags show when low FPS persists after emergency render scaling', () => {
    installWindowStub();
    const { manager } = makeQualityManager();
    manager.renderHardwareScalingLevel = 3;

    const flags = manager.getPerformanceDiagnosticFlags(
      { context: 'webgl2', unmaskedRenderer: 'ANGLE (Google, SwiftShader driver)' },
      { brave: false },
      null,
      30,
    );

    expect(flags).toContain('software-renderer-likely');
    expect(flags).toContain('low-fps-measured');
    expect(flags).toContain('low-fps-after-render-scale');
    expect(flags).toContain('emergency-render-scale');
    expect(flags).not.toContain('low-fps-with-hardware-renderer');
  });

  test('renderer warnings call out software WebGL first', () => {
    const { manager } = makeQualityManager();

    const warning = manager.rendererWarningForDiagnosticFlags([
      'software-renderer-likely',
      'brave-low-fps',
      'low-fps-with-hardware-renderer',
    ]);

    expect(warning).toContain('software rendering');
    expect(warning).toContain('SwiftShader');
  });

  test('renderer warnings distinguish slow Brave hardware renderers', () => {
    const { manager } = makeQualityManager();

    const warning = manager.rendererWarningForDiagnosticFlags(['brave-low-fps', 'low-fps-with-hardware-renderer']);

    expect(warning).toContain('Brave warning');
    expect(warning).toContain('hardware renderer');
  });

  test('renderer warnings ignore plain low FPS without renderer evidence', () => {
    const { manager } = makeQualityManager();

    expect(manager.rendererWarningForDiagnosticFlags(['low-fps-measured'])).toBeNull();
  });

  test('perf frame pacing summary calls out the useful cadence fields', () => {
    expect(formatFramePacingForChat({
      intervals: 90,
      meanMs: 33.3,
      medianMs: 33.4,
      p95Ms: 34.1,
      maxMs: 36.8,
      stddevMs: 1.2,
      over16Ms: 90,
      over33Ms: 88,
      over50Ms: 0,
      over100Ms: 0,
    })).toBe('median 33.4ms, p95 34.1ms, max 36.8ms, >33ms 88, >50ms 0');
  });

  test('client log payloads are clipped by encoded byte size', () => {
    const manager = Object.create(GameManager.prototype) as any;
    manager.username = 'tester';

    const payload = manager.buildClientLogPayload('client_perf_snapshot', {
      currentMap: 'kcmap',
      diagnosticFlags: ['low-fps-measured'],
      framePacing: {
        intervals: 90,
        meanMs: 33.3,
        medianMs: 33.3,
        p95Ms: 34.1,
        maxMs: 36.8,
        stddevMs: 1.2,
        over16Ms: 90,
        over33Ms: 88,
        over50Ms: 0,
        over100Ms: 0,
      },
      webgl: { unmaskedRenderer: 'ANGLE (NVIDIA)' },
      oversized: '\u754c'.repeat(80_000),
    });
    const parsed = JSON.parse(payload) as { details: Record<string, unknown> };

    expect(new TextEncoder().encode(payload).byteLength).toBeLessThanOrEqual(60 * 1024);
    expect(parsed.details.truncated).toBe(true);
    expect(parsed.details.currentMap).toBe('kcmap');
    expect(parsed.details.diagnosticFlags).toEqual(['low-fps-measured']);
    expect(parsed.details.framePacing).toEqual({
      intervals: 90,
      meanMs: 33.3,
      medianMs: 33.3,
      p95Ms: 34.1,
      maxMs: 36.8,
      stddevMs: 1.2,
      over16Ms: 90,
      over33Ms: 88,
      over50Ms: 0,
      over100Ms: 0,
    });
    expect(parsed.details.webgl).toEqual({ unmaskedRenderer: 'ANGLE (NVIDIA)' });
    expect(parsed.details.oversized).toBeUndefined();
  });

  test('client log falls back to fetch when sendBeacon rejects the payload', () => {
    const manager = Object.create(GameManager.prototype) as any;
    manager.username = 'tester';
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        sendBeacon: () => false,
      },
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init });
        return Promise.resolve(new Response('{}'));
      },
    });

    manager.reportClientLog('client_perf_snapshot', { measuredFps: 42, framePacing: { medianMs: 24 } });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('/api/client-log');
    expect(fetchCalls[0].init.keepalive).toBe(true);
    expect(String(fetchCalls[0].init.body)).toContain('client_perf_snapshot');
  });

  test('stable low cadence distinguishes a 30 FPS cap from stalls', () => {
    expect(isStableLowFrameCadence(30.1, {
      intervals: 90,
      meanMs: 33.2,
      medianMs: 33.3,
      p95Ms: 35.0,
      maxMs: 38.0,
      stddevMs: 1.4,
      over16Ms: 90,
      over33Ms: 88,
      over50Ms: 0,
      over100Ms: 0,
    })).toBe(true);
    expect(isStableLowFrameCadence(30.1, {
      intervals: 90,
      meanMs: 33.2,
      medianMs: 33.3,
      p95Ms: 81.0,
      maxMs: 160.0,
      stddevMs: 18.0,
      over16Ms: 90,
      over33Ms: 40,
      over50Ms: 8,
      over100Ms: 2,
    })).toBe(false);
  });

  test('automatic low FPS snapshot samples frame pacing without changing render scale', async () => {
    installLocalStorageStub();
    const { manager, hardwareScaleCalls } = makeQualityManager();
    const reported: Array<{ event: string; snapshot: Record<string, unknown> }> = [];
    manager.shouldCapturePerformanceDiagnostic = () => true;
    manager.sampleRafFps = async () => ({
      frames: 90,
      durationMs: 3000,
      fps: 30,
      framePacing: {
        intervals: 90,
        meanMs: 33.3,
        medianMs: 33.3,
        p95Ms: 34.2,
        maxMs: 37.5,
        stddevMs: 1.1,
        over16Ms: 90,
        over33Ms: 88,
        over50Ms: 0,
        over100Ms: 0,
      },
    });
    manager.collectPerformanceSnapshot = (sample: unknown) => ({
      measuredFps: (sample as { fps: number }).fps,
      framePacing: (sample as { framePacing: unknown }).framePacing,
      diagnosticFlags: ['low-fps-with-hardware-renderer'],
    });
    manager.maybeShowLowFpsRendererWarning = () => {};
    manager.reportClientLog = (event: string, snapshot: Record<string, unknown>) => reported.push({ event, snapshot });

    await manager.captureLowFpsDiagnosticSnapshot({
      frames: 95,
      durationMs: 3000,
      fps: 31.4,
      framePacing: null,
    });

    expect(hardwareScaleCalls).toEqual([]);
    expect(manager.renderHardwareScalingLevel).toBe(1);
    expect(reported).toHaveLength(1);
    expect(reported[0].event).toBe('client_low_fps_snapshot');
    expect(reported[0].snapshot.lowFpsAction).toBe('diagnostic-only');
    expect(reported[0].snapshot.lowFpsInitialFps).toBe(31.4);
    expect(reported[0].snapshot.framePacing).toEqual({
      intervals: 90,
      meanMs: 33.3,
      medianMs: 33.3,
      p95Ms: 34.2,
      maxMs: 37.5,
      stddevMs: 1.1,
      over16Ms: 90,
      over33Ms: 88,
      over50Ms: 0,
      over100Ms: 0,
    });
  });

  test('perf snapshot enrichment records battery and high entropy browser data', async () => {
    const browser: Record<string, unknown> = {};
    const highEntropy = {
      architecture: 'x86',
      bitness: '64',
      fullVersionList: [{ brand: 'Brave', version: '146.0.1.2' }],
      platformVersion: '10.0.0',
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        navigator: {
          getBattery: async () => ({
            charging: false,
            level: 0.22,
            chargingTime: Infinity,
            dischargingTime: 3600,
          }),
          userAgentData: {
            getHighEntropyValues: async (hints: string[]) => {
              expect(hints).toContain('fullVersionList');
              return highEntropy;
            },
          },
        },
      },
    });
    const manager = Object.create(GameManager.prototype) as any;
    const snapshot = { browser };

    await manager.enrichPerformanceSnapshot(snapshot);

    expect(browser.userAgentDataHighEntropy).toEqual(highEntropy);
    expect(browser.battery).toEqual({
      charging: false,
      level: 0.22,
      chargingTime: null,
      dischargingTime: 3600,
    });
  });
});
