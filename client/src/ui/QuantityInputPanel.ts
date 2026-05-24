import { closeActiveContextMenu } from './popupStyle';

export type QuantityInputRequest =
  | {
      inputType?: 'number';
      title: string;
      prompt: string;
      max?: number;
      defaultValue?: number;
      submitLabel?: string;
      onSubmit: (quantity: number) => void;
    }
  | {
      inputType: 'text';
      title: string;
      prompt: string;
      defaultText?: string;
      maxLength?: number;
      placeholder?: string;
      submitLabel?: string;
      validateText?: (value: string) => string | null;
      onTextSubmit: (value: string) => void;
    };

export type QuantityInputRequester = (request: QuantityInputRequest) => void;

const QUANTITY_TEXT_SHADOW = '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000';

export class QuantityInputPanel {
  private container: HTMLDivElement;
  private titleEl!: HTMLDivElement;
  private promptEl!: HTMLDivElement;
  private errorEl!: HTMLDivElement;
  private input!: HTMLInputElement;
  private submitBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private hiddenChatPanel: HTMLElement | null = null;
  private request: QuantityInputRequest | null = null;

  constructor() {
    this.container = this.buildUI();
    const mount = document.getElementById('ui-chat-inner');
    (mount ?? document.body).appendChild(this.container);
  }

  show(request: QuantityInputRequest): void {
    closeActiveContextMenu();
    this.request = request;
    this.titleEl.textContent = request.title;
    this.promptEl.textContent = request.prompt;
    this.errorEl.textContent = '';
    this.submitBtn.textContent = request.submitLabel ?? 'Confirm';
    if (request.inputType === 'text') {
      this.input.type = 'text';
      this.input.inputMode = 'text';
      this.input.min = '';
      this.input.step = '';
      this.input.max = '';
      this.input.maxLength = Math.max(1, Math.floor(request.maxLength ?? 12));
      this.input.placeholder = request.placeholder ?? '';
      this.input.value = request.defaultText ?? '';
    } else {
      this.input.type = 'number';
      this.input.inputMode = 'numeric';
      this.input.min = '1';
      this.input.step = '1';
      this.input.removeAttribute('maxlength');
      this.input.placeholder = '';
      this.input.value = String(Math.max(1, Math.floor(request.defaultValue ?? 1)));
      this.input.max = request.max && request.max > 0 ? String(Math.floor(request.max)) : '';
    }
    this.setVisible(true);
    window.setTimeout(() => {
      this.input.focus();
      this.input.select();
    }, 0);
  }

  hide(): void {
    this.request = null;
    this.setVisible(false);
  }

  private buildUI(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'quantity-input-panel';
    panel.style.cssText = `
      width: 100%;
      height: 100%;
      margin: 3px 8px;
      padding: 8px 10px;
      box-sizing: border-box;
      display: none;
      flex-direction: column;
      justify-content: center;
      gap: 7px;
      overflow: hidden;
      user-select: none;
      font-family: Arial, Helvetica, sans-serif;
      color: #f4ded5;
      text-shadow: ${QUANTITY_TEXT_SHADOW};
    `;

    this.titleEl = document.createElement('div');
    this.titleEl.style.cssText = `
      color: #f4ded5;
      font-size: 13px;
      font-weight: bold;
    `;
    panel.appendChild(this.titleEl);

    this.promptEl = document.createElement('div');
    this.promptEl.style.cssText = `
      color: #d8372b;
      font-size: 13px;
      font-weight: bold;
      line-height: 1.25;
    `;
    panel.appendChild(this.promptEl);

    const row = document.createElement('div');
    row.style.cssText = `display: flex; gap: 6px; align-items: center;`;

    this.input = document.createElement('input');
    this.input.type = 'number';
    this.input.min = '1';
    this.input.step = '1';
    this.input.inputMode = 'numeric';
    this.input.style.cssText = `
      flex: 1;
      min-width: 0;
      height: 30px;
      box-sizing: border-box;
      background: rgba(0,0,0,0.58);
      border: 1px solid #9a332b;
      color: #f4ded5;
      border-radius: 2px;
      padding: 5px 8px;
      outline: none;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 14px;
      font-weight: bold;
      text-shadow: ${QUANTITY_TEXT_SHADOW};
      box-shadow: inset 0 0 0 1px rgba(255,190,150,0.08);
    `;
    this.input.addEventListener('keydown', (event) => this.handleInputKeyDown(event));
    row.appendChild(this.input);

    this.submitBtn = this.makeButton('Confirm', () => this.submit());
    this.cancelBtn = this.makeButton('Cancel', () => this.hide());
    row.appendChild(this.submitBtn);
    row.appendChild(this.cancelBtn);
    panel.appendChild(row);

    this.errorEl = document.createElement('div');
    this.errorEl.style.cssText = `
      min-height: 14px;
      color: #ffb7a8;
      font-size: 11px;
      font-weight: bold;
    `;
    panel.appendChild(this.errorEl);

    panel.addEventListener('click', () => this.input.focus());

    return panel;
  }

  private makeButton(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = `
      min-width: 72px;
      height: 30px;
      padding: 5px 10px;
      box-sizing: border-box;
      background: rgba(43, 10, 8, 0.9);
      border: 1px solid #9a332b;
      color: #f4ded5;
      border-radius: 2px;
      cursor: pointer;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12px;
      font-weight: bold;
      text-shadow: ${QUANTITY_TEXT_SHADOW};
      box-shadow: inset 0 0 0 1px rgba(255,190,150,0.08);
    `;
    button.addEventListener('mouseenter', () => { button.style.background = 'rgba(78, 18, 14, 0.95)'; });
    button.addEventListener('mouseleave', () => { button.style.background = 'rgba(43, 10, 8, 0.9)'; });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return button;
  }

  private handleInputKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      this.submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.hide();
    }
  }

  private submit(): void {
    const request = this.request;
    if (!request) return;
    if (request.inputType === 'text') {
      const value = this.input.value.trim();
      const error = request.validateText?.(value) ?? (!value ? 'Enter a username.' : null);
      if (error) {
        this.errorEl.textContent = error;
        this.input.focus();
        this.input.select();
        return;
      }
      this.hide();
      request.onTextSubmit(value);
      return;
    }

    const quantity = Number(this.input.value);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      this.errorEl.textContent = 'Enter a whole number greater than 0.';
      this.input.focus();
      this.input.select();
      return;
    }
    const max = request.max && request.max > 0 ? Math.floor(request.max) : 0;
    if (max > 0 && quantity > max) {
      this.errorEl.textContent = `You only have ${max}.`;
      this.input.value = String(max);
      this.input.focus();
      this.input.select();
      return;
    }
    this.hide();
    request.onSubmit(quantity);
  }

  private setVisible(visible: boolean): void {
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
}
