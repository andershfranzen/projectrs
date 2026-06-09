import { describe, expect, test } from 'bun:test';
import { GameManager } from './GameManager';

function makeManager(): any {
  const manager = Object.create(GameManager.prototype) as any;
  manager.lastWorldContextMenuEventAt = 0;
  manager.lastWorldContextMenuEventX = -9999;
  manager.lastWorldContextMenuEventY = -9999;
  manager.opens = [] as { x: number; y: number }[];
  manager.hideCount = 0;
  manager.hideContextMenu = () => { manager.hideCount++; };
  manager.openWorldContextMenuAt = (x: number, y: number) => {
    manager.opens.push({ x, y });
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
