/**
 * Shared popup styling helpers.
 *
 * EvilQuest's playable canvas area is `calc(100vw - 300px)` wide and
 * `calc(100vh - 220px)` tall — the right 300px is the UI column and the
 * bottom 220px is the chat. All popups must:
 *   - Center inside the canvas area (NOT the whole viewport)
 *   - Size themselves relative to the canvas, not fixed pixels
 *   - Never exceed the canvas bounds on small clients
 *
 * Usage:
 *   el.style.cssText = popupContainerCss({ widthFrac: 0.3 });
 *
 * For finer control, spread `popupGeometryCss()` into your existing CSS.
 */

/** Width/height of the non-canvas UI regions (keep in sync with index.html). */
export const RIGHT_COLUMN_WIDTH_PX = 300;
export const CHAT_HEIGHT_PX = 220;

export interface PopupGeometryOpts {
  /** Fraction of the canvas width the popup should take (0..1). Default 0.4. */
  widthFrac?: number;
  /** Absolute minimum width in px (floor). Default 320. */
  minWidthPx?: number;
  /** Safety margin on all sides inside the canvas. Default 40. */
  marginPx?: number;
}

/**
 * CSS fragment for positioning a popup centered inside the playable canvas
 * area with responsive width/height bounds. Combine with your existing
 * background/border/etc styles.
 */
export function popupGeometryCss(opts: PopupGeometryOpts = {}): string {
  const widthFrac = opts.widthFrac ?? 0.4;
  const minWidth = opts.minWidthPx ?? 320;
  const margin = opts.marginPx ?? 40;
  const right = RIGHT_COLUMN_WIDTH_PX;
  const bottom = CHAT_HEIGHT_PX;
  return `
    position: fixed;
    left: calc((100vw - ${right}px) / 2);
    top: calc((100vh - ${bottom}px) / 2);
    transform: translate(-50%, -50%);
    width: calc((100vw - ${right}px) * ${widthFrac});
    min-width: ${minWidth}px;
    max-width: calc(100vw - ${right}px - ${margin}px);
    max-height: calc(100vh - ${bottom}px - ${margin}px);
  `;
}

/**
 * Full popup container CSS — geometry + a flex-column layout so the inner
 * scroll area can `flex: 1 1 auto; min-height: 0` and overflow gracefully.
 */
export function popupContainerCss(opts: PopupGeometryOpts = {}): string {
  return `
    ${popupGeometryCss(opts)}
    display: none; flex-direction: column;
    z-index: 1001;
    font-family: Arial, Helvetica, sans-serif; color: #ddd; user-select: none;
    box-shadow: 0 4px 20px rgba(0,0,0,0.6);
  `;
}

export interface ViewportPanelOpts {
  width?: string;
  maxHeight?: string;
  zIndex?: number;
}

export function viewportPanelCss(opts: ViewportPanelOpts = {}): string {
  return `
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: ${opts.width ?? 'min(720px, 92vw)'}; max-height: ${opts.maxHeight ?? '90vh'};
    display: none; flex-direction: column;
    background: #1a1410; border: 2px solid #aa8844;
    border-radius: 6px; z-index: ${opts.zIndex ?? 500};
    font-family: Arial, Helvetica, sans-serif; color: #ddd; user-select: none;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  `;
}

export const panelHeaderCss = `
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px; background: #2a1f17; border-bottom: 1px solid #aa8844;
  border-radius: 4px 4px 0 0;
`;

export const panelTitleCss = 'font-size: 16px; color: #d8372b; font-weight: bold;';

export const panelCloseButtonCss = `
  background: #444; border: 1px solid #666; color: #ddd; cursor: pointer;
  padding: 2px 8px; border-radius: 3px; font-family: Arial, Helvetica, sans-serif;
`;

export interface ContextMenuItem {
  label: string;
  action: (event: MouseEvent) => void;
}

export interface ContextMenuOpts {
  x: number;
  y: number;
  fontSizePx?: number;
  itemPadding?: string;
  maxWidthPx?: number;
  minWidthPx?: number;
  zIndex?: number;
  onClose?: () => void;
}

export function contextMenuCss(opts: ContextMenuOpts): string {
  return `
    position: fixed; left: ${opts.x}px; top: ${opts.y}px;
    background: #3a3125; border: 2px solid #5a4a35;
    font-family: Arial, Helvetica, sans-serif; font-size: ${opts.fontSizePx ?? 12}px; z-index: ${opts.zIndex ?? 1001};
    min-width: ${opts.minWidthPx ?? 100}px;
    ${opts.maxWidthPx ? `max-width: ${opts.maxWidthPx}px;` : ''}
    box-shadow: 2px 2px 8px rgba(0,0,0,0.5);
  `;
}

let activeContextMenu: { el: HTMLDivElement; close: () => void } | null = null;
let contextMenuGlobalsInstalled = false;

function ensureContextMenuGlobalListeners(): void {
  if (contextMenuGlobalsInstalled) return;
  contextMenuGlobalsInstalled = true;

  // Capture-phase right-click handling closes an old menu before a panel's
  // target handler can create the replacement. If the right-click lands on
  // empty UI, this still clears the old menu instead of leaving it stranded.
  document.addEventListener('contextmenu', () => {
    closeActiveContextMenu();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeActiveContextMenu();
  });
}

export function closeActiveContextMenu(menu?: HTMLDivElement): void {
  if (activeContextMenu && (!menu || activeContextMenu.el === menu)) {
    activeContextMenu.close();
  } else if (menu) {
    menu.remove();
  }
}

export function createContextMenu(items: ContextMenuItem[], opts: ContextMenuOpts): HTMLDivElement {
  ensureContextMenuGlobalListeners();
  closeActiveContextMenu();

  const menu = document.createElement('div');
  menu.className = 'eq-context-menu';
  menu.style.cssText = contextMenuCss(opts);
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    menu.remove();
    document.removeEventListener('click', close);
    if (activeContextMenu?.el === menu) activeContextMenu = null;
    opts.onClose?.();
  };

  for (const opt of items) {
    const item = document.createElement('div');
    item.textContent = opt.label;
    item.style.cssText = `padding: ${opts.itemPadding ?? '4px 12px'}; color: #d8372b; cursor: pointer;`;
    item.addEventListener('mouseenter', () => item.style.background = '#5a4a35');
    item.addEventListener('mouseleave', () => item.style.background = 'transparent');
    item.addEventListener('click', (event) => {
      opt.action(event);
      close();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  activeContextMenu = { el: menu, close };
  setTimeout(() => document.addEventListener('click', close), 0);
  return menu;
}

export function clampElementToRect(el: HTMLElement, bounds: DOMRect): void {
  const rect = el.getBoundingClientRect();
  let left = rect.left;
  let top = rect.top;

  if (rect.right > bounds.right) left = Math.max(bounds.left, bounds.right - rect.width);
  if (rect.bottom > bounds.bottom) top = Math.max(bounds.top, bounds.bottom - rect.height);
  if (left < bounds.left) left = bounds.left;
  if (top < bounds.top) top = bounds.top;

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
