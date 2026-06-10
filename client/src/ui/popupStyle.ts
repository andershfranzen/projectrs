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
  const isMobile = typeof window !== 'undefined'
    && window.matchMedia?.('(max-width: 760px), (pointer: coarse) and (max-width: 900px)').matches;

  if (isMobile) {
    const mobileMargin = Math.max(10, Math.floor(margin / 2));
    const mobileWidth = Math.max(360, minWidth);
    return `
      position: fixed;
      left: calc(var(--eq-viewport-left, 0px) + var(--eq-viewport-width, 100vw) / 2);
      top: calc(var(--eq-viewport-top, 0px) + (var(--eq-viewport-height, 100dvh) - var(--mobile-nav-height, 68px) - env(safe-area-inset-bottom, 0px)) / 2);
      transform: translate(-50%, -50%);
      width: min(${mobileWidth}px, calc(var(--eq-viewport-width, 100vw) - ${mobileMargin * 2}px));
      min-width: 0;
      max-width: calc(var(--eq-viewport-width, 100vw) - ${mobileMargin * 2}px);
      max-height: calc(var(--eq-viewport-height, 100dvh) - var(--mobile-nav-height, 68px) - env(safe-area-inset-bottom, 0px) - ${mobileMargin * 2}px);
    `;
  }

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
    position: fixed;
    left: calc(var(--eq-viewport-left, 0px) + var(--eq-viewport-width, 100vw) / 2);
    top: calc(var(--eq-viewport-top, 0px) + var(--eq-viewport-height, 100vh) / 2);
    transform: translate(-50%, -50%);
    width: ${opts.width ?? 'min(720px, calc(var(--eq-viewport-width, 100vw) - 24px))'};
    max-height: ${opts.maxHeight ?? 'calc(var(--eq-viewport-height, 100vh) - 24px)'};
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
  labelParts?: { text: string; color?: string }[];
  labelColor?: string;
  action: (event: MouseEvent) => void;
}

export interface ContextMenuOpts {
  x: number;
  y: number;
  title?: string;
  fontSizePx?: number;
  itemPadding?: string;
  maxWidthPx?: number;
  minWidthPx?: number;
  zIndex?: number;
  onClose?: () => void;
}

const DEFAULT_CONTEXT_MENU_Z_INDEX = 3000;
const DEFAULT_TOUCH_CONTEXT_MENU_MS = 450;
const DEFAULT_TOUCH_CONTEXT_MENU_MOVE_CANCEL_PX = 12;
const DEFAULT_CONTEXT_MENU_CLICK_SUPPRESS_MS = 900;
const CONTEXT_MENU_CLICK_SUPPRESS_RADIUS_PX = 24;
const CONTEXT_MENU_FOLD_MS = 150;

export function contextMenuCss(opts: ContextMenuOpts): string {
  return `
    position: fixed; left: ${opts.x}px; top: ${opts.y}px;
    background: #3a3125; border: 2px solid #5a4a35;
    font-family: Arial, Helvetica, sans-serif; font-size: ${opts.fontSizePx ?? 12}px; z-index: ${opts.zIndex ?? DEFAULT_CONTEXT_MENU_Z_INDEX};
    min-width: ${opts.minWidthPx ?? 100}px;
    ${opts.maxWidthPx ? `max-width: ${opts.maxWidthPx}px;` : ''}
    box-shadow: 2px 2px 8px rgba(0,0,0,0.5);
  `;
}

export interface HoverTooltipOpts {
  title: string;
  body?: string | string[];
  x: number;
  y: number;
  titleColor?: string;
  bodyColor?: string;
  minWidthPx?: number;
  maxWidthPx?: number;
  zIndex?: number;
}

export class HoverTooltip {
  readonly el: HTMLDivElement;
  private removed = false;

