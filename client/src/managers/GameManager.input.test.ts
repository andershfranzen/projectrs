import { describe, expect, test } from 'bun:test';
import { GameManager, isTrustedBrowserInputEvent } from './GameManager';

function makeManager(): any {
  const manager = Object.create(GameManager.prototype) as any;
  manager.lastWorldContextMenuEventAt = 0;
  manager.lastWorldContextMenuEventX = -9999;
  manager.lastWorldContextMenuEventY = -9999;
  manager.opens = [] as { x: number; y: number }[];
  manager.hideCount = 0;
  manager.contextMenu = null;
  manager.hideContextMenu = () => {
    manager.hideCount++;
    manager.contextMenu = null;
  };
  manager.openWorldContextMenuAt = (x: number, y: number) => {
    manager.opens.push({ x, y });
    manager.contextMenu = {} as HTMLDivElement;
  };
  return manager;
}

function makeMouseEvent(x: number, y: number): MouseEvent & { prevented: boolean; stopped: boolean } {
  return {
    clientX: x,
    clientY: y,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  } as MouseEvent & { prevented: boolean; stopped: boolean };
}

describe('GameManager world context-menu input', () => {
  test('does not treat script-dispatched DOM events as browser input', () => {
    expect(isTrustedBrowserInputEvent({ isTrusted: false } as Event)).toBe(false);
    expect(isTrustedBrowserInputEvent({ isTrusted: true } as Event)).toBe(true);
    expect(isTrustedBrowserInputEvent()).toBe(true);
  });

  test('dedupes the pointerdown/mousedown/contextmenu chain for one right-click', () => {
    const manager = makeManager();
    const canvas = {} as HTMLCanvasElement;

    const first = makeMouseEvent(100, 120);
    manager.handleWorldContextMenuEvent(canvas, first, false);
    expect(manager.opens).toEqual([{ x: 100, y: 120 }]);
    expect(first.prevented).toBe(true);
    expect(first.stopped).toBe(true);

    const followup = makeMouseEvent(101, 121);
    manager.handleWorldContextMenuEvent(canvas, followup, false);
    expect(manager.opens).toEqual([{ x: 100, y: 120 }]);
    expect(manager.hideCount).toBe(1);
    expect(followup.prevented).toBe(true);
    expect(followup.stopped).toBe(true);
  });

  test('reopens duplicate native contextmenu if capture handling already closed the first menu', () => {
    const manager = makeManager();
    const canvas = {} as HTMLCanvasElement;

    manager.handleWorldContextMenuEvent(canvas, makeMouseEvent(100, 120), false);
    manager.contextMenu = null;
    manager.handleWorldContextMenuEvent(canvas, makeMouseEvent(101, 121), false);

    expect(manager.opens).toEqual([
      { x: 100, y: 120 },
      { x: 101, y: 121 },
    ]);
    expect(manager.hideCount).toBe(2);
  });

  test('allows a distinct right-click point even inside the dedupe window', () => {
    const manager = makeManager();
    const canvas = {} as HTMLCanvasElement;

    manager.handleWorldContextMenuEvent(canvas, makeMouseEvent(100, 120), false);
    manager.handleWorldContextMenuEvent(canvas, makeMouseEvent(140, 120), false);

    expect(manager.opens).toEqual([
      { x: 100, y: 120 },
      { x: 140, y: 120 },
    ]);
    expect(manager.hideCount).toBe(2);
  });
});
