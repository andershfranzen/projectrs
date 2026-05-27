import { closeActiveContextMenu } from './popupStyle';

export type QuantityInputRequest =
  | {
      inputType?: 'number';
      title: string;
      prompt: string;
      max?: number;
      defaultValue?: number;
      submitLabel?: string;
      quickAmounts?: Array<{ label: string; value: number | 'all' }>;
      details?: string[];
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
      details?: string[];
      validateText?: (value: string) => string | null;
      onTextSubmit: (value: string) => void;
    }
  | {
      inputType: 'choice';
      title: string;
      prompt: string;
      details?: string[];
      choices: Array<{
        label: string;
        detail?: string;
        disabled?: boolean;
        onSelect: () => void;
      }>;
    };

export type QuantityInputRequester = (request: QuantityInputRequest) => void;

const QUANTITY_TEXT_SHADOW = '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000';

export class QuantityInputPanel {
  private container: HTMLDivElement;
  private titleEl!: HTMLDivElement;
  private promptEl!: HTMLDivElement;
  private detailsEl!: HTMLDivElement;
  private errorEl!: HTMLDivElement;
  private inputRow!: HTMLDivElement;
  private input!: HTMLInputElement;
  private quickRow!: HTMLDivElement;
  private choiceRow!: HTMLDivElement;
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
    this.renderDetails(request.details ?? []);
    this.errorEl.textContent = '';
    this.choiceRow.style.display = 'none';
    if (request.inputType === 'choice') {
      this.inputRow.style.display = 'none';
      this.renderQuickAmounts([]);
      this.renderChoices(request.choices);
    } else if (request.inputType === 'text') {
      this.inputRow.style.display = 'flex';
      this.submitBtn.textContent = request.submitLabel ?? 'Confirm';
      this.input.type = 'text';
      this.input.inputMode = 'text';
      this.input.min = '';
      this.input.step = '';
      this.input.max = '';
      this.input.maxLength = Math.max(1, Math.floor(request.maxLength ?? 12));
      this.input.placeholder = request.placeholder ?? '';
      this.input.value = request.defaultText ?? '';
      this.renderQuickAmounts([]);
    } else {
      this.inputRow.style.display = 'flex';
      this.submitBtn.textContent = request.submitLabel ?? 'Confirm';
      this.input.type = 'number';
      this.input.inputMode = 'numeric';
      this.input.min = '1';
      this.input.step = '1';
      this.input.removeAttribute('maxlength');
      this.input.placeholder = '';
      this.input.value = String(Math.max(1, Math.floor(request.defaultValue ?? 1)));
      this.input.max = request.max && request.max > 0 ? String(Math.floor(request.max)) : '';
      this.renderQuickAmounts(request.quickAmounts ?? []);
    }
    this.setVisible(true);
    window.setTimeout(() => {
      if (this.request?.inputType === 'choice') {
        this.choiceRow.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
        return;
      }
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

    this.detailsEl = document.createElement('div');
    this.detailsEl.style.cssText = `
      display: none;
      flex-direction: column;
      gap: 2px;
      padding: 5px 7px;
      box-sizing: border-box;
      background: rgba(0,0,0,0.32);
      border: 1px solid rgba(154,51,43,0.55);
      color: #f4ded5;
      font-size: 11px;
      font-weight: bold;
      line-height: 1.25;
    `;
    panel.appendChild(this.detailsEl);

    this.inputRow = document.createElement('div');
    this.inputRow.style.cssText = `display: flex; gap: 6px; align-items: center;`;

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
    this.inputRow.appendChild(this.input);

    this.submitBtn = this.makeButton('Confirm', () => this.submit());
    this.cancelBtn = this.makeButton('Cancel', () => this.hide());
    this.inputRow.appendChild(this.submitBtn);
    this.inputRow.appendChild(this.cancelBtn);
    panel.appendChild(this.inputRow);

    this.quickRow = document.createElement('div');
    this.quickRow.style.cssText = `
      display: none;
      gap: 5px;
      align-items: center;
      flex-wrap: wrap;
    `;
    panel.appendChild(this.quickRow);

    this.choiceRow = document.createElement('div');
    this.choiceRow.style.cssText = `
      display: none;
      flex-direction: column;
      gap: 5px;
    `;
    panel.appendChild(this.choiceRow);

    this.errorEl = document.createElement('div');
    this.errorEl.style.cssText = `
      min-height: 14px;
      color: #ffb7a8;
      font-size: 11px;
      font-weight: bold;
    `;
    panel.appendChild(this.errorEl);

    panel.addEventListener('click', () => {
      if (this.request?.inputType !== 'choice') this.input.focus();
    });

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

  private renderQuickAmounts(amounts: Array<{ label: string; value: number | 'all' }>): void {
    this.quickRow.innerHTML = '';
    if (amounts.length === 0) {
      this.quickRow.style.display = 'none';
      return;
    }

    this.quickRow.style.display = 'flex';
    for (const amount of amounts) {
      const button = this.makeButton(amount.label, () => this.submitQuickAmount(amount.value));
      button.style.flex = '1 1 42px';
      button.style.minWidth = '42px';
      button.style.height = '26px';
      button.style.padding = '3px 6px';
      this.quickRow.appendChild(button);
    }
  }

  private renderChoices(choices: Extract<QuantityInputRequest, { inputType: 'choice' }>['choices']): void {
    this.choiceRow.innerHTML = '';
    if (choices.length === 0) {
      this.choiceRow.style.display = 'none';
      return;
    }

    this.choiceRow.style.display = 'flex';
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = !!choice.disabled;
      button.style.cssText = `
        width: 100%;
        min-height: 38px;
        padding: 6px 8px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        background: rgba(43, 10, 8, 0.9);
        border: 1px solid #9a332b;
        color: #f4ded5;
        border-radius: 2px;
        cursor: ${choice.disabled ? 'not-allowed' : 'pointer'};
        opacity: ${choice.disabled ? '0.45' : '1'};
        font-family: Arial, Helvetica, sans-serif;
        text-align: left;
        text-shadow: ${QUANTITY_TEXT_SHADOW};
        box-shadow: inset 0 0 0 1px rgba(255,190,150,0.08);
      `;
      const label = document.createElement('div');
      label.textContent = choice.label;
      label.style.cssText = `font-size: 12px; font-weight: bold;`;
      button.appendChild(label);
      if (choice.detail) {
        const detail = document.createElement('div');
        detail.textContent = choice.detail;
        detail.style.cssText = `font-size: 11px; font-weight: bold; color: #ddb8ad; line-height: 1.2;`;
        button.appendChild(detail);
      }
      button.addEventListener('mouseenter', () => {
        if (!button.disabled) button.style.background = 'rgba(78, 18, 14, 0.95)';
      });
      button.addEventListener('mouseleave', () => {
        if (!button.disabled) button.style.background = 'rgba(43, 10, 8, 0.9)';
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        this.hide();
        choice.onSelect();
      });
      this.choiceRow.appendChild(button);
    }

    const cancel = this.makeButton('Cancel', () => this.hide());
    cancel.style.width = '100%';
    this.choiceRow.appendChild(cancel);
  }

  private renderDetails(details: string[]): void {
    this.detailsEl.innerHTML = '';
    const visibleDetails = details.map((detail) => detail.trim()).filter(Boolean);
    if (visibleDetails.length === 0) {
      this.detailsEl.style.display = 'none';
      return;
    }

    this.detailsEl.style.display = 'flex';
    for (const detail of visibleDetails) {
      const line = document.createElement('div');
      line.textContent = detail;
      this.detailsEl.appendChild(line);
    }
  }

  private submitQuickAmount(value: number | 'all'): void {
    const request = this.request;
    if (!request || request.inputType === 'text' || request.inputType === 'choice') return;
    const max = request.max && request.max > 0 ? Math.floor(request.max) : 0;
    let quantity = value === 'all' ? max : Math.floor(value);
    if (max > 0) quantity = Math.min(quantity, max);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      this.errorEl.textContent = 'Enter a whole number greater than 0.';
      return;
    }
    this.hide();
    request.onSubmit(quantity);
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
    if (request.inputType === 'choice') return;
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