  constructor(opts: HoverTooltipOpts) {
    ensureContextMenuGlobalListeners();
    const tooltip = document.createElement('div');
    tooltip.className = 'eq-context-menu eq-hover-tooltip';
    tooltip.style.cssText = contextMenuCss({
      x: opts.x + 12,
      y: opts.y + 12,
      minWidthPx: opts.minWidthPx ?? 126,
      maxWidthPx: opts.maxWidthPx ?? 220,
      zIndex: opts.zIndex ?? 3100,
    }) + `
      pointer-events: none;
      padding: 0;
    `;

    const title = document.createElement('div');
    title.style.cssText = `
      padding: 5px 10px 2px;
      color: ${opts.titleColor ?? '#f4ded5'};
      font-weight: bold;
      text-align: center;
      text-shadow: 1px 1px 0 #000;
      white-space: normal;
    `;
    title.textContent = opts.title;
    tooltip.appendChild(title);

    const bodyLines = Array.isArray(opts.body) ? opts.body.filter(Boolean) : (opts.body ? [opts.body] : []);
    if (bodyLines.length > 0) {
      const body = document.createElement('div');
      body.style.cssText = `
        padding: 0 10px 6px;
        color: ${opts.bodyColor ?? '#d8372b'};
        text-align: center;
        font-size: 11px;
        line-height: 15px;
        white-space: pre-line;
      `;
      body.textContent = bodyLines.join('\n');
      tooltip.appendChild(body);
    }

    document.body.appendChild(tooltip);
    this.el = tooltip;
    activeHoverTooltips.add(this);
    this.move(opts.x, opts.y);
  }

  move(x: number, y: number): void {
    if (this.removed) return;
    this.el.style.left = `${x + 12}px`;
    this.el.style.top = `${y + 12}px`;
    const visualViewport = window.visualViewport;
    const viewportLeft = visualViewport?.offsetLeft ?? 0;
    const viewportTop = visualViewport?.offsetTop ?? 0;
    const viewportWidth = visualViewport?.width ?? window.innerWidth;
    const viewportHeight = visualViewport?.height ?? window.innerHeight;
    clampElementToRect(this.el, new DOMRect(
      viewportLeft + 4,
      viewportTop + 4,
      Math.max(0, viewportWidth - 8),
      Math.max(0, viewportHeight - 8),
    ));
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    activeHoverTooltips.delete(this);
    this.el.remove();
  }
}

const activeHoverTooltips = new Set<HoverTooltip>();
let activeContextMenu: { el: HTMLDivElement; close: () => void } | null = null;
let contextMenuGlobalsInstalled = false;
let suppressedContextMenuClick: {
  source: HTMLElement;
  x: number;
  y: number;
  until: number;
} | null = null;

function consumeSuppressedContextMenuFollowup(event: MouseEvent): boolean {
  const suppressed = suppressedContextMenuClick;
  if (!suppressed) return false;
  if (performance.now() > suppressed.until) {
    suppressedContextMenuClick = null;
    return false;
  }

  const target = event.target instanceof Node ? event.target : null;
  const sourceEvent = target !== null && suppressed.source.contains(target);
  const nearSourcePoint = Math.hypot(event.clientX - suppressed.x, event.clientY - suppressed.y)
    <= CONTEXT_MENU_CLICK_SUPPRESS_RADIUS_PX;
  if (!sourceEvent && !nearSourcePoint) return false;

  suppressedContextMenuClick = null;
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
}

