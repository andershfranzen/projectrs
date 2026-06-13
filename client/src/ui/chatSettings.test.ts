import { describe, expect, test } from 'bun:test';
import {
  CHAT_COLOR_OPTIONS,
  CHAT_FONT_SIZE_DEFAULT,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_MIN,
  DEFAULT_CHAT_COLORS,
  chatColorCssVar,
  normalizeChatColor,
  normalizeChatFontSize,
} from './chatSettings';

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
});
