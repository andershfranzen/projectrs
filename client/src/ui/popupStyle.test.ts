import { describe, expect, test } from 'bun:test';

class StubElement {
  className = '';
  children: StubElement[] = [];
  removed = false;
  scrollHeight = 0;
  style: Record<string, string> = {};
  textContent = '';

  addEventListener() {}
  appendChild(child: StubElement): void {
    this.children.push(child);
  }
  contains(target: unknown): boolean {
    return this === target || this.children.includes(target as StubElement);
  }
  getBoundingClientRect(): DOMRect {
    return {
      left: 10,
      top: 10,
      right: 130,
      bottom: 70,
      width: 120,
      height: 60,
    } as DOMRect;
  }
  remove(): void {
    this.removed = true;
  }
  setAttribute() {}
}

async function withPopupDomStubs<T>(
  fn: (state: { windowListeners: Record<string, (() => void)[]> }) => T | Promise<T>,
): Promise<T> {
  const hadDocument = 'document' in globalThis;
  const hadWindow = 'window' in globalThis;
  const hadDOMRect = 'DOMRect' in globalThis;
  const hadElement = 'Element' in globalThis;
  const hadNode = 'Node' in globalThis;
  const prevDocument = (globalThis as any).document;
  const prevWindow = (globalThis as any).window;
  const prevDOMRect = (globalThis as any).DOMRect;
  const prevElement = (globalThis as any).Element;
  const prevNode = (globalThis as any).Node;
  const windowListeners: Record<string, (() => void)[]> = {};
  const body = new StubElement();

  (globalThis as any).Element = StubElement;
  (globalThis as any).Node = StubElement;
  (globalThis as any).DOMRect = class {
    constructor(public left: number, public top: number, public width: number, public height: number) {}
    get right(): number { return this.left + this.width; }
    get bottom(): number { return this.top + this.height; }
  };
  (globalThis as any).document = {
    body,
    createElement: () => new StubElement(),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };
  (globalThis as any).window = {
    addEventListener: (type: string, handler: () => void) => {
      (windowListeners[type] ??= []).push(handler);
    },
    innerHeight: 600,
    innerWidth: 800,
    matchMedia: () => ({ matches: true }),
    visualViewport: null,
  };

  try {
    return await fn({ windowListeners });
  } finally {
    if (hadDocument) (globalThis as any).document = prevDocument;
    else delete (globalThis as any).document;
    if (hadWindow) (globalThis as any).window = prevWindow;
    else delete (globalThis as any).window;
    if (hadDOMRect) (globalThis as any).DOMRect = prevDOMRect;
    else delete (globalThis as any).DOMRect;
    if (hadElement) (globalThis as any).Element = prevElement;
    else delete (globalThis as any).Element;
    if (hadNode) (globalThis as any).Node = prevNode;
    else delete (globalThis as any).Node;
  }
}

describe('popupStyle context menus', () => {
  test('closes the active context menu when the window loses focus', () => {
    return withPopupDomStubs(async ({ windowListeners }) => {
      const { createContextMenu } = await import(`./popupStyle.ts?test=${Date.now()}`);
      let closed = 0;
      const menu = createContextMenu([{ label: 'Mine', action: () => {} }], {
        x: 20,
        y: 30,
        onClose: () => { closed++; },
      }) as unknown as StubElement;

      expect(menu.removed).toBe(false);
      expect(closed).toBe(0);

      windowListeners.blur?.[0]?.();

      expect(menu.removed).toBe(true);
      expect(closed).toBe(1);
    });
  });
});
