import { afterEach, describe, expect, test } from 'bun:test';
import {
  CHAT_COLOR_OPTIONS,
  CHAT_FONT_SIZE_DEFAULT,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_MIN,
  DEFAULT_CHAT_COLORS,
  chatColorCssVar,
  normalizeNpcDialogueInChat,
  normalizeChatColor,
  normalizeChatFontSize,
  setNpcDialogueInChatEnabled,
} from './chatSettings';

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
});

describe('chat settings', () => {
  test('exposes the expected chat color categories', () => {
    expect(CHAT_COLOR_OPTIONS.map(option => option.key)).toEqual([
      'player',
      'npc',
      'world',
      'private',
      'game',
      'trade',
    ]);
  });

  test('normalizes chat font size into the allowed range', () => {
    expect(normalizeChatFontSize(4)).toBe(CHAT_FONT_SIZE_MIN);
    expect(normalizeChatFontSize(99)).toBe(CHAT_FONT_SIZE_MAX);
    expect(normalizeChatFontSize('nope')).toBe(CHAT_FONT_SIZE_DEFAULT);
  });

  test('normalizes chat colors and exposes CSS fallbacks', () => {
    expect(normalizeChatColor('#abc')).toBe('#aabbcc');
    expect(normalizeChatColor('#A1B2C3')).toBe('#a1b2c3');
    expect(normalizeChatColor('red', DEFAULT_CHAT_COLORS.private)).toBe(DEFAULT_CHAT_COLORS.private);
    expect(chatColorCssVar('npc')).toBe('var(--eq-chat-color-npc, #f4ded5)');
  });

  test('defaults NPC dialogue echoes on unless explicitly disabled', () => {
    expect(normalizeNpcDialogueInChat(true)).toBe(true);
    expect(normalizeNpcDialogueInChat(false)).toBe(false);
    expect(normalizeNpcDialogueInChat('false')).toBe(true);
  });

  test('persists NPC dialogue echo preference and broadcasts it', () => {
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

    setNpcDialogueInChatEnabled(false);

    expect(JSON.parse(store.get('projectrs_chat_settings_v1') ?? '{}').npcDialogueInChat).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('evilquest:chatsettingschange');
    expect(events[0].detail).toMatchObject({ npcDialogueInChat: false });
  });
});
