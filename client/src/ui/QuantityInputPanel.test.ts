import { describe, expect, test } from 'bun:test';
import { QuantityInputPanel } from './QuantityInputPanel';

describe('QuantityInputPanel', () => {
  test('Escape closes the prompt and stops fallthrough handlers', () => {
    const panel = Object.create(QuantityInputPanel.prototype) as any;
    let hidden = false;
    let prevented = false;
    let stoppedImmediate = false;
    panel.request = { title: 'Quantity' };
    panel.hide = () => { hidden = true; panel.request = null; };

    panel.handleDocumentKeyDown({
      key: 'Escape',
      preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stoppedImmediate = true; },
    } as KeyboardEvent);

    expect(hidden).toBe(true);
    expect(prevented).toBe(true);
    expect(stoppedImmediate).toBe(true);
  });
});
