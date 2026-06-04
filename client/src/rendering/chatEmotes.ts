type ForumDiscordEmoji = {
  name: string;
  url: string;
  available?: boolean;
};

type ForumEmojiResponse = {
  emojis?: ForumDiscordEmoji[];
};

const DISCORD_EMOTE_REFRESH_MS = 5 * 60 * 1000;
const discordEmotesByName = new Map<string, ForumDiscordEmoji>();
const listeners = new Set<() => void>();

let loadStarted = false;
let refreshTimer: number | null = null;

export type ChatEmoteChoice = {
  name: string;
  url: string;
};

export function ensureChatEmotesLoaded(): void {
  if (typeof window === 'undefined') return;
  if (!loadStarted) {
    loadStarted = true;
    void refreshDiscordEmotes();
  }
  if (refreshTimer === null) {
    refreshTimer = window.setInterval(() => void refreshDiscordEmotes(), DISCORD_EMOTE_REFRESH_MS);
  }
}

export function getChatEmoteCompletions(query: string, limit: number = 8): ChatEmoteChoice[] {
  const normalized = query.trim().toLowerCase();
  const matches = [...discordEmotesByName.values()]
    .filter((emoji) => {
      if (!normalized) return true;
      return emoji.name.toLowerCase().includes(normalized);
    })
    .sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aScore = normalized && !aName.startsWith(normalized) ? 1 : 0;
      const bScore = normalized && !bName.startsWith(normalized) ? 1 : 0;
      if (aScore !== bScore) return aScore - bScore;
      return aName.localeCompare(bName);
    })
    .slice(0, limit);

  return matches.map((emoji) => ({ name: emoji.name, url: emoji.url }));
}

export function onChatEmotesUpdated(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function renderChatText(raw: string): string {
  return escapeHtml(raw).replace(/:([a-z0-9_-]+):/gi, (match, name) => {
    const emoji = discordEmotesByName.get(String(name).toLowerCase());
    if (!emoji) return match;
    const label = escapeHtml(`:${emoji.name}:`);
    return `<img class="chat-inline-emote" src="${escapeHtml(emoji.url)}" alt="${label}" title="${label}" loading="lazy" />`;
  });
}

export function escapeHtml(raw: string): string {
  return raw.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] || char));
}

async function refreshDiscordEmotes(): Promise<void> {
  try {
    const res = await fetch('/api/forums/emojis', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json().catch(() => null) as ForumEmojiResponse | null;
    if (!data || !Array.isArray(data.emojis)) return;
    discordEmotesByName.clear();
    for (const emoji of data.emojis) {
      if (!emoji || typeof emoji.name !== 'string' || typeof emoji.url !== 'string') continue;
      if (emoji.available === false) continue;
      discordEmotesByName.set(emoji.name.toLowerCase(), emoji);
    }
    for (const listener of listeners) listener();
  } catch {
    // Chat should keep working if the forum emoji endpoint is unavailable.
  }
}
