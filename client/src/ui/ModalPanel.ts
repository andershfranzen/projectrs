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

export const GAME_DIALOG_MODAL_WIDTH = '470px';
export const GAME_DIALOG_MODAL_HEIGHT = '420px';
export const GAME_DIALOG_MODAL_MAX_HEIGHT = 'calc(100% - var(--chat-height, 220px) - 18px)';
export const DIALOGUE_TEXT_SHADOW = '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000';
export const DIALOGUE_PARCHMENT_BG = 'linear-gradient(rgba(45, 28, 20, 0.5), rgba(21, 14, 11, 0.7)), url("/ui/parchment.png") repeat';
export const DIALOGUE_ACCENT = '#8f2f28';
export const DIALOGUE_ACCENT_BRIGHT = '#b4493f';
export const DIALOGUE_STONE_EDGE = '#4a4035';
export const DIALOGUE_STONE_EDGE_DARK = '#18120f';

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

export interface GameDialogModalOpts extends Omit<ModalPanelOpts, 'geometry' | 'chrome'> {
  width?: string;
  maxHeight?: string;
  height?: string;
  zIndex?: number;
}

function centerPanelCss(opts: Extract<ModalGeometry, { kind: 'center' }>): string {
  return `
    position: fixed;
    left: calc(var(--eq-viewport-left, 0px) + var(--eq-viewport-width, 100vw) / 2);
    top: calc(var(--eq-viewport-top, 0px) + var(--eq-viewport-height, 100vh) / 2);
    transform: translate(-50%, -50%);
    display: none; flex-direction: column;
    width: ${opts.width};
    max-height: ${opts.maxHeight ?? 'calc(var(--eq-viewport-height, 100vh) - 24px)'};
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
          ${DIALOGUE_PARCHMENT_BG};
        border: 3px solid ${DIALOGUE_STONE_EDGE};
        border-radius: 5px;
        box-shadow:
          inset 0 0 0 1px rgba(214, 188, 143, 0.18),
          inset 0 0 0 4px rgba(14, 11, 10, 0.68),
          inset 0 -2px 0 rgba(0, 0, 0, 0.45),
          0 0 0 1px ${DIALOGUE_STONE_EDGE_DARK},
          0 0 0 2px rgba(143, 47, 40, 0.76),
          0 7px 20px rgba(0,0,0,0.68);
        padding: 4px;
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
      padding: 6px 9px 7px;
      background:
        linear-gradient(180deg, rgba(92, 82, 67, 0.52), rgba(36, 29, 24, 0.82)),
        url('/ui/stone-light.png') repeat;
      border: 1px solid rgba(23, 17, 14, 0.92);
      border-bottom-color: ${DIALOGUE_ACCENT};
      border-radius: 2px 2px 0 0;
      box-shadow:
        inset 0 1px 0 rgba(235, 210, 168, 0.14),
        inset 0 -1px 0 rgba(180, 73, 63, 0.42),
        0 1px 0 rgba(0, 0, 0, 0.75);
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
      background:
        linear-gradient(180deg, rgba(62, 48, 39, 0.95), rgba(28, 21, 18, 0.98)),
        url('/ui/stone-dark.png') repeat;
      border: 1px solid ${DIALOGUE_ACCENT_BRIGHT};
      color: #f4ded5;
      cursor: pointer;
      padding: 1px 7px;
      border-radius: 2px;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12px;
      font-weight: bold;
      text-shadow: 1px 1px 0 #000;
      box-shadow:
        inset 0 1px 0 rgba(255, 220, 180, 0.1),
        0 1px 0 rgba(0, 0, 0, 0.65);
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
      ? `font-size: 14px; color: #f1d6b6; font-weight: bold; text-shadow: ${DIALOGUE_TEXT_SHADOW};`
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

export function createGameDialogModal(opts: GameDialogModalOpts): ModalPanelParts {
  const { width, maxHeight, height, zIndex, ...modalOpts } = opts;
  const geometry: Extract<ModalGeometry, { kind: 'game-canvas' }> = {
    kind: 'game-canvas',
    width: width ?? GAME_DIALOG_MODAL_WIDTH,
    maxHeight: maxHeight ?? GAME_DIALOG_MODAL_MAX_HEIGHT,
  };
  if (zIndex !== undefined) geometry.zIndex = zIndex;

  const modal = createModalPanel({
    ...modalOpts,
    geometry,
    chrome: 'dialogue',
  });
  modal.root.style.height = height ?? GAME_DIALOG_MODAL_HEIGHT;
  return modal;
}

export function mountModalInGameFrame(root: HTMLElement): void {
  (document.getElementById('game-frame') ?? document.body).appendChild(root);
}
