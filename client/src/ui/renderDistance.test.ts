import { afterEach, describe, expect, test } from 'bun:test';
import { CHUNK_LOAD_RADIUS } from '@projectrs/shared';
import {
  RENDER_DISTANCE_OPTIONS,
  normalizeRenderDistanceValue,
  renderDistanceOptionFor,
  setRenderDistance,
} from './renderDistance';

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');

afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');

  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');

  if (originalCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', originalCustomEvent);
  else Reflect.deleteProperty(globalThis, 'CustomEvent');

  setRenderDistance('max');
});

describe('render distance settings', () => {
  test('keeps the current render distance as Max', () => {
    const max = renderDistanceOptionFor('max');
    expect(max.cameraMaxZ).toBe(60);
    expect(max.chunkRadius).toBe(CHUNK_LOAD_RADIUS);
    expect(RENDER_DISTANCE_OPTIONS.map(option => option.value)).toEqual(['low', 'medium', 'max']);
  });

  test('defaults invalid persisted values to Max', () => {
    expect(normalizeRenderDistanceValue('low')).toBe('low');
    expect(normalizeRenderDistanceValue('medium')).toBe('medium');
    expect(normalizeRenderDistanceValue('max')).toBe('max');
    expect(normalizeRenderDistanceValue('wide-open')).toBe('max');
  });

  test('persists the selected value and broadcasts runtime details', () => {
    const store = new Map<string, string>();
    const events: CustomEvent[] = [];
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
      },
    });
    Object.defineProperty(globalThis, 'CustomEvent', {
      configurable: true,
      value: class TestCustomEvent<T = unknown> {
        type: string;
        detail: T;
        constructor(type: string, init?: { detail?: T }) {
          this.type = type;
          this.detail = init?.detail as T;
        }
      },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        dispatchEvent: (event: CustomEvent) => {
          events.push(event);
          return true;
        },
      },
    });

    setRenderDistance('low');

    expect(store.get('projectrs_render_distance')).toBe('low');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('evilquest:renderdistancechange');
    expect(events[0].detail).toEqual({
      value: 'low',
      cameraMaxZ: 38,
      chunkRadius: 1,
    });
  });
});
