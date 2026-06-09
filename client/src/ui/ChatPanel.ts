import {
  createTextTabButton,
  installUiChromeStyles,
  setToggleButtonActive,
  UI_RED,
} from './uiChrome';
import {
  ensureChatEmotesLoaded,
  escapeHtml,
  getChatEmoteCompletions,
  onChatEmotesUpdated,
  renderChatText,
  type ChatEmoteChoice,
} from '../rendering/chatEmotes';

export type ChatSendCallback = (message: string) => void;
export type ChatPrivateSendCallback = (to: string, message: string) => void;

type ChatTab = 'all' | 'game' | 'public' | 'private';
const MAX_CHAT_MESSAGES = 300;
const CHAT_PLACEHOLDER_STYLE_ID = 'evilquest-chat-placeholder-style';
const MOBILE_CHAT_HINT_QUERY = '(max-width: 760px), (pointer: coarse) and (max-width: 900px), (max-height: 520px) and (max-width: 900px) and (orientation: landscape)';
const PRIVATE_CHAT_COLOR = '#4fdfff';
const CHAT_BOTTOM_STICKY_THRESHOLD = 12;

export class ChatPanel {
  private container: HTMLDivElement;
  private log: HTMLDivElement;
  private input: HTMLInputElement;
  private privatePrefixEl: HTMLButtonElement | null = null;
  private privateClearBtn: HTMLButtonElement | null = null;
  private adminButton: HTMLButtonElement | null = null;
  private emoteMenu: HTMLDivElement | null = null;
  private onSend: ChatSendCallback | null = null;
  private onPrivateSend: ChatPrivateSendCallback | null = null;
  private mobileHintMedia: MediaQueryList | null = null;
  private privateTarget: string | null = null;
  private emoteChoices: ChatEmoteChoice[] = [];
  private emoteChoiceIndex = 0;
  private emoteToken: { start: number; end: number } | null = null;
  private emoteQuery = '';
  private removeEmoteListener: (() => void) | null = null;
  private readonly globalKeydownHandler = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || !this.shouldFocusChatFromGlobalEnter(event)) return;
    event.preventDefault();
    this.input.focus();
  };

  // Chat filtering
  private activeTab: ChatTab = 'all';
  private tabButtons: HTMLButtonElement[] = [];
  private messages: { el: HTMLDivElement; type: 'game' | 'public' | 'private' }[] = [];

  constructor() {
    installUiChromeStyles();
    this.installChatStyles();
    ensureChatEmotesLoaded();
    this.removeEmoteListener = onChatEmotesUpdated(() => this.updateEmoteAutocomplete());
    this.container = this.buildUI();
    this.log = this.container.querySelector('#chat-log') as HTMLDivElement;
    this.input = this.container.querySelector('#chat-input') as HTMLInputElement;
    this.mobileHintMedia = window.matchMedia(MOBILE_CHAT_HINT_QUERY);
    this.updateInputPlaceholder();
    this.mobileHintMedia.addEventListener('change', this.updateInputPlaceholder);
    window.addEventListener('resize', this.updateInputPlaceholder);
    const mount = document.getElementById('ui-chat-inner');
    (mount ?? document.body).appendChild(this.container);

    this.input.addEventListener('keydown', (e) => {
      if (this.handleEmoteAutocompleteKey(e)) {
        e.stopPropagation();
        return;
      }
      if (e.key === 'Enter') {
        const msg = this.input.value.trim();
        if (msg) {
          if (this.privateTarget) this.onPrivateSend?.(this.privateTarget, msg);
          else this.onSend?.(msg);
          this.input.value = '';
        }
        this.input.blur();
      }
      if (e.key === 'Escape') {
        if (this.privateTarget) {
          this.setPrivateTarget(null);
          e.preventDefault();
        }
        this.input.blur();
      }
      e.stopPropagation();
    });
    this.input.addEventListener('input', () => this.updateEmoteAutocomplete());
    this.input.addEventListener('click', () => this.updateEmoteAutocomplete());
    this.input.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
        this.updateEmoteAutocomplete();
      }
    });

    window.addEventListener('keydown', this.globalKeydownHandler, { capture: true });

    this.container.addEventListener('click', () => {
      this.input.focus();
    });
  }

  private readonly updateInputPlaceholder = (): void => {
    const isMobile = this.mobileHintMedia?.matches ?? window.matchMedia(MOBILE_CHAT_HINT_QUERY).matches;
    this.input.placeholder = isMobile ? 'Press here to chat...' : 'Press Enter to chat...';
  };

  private installChatStyles(): void {
    if (document.getElementById(CHAT_PLACEHOLDER_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = CHAT_PLACEHOLDER_STYLE_ID;
    style.textContent = `
      #chat-input::placeholder { color: rgba(216,55,43,0.8); text-shadow: 1px 1px 0 #000; }
      #chat-log img.chat-inline-emote {
        width: 20px;
        height: 20px;
        object-fit: contain;
        vertical-align: -5px;
        margin: 0 1px;
      }
      .chat-bubble-overlay img.chat-inline-emote {
        width: 22px;
        height: 22px;
        object-fit: contain;
        vertical-align: -6px;
        margin: 0 1px;
      }
      #chat-emote-autocomplete {
        position: absolute;
        left: 8px;
        right: 8px;
        bottom: 38px;
        z-index: 40;
        display: none;
        max-height: 162px;
        overflow-y: auto;
        padding: 4px;
        background: rgba(18, 11, 7, 0.96);
        border: 1px solid rgba(255,200,100,0.28);
        border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      }
      #chat-emote-autocomplete button {
        display: flex;
        width: 100%;
        align-items: center;
        gap: 6px;
        border: 0;
        background: transparent;
        color: #f4ded5;
        padding: 4px 6px;
        border-radius: 2px;
        font: 700 12px Arial, Helvetica, sans-serif;
        text-align: left;
        cursor: pointer;
        text-shadow: 1px 1px 0 #000;
      }
      #chat-emote-autocomplete button[data-active="true"],
      #chat-emote-autocomplete button:hover {
        background: rgba(120,80,40,0.34);
        color: #fff4d8;
      }
      #chat-emote-autocomplete img {
        width: 22px;
        height: 22px;
        object-fit: contain;
        flex: 0 0 22px;
      }
    `;
    document.head.appendChild(style);
  }

  private shouldFocusChatFromGlobalEnter(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return false;
    if (document.activeElement === this.input) return false;
    const gameFrame = document.getElementById('game-frame');
    if (gameFrame) {
      const frameStyle = window.getComputedStyle(gameFrame);
      if (frameStyle.display === 'none' || frameStyle.visibility === 'hidden') return false;
    }
    if (this.hasVisibleBlockingPanel()) return false;

    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) {
      const tag = active.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable) return false;
      if (active.closest('[role="dialog"], .modal, #login-screen')) return false;
      if (this.isFocusedInteractiveControl(active, tag)) return false;
    }

    return true;
  }

  private isFocusedInteractiveControl(active: HTMLElement, tag: string): boolean {
    if (tag === 'button' || tag === 'a' || tag === 'summary') return true;
    const role = active.getAttribute('role')?.toLowerCase();
    if (role && ['button', 'link', 'menuitem', 'option', 'radio', 'checkbox', 'tab', 'slider', 'spinbutton'].includes(role)) {
      return true;
    }
    return active.id !== 'game-canvas' && active.tabIndex >= 0;
  }

  private hasVisibleBlockingPanel(): boolean {
    const selectors = [
      '#dialogue-panel',
      '#quantity-input-panel',
      '#bank-panel',
      '#smithing-panel',
      '#shop-panel',
      '#spellbook-panel',
      '#trade-panel',
      '#duel-panel',
      '#character-creator',
      '#admin-panel',
      '#login-screen',
      '[role="dialog"]',
      '.modal',
    ];
    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        if (el === this.container || this.container.contains(el)) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (el.getClientRects().length === 0) continue;
        return true;
      }
    }
    return false;
  }

  private buildUI(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'chat-panel';
    panel.style.cssText = `
      width: 100%; height: 100%;
      background: transparent;
      display: flex; flex-direction: column;
      font-family: Arial, Helvetica, sans-serif; font-size: 12px;
      position: relative;
    `;

    // Tab bar — sits on the stone, no separate background
    const tabBar = document.createElement('div');
    tabBar.style.cssText = `
      display: flex; gap: 8px; padding: 2px 8px;
      border-bottom: 1px solid rgba(0,0,0,0.3);
      flex-shrink: 0;
    `;

    const tabs: { key: ChatTab; label: string }[] = [
      { key: 'all', label: 'All' },
      { key: 'game', label: 'Game' },
      { key: 'public', label: 'Public' },
      { key: 'private', label: 'Private' },
    ];

    for (const tab of tabs) {
      const btn = createTextTabButton(tab.label, () => this.switchTab(tab.key));
      btn.dataset.tab = tab.key;
      tabBar.appendChild(btn);
      this.tabButtons.push(btn);
    }

    this.adminButton = createTextTabButton('Admin', () => {});
    this.adminButton.style.display = 'none';
    this.adminButton.title = 'Admin';
    this.adminButton.setAttribute('aria-label', 'Open admin panel');
    tabBar.appendChild(this.adminButton);

    panel.appendChild(tabBar);

    // Chat log
    const log = document.createElement('div');
    log.id = 'chat-log';
    log.style.cssText = `
      flex: 1; overflow-y: auto; padding: 6px 10px;
      color: #d8372b; line-height: 1.6;
      font-size: 13px; font-weight: bold;
      text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
      background:
        linear-gradient(rgba(38, 26, 18, 0.18), rgba(38, 26, 18, 0.18)),
        url('/ui/parchment.png') repeat;
      box-shadow: inset 0 3px 9px rgba(0,0,0,0.43), inset 0 -3px 9px rgba(0,0,0,0.28),
                  2px 2px 4px rgba(0,0,0,0.3);
      border: 2px solid #6f6248;
      border-radius: 6px;
      margin: 3px 8px;
    `;
    panel.appendChild(log);

    // Input
    const inputBar = document.createElement('div');
    inputBar.style.cssText = `
      border-top: 1px solid rgba(0,0,0,0.3); padding: 3px 6px;
      display: flex; align-items: center;
      flex-shrink: 0;
      gap: 5px;
    `;

    this.privatePrefixEl = document.createElement('button');
    this.privatePrefixEl.type = 'button';
    this.privatePrefixEl.style.cssText = `
      display:none;
      flex:0 1 auto;
      max-width:44%;
      min-width:0;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
      background:rgba(0,40,52,0.72);
      border:1px solid rgba(79,223,255,0.45);
      color:${PRIVATE_CHAT_COLOR};
      border-radius:2px;
      padding:5px 7px;
      font:700 12px Arial, Helvetica, sans-serif;
      text-shadow:1px 1px 0 #000;
      cursor:pointer;
    `;
    this.privatePrefixEl.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.input.focus();
    });

    this.privateClearBtn = document.createElement('button');
    this.privateClearBtn.type = 'button';
    this.privateClearBtn.textContent = 'X';
    this.privateClearBtn.title = 'Clear private chat target';
    this.privateClearBtn.setAttribute('aria-label', 'Clear private chat target');
    this.privateClearBtn.style.cssText = `
      display:none;
      flex:0 0 24px;
      width:24px;
      height:28px;
      padding:0;
      background:rgba(43,10,8,0.82);
      border:1px solid rgba(216,55,43,0.55);
      color:#f4ded5;
      border-radius:2px;
      font:700 11px Arial, Helvetica, sans-serif;
      cursor:pointer;
      text-shadow:1px 1px 0 #000;
    `;
    this.privateClearBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.setPrivateTarget(null);
      this.input.focus();
    });
    inputBar.appendChild(this.privateClearBtn);
    inputBar.appendChild(this.privatePrefixEl);

    const input = document.createElement('input');
    input.id = 'chat-input';
    input.type = 'text';
    input.placeholder = 'Press Enter to chat...';
    input.maxLength = 200;
    input.style.cssText = `
      flex: 1; background: rgba(0,0,0,0.5);
      border: 1px solid rgba(255,200,100,0.2); color: #d8372b;
      font-family: Arial, Helvetica, sans-serif; font-size: 13px;
      font-weight: bold;
      padding: 5px 8px; outline: none;
      border-radius: 2px;
      text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
    `;

    inputBar.appendChild(input);
    panel.appendChild(inputBar);

    this.emoteMenu = document.createElement('div');
    this.emoteMenu.id = 'chat-emote-autocomplete';
    this.emoteMenu.setAttribute('role', 'listbox');
    this.emoteMenu.setAttribute('aria-label', 'Emoji autocomplete');
    panel.appendChild(this.emoteMenu);

    const collapseButton = document.createElement('button');
    collapseButton.id = 'chat-collapse-button';
    collapseButton.type = 'button';
    collapseButton.textContent = '<';
    collapseButton.title = 'Slide chat closed';
    collapseButton.setAttribute('aria-label', 'Slide chat closed');
    collapseButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const frame = document.getElementById('game-frame');
      const collapsed = frame?.classList.toggle('mobile-chat-collapsed') ?? false;
      collapseButton.textContent = collapsed ? '>' : '<';
      collapseButton.title = collapsed ? 'Open chat' : 'Slide chat closed';
      collapseButton.setAttribute('aria-label', collapsed ? 'Open chat' : 'Slide chat closed');
    });
    panel.appendChild(collapseButton);

    // Set initial tab
    this.switchTab('all');

    return panel;
  }

  private switchTab(tab: ChatTab): void {
    this.activeTab = tab;
    for (const btn of this.tabButtons) {
      setToggleButtonActive(btn, btn.dataset.tab === tab);
    }
    // Filter messages
    for (const msg of this.messages) {
      if (tab === 'all') {
        msg.el.style.display = '';
      } else {
        msg.el.style.display = msg.type === tab ? '' : 'none';
      }
    }
  }

  private handleEmoteAutocompleteKey(event: KeyboardEvent): boolean {
    if (!this.isEmoteMenuOpen()) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.emoteChoiceIndex = (this.emoteChoiceIndex + 1) % this.emoteChoices.length;
      this.renderEmoteAutocomplete();
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.emoteChoiceIndex = (this.emoteChoiceIndex - 1 + this.emoteChoices.length) % this.emoteChoices.length;
      this.renderEmoteAutocomplete();
      return true;
    }
    if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      this.insertEmoteChoice(this.emoteChoices[this.emoteChoiceIndex]);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.hideEmoteAutocomplete();
      return true;
    }
    return false;
  }

  private updateEmoteAutocomplete(): void {
    if (!this.input || document.activeElement !== this.input) return;
    const token = this.currentEmoteToken();
    if (!token) {
      this.hideEmoteAutocomplete();
      return;
    }
    const choices = getChatEmoteCompletions(token.query, 8);
    if (choices.length === 0) {
      this.hideEmoteAutocomplete();
      return;
    }
    if (!this.emoteToken || this.emoteToken.start !== token.start || this.emoteQuery !== token.query) {
      this.emoteChoiceIndex = 0;
    }
    this.emoteToken = { start: token.start, end: token.end };
    this.emoteQuery = token.query;
    this.emoteChoices = choices;
    this.emoteChoiceIndex = Math.min(this.emoteChoiceIndex, choices.length - 1);
    this.renderEmoteAutocomplete();
  }

  private currentEmoteToken(): { start: number; end: number; query: string } | null {
    const caret = this.input.selectionStart ?? this.input.value.length;
    if (caret !== (this.input.selectionEnd ?? caret)) return null;
    const beforeCaret = this.input.value.slice(0, caret);
    const match = /(^|\s):([a-z0-9_-]{0,32})$/i.exec(beforeCaret);
    if (!match) return null;
    const query = match[2] ?? '';
    const start = caret - query.length - 1;
    return { start, end: caret, query };
  }

  private renderEmoteAutocomplete(): void {
    if (!this.emoteMenu) return;
    this.emoteMenu.replaceChildren();
    for (let i = 0; i < this.emoteChoices.length; i++) {
      const choice = this.emoteChoices[i];
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.dataset.active = i === this.emoteChoiceIndex ? 'true' : 'false';
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.insertEmoteChoice(choice);
      });

      const img = document.createElement('img');
      img.src = choice.url;
      img.alt = `:${choice.name}:`;
      img.loading = 'lazy';
      button.appendChild(img);

      const label = document.createElement('span');
      label.textContent = `:${choice.name}:`;
      button.appendChild(label);

      this.emoteMenu.appendChild(button);
    }
    this.emoteMenu.style.display = 'block';
  }

  private insertEmoteChoice(choice: ChatEmoteChoice | undefined): void {
    if (!choice || !this.emoteToken) return;
    const value = this.input.value;
    const before = value.slice(0, this.emoteToken.start);
    const after = value.slice(this.emoteToken.end);
    const shortcode = `:${choice.name}:`;
    const suffix = after.length === 0 ? ' ' : (/^\s/.test(after) ? '' : ' ');
    this.input.value = `${before}${shortcode}${suffix}${after}`;
    const caret = before.length + shortcode.length + suffix.length;
    this.input.setSelectionRange(caret, caret);
    this.hideEmoteAutocomplete();
    this.input.focus();
  }

  private hideEmoteAutocomplete(): void {
    this.emoteChoices = [];
    this.emoteChoiceIndex = 0;
    this.emoteToken = null;
    this.emoteQuery = '';
    if (this.emoteMenu) {
      this.emoteMenu.style.display = 'none';
      this.emoteMenu.replaceChildren();
    }
  }

  private isEmoteMenuOpen(): boolean {
    return !!this.emoteMenu && this.emoteMenu.style.display !== 'none' && this.emoteChoices.length > 0;
  }

  addMessage(from: string, message: string, color: string = '#fff'): void {
    const el = document.createElement('div');
    el.innerHTML = `<span style="color: ${color}; font-weight: bold;">${escapeHtml(from)}:</span> <span style="color: #fff;">${renderChatText(message)}</span>`;
    this.appendMessage(el, 'public');
  }

  addPrivateMessage(label: string, message: string, replyTarget: string | null = null): void {
    const el = document.createElement('div');
    el.style.color = PRIVATE_CHAT_COLOR;
    el.innerHTML = `<span style="font-weight: bold;">${escapeHtml(label)}:</span> ${renderChatText(message)}`;
    if (replyTarget) {
      el.title = `Send private message to ${replyTarget}`;
      el.style.cursor = 'pointer';
      el.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setPrivateTarget(replyTarget);
      });
    }
    this.appendMessage(el, 'private');
  }

  addSystemMessage(message: string, color: string = UI_RED): void {
    const el = document.createElement('div');
    el.innerHTML = `<span style="color: ${color};">${escapeHtml(message)}</span>`;
    this.appendMessage(el, 'game');
  }

  addTradeRequestMessage(from: string, onAccept: () => void, onTradeBack: () => void): void {
    const el = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = `${from} sent you a trade request. `;
    label.style.color = UI_RED;
    el.appendChild(label);

    const accept = this.makeInlineAction('Accept', () => {
      onAccept();
      accept.style.pointerEvents = 'none';
      accept.style.opacity = '0.6';
    });
    el.appendChild(accept);

    const divider = document.createElement('span');
    divider.textContent = ' or ';
    divider.style.color = UI_RED;
    el.appendChild(divider);

    el.appendChild(this.makeInlineAction('trade them back', onTradeBack));
    this.appendMessage(el, 'game');
  }

  addDuelRequestMessage(from: string, onAccept: () => void, onDuelBack: () => void): void {
    const el = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = `${from} sent you a duel request. `;
    label.style.color = UI_RED;
    el.appendChild(label);

    const accept = this.makeInlineAction('Accept', () => {
      onAccept();
      accept.style.pointerEvents = 'none';
      accept.style.opacity = '0.6';
    });
    el.appendChild(accept);

    const divider = document.createElement('span');
    divider.textContent = ' or ';
    divider.style.color = UI_RED;
    el.appendChild(divider);

    el.appendChild(this.makeInlineAction('duel them back', onDuelBack));
    this.appendMessage(el, 'game');
  }

  private makeInlineAction(label: string, action: () => void): HTMLSpanElement {
    const el = document.createElement('span');
    el.textContent = label;
    el.style.cssText = `
      color: #f4ded5;
      text-decoration: underline;
      cursor: pointer;
    `;
    el.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    el.addEventListener('mouseenter', () => { el.style.color = '#fff4d8'; });
    el.addEventListener('mouseleave', () => { el.style.color = '#f4ded5'; });
    return el;
  }

  private appendMessage(el: HTMLDivElement, type: 'game' | 'public' | 'private'): void {
    if (this.activeTab !== 'all' && this.activeTab !== type) el.style.display = 'none';
    const shouldStickToBottom = this.isScrolledToChatBottom();
    this.log.appendChild(el);
    this.messages.push({ el, type });
    while (this.messages.length > MAX_CHAT_MESSAGES) {
      const old = this.messages.shift();
      old?.el.remove();
    }
    if (shouldStickToBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  private isScrolledToChatBottom(): boolean {
    return this.log.scrollHeight - this.log.clientHeight - this.log.scrollTop <= CHAT_BOTTOM_STICKY_THRESHOLD;
  }

  setSendHandler(handler: ChatSendCallback): void {
    this.onSend = handler;
  }

  setPrivateSendHandler(handler: ChatPrivateSendCallback): void {
    this.onPrivateSend = handler;
  }

  setAdminControls(enabled: boolean, onOpen: () => void): void {
    if (!this.adminButton) return;
    this.adminButton.style.display = enabled ? '' : 'none';
    this.adminButton.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      onOpen();
    };
  }

  setPrivateTarget(username: string | null): void {
    const target = username?.trim() || null;
    this.privateTarget = target;
    if (this.privatePrefixEl) {
      this.privatePrefixEl.textContent = target ? `Send to ${target}:` : '';
      this.privatePrefixEl.style.display = target ? 'block' : 'none';
      this.privatePrefixEl.title = target ? `Private message target: ${target}` : '';
    }
    if (this.privateClearBtn) {
      this.privateClearBtn.style.display = target ? 'block' : 'none';
    }
    if (target) this.input.focus();
  }

  destroy(): void {
    this.removeEmoteListener?.();
    this.removeEmoteListener = null;
    this.mobileHintMedia?.removeEventListener('change', this.updateInputPlaceholder);
    window.removeEventListener('resize', this.updateInputPlaceholder);
    window.removeEventListener('keydown', this.globalKeydownHandler, true);
    this.container.remove();
  }
}
