import { afterEach, describe, expect, test } from 'bun:test';
import { GameManager } from './GameManager';

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

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
});

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

  test('sets high quality for the session and clears low quality preference', () => {
    const storage = installLocalStorageStub();
    storage.set('projectrs_low_quality', '1');
    const { manager, canvas, hardwareScaleCalls, messages, qualityLogs } = makeQualityManager();
    manager.baseHardwareScalingLevel = 2;
    manager.renderHardwareScalingLevel = 2;

    expect(manager.handleChatCommand('/quality high')).toBe(true);

    expect(storage.has('projectrs_low_quality')).toBe(false);
    expect(manager.baseHardwareScalingLevel).toBe(1);
    expect(manager.renderHardwareScalingLevel).toBe(1);
    expect(hardwareScaleCalls).toEqual([1]);
    expect(canvas.dataset.renderScale).toBe('1.00');
    expect(messages.at(-1)).toBe('Render quality set to high (scale 1.0).');
    expect(qualityLogs).toEqual(['high']);
  });

  test('auto quality clears the manual low preference and uses detected scale', () => {
    const storage = installLocalStorageStub();
    storage.set('projectrs_low_quality', '1');
    const { manager, hardwareScaleCalls, messages, qualityLogs } = makeQualityManager();
    manager.detectBaseHardwareScalingLevel = () => 2;

    expect(manager.handleChatCommand('/quality auto')).toBe(true);

    expect(storage.has('projectrs_low_quality')).toBe(false);
    expect(manager.baseHardwareScalingLevel).toBe(2);
    expect(manager.renderHardwareScalingLevel).toBe(2);
    expect(hardwareScaleCalls).toEqual([2]);
    expect(messages.at(-1)).toBe('Render quality set to auto (scale 2.0).');
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

  test('low FPS adaptive scaling can step from normal to low quality', () => {
    installLocalStorageStub();
    const { manager, canvas, hardwareScaleCalls, messages } = makeQualityManager();

    expect(manager.maybeApplyLowFpsRenderScale(35)).toBe(2);

    expect(manager.renderHardwareScalingLevel).toBe(2);
    expect(hardwareScaleCalls).toEqual([2]);
    expect(canvas.dataset.renderScale).toBe('2.00');
    expect(messages.at(-1)).toBe('Low FPS detected; lowering render resolution.');
  });

  test('low FPS adaptive scaling can step further only when FPS remains very low', () => {
    installLocalStorageStub();
    const { manager, canvas, hardwareScaleCalls, messages } = makeQualityManager();
    manager.renderHardwareScalingLevel = 2;

    expect(manager.maybeApplyLowFpsRenderScale(48)).toBeNull();
    expect(manager.maybeApplyLowFpsRenderScale(40)).toBe(3);
    expect(manager.maybeApplyLowFpsRenderScale(30)).toBeNull();

    expect(manager.renderHardwareScalingLevel).toBe(3);
    expect(hardwareScaleCalls).toEqual([3]);
    expect(canvas.dataset.renderScale).toBe('3.00');
    expect(messages.at(-1)).toBe('FPS still low; lowering render resolution further.');
  });
});
