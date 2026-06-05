'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { FaBell, FaBold, FaCog, FaEdit, FaExchangeAlt, FaEye, FaEyeSlash, FaFlag, FaGrin, FaHome, FaImage, FaItalic, FaLink, FaListUl, FaLock, FaPen, FaQuoteRight, FaReply, FaShieldAlt, FaThumbtack, FaTrashAlt, FaTrophy, FaUnlock, FaUser, FaUsers } from 'react-icons/fa';
import { useAutoCloseMenu } from '../useAutoCloseMenu';

const TOKEN_KEY = 'evilquest_token';
const AUTH_CHANGED_EVENT = 'evilquest-auth-changed';
const PROFILE_BIO_LIMIT = 500;
const PROFILE_SIGNATURE_LIMIT = 240;
const EMOJI: Record<string, string> = {
  smile: '🙂',
  laughing: '😂',
  heart: '❤️',
  skull: '💀',
  fire: '🔥',
  sword: '⚔️',
  'thumbs-up': '👍',
  'thumbs-down': '👎',
};

type ForumDiscordEmoji = { id: string; guildId: string; name: string; animated: boolean; available: boolean; url: string; updatedAt: number };
type ForumUser = { ok?: boolean; accountId?: number; username?: string; isAdmin?: boolean; isModerator?: boolean };
type ForumOnlineUser = { accountId: number; username: string; avatarUrl: string; combatLevel: number | null; isAdmin: boolean; isRoleModerator?: boolean; lastSeenAt: number };
type ForumCategory = {
  id: number;
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
  isHidden: boolean;
  isLocked: boolean;
  staffOnlyWrite: boolean;
  threadCount: number;
  postCount: number;
  latestThread: ForumThread | null;
};
type ForumThread = {
  id: number;
  categoryId: number;
  categorySlug: string;
  categoryName: string;
  slug: string;
  title: string;
  author: { accountId: number; username: string };
  createdAt: number;
  updatedAt: number;
  lastPostAt: number;
  lastPostBy: string;
  replyCount: number;
  viewCount: number;
  isPinned: boolean;
  isLocked: boolean;
  isHidden: boolean;
  isDeleted: boolean;
};
type ForumPost = {
  id: number;
  threadId: number;
  author: { accountId: number; username: string; avatarUrl: string; combatLevel: number | null; isAdmin: boolean; isRoleModerator?: boolean; signature: string };
  replyTo: { id: number; author: { accountId: number; username: string }; body: string; createdAt: number } | null;
  body: string;
  createdAt: number;
  updatedAt: number;
  editedAt: number | null;
  isHidden: boolean;
  isDeleted: boolean;
  hiddenReason: string;
  reactions: Record<string, number>;
  reactionUsers?: Record<string, ForumReactionUsers>;
  myReaction: string | null;
};
type ForumReactionUsers = { names: string[]; others: number };
type ReactionBurst = { id: number; reaction: string; delta: 1 | -1 };
type ForumListResponse = {
  categories: ForumCategory[];
  threads: ForumThread[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalThreads: number;
};
type ForumThreadDetail = {
  thread: ForumThread;
  category: ForumCategory;
  posts: ForumPost[];
  page: number;
  pageSize: number;
  totalPosts: number;
  totalPages: number;
};
type ForumProfile = {
  accountId: number;
  username: string;
  createdAt: number;
  avatarUrl: string;
  bio: string;
  title: string;
  signature: string;
  postCount: number;
  threadCount: number;
  isModerator: boolean;
  isRoleModerator?: boolean;
  isAdmin: boolean;
  combatLevel: number | null;
  topSkills: Array<{ id: string; name: string; level: number; xp: number }>;
  recentThreads: ForumThread[];
  recentPosts: Array<{ id: number; threadId: number; threadTitle: string; threadSlug: string; createdAt: number }>;
};
type ForumReport = {
  id: number;
  postId: number;
  threadId: number;
  threadTitle: string;
  reason: string;
  status: string;
  reporter: { accountId: number; username: string };
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
};
type ForumMedia = { id: number; url: string };
type PendingMediaInsert = { start: number; end: number; alt: string };
type EmojiChoice = { name: string; label: string; icon: string; url?: string; source: 'local' | 'discord' };
type ForumEmojiResponse = {
  emojis: ForumDiscordEmoji[];
  discord?: { enabled: boolean; guildId: string; lastSyncAt: number | null; lastError: string | null };
};
type ForumNotification = {
  id: number;
  type: string;
  createdAt: number;
  readAt: number | null;
  actor: { accountId: number; username: string };
  thread: { id: number; categorySlug: string; slug: string; title: string };
  postId: number;
  postPage: number;
  sourcePostId: number | null;
};

let discordEmojiByName: Record<string, ForumDiscordEmoji> = {};
let discordEmojiList: ForumDiscordEmoji[] = [];
let discordEmojiNotice = '';

function token(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(TOKEN_KEY) || '';
}

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  const saved = token();
  if (saved) headers.set('Authorization', `Bearer ${saved}`);
  if (opts.body && !(opts.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin', cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

async function uploadForumFile(file: File): Promise<ForumMedia> {
  const form = new FormData();
  form.set('file', file);
  const data = await api<{ media: ForumMedia }>('/api/forums/upload', { method: 'POST', body: form });
  return data.media;
}

function cacheDiscordEmojis(emojis: ForumDiscordEmoji[], discord?: ForumEmojiResponse['discord']): void {
  discordEmojiList = emojis;
  discordEmojiByName = Object.fromEntries(emojis.map((emoji) => [emoji.name.toLowerCase(), emoji]));
  if (emojis.length > 0) discordEmojiNotice = '';
  else if (discord?.enabled === false) discordEmojiNotice = 'Discord emotes are not configured on this server.';
  else if (discord?.lastError) discordEmojiNotice = `Discord emote sync failed: ${discord.lastError}.`;
  else if (discord?.enabled) discordEmojiNotice = 'Discord emotes are syncing. Try again in a moment.';
  else discordEmojiNotice = '';
}

function fmt(ts: number): string {
  // `undefined` locale + no timeZone => the viewer's own locale and timezone
  // (e.g. a Danish browser renders 24h time in Europe/Copenhagen).
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));
}

function escapeHtml(raw: string): string {
  return raw.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
}

function renderEmojiShortcode(name: string): string {
  const local = EMOJI[name.toLowerCase()];
  if (local) return local;
  const emoji = discordEmojiByName[name.toLowerCase()];
  if (!emoji) return `:${name}:`;
  const label = escapeHtml(`:${emoji.name}:`);
  return `<img class="forum-inline-emoji" src="${escapeHtml(emoji.url)}" alt="${label}" title="${label}" loading="lazy" />`;
}

function renderMarkdown(raw: string): string {
  let text = escapeHtml(raw).replace(/:([a-z0-9_-]+):/gi, (_, name) => renderEmojiShortcode(String(name)));
  text = text.replace(/!\[([^\]]*)]\((https?:\/\/[^\s)]+\.(?:png|jpe?g|webp|gif)|\/forum-media\/[^\s)]+)\)/gi, '<img src="$2" alt="$1" loading="lazy" />');
  text = text.replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+|\/forums\/[^\s)]+|\/forum-media\/[^\s)]+)\)/gi, '<a href="$2" rel="noopener noreferrer nofollow ugc">$1</a>');
  text = text.replace(/(^|[\s>])((https?:\/\/[^\s<"]+\.(?:png|jpe?g|webp|gif))(?:[?#][^\s<"]*)?)/gi, '$1<img src="$2" alt="" loading="lazy" />');
  text = text.replace(/(^|[\s>])((https?:\/\/[^\s<"]+))/gi, '$1<a href="$2" rel="noopener noreferrer nofollow ugc">$2</a>');
  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  return text.split(/\n{2,}/).map((block) => /<\/?(h1|h2|h3|blockquote|img)/.test(block) ? block : `<p>${block.replace(/\n/g, '<br />')}</p>`).join('');
}

function currentRoute() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts[1] === 'category') return { view: 'category', category: parts[2] || '' } as const;
  if (parts[1] === 'thread') return { view: 'thread', category: parts[2] || '', thread: parts[3] || '' } as const;
  if (parts[1] === 'u') return { view: 'profile', username: parts[2] || '' } as const;
  if (parts[1] === 'moderation') return { view: 'moderation' } as const;
  return { view: 'index' } as const;
}

function currentPageParam(): number {
  const page = Number(new URLSearchParams(window.location.search).get('page') ?? 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function previewText(raw: string): string {
  return raw.replace(/[#>*_`![\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function reactionUsersText(summary: ForumReactionUsers | undefined): string {
  if (!summary || summary.names.length === 0) return '';
  const parts = [...summary.names];
  if (summary.others > 0) parts.push(`+ ${summary.others} ${summary.others === 1 ? 'other' : 'others'}`);
  return parts.join(', ');
}

function isImageUrl(url: string): boolean {
  return /^https:\/\/\S+\.(png|jpe?g|webp|gif)([?#]\S*)?$/i.test(url) || url.startsWith('/forum-media/');
}

function mediaMarkdown(url: string, alt: string): string {
  return isImageUrl(url) ? `![${alt || 'image'}](${url})` : `[${alt || url}](${url})`;
}

function MediaUploadModal({ open, alt, onClose, onInsert }: { open: boolean; alt: string; onClose: () => void; onInsert: (markdown: string) => void }) {
  const [url, setUrl] = useState('');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  async function upload(file: File) {
    setError('');
    setUploading(true);
    try {
      const media = await uploadForumFile(file);
      onInsert(mediaMarkdown(media.url, alt || file.name));
      setUrl('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  function insertUrl() {
    const trimmed = url.trim();
    if (!trimmed) return;
    if (!/^https:\/\//i.test(trimmed)) {
      setError('Use a direct https:// URL.');
      return;
    }
    onInsert(mediaMarkdown(trimmed, alt));
    setUrl('');
    onClose();
  }

  return (
    <div className="forum-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="forum-media-modal" role="dialog" aria-modal="true" aria-label="Add media" onClick={(event) => event.stopPropagation()}>
        <h3>Add image, GIF, or URL</h3>
        <div
          className={`forum-dropzone${dragging ? ' is-dragging' : ''}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void upload(file);
          }}
        >
          <FaImage aria-hidden />
          <strong>Drop an image or GIF here</strong>
          <span>PNG, JPEG, WebP, or GIF</span>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void upload(file);
            event.currentTarget.value = '';
          }} />
        </div>
        <div className="forum-media-url-row">
          <input value={url} placeholder="https://example.com/image.gif or page URL" onChange={(event) => setUrl(event.target.value)} />
          <button type="button" onClick={insertUrl}>Insert</button>
        </div>
        {error ? <p className="forum-error">{error}</p> : null}
        <div className="forum-composer-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          {uploading ? <span>Uploading...</span> : null}
        </div>
      </div>
    </div>
  );
}

function forumEmojiChoices(query: string): EmojiChoice[] {
  const search = query.trim().toLowerCase();
  const seen = new Set<string>();
  const choices: EmojiChoice[] = [];
  for (const [name, icon] of Object.entries(EMOJI)) {
    seen.add(name.toLowerCase());
    choices.push({ name, label: `:${name}:`, icon, source: 'local' });
  }
  for (const emoji of discordEmojiList) {
    const key = emoji.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push({ name: emoji.name, label: `:${emoji.name}:`, icon: '', url: emoji.url, source: 'discord' });
  }
  return search ? choices.filter((choice) => choice.name.toLowerCase().includes(search)) : choices;
}

function MarkdownEditor({ value, onChange, rows, placeholder, maxLength }: { value: string; onChange: (value: string) => void; rows: number; placeholder: string; maxLength?: number }) {
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [mediaInsert, setMediaInsert] = useState<PendingMediaInsert | null>(null);
  const [emojiMenuOpen, setEmojiMenuOpen] = useState(false);
  const [emojiSearch, setEmojiSearch] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiMenuRef = useAutoCloseMenu<HTMLDivElement>(emojiMenuOpen, () => setEmojiMenuOpen(false));

  function emit(next: string) {
    onChange(maxLength === undefined ? next : next.slice(0, maxLength));
  }

  function focusSelection(start: number, end: number) {
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(start, end);
    });
  }

  function replaceSelection(before: string, after = '', fallback = 'text') {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || fallback;
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    emit(next);
    focusSelection(start + before.length, start + before.length + selected.length);
  }

  function insertLine(prefix: string, fallback: string) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || fallback;
    const lineStart = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
    const lineEnd = end < value.length && value[end] !== '\n' ? '\n' : '';
    const next = `${value.slice(0, start)}${lineStart}${selected.split('\n').map((line) => `${prefix}${line}`).join('\n')}${lineEnd}${value.slice(end)}`;
    emit(next);
    focusSelection(start + lineStart.length + prefix.length, start + lineStart.length + prefix.length + selected.length);
  }

  function insertAtCursor(markdown: string) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${markdown}${value.slice(end)}`;
    emit(next);
    focusSelection(start + markdown.length, start + markdown.length);
  }

  function insertLink() {
    const url = window.prompt('Link URL');
    if (!url) return;
    replaceSelection('[', `](${url})`, 'link text');
  }

  function insertEmoji(name: string) {
    insertAtCursor(`:${name}:`);
    setEmojiMenuOpen(false);
    setEmojiSearch('');
  }

  function openMediaModal() {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || 'image';
    setMediaInsert({ start, end, alt: selected });
  }

  function insertMedia(markdown: string) {
    const insert = mediaInsert ?? { start: value.length, end: value.length, alt: 'image' };
    const next = `${value.slice(0, insert.start)}${markdown}${value.slice(insert.end)}`;
    emit(next);
    setMediaInsert(null);
    focusSelection(insert.start + markdown.length, insert.start + markdown.length);
  }

  const emojiChoices = forumEmojiChoices(emojiSearch);

  return (
    <div className="forum-markdown-editor">
      <div className="forum-markdown-tabs" role="tablist" aria-label="Markdown editor mode">
        <button type="button" className={mode === 'write' ? 'active' : ''} onClick={() => setMode('write')}><FaPen aria-hidden />Write</button>
        <button type="button" className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}><FaEye aria-hidden />Preview</button>
      </div>
      {mode === 'write' ? (
        <>
          <div className="forum-markdown-toolbar" aria-label="Formatting options">
            <button type="button" title="Bold" onClick={() => replaceSelection('**', '**', 'bold text')}><FaBold aria-hidden /></button>
            <button type="button" title="Italic" onClick={() => replaceSelection('*', '*', 'italic text')}><FaItalic aria-hidden /></button>
            <button type="button" title="Quote" onClick={() => insertLine('> ', 'quoted text')}><FaQuoteRight aria-hidden /></button>
            <button type="button" title="List" onClick={() => insertLine('- ', 'list item')}><FaListUl aria-hidden /></button>
            <button type="button" title="Link" onClick={insertLink}><FaLink aria-hidden /></button>
            <button type="button" title="Image or upload" onClick={openMediaModal}><FaImage aria-hidden /></button>
            <div className="forum-emoji-picker" ref={emojiMenuRef}>
              <button type="button" title="Emoji" aria-haspopup="menu" aria-expanded={emojiMenuOpen} onClick={() => setEmojiMenuOpen((open) => !open)}><FaGrin aria-hidden /></button>
              {emojiMenuOpen ? (
                <div className="forum-emoji-menu" role="menu" aria-label="Forum emoji">
                  <input value={emojiSearch} placeholder="Search emotes" onChange={(event) => setEmojiSearch(event.target.value)} />
                  {discordEmojiNotice ? <p className="forum-emoji-notice">{discordEmojiNotice}</p> : null}
                  <div className="forum-emoji-grid">
                    {emojiChoices.map((choice) => (
                      <button key={`${choice.source}-${choice.name}`} type="button" role="menuitem" title={choice.label} onClick={() => insertEmoji(choice.name)}>
                        {choice.url ? <img src={choice.url} alt="" loading="lazy" /> : <span>{choice.icon}</span>}
                        <small>{choice.name}</small>
                      </button>
                    ))}
                    {emojiChoices.length === 0 ? <p>No emotes found.</p> : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <textarea ref={textareaRef} value={value} rows={rows} maxLength={maxLength} placeholder={placeholder} onChange={(event) => emit(event.target.value)} />
        </>
      ) : (
        <div className="forum-post-body preview" dangerouslySetInnerHTML={{ __html: value ? renderMarkdown(value) : '<p class="forum-preview-empty">Nothing to preview yet.</p>' }} />
      )}
      {maxLength !== undefined ? <div className="forum-markdown-count">{value.length}/{maxLength}</div> : null}
      <MediaUploadModal open={mediaInsert != null} alt={mediaInsert?.alt ?? ''} onClose={() => setMediaInsert(null)} onInsert={insertMedia} />
    </div>
  );
}

function ForumComposer({ categories, defaultCategoryId, showCategorySelect = true, onCreated }: { categories: ForumCategory[]; defaultCategoryId?: number; showCategorySelect?: boolean; onCreated: (thread: ForumThread) => void }) {
  const [categoryId, setCategoryId] = useState(defaultCategoryId ?? categories[0]?.id ?? 0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const data = await api<{ ok: true; thread: ForumThread }>('/api/forums/thread', { method: 'POST', body: JSON.stringify({ categoryId, title, body }) });
      setTitle('');
      setBody('');
      onCreated(data.thread);
      window.history.pushState(null, '', `/forums/thread/${data.thread.categorySlug}/${data.thread.slug}`);
      window.dispatchEvent(new Event('popstate'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create thread.');
    }
  }

  return (
    <form className={`forum-composer${showCategorySelect ? '' : ' forum-composer-single-category'}`} onSubmit={submit}>
      {!showCategorySelect ? <div className="forum-composer-category">Posting in <strong>{categories[0]?.name ?? 'this category'}</strong></div> : null}
      <div className="forum-composer-grid">
        {showCategorySelect ? (
          <select value={categoryId} onChange={(event) => setCategoryId(Number(event.target.value))}>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        ) : null}
        <input value={title} maxLength={120} placeholder="Thread title" onChange={(event) => setTitle(event.target.value)} />
      </div>
      <MarkdownEditor value={body} onChange={setBody} rows={7} placeholder="Write in Markdown. Images: ![alt](url), emoji: :fire:" />
      <div className="forum-composer-actions">
        <button type="submit" className="button">Post Thread</button>
      </div>
      {error ? <p className="forum-error">{error}</p> : null}
    </form>
  );
}

function ThreadList({ threads }: { threads: ForumThread[] }) {
  if (threads.length === 0) return <p className="forum-empty">No threads yet.</p>;
  return (
    <ol className="forum-thread-list">
      {threads.map((thread) => (
        <li key={thread.id} className={thread.isHidden ? 'is-hidden' : ''}>
          <div className="forum-thread-main">
            <a href={`/forums/thread/${thread.categorySlug}/${thread.slug}`}>
              {thread.isPinned ? <span className="forum-pill">Pinned</span> : null}
              {thread.isLocked ? <span className="forum-pill">Locked</span> : null}
              {thread.isHidden ? <span className="forum-pill">Hidden</span> : null}
              <strong>{thread.title}</strong>
            </a>
            <span>by <a href={`/forums/u/${thread.author.username}`}>{thread.author.username}</a> in <a href={`/forums/category/${thread.categorySlug}`}>{thread.categoryName}</a></span>
          </div>
          <div className="forum-thread-side">
            <strong>{thread.replyCount} replies · {thread.viewCount} views</strong>
            <span>{fmt(thread.lastPostAt)} by {thread.lastPostBy}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (page: number) => void }) {
  if (totalPages <= 1) return null;
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1).filter((candidate) => (
    candidate === 1 || candidate === totalPages || Math.abs(candidate - page) <= 2
  ));
  return (
    <nav className="forum-pagination" aria-label="Forum pages">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      {pages.map((candidate, index) => (
        <button key={candidate} type="button" className={candidate === page ? 'active' : ''} onClick={() => onPage(candidate)}>
          {index > 0 && candidate - pages[index - 1] > 1 ? '...' : null}{candidate}
        </button>
      ))}
      <button type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</button>
    </nav>
  );
}

function NotificationsMenu({ notifications, unreadCount, onRefresh }: { notifications: ForumNotification[]; unreadCount: number; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useAutoCloseMenu<HTMLDivElement>(open, () => setOpen(false));
  async function markRead(notificationId?: number) {
    await api('/api/forums/notifications/read', { method: 'POST', body: JSON.stringify({ notificationId }) });
    onRefresh();
  }
  return (
    <div className="forum-notifications" ref={menuRef}>
      <button type="button" className="auth-topbar-link forum-nav-link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <FaBell aria-hidden />Notifications{unreadCount > 0 ? <span>{unreadCount}</span> : null}
      </button>
      {open ? (
        <div className="forum-notifications-menu" role="dialog" aria-label="Notifications">
          <div className="forum-notifications-head">
            <strong>Notifications</strong>
            {unreadCount > 0 ? <button type="button" onClick={() => void markRead()}>Mark all read</button> : null}
          </div>
          {notifications.length === 0 ? <p>No notifications yet.</p> : notifications.map((notification) => (
            <a
              key={notification.id}
              className={notification.readAt == null ? 'unread' : ''}
              href={`/forums/thread/${notification.thread.categorySlug}/${notification.thread.slug}?page=${notification.postPage}#post-${notification.postId}`}
              onClick={() => void markRead(notification.id)}
            >
              <span>{notification.actor.username} {notification.type === 'quote_reply' ? 'quoted you' : 'replied'} in {notification.thread.title}</span>
              <small>{fmt(notification.createdAt)}</small>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReactionChip({
  reactionKey,
  icon,
  count,
  active,
  users,
  burst,
  onReact,
  disabled,
}: {
  reactionKey: string;
  icon: string;
  count: number;
  active: boolean;
  users?: ForumReactionUsers;
  burst: ReactionBurst | null;
  onReact?: (reaction: string) => void;
  disabled?: boolean;
}) {
  const usersText = reactionUsersText(users);
  const label = usersText ? `${icon} ${count}: ${usersText}` : `React ${icon} ${count}`;
  const content = (
    <>
      {icon} {count}
      {usersText ? <span className="forum-reaction-tooltip" role="tooltip">{usersText}</span> : null}
      {burst?.reaction === reactionKey ? (
        <span key={burst.id} className={burst.delta > 0 ? 'forum-reaction-burst positive' : 'forum-reaction-burst negative'}>
          {burst.delta > 0 ? '+1' : '-1'}
        </span>
      ) : null}
    </>
  );

  if (onReact) {
    return (
      <button
        type="button"
        className={active ? 'forum-reaction-chip active' : 'forum-reaction-chip'}
        aria-label={label}
        disabled={disabled}
        onClick={() => onReact(reactionKey)}
      >
        {content}
      </button>
    );
  }

  return (
    <span
      className={active ? 'forum-reaction-chip active' : 'forum-reaction-chip'}
      tabIndex={usersText ? 0 : undefined}
      aria-label={usersText ? label : undefined}
    >
      {content}
    </span>
  );
}

function PostCard({ post, me, onRefresh, onQuote, canReply }: { post: ForumPost; me: ForumUser; onRefresh: () => void; onQuote: (post: ForumPost) => void; canReply: boolean }) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactionMenuOpen, setReactionMenuOpen] = useState(false);
  const [reactionBurst, setReactionBurst] = useState<ReactionBurst | null>(null);
  const [pendingReaction, setPendingReaction] = useState<string | null>(null);
  const [body, setBody] = useState(post.body);
  const reactionsMenuRef = useAutoCloseMenu<HTMLDivElement>(reactionMenuOpen, () => setReactionMenuOpen(false));
  const optionsMenuRef = useAutoCloseMenu<HTMLDivElement>(menuOpen, () => setMenuOpen(false));
  const canEdit = me.accountId === post.author.accountId || me.isModerator || me.isAdmin;
  const canManage = canEdit || me.isModerator || me.isAdmin || me.ok;
  const reactions = Object.entries(EMOJI);

  function toggleReactionMenu() {
    setReactionMenuOpen((open) => {
      const next = !open;
      if (next) setMenuOpen(false);
      return next;
    });
  }

  function toggleOptionsMenu() {
    setMenuOpen((open) => {
      const next = !open;
      if (next) setReactionMenuOpen(false);
      return next;
    });
  }

  async function react(reaction: string) {
    if (pendingReaction) return;
    const delta = post.myReaction === reaction ? -1 : 1;
    setPendingReaction(reaction);
    try {
      await api('/api/forums/reaction', { method: 'POST', body: JSON.stringify({ postId: post.id, reaction }) });
      const id = Date.now();
      setReactionBurst({ id, reaction, delta });
      window.setTimeout(() => setReactionBurst((current) => current?.id === id ? null : current), 900);
      setReactionMenuOpen(false);
      onRefresh();
    } finally {
      setPendingReaction(null);
    }
  }

  async function save() {
    await api('/api/forums/post/edit', { method: 'POST', body: JSON.stringify({ postId: post.id, body }) });
    setEditing(false);
    onRefresh();
  }

  async function hide() {
    await api('/api/forums/moderate/post', { method: 'POST', body: JSON.stringify({ postId: post.id, action: post.isHidden ? 'restore' : 'hide', reason: 'Moderated' }) });
    setMenuOpen(false);
    onRefresh();
  }

  async function remove() {
    if (!window.confirm('Delete this post?')) return;
    await api('/api/forums/post/delete', { method: 'POST', body: JSON.stringify({ postId: post.id }) });
    setMenuOpen(false);
    onRefresh();
  }

  async function report() {
    await api('/api/forums/report', { method: 'POST', body: JSON.stringify({ postId: post.id, reason: 'Needs review' }) });
    setMenuOpen(false);
  }

  return (
    <article id={`post-${post.id}`} className={`forum-post${post.isHidden ? ' is-hidden' : ''}`}>
      <aside>
        <ForumAvatarImage
          url={post.author.avatarUrl}
          alt={`${post.author.username} avatar`}
          imgClassName="forum-post-avatar"
          fallbackClassName="forum-post-avatar forum-post-avatar-empty"
          fallback="?"
        />
        <a className={roleNameClass(post.author)} href={`/forums/u/${post.author.username}`}>{post.author.username}</a>
        {post.author.combatLevel != null ? <span className="forum-post-combat">Combat Lv. {post.author.combatLevel}</span> : null}
        <a href={`#post-${post.id}`}>{fmt(post.createdAt)}</a>
        {post.editedAt ? <span className="forum-post-edited">Edited {fmt(post.editedAt)}</span> : null}
      </aside>
      <div>
        {editing ? (
          <>
            <MarkdownEditor value={body} onChange={setBody} rows={8} placeholder="Edit with Markdown..." />
            <div className="forum-composer-actions">
              <button className="auth-topbar-button" type="button" onClick={() => void save()}>Save</button>
              <button className="auth-topbar-button" type="button" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            {post.replyTo ? (
              <div className="forum-quoted-post">
                <div className="forum-quoted-post-head">
                  <strong>{post.replyTo.author.username}</strong>
                  <span>{post.replyTo.createdAt ? fmt(post.replyTo.createdAt) : 'Earlier post'}</span>
                  <a href={`#post-${post.replyTo.id}`}>View</a>
                </div>
                <p>{previewText(post.replyTo.body)}</p>
              </div>
            ) : null}
            <div className="forum-post-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(post.body) }} />
            {post.author.signature ? (
              <CollapsibleSignature signature={post.author.signature} />
            ) : null}
          </>
        )}
        <div className="forum-post-actions-row">
          <div className="forum-post-actions">
            {reactions.filter(([key]) => (post.reactions[key] ?? 0) > 0 || reactionBurst?.reaction === key).map(([key, icon]) => (
              <ReactionChip
                key={key}
                reactionKey={key}
                icon={icon}
                count={post.reactions[key] ?? 0}
                active={post.myReaction === key}
                users={post.reactionUsers?.[key]}
                burst={reactionBurst}
                onReact={me.ok ? (reaction) => void react(reaction) : undefined}
                disabled={pendingReaction != null}
              />
            ))}
          </div>
          <div className="forum-post-right-actions">
            {me.ok ? (
              <div className="forum-post-menu" ref={reactionsMenuRef}>
                <button type="button" aria-haspopup="menu" aria-expanded={reactionMenuOpen} onClick={toggleReactionMenu}><FaGrin aria-hidden />Reactions</button>
                {reactionMenuOpen ? (
                  <div className="forum-post-menu-list forum-reaction-menu-list" role="menu">
                    {reactions.map(([key, icon]) => (
                      <button key={key} type="button" role="menuitem" className={post.myReaction === key ? 'active' : ''} onClick={() => void react(key)}>
                        <span>{icon}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {canReply ? <button type="button" onClick={() => onQuote(post)}><FaReply aria-hidden />Reply</button> : null}
            {canManage ? (
              <div className="forum-post-menu" ref={optionsMenuRef}>
                <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={toggleOptionsMenu}><FaCog aria-hidden />Options</button>
                {menuOpen ? (
                  <div className="forum-post-menu-list" role="menu">
                    {canEdit ? <button type="button" role="menuitem" onClick={() => { setEditing(true); setMenuOpen(false); }}><FaEdit aria-hidden />Edit</button> : null}
                    {canEdit ? <button type="button" role="menuitem" onClick={() => void remove()}><FaTrashAlt aria-hidden />Delete</button> : null}
                    {me.isModerator || me.isAdmin ? <button type="button" role="menuitem" onClick={() => void hide()}>{post.isHidden ? <FaEye aria-hidden /> : <FaEyeSlash aria-hidden />}{post.isHidden ? 'Restore' : 'Hide'}</button> : null}
                    {me.ok ? <button type="button" role="menuitem" onClick={() => void report()}><FaFlag aria-hidden />Report</button> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

export function ForumsApp() {
  const [route, setRoute] = useState(() => (typeof window === 'undefined' ? { view: 'index' as const } : currentRoute()));
  const [page, setPage] = useState(() => (typeof window === 'undefined' ? 1 : currentPageParam()));
  const [me, setMe] = useState<ForumUser>({});
  const [list, setList] = useState<ForumListResponse | null>(null);
  const [detail, setDetail] = useState<ForumThreadDetail | null>(null);
  const [profile, setProfile] = useState<ForumProfile | null>(null);
  const [reports, setReports] = useState<ForumReport[]>([]);
  const [moderators, setModerators] = useState<Array<{ username: string }>>([]);
  const [notifications, setNotifications] = useState<ForumNotification[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [onlineUsers, setOnlineUsers] = useState<ForumOnlineUser[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('latest');
  const [reply, setReply] = useState('');
  const [replyTo, setReplyTo] = useState<ForumPost | null>(null);
  const [pendingPostId, setPendingPostId] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [moveCategoryId, setMoveCategoryId] = useState(0);
  const [, setEmojiVersion] = useState(0);

  const categories = list?.categories ?? [];
  const canPost = me.ok === true;
  const writableCategories = useMemo(
    () => categories.filter((category) => !category.isLocked && (!category.staffOnlyWrite || me.isModerator || me.isAdmin)),
    [categories, me.isAdmin, me.isModerator],
  );
  const currentCategory = route.view === 'category' ? categories.find((category) => category.slug === route.category) : undefined;
  const currentWritableCategory = currentCategory && writableCategories.some((category) => category.id === currentCategory.id) ? currentCategory : undefined;

  async function loadNotifications() {
    try {
      const data = await api<{ notifications: ForumNotification[]; unreadCount: number }>('/api/forums/notifications');
      setNotifications(data.notifications);
      setUnreadNotifications(data.unreadCount);
    } catch {
      setNotifications([]);
      setUnreadNotifications(0);
    }
  }

  async function loadOnlineUsers() {
    try {
      const data = await api<{ users: ForumOnlineUser[] }>('/api/forums/online');
      setOnlineUsers(data.users);
    } catch {
      setOnlineUsers([]);
    }
  }

  function goToPage(nextPage: number) {
    const params = new URLSearchParams(window.location.search);
    if (nextPage <= 1) params.delete('page');
    else params.set('page', String(nextPage));
    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
    window.history.pushState(null, '', nextUrl);
    setPage(nextPage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function load() {
    setStatus('');
    api<ForumUser>('/api/forums/me').then((user) => { setMe(user); void loadNotifications(); }).catch(() => { setMe({ ok: false }); setNotifications([]); setUnreadNotifications(0); });
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (sort) params.set('sort', sort);
    if (page > 1) params.set('page', String(page));
    if (route.view === 'thread') {
      const data = await api<ForumThreadDetail>(`/api/forums/thread/${route.category}/${route.thread}?${params.toString()}`);
      setDetail(data);
      window.setTimeout(() => {
        const target = pendingPostId ? document.getElementById(`post-${pendingPostId}`) : (window.location.hash ? document.querySelector(window.location.hash) : null);
        target?.scrollIntoView({ block: 'start' });
        if (pendingPostId) setPendingPostId(null);
      }, 0);
      setMoveCategoryId(data.thread.categoryId);
      setList(await api<ForumListResponse>('/api/forums'));
      setProfile(null);
      return;
    }
    if (route.view === 'profile') {
      setProfile(await api<ForumProfile>(`/api/forums/profile/${route.username}`));
      setList(await api<ForumListResponse>('/api/forums'));
      setDetail(null);
      return;
    }
    if (route.view === 'moderation') {
      const data = await api<{ reports: ForumReport[]; moderators: Array<{ username: string }>; categories: ForumCategory[] }>('/api/forums/moderation');
      setReports(data.reports);
      setModerators(data.moderators);
      setList({ categories: data.categories, threads: [], page: 1, pageSize: 20, totalPages: 1, totalThreads: 0 });
      return;
    }
    const path = route.view === 'category' ? `/api/forums/category/${route.category}` : '/api/forums';
    const data = await api<ForumListResponse>(`${path}?${params.toString()}`);
    setList(data);
    setDetail(null);
    setProfile(null);
  }

  useEffect(() => {
    const onPop = () => {
      setRoute(currentRoute());
      setPage(currentPageParam());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => { void load().catch((err) => setStatus(err.message)); }, [route, query, sort, page]);

  useEffect(() => {
    const onAuthChanged = () => {
      void load().catch((err) => setStatus(err.message));
      void loadOnlineUsers();
    };
    window.addEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
  });

  useEffect(() => {
    void loadOnlineUsers();
    const interval = window.setInterval(() => void loadOnlineUsers(), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!me.ok || !me.accountId) return;
    let cancelled = false;
    async function pulse() {
      try {
        await api('/api/forums/presence', { method: 'POST' });
        if (!cancelled) await loadOnlineUsers();
      } catch {
        // Presence should never block forum browsing.
      }
    }
    void pulse();
    const interval = window.setInterval(() => void pulse(), 25_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [me.ok, me.accountId]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    let didScheduleRetry = false;
    async function loadEmojis() {
      try {
        const data = await api<ForumEmojiResponse>('/api/forums/emojis');
        if (cancelled) return;
        cacheDiscordEmojis(data.emojis, data.discord);
        setEmojiVersion((version) => version + 1);
        if (data.emojis.length === 0 && !didScheduleRetry) {
          didScheduleRetry = true;
          retryTimer = window.setTimeout(() => void loadEmojis(), 3_000);
        }
      } catch {
        // Forum text should still render if Discord emoji sync is unavailable.
      }
    }
    void loadEmojis();
    const interval = window.setInterval(() => void loadEmojis(), 5 * 60_000);
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      window.clearInterval(interval);
    };
  }, []);

  async function submitReply(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    const result = await api<{ ok: true; post: ForumPost }>('/api/forums/reply', { method: 'POST', body: JSON.stringify({ threadId: detail.thread.id, body: reply, replyToPostId: replyTo?.id }) });
    setReply('');
    setReplyTo(null);
    setPendingPostId(result.post.id);
    const lastPage = Math.max(1, Math.ceil((detail.totalPosts + 1) / detail.pageSize));
    if (lastPage !== page) goToPage(lastPage);
    else await load();
  }

  async function moderateThread(action: string, categoryId?: number) {
    if (!detail) return;
    await api('/api/forums/moderate/thread', { method: 'POST', body: JSON.stringify({ threadId: detail.thread.id, action, categoryId }) });
    await load();
  }

  return (
    <main className="page forums-page">
      <header className="forums-header">
        <div className="forums-title-block">
          <span className="forums-kicker">EvilQuest</span>
          <h1 className="panel-title">Forums</h1>
        </div>
        <nav className="forums-nav">
          <a className="back-link" href="/">Back to Home</a>
          <div className="forums-nav-actions">
            <a className="auth-topbar-link forum-nav-link" href="/forums"><FaHome aria-hidden />Index</a>
            {me.isModerator || me.isAdmin ? <a className="auth-topbar-link forum-nav-link" href="/forums/moderation"><FaShieldAlt aria-hidden />Moderation</a> : null}
            {me.username ? <a className="auth-topbar-link forum-nav-link" href={`/forums/u/${me.username}`}><FaUser aria-hidden />Profile</a> : null}
            {me.ok ? <NotificationsMenu notifications={notifications} unreadCount={unreadNotifications} onRefresh={() => void loadNotifications()} /> : null}
          </div>
        </nav>
      </header>
      {status ? <p className="forum-error">{status}</p> : null}

      {route.view === 'thread' && detail ? (
        <section className="panel forum-panel">
          <div className="forum-thread-subnav">
            <a href={`/forums/category/${detail.category.slug}`}>{detail.category.name}</a>
            <a className="auth-topbar-link forum-nav-link" href="/forums"><FaHome aria-hidden />Back to Forums</a>
          </div>
          <h2 className="forum-thread-title">{detail.thread.title}</h2>
          {(me.isModerator || me.isAdmin) ? (
            <div className="forum-mod-actions">
              <button onClick={() => void moderateThread(detail.thread.isPinned ? 'unpin' : 'pin')}><FaThumbtack aria-hidden />{detail.thread.isPinned ? 'Unpin' : 'Pin'}</button>
              <button onClick={() => void moderateThread(detail.thread.isLocked ? 'unlock' : 'lock')}>{detail.thread.isLocked ? <FaUnlock aria-hidden /> : <FaLock aria-hidden />}{detail.thread.isLocked ? 'Unlock' : 'Lock'}</button>
              <button onClick={() => void moderateThread(detail.thread.isHidden ? 'restore' : 'hide')}>{detail.thread.isHidden ? <FaEye aria-hidden /> : <FaEyeSlash aria-hidden />}{detail.thread.isHidden ? 'Restore' : 'Hide'}</button>
              <select value={moveCategoryId} onChange={(event) => setMoveCategoryId(Number(event.target.value))}>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
              <button onClick={() => void moderateThread('move', moveCategoryId)}><FaExchangeAlt aria-hidden />Move</button>
            </div>
          ) : null}
          {detail.posts.map((post) => <PostCard key={post.id} post={post} me={me} canReply={canPost && !detail.thread.isLocked} onQuote={(target) => {
            setReplyTo(target);
            setReply((current) => current || '');
            window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('.forum-reply-composer textarea')?.focus(), 0);
          }} onRefresh={() => void load()} />)}
          <Pagination page={detail.page} totalPages={detail.totalPages} onPage={goToPage} />
          {canPost && !detail.thread.isLocked ? (
            <form className="forum-composer forum-reply-composer" onSubmit={submitReply}>
              {replyTo ? (
                <div className="forum-replying-to">
                  <span>Replying to <strong>{replyTo.author.username}</strong>: {previewText(replyTo.body)}</span>
                  <button type="button" onClick={() => setReplyTo(null)}>Cancel</button>
                </div>
              ) : null}
              <MarkdownEditor value={reply} onChange={setReply} rows={6} placeholder="Reply with Markdown..." />
              <div className="forum-reply-actions">
                <button type="submit" className="button">Reply</button>
              </div>
            </form>
          ) : <p className="forum-empty">{detail.thread.isLocked ? 'This thread is locked.' : 'Sign in to reply.'}</p>}
        </section>
      ) : null}

      {route.view === 'profile' && profile ? (
        <section className="panel forum-panel forum-profile">
          <div className="forum-profile-head">
            <ForumAvatarImage
              url={profile.avatarUrl}
              alt={`${profile.username} avatar`}
              fallbackClassName="forum-avatar-fallback"
              fallback={profile.username.slice(0, 1).toUpperCase()}
            />
            <div>
              <h2><span className={profileNameClass(profile)}>{profile.username}</span> {profile.combatLevel != null ? <span className="forum-profile-combat">Combat Lv. {profile.combatLevel}</span> : null}</h2>
              <p>{profile.title || (profile.isAdmin ? 'Administrator' : (profile.isRoleModerator || profile.isModerator) ? 'Moderator' : 'Adventurer')}</p>
              <a className="forum-profile-hiscores-link" href={`/hiscores?player=${encodeURIComponent(profile.username)}`}><FaTrophy aria-hidden />Hiscores Profile</a>
            </div>
          </div>
          {profile.bio ? <div className="forum-profile-bio" dangerouslySetInnerHTML={{ __html: renderMarkdown(profile.bio) }} /> : null}
          <div className="forum-profile-stats">
            <span>{profile.threadCount} threads</span>
            <span>{profile.postCount} posts</span>
          </div>
          {me.username === profile.username ? <ProfileEditor profile={profile} onSaved={() => void load()} /> : null}
          <h3>Recent Threads</h3>
          <ThreadList threads={profile.recentThreads} />
        </section>
      ) : null}

      {route.view === 'moderation' && (me.isModerator || me.isAdmin) ? (
        <section className="panel forum-panel">
          <h2>Moderation</h2>
          <div className="forum-admin-grid">
            <div>
              <h3>Reports</h3>
              {reports.map((report) => (
                <div key={report.id} className="forum-report">
                  <strong>{report.threadTitle}</strong>
                  <p>{report.reason}</p>
                  <span>{report.status} · by {report.reporter.username}</span>
                  {report.status === 'open' ? <button onClick={() => void api('/api/forums/moderate/report', { method: 'POST', body: JSON.stringify({ reportId: report.id }) }).then(load)}>Resolve</button> : null}
                </div>
              ))}
            </div>
            <ModeratorManager me={me} moderators={moderators} onSaved={() => void load()} />
            <CategoryManager categories={categories} onSaved={() => void load()} />
          </div>
        </section>
      ) : null}

      {(route.view === 'index' || route.view === 'category') && list ? (
        <>
          <section className="panel forum-panel">
            <div className="forum-toolbar">
              <input value={query} placeholder="Search forums" onChange={(event) => setQuery(event.target.value)} />
              <select value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="latest">Latest</option>
                <option value="new">Newest</option>
                <option value="top">Top</option>
              </select>
            </div>
            <div className="forum-category-grid">
              {categories.map((category) => (
                <a key={category.id} className="forum-category-card" href={`/forums/category/${category.slug}`}>
                  <strong>{category.name}</strong>
                  <span>{category.description}</span>
                  <small>{category.threadCount} threads · {category.postCount} posts</small>
                </a>
              ))}
            </div>
          </section>
          <section className="panel forum-panel">
            <h2>{route.view === 'category' ? categories.find((c) => c.slug === route.category)?.name ?? 'Category' : 'Latest Threads'}</h2>
            <ThreadList threads={list.threads} />
            <Pagination page={list.page} totalPages={list.totalPages} onPage={goToPage} />
          </section>
          {canPost && (route.view === 'category' ? currentWritableCategory : writableCategories.length > 0) ? (
            <section className="panel forum-panel">
              <h2>Start a Thread</h2>
              <ForumComposer
                categories={route.view === 'category' && currentWritableCategory ? [currentWritableCategory] : writableCategories}
                defaultCategoryId={route.view === 'category' ? currentWritableCategory?.id : undefined}
                showCategorySelect={route.view !== 'category'}
                onCreated={() => void load()}
              />
            </section>
          ) : null}
        </>
      ) : null}
      <ForumOnlineFooter users={onlineUsers} />
    </main>
  );
}

function ForumOnlineFooter({ users }: { users: ForumOnlineUser[] }) {
  return (
    <footer className="forum-online-footer">
      <div className="forum-online-title"><FaUsers aria-hidden />Online on the Forums</div>
      {users.length > 0 ? (
        <div className="forum-online-list">
          {users.map((user) => (
            <a key={user.accountId} className="forum-online-user" href={`/forums/u/${user.username}`}>
              <span className={roleNameClass(user)}>{user.username}</span>
            </a>
          ))}
        </div>
      ) : <p>No signed-in players are browsing the forums right now.</p>}
    </footer>
  );
}

function ForumAvatarImage({ url, alt, imgClassName, fallbackClassName, fallback }: { url: string; alt: string; imgClassName?: string; fallbackClassName: string; fallback: string }) {
  const [failedUrl, setFailedUrl] = useState('');
  const canShow = url && failedUrl !== url;
  if (canShow) return <img className={imgClassName} src={url} alt={alt} onError={() => setFailedUrl(url)} />;
  return <div className={fallbackClassName}>{fallback}</div>;
}

function profileNameClass(profile: Pick<ForumProfile, 'isAdmin' | 'isModerator' | 'isRoleModerator'>): string | undefined {
  return roleNameClass(profile);
}

function roleNameClass(profile: { isAdmin?: boolean; isModerator?: boolean; isRoleModerator?: boolean }): string | undefined {
  if (profile.isAdmin) return 'forum-admin-name';
  if (profile.isRoleModerator || profile.isModerator) return 'forum-moderator-name';
  return undefined;
}

function CollapsibleSignature({ signature }: { signature: string }) {
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    setCanCollapse(content.scrollHeight > 86);
  }, [signature, expanded]);

  return (
    <div className={`forum-post-signature${canCollapse ? ' can-collapse' : ''}${expanded ? ' is-expanded' : ''}`}>
      <div ref={contentRef} className="forum-post-signature-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(signature) }} />
      {canCollapse ? (
        <button type="button" className="forum-signature-toggle" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          {expanded ? 'Hide signature' : 'Show signature'}
        </button>
      ) : null}
    </div>
  );
}

function ProfileEditor({ profile, onSaved }: { profile: ForumProfile; onSaved: () => void }) {
  const [bio, setBio] = useState(profile.bio);
  const [title, setTitle] = useState(profile.title);
  const [signature, setSignature] = useState(profile.signature);
  const [saveStatus, setSaveStatus] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    setSaving(true);
    setSaveStatus('Saving...');
    setSaveError('');
    const payload: { bio: string; title: string; signature: string } = { bio, title, signature };
    try {
      await api('/api/forums/profile', { method: 'POST', body: JSON.stringify(payload) });
      setSaveStatus('Profile saved.');
      onSaved();
    } catch (error) {
      setSaveStatus('');
      setSaveError(error instanceof Error ? error.message : 'Profile could not be saved.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="forum-profile-editor">
      <input value={title} maxLength={40} placeholder="Forum title" onChange={(event) => setTitle(event.target.value)} />
      <div className="forum-profile-markdown-field">
        <span>Profile Bio</span>
        <MarkdownEditor value={bio} onChange={setBio} rows={4} maxLength={PROFILE_BIO_LIMIT} placeholder="Profile bio with Markdown..." />
      </div>
      <div className="forum-profile-markdown-field">
        <span>Signature</span>
        <MarkdownEditor value={signature} onChange={setSignature} rows={4} maxLength={PROFILE_SIGNATURE_LIMIT} placeholder="Forum signature with Markdown..." />
      </div>
      <div className="forum-profile-save-row">
        <button className="button" type="button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving...' : 'Save Profile'}</button>
      </div>
      {saveStatus ? <p className="forum-profile-save-status" role="status">{saveStatus}</p> : null}
      {saveError ? <p className="forum-profile-save-error" role="alert">{saveError}</p> : null}
    </div>
  );
}

function ModeratorManager({ me, moderators, onSaved }: { me: ForumUser; moderators: Array<{ username: string }>; onSaved: () => void }) {
  const [username, setUsername] = useState('');
  if (!me.isAdmin) return <div><h3>Moderators</h3>{moderators.map((mod) => <p key={mod.username}>{mod.username}</p>)}</div>;
  async function setModerator(action: 'grant' | 'revoke') {
    await api('/api/forums/admin/moderator', { method: 'POST', body: JSON.stringify({ username, action }) });
    setUsername('');
    onSaved();
  }
  return (
    <div>
      <h3>Moderators</h3>
      {moderators.map((mod) => <p key={mod.username}>{mod.username}</p>)}
      <input value={username} placeholder="Username" onChange={(event) => setUsername(event.target.value)} />
      <div className="forum-composer-actions">
        <button onClick={() => void setModerator('grant')}>Grant</button>
        <button onClick={() => void setModerator('revoke')}>Revoke</button>
      </div>
    </div>
  );
}

function CategoryManager({ categories, onSaved }: { categories: ForumCategory[]; onSaved: () => void }) {
  const [categoryId, setCategoryId] = useState<string>(categories[0]?.id.toString() ?? 'new');
  const selected = categories.find((category) => category.id.toString() === categoryId);
  const [name, setName] = useState(selected?.name ?? '');
  const [description, setDescription] = useState(selected?.description ?? '');
  const [sortOrder, setSortOrder] = useState(selected?.sortOrder ?? 100);
  const [isHidden, setIsHidden] = useState(selected?.isHidden ?? false);
  const [isLocked, setIsLocked] = useState(selected?.isLocked ?? false);
  const [staffOnlyWrite, setStaffOnlyWrite] = useState(selected?.staffOnlyWrite ?? false);

  useEffect(() => {
    const category = categories.find((item) => item.id.toString() === categoryId);
    setName(category?.name ?? '');
    setDescription(category?.description ?? '');
    setSortOrder(category?.sortOrder ?? 100);
    setIsHidden(category?.isHidden ?? false);
    setIsLocked(category?.isLocked ?? false);
    setStaffOnlyWrite(category?.staffOnlyWrite ?? false);
  }, [categories, categoryId]);

  async function save() {
    await api('/api/forums/moderate/category', {
      method: 'POST',
      body: JSON.stringify({
        categoryId: categoryId === 'new' ? undefined : Number(categoryId),
        name,
        description,
        sortOrder,
        isHidden,
        isLocked,
        staffOnlyWrite,
      }),
    });
    onSaved();
  }

  return (
    <div>
      <h3>Categories</h3>
      <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
        {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        <option value="new">New category</option>
      </select>
      <input value={name} maxLength={60} placeholder="Name" onChange={(event) => setName(event.target.value)} />
      <textarea value={description} rows={3} maxLength={240} placeholder="Description" onChange={(event) => setDescription(event.target.value)} />
      <input type="number" value={sortOrder} onChange={(event) => setSortOrder(Number(event.target.value))} />
      <label><input type="checkbox" checked={isHidden} onChange={(event) => setIsHidden(event.target.checked)} /> Hidden</label>
      <label><input type="checkbox" checked={isLocked} onChange={(event) => setIsLocked(event.target.checked)} /> Locked</label>
      <label><input type="checkbox" checked={staffOnlyWrite} onChange={(event) => setStaffOnlyWrite(event.target.checked)} /> Staff write only</label>
      <button type="button" onClick={() => void save()}>Save Category</button>
    </div>
  );
}
