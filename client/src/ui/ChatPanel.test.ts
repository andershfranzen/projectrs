import { describe, expect, test } from 'bun:test';
import { ChatPanel } from './ChatPanel';

function makePanel(scrollTop: number): { panel: any; log: any } {
  const log = {
    scrollTop,
    scrollHeight: 1_000,
    clientHeight: 200,
    appendChild() {
      this.scrollHeight += 40;
    },
  };
  const panel = Object.create(ChatPanel.prototype) as any;
  panel.activeTab = 'all';
  panel.log = log;
  panel.messages = [];
  return { panel, log };
}

function makeKeyEvent(): KeyboardEvent {
  return {
    key: 'Enter',
    defaultPrevented: false,
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  } as KeyboardEvent;
}

function makeElement(
  tagName = 'DIV',
  style: Partial<CSSStyleDeclaration> = { display: 'block', visibility: 'visible' },
  rectCount = 1,
  attrs: { id?: string; role?: string; tabIndex?: number } = {},
): HTMLElement {
  return {
    id: attrs.id ?? '',
    tagName,
    tabIndex: attrs.tabIndex ?? -1,
    isContentEditable: false,
    getAttribute: (name: string) => name === 'role' ? attrs.role ?? null : null,
    closest: () => null,
    getClientRects: () => Array.from({ length: rectCount }, () => ({})),
    __style: style,
  } as unknown as HTMLElement;
}

function withDomStubs<T>(
  opts: {
    activeElement?: HTMLElement;
    blockingBySelector?: Record<string, HTMLElement[]>;
    gameFrameStyle?: Partial<CSSStyleDeclaration>;
  },
  fn: () => T,
): T {
  const hadDocument = 'document' in globalThis;
  const hadWindow = 'window' in globalThis;
  const prevDocument = (globalThis as any).document;
  const prevWindow = (globalThis as any).window;
  const body = makeElement('BODY');
  const gameFrame = makeElement('DIV', opts.gameFrameStyle ?? { display: 'block', visibility: 'visible' });
  const blockingBySelector = opts.blockingBySelector ?? {};

  (globalThis as any).document = {
    activeElement: opts.activeElement ?? body,
    body,
    getElementById: (id: string) => id === 'game-frame' ? gameFrame : null,
    querySelectorAll: (selector: string) => blockingBySelector[selector] ?? [],
  };
  (globalThis as any).window = {
    getComputedStyle: (el: any) => el.__style ?? { display: 'block', visibility: 'visible' },
  };

  try {
    return fn();
  } finally {
    if (hadDocument) (globalThis as any).document = prevDocument;
    else delete (globalThis as any).document;
    if (hadWindow) (globalThis as any).window = prevWindow;
    else delete (globalThis as any).window;
  }
}

describe('ChatPanel scroll behavior', () => {
  test('keeps chat scroll position when reading older messages', () => {
    const { panel, log } = makePanel(120);

    panel.appendMessage({ style: {}, remove() {} }, 'public');

    expect(log.scrollTop).toBe(120);
  });

  test('continues following chat when already at the bottom', () => {
    const { panel, log } = makePanel(800);

    panel.appendMessage({ style: {}, remove() {} }, 'public');

    expect(log.scrollTop).toBe(1_040);
  });
});

describe('ChatPanel global Enter focus guard', () => {
  function makeFocusPanel(): any {
    const panel = Object.create(ChatPanel.prototype) as any;
    panel.input = makeElement('INPUT');
    panel.container = { contains: () => false };
    return panel;
  }

  test('allows Enter to focus chat during normal gameplay', () => {
    withDomStubs({}, () => {
      expect(makeFocusPanel().shouldFocusChatFromGlobalEnter(makeKeyEvent())).toBe(true);
    });
  });

  test('ignores hidden panels so stale mounted UI does not block chat focus', () => {
    const hiddenBank = makeElement('DIV', { display: 'none', visibility: 'visible' });
    withDomStubs({ blockingBySelector: { '#bank-panel': [hiddenBank] } }, () => {
      expect(makeFocusPanel().shouldFocusChatFromGlobalEnter(makeKeyEvent())).toBe(true);
    });
  });

  test('blocks Enter while a modal-style panel is visible', () => {
    const visibleBank = makeElement('DIV', { display: 'flex', visibility: 'visible' });
    withDomStubs({ blockingBySelector: { '#bank-panel': [visibleBank] } }, () => {
      expect(makeFocusPanel().shouldFocusChatFromGlobalEnter(makeKeyEvent())).toBe(false);
    });
  });

  test('does not steal Enter from another focused text input', () => {
    withDomStubs({ activeElement: makeElement('INPUT') }, () => {
      expect(makeFocusPanel().shouldFocusChatFromGlobalEnter(makeKeyEvent())).toBe(false);
    });
  });

  test('does not steal Enter from focused role-button controls', () => {
    const compass = makeElement('CANVAS', { display: 'block', visibility: 'visible' }, 1, {
      role: 'button',
      tabIndex: 0,
    });
    withDomStubs({ activeElement: compass }, () => {
      expect(makeFocusPanel().shouldFocusChatFromGlobalEnter(makeKeyEvent())).toBe(false);
    });
  });
});
