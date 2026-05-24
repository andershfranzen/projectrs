export const UI_RED = '#d8372b';
export const UI_MUTED = '#8f8778';
export const UI_TEXT = '#cfc7b8';

export const TAB_BUTTON_BG = `
  linear-gradient(180deg, #302b24 0%, #211d18 48%, #16130f 100%)
`;

export const TAB_BUTTON_ACTIVE_BG = `
  linear-gradient(180deg, #17130f 0%, #201913 55%, #2a2119 100%)
`;

export function installUiChromeStyles(): void {
  if (document.getElementById('evilquest-ui-chrome')) return;
  const style = document.createElement('style');
  style.id = 'evilquest-ui-chrome';
  style.textContent = `
    .eq-tab-button,
    .eq-text-tab,
    .eq-action-button,
    .stance-btn {
      font-family: Arial, Helvetica, sans-serif;
      user-select: none;
      -webkit-user-select: none;
      touch-action: manipulation;
    }

    .eq-tab-button,
    .eq-text-tab,
    .eq-action-button {
      appearance: none;
      -webkit-appearance: none;
    }

    .eq-tab-button {
      flex: 1;
      height: var(--side-tab-size, 44px);
      padding: 2px 0;
      border-radius: 0;
      border-top: 1px solid #4b453b;
      border-left: 1px solid #474137;
      border-right: 1px solid #0f0d0a;
      border-bottom: 1px solid #0e0c09;
      background: ${TAB_BUTTON_BG};
      color: #d8d0c0;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -2px 4px rgba(0,0,0,0.32);
      transition: background 0.08s, border-color 0.08s, box-shadow 0.08s;
    }

    .eq-tab-button.is-active {
      border-top-color: #1a1815;
      border-left-color: #1a1815;
      border-right-color: #4b453b;
      border-bottom-color: #4b453b;
      background: ${TAB_BUTTON_ACTIVE_BG};
      box-shadow: inset 0 2px 5px rgba(0,0,0,0.55), inset 0 -1px 0 rgba(255,255,255,0.03);
    }

    .eq-tab-button:focus-visible,
    .eq-text-tab:focus-visible,
    .eq-action-button:focus-visible,
    .stance-btn:focus-visible {
      outline: 1px solid ${UI_RED};
      outline-offset: -2px;
    }

    .eq-text-tab {
      border: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: #8a857c;
      cursor: pointer;
      font-size: 11px;
      font-weight: bold;
      padding: 3px 12px;
      transition: color 0.1s, border-color 0.1s;
    }

    .eq-text-tab.is-active {
      color: ${UI_RED};
      border-bottom-color: ${UI_RED};
    }

    .eq-action-button {
      cursor: pointer;
      text-shadow: 1px 1px 0 rgba(0,0,0,0.5);
    }
  `;
  document.head.appendChild(style);
}

export function panelFrameCss(): string {
  return `
    display: flex;
    flex-direction: column;
    gap: var(--side-panel-gap, 8px);
    min-height: 100%;
    padding: var(--side-panel-padding, 6px 7px);
    color: ${UI_TEXT};
    font-family: Arial, Helvetica, sans-serif;
  `;
}

export function panelHeaderCss(color: string = UI_RED): string {
  return `
    color: ${color};
    font-size: 13px;
    line-height: 16px;
    font-weight: bold;
    letter-spacing: 0;
    text-shadow: 1px 1px 0 #000;
    padding: 0 0 5px;
    flex: 0 0 auto;
  `;
}

export function mutedBodyCss(): string {
  return `
    min-height: 34px;
    color: ${UI_MUTED};
    font-size: 11px;
    line-height: 15px;
    font-style: italic;
    text-shadow: 1px 1px 0 #000;
  `;
}

export function createPanelFrame(title: string, color: string, body: HTMLElement): HTMLDivElement {
  const view = document.createElement('div');
  view.style.cssText = panelFrameCss();

  const header = document.createElement('div');
  header.textContent = title;
  header.style.cssText = panelHeaderCss(color);

  const content = document.createElement('div');
  content.style.cssText = `
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  `;
  content.appendChild(body);

  view.appendChild(header);
  view.appendChild(content);
  return view;
}

export function createIconTabButton(opts: {
  key: string;
  label: string;
  icon?: string;
  iconScale?: number;
  onClick: () => void;
}): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'eq-tab-button';
  button.dataset.tab = opts.key;
  button.title = opts.label;
  button.setAttribute('aria-label', opts.label);
  button.addEventListener('click', opts.onClick);

  if (opts.icon) {
    const img = document.createElement('img');
    img.src = opts.icon;
    img.alt = '';
    img.draggable = false;
    const scale = (opts.iconScale ?? 1) * 0.82;
    img.style.cssText = `
      width: auto;
      height: auto;
      max-width: ${100 * scale}%;
      max-height: ${100 * scale}%;
      object-fit: contain;
      image-rendering: pixelated;
      pointer-events: none;
    `;
    button.appendChild(img);
  } else {
    button.textContent = opts.label;
    button.style.fontSize = '10px';
    button.style.fontWeight = 'bold';
    button.style.lineHeight = '1';
    button.style.textShadow = '1px 1px 0 #000';
  }

  return button;
}

export function createTextTabButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'eq-text-tab';
  button.textContent = label;
  button.dataset.tab = label.toLowerCase();
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

export function setToggleButtonActive(button: HTMLElement, active: boolean): void {
  button.classList.toggle('is-active', active);
  button.setAttribute('aria-pressed', String(active));
}