function ensureContextMenuGlobalListeners(): void {
  if (contextMenuGlobalsInstalled) return;
  contextMenuGlobalsInstalled = true;

  const closeFloatingUi = () => {
    closeActiveContextMenu();
    closeActiveHoverTooltips();
  };

  // Capture-phase right-click handling closes an old menu before a panel's
  // target handler can create the replacement. If the right-click lands on
  // empty UI, this still clears the old menu instead of leaving it stranded.
  document.addEventListener('contextmenu', (event) => {
    if (consumeSuppressedContextMenuFollowup(event)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.eq-context-menu')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // World right-click is owned by GameManager; closing here can erase the
    // pointerdown menu before the canvas receives the native contextmenu event.
    if (target?.closest('#game-canvas')) {
      return;
    }
    closeActiveContextMenu();
    closeActiveHoverTooltips();
  }, true);

  document.addEventListener('contextmenu', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('#game-frame')) return;
    event.preventDefault();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeActiveContextMenu();
  });

  window.addEventListener('blur', closeFloatingUi);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') closeFloatingUi();
  });

  document.addEventListener('pointerdown', () => {
    if (suppressedContextMenuClick && performance.now() <= suppressedContextMenuClick.until) {
      suppressedContextMenuClick = null;
    }
  }, true);

  document.addEventListener('click', (event) => {
    consumeSuppressedContextMenuFollowup(event);
  }, true);
}

export function closeActiveContextMenu(menu?: HTMLDivElement): void {
  if (activeContextMenu && (!menu || activeContextMenu.el === menu)) {
    activeContextMenu.close();
  } else if (menu) {
    menu.remove();
  }
}

export function closeActiveHoverTooltips(): void {
  for (const tooltip of Array.from(activeHoverTooltips)) {
    tooltip.remove();
  }
}

export function createContextMenu(items: ContextMenuItem[], opts: ContextMenuOpts): HTMLDivElement {
  ensureContextMenuGlobalListeners();
  closeActiveContextMenu();
  closeActiveHoverTooltips();

  const menu = document.createElement('div');
  menu.className = 'eq-context-menu';
  menu.setAttribute('role', 'menu');
  menu.style.cssText = contextMenuCss(opts);
  menu.style.overflow = 'hidden';
  menu.style.visibility = 'hidden';
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    menu.remove();
    document.removeEventListener('click', close);
    if (activeContextMenu?.el === menu) activeContextMenu = null;
    opts.onClose?.();
  };

  const title = document.createElement('div');
  title.textContent = opts.title ?? 'Select an option';
  title.style.cssText = `
    padding: 5px 12px 4px;
    color: #f4ded5;
    font-weight: bold;
    text-align: center;
    border-bottom: 1px solid rgba(216,55,43,0.45);
    background: rgba(20, 13, 9, 0.72);
    text-shadow: 1px 1px 0 #000;
    cursor: default;
  `;
  menu.appendChild(title);

  const optionsWrap = document.createElement('div');
  optionsWrap.style.cssText = `
    overflow: hidden;
    transform-origin: 50% 0%;
  `;

  for (const opt of items) {
    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    item.style.cssText = `padding: ${opts.itemPadding ?? '4px 12px'}; color: ${opt.labelColor ?? '#d8372b'}; cursor: pointer;`;
    if (opt.labelParts?.length) {
      for (const part of opt.labelParts) {
        const span = document.createElement('span');
        span.textContent = part.text;
        if (part.color) span.style.color = part.color;
        item.appendChild(span);
      }
    } else {
      item.textContent = opt.label;
    }
    item.addEventListener('mouseenter', () => item.style.background = '#5a4a35');
    item.addEventListener('mouseleave', () => item.style.background = 'transparent');
    item.addEventListener('click', (event) => {
      opt.action(event);
      close();
    });
    optionsWrap.appendChild(item);
  }
  menu.appendChild(optionsWrap);

  document.body.appendChild(menu);
  const margin = 4;
  const visualViewport = window.visualViewport;
  const viewportLeft = visualViewport?.offsetLeft ?? 0;
  const viewportTop = visualViewport?.offsetTop ?? 0;
  const viewportWidth = visualViewport?.width ?? window.innerWidth;
  const viewportHeight = visualViewport?.height ?? window.innerHeight;
  clampElementToRect(menu, new DOMRect(
    viewportLeft + margin,
    viewportTop + margin,
    Math.max(0, viewportWidth - margin * 2),
    Math.max(0, viewportHeight - margin * 2),
  ));
  activeContextMenu = { el: menu, close };
  setTimeout(() => {
    if (!closed) document.addEventListener('click', close);
  }, 0);
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const optionsHeight = optionsWrap.scrollHeight;
  if (reduceMotion || optionsHeight <= 0) {
    menu.style.visibility = 'visible';
  } else {
    window.requestAnimationFrame(() => {
      if (closed) return;
      optionsWrap.style.maxHeight = '0px';
      optionsWrap.style.opacity = '0';
      optionsWrap.style.transform = 'scaleY(0.82)';
      optionsWrap.style.willChange = 'max-height, opacity, transform';
      optionsWrap.style.transition = `
        max-height ${CONTEXT_MENU_FOLD_MS}ms cubic-bezier(0.18, 0.9, 0.24, 1),
        opacity ${Math.round(CONTEXT_MENU_FOLD_MS * 0.75)}ms ease-out,
        transform ${CONTEXT_MENU_FOLD_MS}ms cubic-bezier(0.18, 0.9, 0.24, 1)
      `;
      menu.style.visibility = 'visible';

      window.requestAnimationFrame(() => {
        if (closed) return;
        optionsWrap.style.maxHeight = `${optionsHeight}px`;
        optionsWrap.style.opacity = '1';
        optionsWrap.style.transform = 'scaleY(1)';
        window.setTimeout(() => {
          if (closed) return;
          optionsWrap.style.maxHeight = '';
          optionsWrap.style.transition = '';
          optionsWrap.style.willChange = '';
        }, CONTEXT_MENU_FOLD_MS + 40);
      });
    });
  }
  return menu;
}

