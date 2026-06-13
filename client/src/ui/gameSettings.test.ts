import { afterEach, describe, expect, test } from 'bun:test';
import {
  GROUND_ITEM_LABEL_OPTIONS,
  NAMEPLATE_OPTIONS,
  TOOLTIP_OPTIONS,
  normalizeGroundItemLabelMode,
  normalizeNameplateMode,
  normalizeTooltipMode,
  setGroundItemLabelMode,
  setNameplateMode,
  setTooltipMode,
} from './gameSettings';

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

  setGroundItemLabelMode('off');
  setNameplateMode('all');
  setTooltipMode('on');
});

function installStorageAndEvents(): { store: Map<string, string>; events: CustomEvent[] } {
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
  return { store, events };
}

describe('game settings', () => {
  test('exposes Game options for ground items and nameplates', () => {
    expect(GROUND_ITEM_LABEL_OPTIONS.map(option => option.value)).toEqual(['off', 'valuable', 'all']);
    expect(NAMEPLATE_OPTIONS.map(option => option.value)).toEqual(['off', 'friends', 'players', 'all']);
    expect(TOOLTIP_OPTIONS.map(option => option.value)).toEqual(['off', 'on']);
  });

  test('normalizes invalid values to existing defaults', () => {
    expect(normalizeGroundItemLabelMode('valuable')).toBe('valuable');
    expect(normalizeGroundItemLabelMode('all')).toBe('all');
    expect(normalizeGroundItemLabelMode('everything')).toBe('off');
    expect(normalizeNameplateMode('friends')).toBe('friends');
    expect(normalizeNameplateMode('players')).toBe('players');
    expect(normalizeNameplateMode('all')).toBe('all');
    expect(normalizeNameplateMode('party')).toBe('all');
    expect(normalizeTooltipMode('off')).toBe('off');
    expect(normalizeTooltipMode('on')).toBe('on');
    expect(normalizeTooltipMode('delayed')).toBe('on');
    expect(normalizeTooltipMode('instant')).toBe('on');
    expect(normalizeTooltipMode('slowly')).toBe('on');
  });

  test('persists ground item label mode and broadcasts settings', () => {
    const { store, events } = installStorageAndEvents();

    setGroundItemLabelMode('valuable');

    expect(JSON.parse(store.get('projectrs_game_settings_v1') ?? '{}')).toEqual({
      groundItemLabels: 'valuable',
      nameplates: 'all',
      tooltips: 'on',
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('evilquest:gamesettingschange');
    expect(events[0].detail).toEqual({
      groundItemLabels: 'valuable',
      nameplates: 'all',
      tooltips: 'on',
    });
  });

  test('persists nameplate mode and keeps other Game settings', () => {
    const { store, events } = installStorageAndEvents();
    store.set('projectrs_game_settings_v1', JSON.stringify({ groundItemLabels: 'all', nameplates: 'all' }));

    setNameplateMode('friends');

    expect(JSON.parse(store.get('projectrs_game_settings_v1') ?? '{}')).toEqual({
      groundItemLabels: 'all',
      nameplates: 'friends',
      tooltips: 'on',
    });
    expect(events[0].detail).toEqual({
      groundItemLabels: 'all',
      nameplates: 'friends',
      tooltips: 'on',
    });
  });

  test('persists tooltip mode and keeps other Game settings', () => {
    const { store, events } = installStorageAndEvents();
    store.set('projectrs_game_settings_v1', JSON.stringify({ groundItemLabels: 'valuable', nameplates: 'players' }));

    setTooltipMode('off');

    expect(JSON.parse(store.get('projectrs_game_settings_v1') ?? '{}')).toEqual({
      groundItemLabels: 'valuable',
      nameplates: 'players',
      tooltips: 'off',
    });
    expect(events[0].detail).toEqual({
      groundItemLabels: 'valuable',
      nameplates: 'players',
      tooltips: 'off',
    });
  });
});
