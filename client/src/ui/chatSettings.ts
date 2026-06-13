export type ChatMessageColorKey = 'player' | 'npc' | 'world' | 'private' | 'game' | 'trade';

export interface ChatMessageColorOption {
  key: ChatMessageColorKey;
  label: string;
}

export interface ChatSettings {
  fontSize: number;
  colors: Record<ChatMessageColorKey, string>;
}

const STORAGE_KEY = 'projectrs_chat_settings_v1';

export const CHAT_FONT_SIZE_MIN = 11;
export const CHAT_FONT_SIZE_MAX = 18;
export const CHAT_FONT_SIZE_DEFAULT = 13;

export const CHAT_COLOR_OPTIONS: readonly ChatMessageColorOption[] = [
  { key: 'player', label: 'Players' },
  { key: 'npc', label: 'NPCs' },
  { key: 'world', label: 'World' },
  { key: 'private', label: 'Private' },
  { key: 'game', label: 'Game' },
  { key: 'trade', label: 'Trade' },
];

export const DEFAULT_CHAT_COLORS: Readonly<Record<ChatMessageColorKey, string>> = {
  player: '#ffffff',
  npc: '#f4ded5',
  world: '#ffff00',
  private: '#4fdfff',
  game: '#d8372b',
  trade: '#ffff00',
};

export const CHAT_COLOR_CSS_VAR_BY_KEY: Readonly<Record<ChatMessageColorKey, string>> = {
  player: '--eq-chat-color-player',
  npc: '--eq-chat-color-npc',
  world: '--eq-chat-color-world',
  private: '--eq-chat-color-private',
  game: '--eq-chat-color-game',
  trade: '--eq-chat-color-trade',
};

let installed = false;
let activeSettings: ChatSettings = makeDefaultSettings();

function makeDefaultSettings(): ChatSettings {
  return {
    fontSize: CHAT_FONT_SIZE_DEFAULT,
    colors: { ...DEFAULT_CHAT_COLORS },
  };
}

function isChatMessageColorKey(value: string): value is ChatMessageColorKey {
  return Object.prototype.hasOwnProperty.call(DEFAULT_CHAT_COLORS, value);
}

export function normalizeChatFontSize(value: unknown): number {
  const numeric = Math.round(typeof value === 'number' ? value : Number(value));
  if (!Number.isFinite(numeric)) return CHAT_FONT_SIZE_DEFAULT;
  return Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, numeric));
}

export function normalizeChatColor(value: unknown, fallback: string = '#ffffff'): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (short) {
    return `#${short[1].split('').map((char) => `${char}${char}`).join('')}`;
  }
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  return fallback;
}

function readStoredSettings(): ChatSettings {
  const next = makeDefaultSettings();
  try {
    if (typeof localStorage === 'undefined') return next;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return next;
    const parsed = JSON.parse(stored) as Partial<ChatSettings>;
    next.fontSize = normalizeChatFontSize(parsed.fontSize);
    const colors = parsed.colors;
    if (colors && typeof colors === 'object') {
      for (const [key, value] of Object.entries(colors)) {
        if (isChatMessageColorKey(key)) {
          next.colors[key] = normalizeChatColor(value, DEFAULT_CHAT_COLORS[key]);
        }
      }
    }
  } catch {
    return next;
  }
  return next;
}

function saveSettings(settings: ChatSettings): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }
  } catch {
    // Ignore storage failures; apply the value for this active page.
  }
}

export function chatColorCssVar(key: ChatMessageColorKey): string {
  return `var(${CHAT_COLOR_CSS_VAR_BY_KEY[key]}, ${DEFAULT_CHAT_COLORS[key]})`;
}

export function getChatSettings(): ChatSettings {
  activeSettings = readStoredSettings();
  return {
    fontSize: activeSettings.fontSize,
    colors: { ...activeSettings.colors },
  };
}

export function applyChatSettings(settings: ChatSettings = getChatSettings()): void {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (root) {
    root.style.setProperty('--eq-chat-font-size', `${normalizeChatFontSize(settings.fontSize)}px`);
    for (const option of CHAT_COLOR_OPTIONS) {
      root.style.setProperty(
        CHAT_COLOR_CSS_VAR_BY_KEY[option.key],
        normalizeChatColor(settings.colors[option.key], DEFAULT_CHAT_COLORS[option.key]),
      );
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('evilquest:chatsettingschange', {
      detail: {
        fontSize: normalizeChatFontSize(settings.fontSize),
        colors: { ...settings.colors },
      },
    }));
  }
}

export function setChatFontSize(fontSize: number): number {
  activeSettings = getChatSettings();
  activeSettings.fontSize = normalizeChatFontSize(fontSize);
  saveSettings(activeSettings);
  applyChatSettings(activeSettings);
  return activeSettings.fontSize;
}

export function setChatMessageColor(key: ChatMessageColorKey, color: string): string {
  activeSettings = getChatSettings();
  const normalized = normalizeChatColor(color, DEFAULT_CHAT_COLORS[key]);
  activeSettings.colors[key] = normalized;
  saveSettings(activeSettings);
  applyChatSettings(activeSettings);
  return normalized;
}

export function installChatSettingsController(): void {
  if (installed) return;
  installed = true;

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) applyChatSettings();
    });
  }
  applyChatSettings();
}
