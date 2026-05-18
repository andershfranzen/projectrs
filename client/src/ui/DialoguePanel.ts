import { ClientOpcode, encodePacket } from '@projectrs/shared';
import type { NetworkManager } from '../managers/NetworkManager';

/** Wire-format dialogue node received via DIALOGUE_OPEN. The server strips
 *  layout + action types — the client only sees what it needs to render. */
export interface DialogueNodePayload {
  sessionId: number;
  speaker: string;
  lines: string[];
  /** Just the labels — the server validates the chosen index against its
   *  own copy of the node, so the client doesn't need actions or next ids. */
  options: { label: string }[];
  /** Transient server-owned line, e.g. banker acknowledgement before opening UI. */
  autoClose?: boolean;
}

export interface DialoguePanelHooks {
  showNpcBubble: (npcEntityId: number, message: string) => void;
  hideNpcBubble: (npcEntityId: number) => void;
  showPlayerBubble: (message: string) => void;
}

/**
 * Dialogue controller.
 *
 * NPC lines render through the same overhead bubble system as player chat.
 * This panel only owns response buttons + keyboard shortcuts for choosing an
 * option, so dialogue no longer appears as a custom bottom overlay.
 */
export class DialoguePanel {
  private container: HTMLDivElement;
  private optionsEl: HTMLDivElement;
  private network: NetworkManager;
  private hooks: DialoguePanelHooks;
  private visible: boolean = false;
  private hiddenChatPanel: HTMLElement | null = null;
  private npcEntityId: number = -1;
  private sessionId: number = 0;
  private currentNode: DialogueNodePayload | null = null;
  private lineIndex: number = 0;
  private keyHandler: (event: KeyboardEvent) => void;
  private npcBubbleTimer: number | null = null;
  private npcReplyDelayTimer: number | null = null;
  private waitingForNpcReply: boolean = false;

  constructor(network: NetworkManager, hooks: DialoguePanelHooks) {
    this.network = network;
    this.hooks = hooks;
    this.keyHandler = (event) => this.handleKeyDown(event);

    this.container = document.createElement('div');
    this.container.style.cssText = `
      width: 100%;
      height: 100%;
      margin: 3px 8px;
      padding: 8px 10px;
      box-sizing: border-box;
      display: none;
      align-items: stretch;
      justify-content: center;
      overflow: hidden;
      user-select: none;
    `;

    this.optionsEl = document.createElement('div');
    this.optionsEl.style.cssText = `
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 6px;
      overflow-y: auto;
    `;

    this.container.appendChild(this.optionsEl);
    window.addEventListener('keydown', this.keyHandler);

    const mount = document.getElementById('ui-chat-inner');
    (mount ?? document.body).appendChild(this.container);
  }

  show(npcEntityId: number, node: DialogueNodePayload): void {
    if (this.npcReplyDelayTimer !== null) {
      window.clearTimeout(this.npcReplyDelayTimer);
      this.npcReplyDelayTimer = null;
    }
    this.npcEntityId = npcEntityId;
    this.sessionId = node.sessionId;
    this.currentNode = node;
    this.lineIndex = 0;
    this.visible = true;
    if (this.waitingForNpcReply) {
      this.waitingForNpcReply = false;
      this.setOptionsVisible(false);
      this.npcReplyDelayTimer = window.setTimeout(() => {
        this.npcReplyDelayTimer = null;
        if (this.visible && this.currentNode === node && this.npcEntityId === npcEntityId) {
          this.render();
        }
      }, 1000);
    } else {
      this.render();
    }
  }

  hide(): void {
    this.visible = false;
    this.waitingForNpcReply = false;
    if (this.npcReplyDelayTimer !== null) {
      window.clearTimeout(this.npcReplyDelayTimer);
      this.npcReplyDelayTimer = null;
    }
    this.clearNpcBubble();
    this.setOptionsVisible(false);
    this.optionsEl.innerHTML = '';
    this.npcEntityId = -1;
    this.sessionId = 0;
    this.currentNode = null;
  }

  closeSession(sessionId: number): void {
    if (sessionId !== 0 && this.sessionId !== sessionId) return;
    this.hide();
  }

  isVisible(): boolean {
    return this.visible;
  }

