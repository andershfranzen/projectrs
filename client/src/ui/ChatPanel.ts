export type ChatSendCallback = (message: string) => void;

type ChatTab = 'all' | 'game' | 'public';

export class ChatPanel {
  private container: HTMLDivElement;
  private log: HTMLDivElement;
  private input: HTMLInputElement;
  private onSend: ChatSendCallback | null = null;

  // Chat filtering
  private activeTab: ChatTab = 'all';
  private tabButtons: HTMLDivElement[] = [];
  private messages: { el: HTMLDivElement; type: 'game' | 'public' | 'private' }[] = [];

  constructor() {
    this.container = this.buildUI();
    this.log = this.container.querySelector('#chat-log') as HTMLDivElement;
    this.input = this.container.querySelector('#chat-input') as HTMLInputElement;
    const mount = document.getElementById('ui-chat-inner');
    (mount ?? document.body).appendChild(this.container);

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const msg = this.input.value.trim();
        if (msg) {
          this.onSend?.(msg);
          this.input.value = '';
        }
        this.input.blur();
      }
      if (e.key === 'Escape') {
        this.input.blur();
      }
      e.stopPropagation();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && document.activeElement !== this.input) {
        e.preventDefault();
        this.input.focus();
      }
    });

    this.container.addEventListener('click', () => {
      this.input.focus();
    });
  }

  private buildUI(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'chat-panel';
    panel.style.cssText = `
      width: 100%; height: 100%;
      background: transparent;
      display: flex; flex-direction: column;
      font-family: Arial, Helvetica, sans-serif; font-size: 12px;
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
    ];

    for (const tab of tabs) {
      const btn = document.createElement('div');
      btn.textContent = tab.label;
      btn.dataset.tab = tab.key;
      btn.style.cssText = `
        padding: 3px 12px; cursor: pointer;
        font-size: 11px; font-weight: bold;
        color: #8a857c;
        border-bottom: 2px solid transparent;
        transition: all 0.1s;
      `;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.switchTab(tab.key);
      });
      tabBar.appendChild(btn);
      this.tabButtons.push(btn);
    }

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
    `;

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

    // Style placeholder text
    const style = document.createElement('style');
    style.textContent = '#chat-input::placeholder { color: rgba(216,55,43,0.8); text-shadow: 1px 1px 0 #000; }';
    panel.appendChild(style);

    inputBar.appendChild(input);
    panel.appendChild(inputBar);

    // Set initial tab
    this.switchTab('all');

    return panel;
  }

  private switchTab(tab: ChatTab): void {
    this.activeTab = tab;
    for (const btn of this.tabButtons) {
      if (btn.dataset.tab === tab) {
        btn.style.color = '#d8372b';
        btn.style.borderBottomColor = '#d8372b';
      } else {
        btn.style.color = '#8a857c';
        btn.style.borderBottomColor = 'transparent';
      }
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

  addMessage(from: string, message: string, color: string = '#fff'): void {
    const el = document.createElement('div');
    el.innerHTML = `<span style="color: ${color}; font-weight: bold;">${this.escapeHtml(from)}:</span> ${this.escapeHtml(message)}`;
    if (this.activeTab !== 'all' && this.activeTab !== 'public') el.style.display = 'none';
    this.log.appendChild(el);
    this.messages.push({ el, type: 'public' });
    this.log.scrollTop = this.log.scrollHeight;
  }

  addSystemMessage(message: string, color: string = '#d8372b'): void {
    const el = document.createElement('div');
    el.innerHTML = `<span style="color: ${color};">${this.escapeHtml(message)}</span>`;
    if (this.activeTab !== 'all' && this.activeTab !== 'game') el.style.display = 'none';
    this.log.appendChild(el);
    this.messages.push({ el, type: 'game' });
    this.log.scrollTop = this.log.scrollHeight;
  }

  setSendHandler(handler: ChatSendCallback): void {
    this.onSend = handler;
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
