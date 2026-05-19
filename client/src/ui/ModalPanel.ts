import {
  panelCloseButtonCss,
  panelHeaderCss,
  panelTitleCss,
  popupGeometryCss,
  type PopupGeometryOpts,
  viewportPanelCss,
  type ViewportPanelOpts,
} from './popupStyle';

type ModalGeometry =
  | ({ kind: 'viewport' } & ViewportPanelOpts)
  | ({ kind: 'canvas' } & PopupGeometryOpts)
  | { kind: 'game-canvas'; width?: string; maxHeight?: string; zIndex?: number }
  | { kind: 'center'; width: string; maxHeight?: string; zIndex?: number };

type ModalChrome = 'standard' | 'dark' | 'stone' | 'dialogue';

export interface ModalPanelParts {
  root: HTMLDivElement;
  header: HTMLDivElement;
  title: HTMLSpanElement;
  subtitle?: HTMLSpanElement;
  closeButton?: HTMLButtonElement;
}

export interface ModalPanelOpts {
  id: string;
  title: string;
  subtitle?: string;
  geometry: ModalGeometry;
  chrome?: ModalChrome;
  closeButton?: boolean;
  closeLabel?: string;
  onClose?: () => void;
  display?: 'none' | 'flex';
}

function centerPanelCss(opts: Extract<ModalGeometry, { kind: 'center' }>): string {
  return `
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    display: none; flex-direction: column;
    width: ${opts.width}; max-height: ${opts.maxHeight ?? '92vh'};
    background: url('/ui/stone-dark.png') repeat;
    border: 2px solid #5a4a35; border-radius: 4px;
    z-index: ${opts.zIndex ?? 1001}; user-select: none; color: #ddd;
    font-family: Arial, Helvetica, sans-serif;
    box-shadow: 0 4px 20px rgba(0,0,0,0.6);
  `;
}

function gameCanvasPanelCss(opts: Extract<ModalGeometry, { kind: 'game-canvas' }>): string {
  return `
    position: absolute;
    left: calc((100% - var(--right-rail-width, 300px)) / 2);
    top: calc((100% - var(--chat-height, 220px)) / 2);
    transform: translate(-50%, -50%);
    width: ${opts.width ?? 'min(480px, calc(100% - var(--right-rail-width, 300px) - 24px))'};
    max-width: calc(100% - var(--right-rail-width, 300px) - 16px);
    max-height: ${opts.maxHeight ?? 'calc(100% - var(--chat-height, 220px) - 16px)'};
    display: none; flex-direction: column;
    z-index: ${opts.zIndex ?? 1001}; user-select: none; color: #ddd;
    font-family: Arial, Helvetica, sans-serif;
    overflow: hidden;
    box-shadow: 0 4px 18px rgba(0,0,0,0.62);
  `;
}

function rootCss(geometry: ModalGeometry, chrome: ModalChrome): string {
  if (geometry.kind === 'viewport') {
    return viewportPanelCss(geometry);
  }
  if (geometry.kind === 'game-canvas') {
    const theme = chrome === 'dialogue'
      ? `
        background:
          linear-gradient(rgba(34, 12, 9, 0.92), rgba(18, 7, 5, 0.96)),
          url('/ui/parchment.png') repeat;
        border: 2px solid #7d2c25;
        border-radius: 4px;
        box-shadow:
          inset 0 0 0 1px rgba(255,190,150,0.08),
          0 4px 18px rgba(0,0,0,0.62);
      `
      : `
        background: url('/ui/stone-dark.png') repeat;
        border: 2px solid #5a4a35; border-radius: 4px;
      `;
    return `
      ${gameCanvasPanelCss(geometry)}
      ${theme}
    `;
  }
  if (geometry.kind === 'canvas') {
    const theme = chrome === 'stone'
      ? `
        background: url('/ui/stone-dark.png') repeat;
        border: 2px solid #5a4a35; border-radius: 4px; z-index: 1001;
        font-family: Arial, Helvetica, sans-serif; color: #ddd; user-select: none;
        box-shadow: 0 4px 20px rgba(0,0,0,0.6);
      `
      : `
        background: #1a1a1a; border: 2px solid #aa8844;
        border-radius: 6px; z-index: 1001;
        font-family: Arial, Helvetica, sans-serif; color: #ddd; user-select: none;
      `;
    return `
      ${popupGeometryCss(geometry)}
      display: none; flex-direction: column;
      ${theme}
    `;
  }
  return centerPanelCss(geometry);
}

function headerCss(chrome: ModalChrome): string {
  if (chrome === 'dialogue') {
    return `
      display: flex; justify-content: space-between; align-items: center;
      padding: 6px 9px;
      background: rgba(43, 10, 8, 0.95);
      border-bottom: 1px solid #9a332b;
      box-shadow: inset 0 -1px 0 rgba(255,190,150,0.08);
    `;
  }
  if (chrome === 'stone') {
    return `
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 12px;
      background: url('/ui/stone-light.png') repeat;
      border-bottom: 2px solid #1a1510;
      border-radius: 2px 2px 0 0;
    `;
  }
  if (chrome === 'dark') {
    return `
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 12px; background: #2a2a2a; border-bottom: 1px solid #aa8844;
      border-radius: 4px 4px 0 0;
    `;
  }
  return panelHeaderCss;
}

function closeCss(chrome: ModalChrome): string {
  if (chrome === 'dialogue') {
    return `
      background: rgba(43, 10, 8, 0.9);
      border: 1px solid #9a332b;
      color: #f4ded5;
      cursor: pointer;
      padding: 1px 7px;
      border-radius: 2px;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12px;
      font-weight: bold;
      text-shadow: 1px 1px 0 #000;
    `;
  }
  if (chrome === 'stone') {
    return `
      background: linear-gradient(180deg, #5a3a2a 0%, #3a2518 100%);
      border: 1px solid #6a4a35; color: #d8372b; cursor: pointer;
      padding: 2px 8px; border-radius: 3px; font-family: Arial, Helvetica, sans-serif; font-weight: bold;
    `;
  }
  return panelCloseButtonCss;
}

export function createModalPanel(opts: ModalPanelOpts): ModalPanelParts {
  const chrome = opts.chrome ?? 'standard';
  const root = document.createElement('div');
  root.id = opts.id;
  root.style.cssText = rootCss(opts.geometry, chrome);
  root.style.display = opts.display ?? 'none';

  const header = document.createElement('div');
  header.style.cssText = headerCss(chrome);

  const title = document.createElement('span');
  title.textContent = opts.title;
  title.style.cssText = chrome === 'stone'
    ? 'font-size: 14px; color: #d8372b; font-weight: bold; text-shadow: 1px 1px 0 #000;'
    : chrome === 'dialogue'
      ? 'font-size: 14px; color: #f4ded5; font-weight: bold; text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;'
      : panelTitleCss;
  header.appendChild(title);

  let subtitle: HTMLSpanElement | undefined;
  if (opts.subtitle) {
    subtitle = document.createElement('span');
    subtitle.textContent = opts.subtitle;
    subtitle.style.cssText = 'font-size: 11px; color: #d8372b; text-shadow: 1px 1px 0 #000;';
    header.appendChild(subtitle);
  }

  let closeButton: HTMLButtonElement | undefined;
  if (opts.closeButton ?? true) {
    closeButton = document.createElement('button');
    closeButton.textContent = opts.closeLabel ?? 'X';
    closeButton.style.cssText = closeCss(chrome);
    if (opts.onClose) closeButton.onclick = opts.onClose;
    header.appendChild(closeButton);
  }

  root.appendChild(header);
  return { root, header, title, subtitle, closeButton };
}