  private advance(): void {
    if (!this.currentNode) return;
    if (this.lineIndex < this.currentNode.lines.length - 1) {
      this.lineIndex++;
      this.render();
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.visible || !this.currentNode) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;

    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) {
      const tag = active.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable) return;
    }

    const onLastLine = this.lineIndex >= this.currentNode.lines.length - 1;
    if (!onLastLine) {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.advance();
      }
      return;
    }

    const options = this.currentNode.options.length > 0 ? this.currentNode.options : [{ label: 'Continue' }];
    const optionIndex = this.optionIndexFromKey(event.key);
    if (optionIndex < 0 || optionIndex >= options.length) return;
    event.preventDefault();
    event.stopPropagation();
    this.chooseOption(optionIndex);
  }

  private optionIndexFromKey(key: string): number {
    if (/^[1-9]$/.test(key)) return Number(key) - 1;
    if (key === '0') return 9;
    return -1;
  }

  private chooseOption(optionIndex: number): void {
    if (!this.currentNode) return;
    const option = this.currentNode.options[optionIndex];
    if (!option) {
      this.hide();
      return;
    }

    if (!/^continue\.?$/i.test(option.label.trim())) this.hooks.showPlayerBubble(option.label);
    this.clearNpcBubble();
    this.setOptionsVisible(false);
    this.waitingForNpcReply = true;
    this.network.sendRaw(encodePacket(
      ClientOpcode.DIALOGUE_CHOOSE,
      this.npcEntityId,
      this.sessionId,
      optionIndex,
    ));
  }

  private render(): void {
    if (!this.currentNode) return;

    const line = this.currentNode.lines[this.lineIndex] ?? '';
    if (line) {
      this.clearNpcBubble();
      if (this.currentNode.speaker === 'You') {
        this.hooks.showPlayerBubble(line);
      } else {
        this.hooks.showNpcBubble(this.npcEntityId, line);
        const npcEntityId = this.npcEntityId;
        this.npcBubbleTimer = window.setTimeout(() => {
          if (this.npcEntityId === npcEntityId) this.clearNpcBubble();
        }, 6000);
      }
    }

    const onLastLine = this.lineIndex >= this.currentNode.lines.length - 1;
    this.optionsEl.innerHTML = '';
    if (this.currentNode.autoClose) {
      this.setOptionsVisible(false);
      return;
    }
    if (!onLastLine) {
      this.setOptionsVisible(true);
      this.appendOptionButton('Continue', () => this.advance(), 'Space / Enter');
      return;
    }

    const options = this.currentNode.options.length > 0
      ? this.currentNode.options
      : [{ label: 'Continue' }];

    this.setOptionsVisible(true);
    for (let i = 0; i < options.length; i++) {
      const optionIndex = i;
      const shortcut = i < 9 ? `${i + 1}` : (i === 9 ? '0' : '');
      this.appendOptionButton(options[i].label, () => this.chooseOption(optionIndex), shortcut);
    }
  }

  private appendOptionButton(label: string, action: () => void, shortcut: string): void {
    const btn = document.createElement('button');
    btn.textContent = shortcut ? `${shortcut}. ${label}` : label;
    btn.style.cssText = `
        width: 100%;
        min-height: 30px;
        padding: 6px 10px;
        box-sizing: border-box;
        background: rgba(43, 10, 8, 0.9);
        border: 1px solid #9a332b;
        color: #f4ded5;
        border-radius: 2px;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 13px;
        font-weight: bold;
        cursor: pointer;
        text-align: left;
        text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
        box-shadow: inset 0 0 0 1px rgba(255,190,150,0.08);
      `;
    btn.onmouseenter = () => { btn.style.background = 'rgba(78, 18, 14, 0.95)'; };
    btn.onmouseleave = () => { btn.style.background = 'rgba(43, 10, 8, 0.9)'; };
    btn.onclick = (ev) => {
      ev.stopPropagation();
      action();
    };
    this.optionsEl.appendChild(btn);
  }

  private setOptionsVisible(visible: boolean): void {
    this.container.style.display = visible ? 'flex' : 'none';
    const chatPanel = document.getElementById('chat-panel');
    if (visible) {
      if (chatPanel && chatPanel !== this.hiddenChatPanel) {
        this.hiddenChatPanel = chatPanel;
        chatPanel.style.display = 'none';
      }
    } else if (this.hiddenChatPanel) {
      this.hiddenChatPanel.style.display = 'flex';
      this.hiddenChatPanel = null;
    }
  }

  private clearNpcBubble(): void {
    if (this.npcBubbleTimer !== null) {
      window.clearTimeout(this.npcBubbleTimer);
      this.npcBubbleTimer = null;
    }
    if (this.npcEntityId >= 0) {
      this.hooks.hideNpcBubble(this.npcEntityId);
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyHandler);
    if (this.npcReplyDelayTimer !== null) {
      window.clearTimeout(this.npcReplyDelayTimer);
      this.npcReplyDelayTimer = null;
    }
    this.clearNpcBubble();
    this.container.remove();
  }
}