export interface LongPressContextMenuOpts {
  delayMs?: number;
  moveCancelPx?: number;
  isEnabled?: () => boolean;
}

export function suppressNextContextMenuClick(
  source: HTMLElement,
  x: number,
  y: number,
  durationMs: number = DEFAULT_CONTEXT_MENU_CLICK_SUPPRESS_MS,
): void {
  ensureContextMenuGlobalListeners();
  suppressedContextMenuClick = {
    source,
    x,
    y,
    until: performance.now() + durationMs,
  };
}

export function installLongPressContextMenu(
  target: HTMLElement,
  onLongPress: (event: PointerEvent) => void,
  opts: LongPressContextMenuOpts = {},
): void {
  let pending: {
    pointerId: number;
    startX: number;
    startY: number;
    fired: boolean;
    timer: number;
  } | null = null;

  const clearPending = (pointerId?: number): void => {
    if (!pending || (pointerId !== undefined && pending.pointerId !== pointerId)) return;
    window.clearTimeout(pending.timer);
    pending = null;
  };

  target.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if (event.button !== 0) return;
    if (opts.isEnabled && !opts.isEnabled()) return;
    clearPending();

    pending = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      fired: false,
      timer: 0,
    };

    const active = pending;
    active.timer = window.setTimeout(() => {
      if (pending !== active) return;
      active.fired = true;
      suppressNextContextMenuClick(target, active.startX, active.startY);
      onLongPress(event);
    }, opts.delayMs ?? DEFAULT_TOUCH_CONTEXT_MENU_MS);
  });

  target.addEventListener('pointermove', (event) => {
    if (!pending || pending.pointerId !== event.pointerId || pending.fired) return;
    const moved = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
    if (moved > (opts.moveCancelPx ?? DEFAULT_TOUCH_CONTEXT_MENU_MOVE_CANCEL_PX)) clearPending(event.pointerId);
  });

  target.addEventListener('pointerup', (event) => {
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (pending.fired) {
      event.preventDefault();
      event.stopPropagation();
    }
    clearPending(event.pointerId);
  });

  target.addEventListener('pointercancel', (event) => clearPending(event.pointerId));
  target.addEventListener('lostpointercapture', (event) => clearPending(event.pointerId));
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
