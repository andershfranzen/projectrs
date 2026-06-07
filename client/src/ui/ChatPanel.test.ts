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
